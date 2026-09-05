import { getAllEntries, getAllSettings, getDirtyEntryCount, getSetting, mutateAllLocalState, mutateSettings } from "../src/db.js";
import { runAction } from "../src/action-runner.js";
import { SHEET_HEADERS, decodePersistedEntry, getDeviceId } from "../src/entries.js";
import { getAuthStatus, signIn, signOut } from "../src/auth.js";
import { getConfig, setOAuthClientCredentials } from "../src/config-loader.js";
import { clearDiagnostics, diagnosticsText, getDiagnostics } from "../src/diagnostics.js";
import { ERROR_CODE } from "../src/error-codes.js";
import { NEXT_DUE_KEY, scheduleSyncHeartbeat } from "../src/background-schedule.js";
import {
  adoptSpreadsheet,
  createReplacementSpreadsheet,
  getSpreadsheetId,
  spreadsheetUrl
} from "../src/sheets.js";
import { syncNow } from "../src/sync.js";
import { DEFAULT_MYSQL_API_BASE_URL, mysqlHostPermission, mysqlProvider, normalizeMysqlApiBaseUrl } from "../src/remote-mysql.js";
import { DEFAULT_CLOUDFLARE_D1_API_BASE_URL, cloudflareD1HostPermission, cloudflareD1Provider, normalizeCloudflareD1ApiBaseUrl } from "../src/remote-cloudflare-d1.js";
import { platform } from "../src/platform.js";
import { REMOTE_PROVIDER_ID, decodeRemoteProviderId, getRemoteProvider } from "../src/remote-provider.js";
import { activateProviderFromLocal, activateProviderFromRemote, getStorageMigrationState, migrateStorage } from "../src/storage-migration.js";
import { runPageTask, startPage } from "../src/page-runtime.js";
import { SETTING_KEY } from "../src/setting-keys.js";
import { $, formatError } from "../src/ui-helpers.js";
import { nowIso } from "../src/time.js";
import { normalizeTempoIssueId, normalizeTempoTaskIssueIds } from "../src/tempo.js";
import { bindThemeControls, readThemePreferences, saveThemePreferences, THEME_OPTIONS } from "../src/themes.js";
import { initReconcilePage } from "../reconcile/reconcile.js";
import { initUsagePage } from "../usage/usage.js";
import {
  BACKUP_SETTING_KEYS,
  DEFAULT_WORKDAY_START_HOUR,
  normalizeBackupSettings,
  normalizeOptionsSettings,
  normalizeWorkdayStartHour,
  planOptionsSettingsSave
} from "../src/options-settings.js";
import { storageUiState } from "../src/options-storage-ui.js";

let diagnostics = [];
let eventsBound = false;
let auxiliaryPagesInitialized = false;
let settingsLayoutWasVisible = false;
let syncSectionNavigation = () => {};

const BACKUP_FORMAT = "personal-time-logger-backup";
const BACKUP_SCHEMA_VERSION = 1;
function backupError(code) {
  return Object.assign(new Error("The backup operation could not complete."), { code });
}

function entryBackupFingerprint(entry) {
  return JSON.stringify(SHEET_HEADERS.map((field) => entry[field]));
}

function parseBackup(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw backupError(ERROR_CODE.BACKUP_INVALID);
  }
  if (!value || value.format !== BACKUP_FORMAT || value.schema_version !== BACKUP_SCHEMA_VERSION
    || !Array.isArray(value.entries) || !value.settings || typeof value.settings !== "object" || Array.isArray(value.settings)) {
    throw backupError(ERROR_CODE.BACKUP_INVALID);
  }

  const ids = new Set();
  const entries = value.entries.map((entry) => {
    let decoded;
    try {
      decoded = decodePersistedEntry(entry);
    } catch {
      throw backupError(ERROR_CODE.BACKUP_INVALID);
    }
    if (decoded.dirty || ids.has(decoded.id)) throw backupError(ERROR_CODE.BACKUP_INVALID);
    ids.add(decoded.id);
    return { ...decoded, dirty: false, last_sync_at: "", sync_error: "" };
  });
  let settings;
  try {
    settings = normalizeBackupSettings(value.settings);
  } catch {
    throw backupError(ERROR_CODE.BACKUP_INVALID);
  }
  const appearance = value.appearance && typeof value.appearance === "object" && !Array.isArray(value.appearance)
    ? value.appearance
    : null;
  return { entries, settings, appearance };
}

async function ensureBackupSync() {
  const result = await syncNow({ force: true });
  if (result?.status !== "synced" || await getDirtyEntryCount()) {
    throw backupError(ERROR_CODE.BACKUP_NOT_SYNCED);
  }
}

async function exportBackupClicked() {
  setStatus("Synchronizing before creating backup...");
  await ensureBackupSync();
  const [entries, allSettings] = await Promise.all([getAllEntries(), getAllSettings()]);
  const settings = Object.fromEntries(BACKUP_SETTING_KEYS
    .filter((key) => Object.hasOwn(allSettings, key))
    .map((key) => [key, allSettings[key]]));
  const backup = {
    format: BACKUP_FORMAT,
    schema_version: BACKUP_SCHEMA_VERSION,
    exported_at: nowIso(),
    settings,
    appearance: readThemePreferences(),
    entries
  };
  const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `personal-time-logger-backup-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
  setStatus(`Backup downloaded (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`);
}

async function importBackupClicked(file) {
  if (!file) return false;
  const backup = parseBackup(await file.text());
  if (globalThis.confirm && !globalThis.confirm(
    `Restore ${backup.entries.length} entr${backup.entries.length === 1 ? "y" : "ies"} from this backup? Existing entries with the same ID will be compared and conflicts will be left unchanged.`
  )) return false;

  setStatus("Synchronizing before restoring backup...");
  await ensureBackupSync();
  const summary = { added: 0, settingsChanged: 0, conflicts: [] };
  await mutateAllLocalState([...BACKUP_SETTING_KEYS, SETTING_KEY.DURATION_MULTIPLIER_UPDATED_AT], ({ entries, settings }) => {
    for (const [key, value] of Object.entries(backup.settings)) {
      if (JSON.stringify(settings.get(key)) !== JSON.stringify(value)) {
        settings.set(key, value);
        if (key === SETTING_KEY.DURATION_MULTIPLIER) {
          settings.set(SETTING_KEY.DURATION_MULTIPLIER_UPDATED_AT, nowIso());
        }
        summary.settingsChanged += 1;
      }
    }
    for (const entry of backup.entries) {
      const current = entries.get(entry.id);
      if (!current) {
        entries.set(entry.id, { ...entry, dirty: true });
        summary.added += 1;
      } else if (entryBackupFingerprint(current) !== entryBackupFingerprint(entry)) {
        summary.conflicts.push(entry.id);
      }
    }
  });
  if (backup.appearance) saveThemePreferences(backup.appearance);

  if (summary.added || summary.settingsChanged) {
    setStatus("Synchronizing restored backup...");
    await ensureBackupSync();
  }
  const conflictIds = summary.conflicts.slice(0, 5).join(", ");
  const conflictSuffix = summary.conflicts.length > 5 ? ", …" : "";
  const conflictText = summary.conflicts.length
    ? ` ${summary.conflicts.length} entr${summary.conflicts.length === 1 ? "y conflict was" : "y conflicts were"} left unchanged (${conflictIds}${conflictSuffix}).`
    : "";
  setStatus(`Backup restored: ${summary.added} entr${summary.added === 1 ? "y" : "ies"} added, ${summary.settingsChanged} setting${summary.settingsChanged === 1 ? "" : "s"} changed.${conflictText}`);
  return true;
}

function renderThemeSelection({ theme, highContrast }) {
  const selected = THEME_OPTIONS.find(({ id }) => id === theme);
  const preview = $("#themePreview");
  preview.dataset.themeName = selected?.label || "Codex";
  preview.dataset.themeDescription = selected?.description || "";
  preview.classList.toggle("is-high-contrast", highContrast);
}

function bindSectionNavigation() {
  const links = [...document.querySelectorAll(".section-nav a[href^='#']")];
  const setActive = (id) => {
    for (const link of links) link.classList.toggle("active", link.hash === `#${id}`);
  };
  syncSectionNavigation = ({ scroll = false } = {}) => {
    const requestedId = window.location.hash.slice(1);
    const requestedSection = requestedId && document.getElementById(requestedId);
    const requestedLink = links.find((link) => link.hash === `#${requestedId}`);
    const visible = requestedSection && !requestedSection.hidden && requestedLink && !requestedLink.hidden;
    const nextId = visible ? requestedId : "appearance";
    if (nextId !== requestedId) history.replaceState(null, "", `#${nextId}`);
    setActive(nextId);
    if (scroll) document.getElementById(nextId)?.scrollIntoView({ block: "start" });
  };
  for (const link of links) {
    link.addEventListener("click", () => setActive(link.hash.slice(1)));
  }
  syncSectionNavigation();
  window.addEventListener("hashchange", syncSectionNavigation);
}

function createTempoMappingRow(task = "", issueId = "") {
  const row = document.createElement("tr");
  const taskCell = document.createElement("td");
  const issueCell = document.createElement("td");
  const actionCell = document.createElement("td");
  const taskInput = document.createElement("input");
  const issueInput = document.createElement("input");
  const removeButton = document.createElement("button");

  taskInput.type = "text";
  taskInput.value = task;
  taskInput.placeholder = "Task name (blank means no Task)";
  taskInput.className = "tempo-task";
  taskInput.setAttribute("aria-label", "Task name");
  issueInput.type = "text";
  issueInput.inputMode = "numeric";
  issueInput.pattern = "[0-9]+";
  issueInput.value = issueId;
  issueInput.className = "tempo-issue-id";
  issueInput.setAttribute("aria-label", `Issue ID for ${task || "entries without a Task"}`);
  removeButton.type = "button";
  removeButton.className = "compact-button";
  removeButton.textContent = "Remove";
  removeButton.addEventListener("click", () => {
    row.remove();
    updateTempoMappingsEmptyState();
  });

  taskCell.append(taskInput);
  issueCell.append(issueInput);
  actionCell.append(removeButton);
  row.append(taskCell, issueCell, actionCell);
  return row;
}

function updateTempoMappingsEmptyState() {
  $("#tempoMappingsEmpty").hidden = $("#tempoMappings").children.length > 0;
}

function renderTempoMappings(value) {
  const mappings = normalizeTempoTaskIssueIds(value);
  const rows = Object.entries(mappings)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([task, issueId]) => createTempoMappingRow(task, issueId));
  $("#tempoMappings").replaceChildren(...rows);
  updateTempoMappingsEmptyState();
}

function readTempoMappings() {
  const mappings = {};
  for (const row of $("#tempoMappings").querySelectorAll("tr")) {
    const task = row.querySelector(".tempo-task").value.trim();
    const rawIssueId = row.querySelector(".tempo-issue-id").value;
    const issueId = normalizeTempoIssueId(rawIssueId);
    if (!issueId) throw new Error(`Enter a positive numeric issue ID for ${task || "entries without a Task"}`);
    if (Object.hasOwn(mappings, task)) throw new Error(`Task “${task || "(No task)"}” is listed more than once`);
    mappings[task] = issueId;
  }
  return mappings;
}

async function saveTempoSettings() {
  const token = $("#tempoApiToken").value.trim();
  const authorAccountId = $("#tempoAuthorAccountId").value.trim();
  const taskIssueIds = readTempoMappings();
  await mutateSettings([
    SETTING_KEY.TEMPO_API_TOKEN,
    SETTING_KEY.TEMPO_AUTHOR_ACCOUNT_ID,
    SETTING_KEY.TEMPO_TASK_ISSUE_IDS
  ], (settings) => {
    settings.set(SETTING_KEY.TEMPO_API_TOKEN, token);
    settings.set(SETTING_KEY.TEMPO_AUTHOR_ACCOUNT_ID, authorAccountId);
    settings.set(SETTING_KEY.TEMPO_TASK_ISSUE_IDS, taskIssueIds);
  });
  setStatus("Tempo settings saved on this device");
}

function setStatus(message) {
  for (const id of ["statusLine", "firstRunStatus", "backupStatus"]) {
    const status = document.getElementById(id);
    if (status) status.textContent = message;
  }
}

async function backendIsEstablished() {
  if (await getSetting(SETTING_KEY.REMOTE_BACKEND_ESTABLISHED, false)) return true;

  // Existing installations predate the explicit marker. Their backend or
  // provider state is enough to avoid showing first-run setup again.
  const backend = await getSetting(SETTING_KEY.REMOTE_BACKEND, null);
  if (backend) return true;
  if (await getSpreadsheetId()) return true;
  const tokenData = await getSetting(SETTING_KEY.GOOGLE_TOKEN_DATA, null);
  return Boolean(tokenData?.access_token || tokenData?.refresh_token);
}

async function markBackendEstablished(providerId) {
  await mutateSettings([
    SETTING_KEY.REMOTE_BACKEND,
    SETTING_KEY.REMOTE_BACKEND_ESTABLISHED
  ], (settings) => {
    settings.set(SETTING_KEY.REMOTE_BACKEND, providerId);
    settings.set(SETTING_KEY.REMOTE_BACKEND_ESTABLISHED, true);
  });
}

async function initializeAuxiliaryPages() {
  if (auxiliaryPagesInitialized) return;
  auxiliaryPagesInitialized = true;
  await Promise.all([initUsagePage(), initReconcilePage()]);
}

function runOptionsAction(key, action, button, actionOptions) {
  const refreshOnError = (actionOptions || {}).refreshOnError !== false;
  let refreshAfterAction = true;
  return runAction(key, async (options) => {
    const result = await action(options);
    refreshAfterAction = result !== false;
    return result;
  }, {
    setBusy(next) {
      if (button) button.disabled = next;
    },
    onError(error) {
      if (!refreshOnError) refreshAfterAction = false;
      setStatus(formatError(error));
    },
    onFinally() {
      if (!refreshAfterAction) return undefined;
      return refresh().catch((error) => setStatus(formatError(error)));
    }
  });
}

function setDeviceAuthPanel(details = null) {
  const panel = $("#deviceAuthPanel");
  if (!panel) return;

  if (!details) {
    panel.hidden = true;
    return;
  }

  const verificationUrl = details.verification_url_complete || details.verification_url;
  const expiresIn = Number(details.expires_in || 0);
  $("#deviceUserCode").textContent = details.user_code || "";
  $("#deviceVerificationUrl").textContent = details.verification_url || verificationUrl;
  $("#deviceVerificationUrl").href = verificationUrl;
  $("#deviceAuthExpires").textContent = expiresIn
    ? `Code expires in about ${Math.round(expiresIn / 60)} minutes.`
    : "";
  panel.hidden = false;

  window.open(verificationUrl, "_blank", "noopener,noreferrer");
}

function setSetupDeviceAuthPanel(details = null) {
  const panel = $("#setupDeviceAuthPanel");
  if (!panel) return;
  if (!details) {
    panel.hidden = true;
    return;
  }
  const verificationUrl = details.verification_url_complete || details.verification_url;
  const expiresIn = Number(details.expires_in || 0);
  $("#setupDeviceUserCode").textContent = details.user_code || "";
  $("#setupDeviceVerificationUrl").textContent = details.verification_url || verificationUrl;
  $("#setupDeviceVerificationUrl").href = verificationUrl;
  $("#setupDeviceAuthExpires").textContent = expiresIn
    ? `Code expires in about ${Math.round(expiresIn / 60)} minutes.`
    : "";
  panel.hidden = false;
  window.open(verificationUrl, "_blank", "noopener,noreferrer");
}

async function saveSettings() {
  const multiplierInput = $("#durationMultiplier");
  const workdayStartInput = $("#workdayStartHour");
  const next = normalizeOptionsSettings({
    interval: $("#syncInterval").value,
    multiplier: multiplierInput.value
  });
  if (!next.valid) {
    multiplierInput.setCustomValidity(next.message);
    multiplierInput.reportValidity();
    multiplierInput.focus();
    setStatus(next.message);
    return false;
  }
  multiplierInput.setCustomValidity("");

  const workdayStart = normalizeWorkdayStartHour(workdayStartInput.value);
  if (!workdayStart.valid) {
    workdayStartInput.setCustomValidity(workdayStart.message);
    workdayStartInput.reportValidity();
    workdayStartInput.focus();
    setStatus(workdayStart.message);
    return false;
  }
  workdayStartInput.setCustomValidity("");

  const saved = await mutateSettings([
    SETTING_KEY.SYNC_INTERVAL_SECONDS,
    SETTING_KEY.DURATION_MULTIPLIER,
    SETTING_KEY.DURATION_MULTIPLIER_UPDATED_AT,
    SETTING_KEY.WORKDAY_START_HOUR,
    NEXT_DUE_KEY
  ], (settings) => {
    const plan = planOptionsSettingsSave({
      currentInterval: settings.get(SETTING_KEY.SYNC_INTERVAL_SECONDS),
      currentMultiplier: settings.get(SETTING_KEY.DURATION_MULTIPLIER),
      currentMultiplierUpdatedAt: settings.get(SETTING_KEY.DURATION_MULTIPLIER_UPDATED_AT),
      interval: next.interval,
      multiplier: next.multiplier
    });
    if (plan.intervalChanged) {
      settings.set(SETTING_KEY.SYNC_INTERVAL_SECONDS, next.interval);
      // Discard the old long-interval due time before replacing the alarm.
      settings.set(NEXT_DUE_KEY, 0);
    }
    if (plan.multiplierSyncNeeded) {
      settings.set(SETTING_KEY.DURATION_MULTIPLIER, next.multiplier);
      settings.set(SETTING_KEY.DURATION_MULTIPLIER_UPDATED_AT, nowIso());
    }
    const currentStart = Number(settings.get(SETTING_KEY.WORKDAY_START_HOUR) ?? DEFAULT_WORKDAY_START_HOUR);
    const workdayStartChanged = currentStart !== workdayStart.start;
    if (workdayStartChanged) {
      settings.set(SETTING_KEY.WORKDAY_START_HOUR, workdayStart.start);
    }
    return { ...plan, workdayStartChanged };
  });
  $("#syncInterval").value = String(next.interval);
  multiplierInput.value = String(next.multiplier);
  workdayStartInput.value = String(workdayStart.start);

  if (!saved.intervalChanged && !saved.multiplierSyncNeeded && !saved.workdayStartChanged) {
    setStatus("Settings unchanged");
    return;
  }

  if (saved.intervalChanged) {
    try {
      if (!scheduleSyncHeartbeat(next.interval)) throw new Error("Browser alarms are unavailable");
      setStatus("Settings saved and sync schedule reset");
    } catch (error) {
      setStatus(`Settings saved, but could not reset the schedule: ${formatError(error)}`);
    }
  } else {
    setStatus("Settings saved");
  }

  if (saved.multiplierSyncNeeded) {
    void runPageTask({
      page: "options",
      phase: "settings-sync",
      task: () => syncNow({ force: true }),
      onError(error) {
        setStatus(`Settings saved, but sync could not start: ${formatError(error)}`);
      }
    });
  }
}

async function saveGoogleCredentials() {
  const clientId = $("#googleClientId").value.trim();
  const clientSecret = $("#googleClientSecret").value.trim();

  const saved = await setOAuthClientCredentials(clientId, clientSecret);
  setStatus(saved.changed
    ? "Google credentials saved; this device must sign in again"
    : "Google credentials saved to Firefox Sync");
}

function renderStorageProviderVisibility(activeBackend, targetBackend) {
  const state = storageUiState({
    activeProviderId: decodeRemoteProviderId(activeBackend),
    targetProviderId: decodeRemoteProviderId(targetBackend)
  });
  for (const selector of ["#googleAccountNav", "#google-account"]) {
    $(selector).hidden = !state.showGoogleAccount;
  }
  for (const selector of ["#spreadsheetNav", "#spreadsheet"]) {
    $(selector).hidden = !state.showSpreadsheet;
  }
  syncSectionNavigation();
}

function renderStorage(activeBackend) {
  const active = decodeRemoteProviderId(activeBackend);
  renderActiveBackendLabel(active);
  $("#remoteBackendTarget").value = active;
  renderProviderFields(active, $("#remoteBackendTarget").value);
  renderStorageProviderVisibility(active, $("#remoteBackendTarget").value);
}

function renderMysqlStorageFields(activeBackend, targetBackend) {
  const active = decodeRemoteProviderId(activeBackend);
  const target = decodeRemoteProviderId(targetBackend);
  $("#mysqlStorageFields").hidden = target !== REMOTE_PROVIDER_ID.MYSQL;
  $("#testMysqlConnection").hidden = active === REMOTE_PROVIDER_ID.MYSQL;
  $("#activateMysqlFromLocal").hidden = !(active !== REMOTE_PROVIDER_ID.MYSQL && target === REMOTE_PROVIDER_ID.MYSQL);
  $("#activateMysqlFromRemote").hidden = !(active !== REMOTE_PROVIDER_ID.MYSQL && target === REMOTE_PROVIDER_ID.MYSQL);
}

function renderProviderFields(activeBackend, targetBackend) {
  renderMysqlStorageFields(activeBackend, targetBackend);
  const active = decodeRemoteProviderId(activeBackend);
  const target = decodeRemoteProviderId(targetBackend);
  $("#cloudflareD1StorageFields").hidden = target !== REMOTE_PROVIDER_ID.CLOUDFLARE_D1;
  $("#testCloudflareD1Connection").hidden = active === REMOTE_PROVIDER_ID.CLOUDFLARE_D1;
  $("#activateCloudflareD1FromLocal").hidden = !(active !== REMOTE_PROVIDER_ID.CLOUDFLARE_D1 && target === REMOTE_PROVIDER_ID.CLOUDFLARE_D1);
  $("#activateCloudflareD1FromRemote").hidden = !(active !== REMOTE_PROVIDER_ID.CLOUDFLARE_D1 && target === REMOTE_PROVIDER_ID.CLOUDFLARE_D1);
}

function renderActiveBackendLabel(activeBackend) {
  const active = decodeRemoteProviderId(activeBackend);
  try {
    $("#activeRemoteBackend").textContent = getRemoteProvider(active).label;
  } catch {
    $("#activeRemoteBackend").textContent = "Unknown backend";
  }
}

async function refreshActiveBackendLabel() {
  renderActiveBackendLabel(await getSetting(
    SETTING_KEY.REMOTE_BACKEND,
    REMOTE_PROVIDER_ID.GOOGLE_SHEETS
  ));
}

async function renderStorageTarget() {
  const active = await getSetting(SETTING_KEY.REMOTE_BACKEND, REMOTE_PROVIDER_ID.GOOGLE_SHEETS);
  renderProviderFields(active, $("#remoteBackendTarget").value);
  renderStorageProviderVisibility(
    active,
    $("#remoteBackendTarget").value
  );
}

function renderMigration(activeBackend, migrationState) {
  const target = $("#remoteBackendTarget").value;
  const active = decodeRemoteProviderId(activeBackend);
  const button = $("#migrateStorage");
  const running = migrationState && !["complete", "failed"].includes(migrationState.phase);
  button.hidden = !running && target === active;
  button.textContent = running ? "Resume migration" : `Migrate data and switch to ${getRemoteProvider(target).label}`;
  if (running) {
    const entries = Number(migrationState.completed_entries || 0);
    const total = Number(migrationState.total_entries || 0);
    $("#migrationStatus").textContent = `Migration ${migrationState.phase}: ${entries}/${total} entries verified.`;
  } else if (migrationState?.phase === "complete") {
    $("#migrationStatus").textContent = "Migration completed and the new backend is active.";
  } else {
    $("#migrationStatus").textContent = "";
  }
}

async function saveMysqlSettingsValues(rawBaseUrl, rawToken) {
  const baseUrl = normalizeMysqlApiBaseUrl(rawBaseUrl);
  const token = String(rawToken || "").trim();
  if (!token) throw Object.assign(new Error("Enter the MySQL API token."), { code: "MYSQL_CONFIG_MISSING" });
  await mutateSettings([SETTING_KEY.MYSQL_API_BASE_URL, SETTING_KEY.MYSQL_API_TOKEN], (settings) => {
    settings.set(SETTING_KEY.MYSQL_API_BASE_URL, baseUrl);
    settings.set(SETTING_KEY.MYSQL_API_TOKEN, token);
  });
  return { baseUrl, token };
}

async function saveMysqlSettings() {
  const { baseUrl } = await saveMysqlSettingsValues($("#mysqlApiBaseUrl").value, $("#mysqlApiToken").value);
  $("#mysqlApiBaseUrl").value = baseUrl;
  setStatus("MySQL API settings saved on this device");
  return false;
}

async function testMysqlConnection() {
  const baseUrl = normalizeMysqlApiBaseUrl($("#mysqlApiBaseUrl").value);
  const token = $("#mysqlApiToken").value.trim();
  if (!token) throw Object.assign(new Error("Enter the MySQL API token."), { code: "MYSQL_CONFIG_MISSING" });
  const permissionRequest = platform.requestOptionalHostPermission(mysqlHostPermission(baseUrl));
  $("#mysqlConnectionStatus").textContent = "Requesting the exact API host permission...";
  let permissionGranted;
  try {
    permissionGranted = await Promise.race([
      permissionRequest,
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("Firefox did not answer the host permission request."), { code: "REMOTE_PERMISSION" })), 10_000))
    ]);
  } catch (error) {
    if (error?.code) throw error;
    throw Object.assign(new Error("Firefox could not grant the MySQL API host permission."), { code: "REMOTE_PERMISSION", cause: error });
  }
  if (!permissionGranted) throw Object.assign(new Error("Firefox did not grant the MySQL API host permission."), { code: "REMOTE_PERMISSION" });
  $("#mysqlConnectionStatus").textContent = "Calling the MySQL API health endpoint...";
  const health = await mysqlProvider.testConnection({ baseUrl, token, requestPermission: false });
  $("#mysqlConnectionStatus").textContent = `Connected: ${health.service}, API ${health.apiVersion}, schema ${health.schemaVersion}, MySQL ${health.mysql}.`;
  setStatus("MySQL API connection verified");
  return false;
}

async function saveCloudflareD1SettingsValues(rawBaseUrl, rawToken) {
  const baseUrl = normalizeCloudflareD1ApiBaseUrl(rawBaseUrl);
  const token = String(rawToken || "").trim();
  if (!token) throw Object.assign(new Error("Enter the Cloudflare D1 API token."), { code: ERROR_CODE.CLOUDFLARE_D1_CONFIG_MISSING });
  await mutateSettings([SETTING_KEY.CLOUDFLARE_D1_API_BASE_URL, SETTING_KEY.CLOUDFLARE_D1_API_TOKEN], (settings) => {
    settings.set(SETTING_KEY.CLOUDFLARE_D1_API_BASE_URL, baseUrl);
    settings.set(SETTING_KEY.CLOUDFLARE_D1_API_TOKEN, token);
  });
  return { baseUrl, token };
}

async function saveCloudflareD1Settings() {
  const { baseUrl } = await saveCloudflareD1SettingsValues($("#cloudflareD1ApiBaseUrl").value, $("#cloudflareD1ApiToken").value);
  $("#cloudflareD1ApiBaseUrl").value = baseUrl;
  setStatus("Cloudflare D1 settings saved on this device");
  return false;
}

async function testCloudflareD1Connection() {
  const baseUrl = normalizeCloudflareD1ApiBaseUrl($("#cloudflareD1ApiBaseUrl").value);
  const token = $("#cloudflareD1ApiToken").value.trim();
  if (!token) throw Object.assign(new Error("Enter the Cloudflare D1 API token."), { code: ERROR_CODE.CLOUDFLARE_D1_CONFIG_MISSING });
  const permissionRequest = platform.requestOptionalHostPermission(cloudflareD1HostPermission(baseUrl));
  $("#cloudflareD1ConnectionStatus").textContent = "Requesting the exact Worker host permission...";
  let permissionGranted;
  try {
    permissionGranted = await Promise.race([
      permissionRequest,
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("Firefox did not answer the host permission request."), { code: ERROR_CODE.REMOTE_PERMISSION })), 10_000))
    ]);
  } catch (error) {
    if (error?.code) throw error;
    throw Object.assign(new Error("Firefox could not grant the Worker host permission."), { code: ERROR_CODE.REMOTE_PERMISSION, cause: error });
  }
  if (!permissionGranted) throw Object.assign(new Error("Firefox did not grant the Worker host permission."), { code: ERROR_CODE.REMOTE_PERMISSION });
  $("#cloudflareD1ConnectionStatus").textContent = "Calling the Worker health endpoint...";
  const health = await cloudflareD1Provider.testConnection({ baseUrl, token, requestPermission: false });
  $("#cloudflareD1ConnectionStatus").textContent = `Connected: ${health.service}, API ${health.apiVersion}, schema ${health.schemaVersion}, storage ${health.storage}.`;
  setStatus("Cloudflare D1 connection verified");
  return false;
}

async function migrateStorageClicked() {
  const target = decodeRemoteProviderId($("#remoteBackendTarget").value);
  const active = decodeRemoteProviderId(await getSetting(SETTING_KEY.REMOTE_BACKEND, REMOTE_PROVIDER_ID.GOOGLE_SHEETS));
  if (target === active) throw Object.assign(new Error("Choose a different target backend."), { code: "MIGRATION_SOURCE_UNSAFE" });
  if (globalThis.confirm && !globalThis.confirm("Migration pauses sync and switches this profile only after full verification. Close other devices and stop editing timers now. Continue?")) return false;
  $("#migrationStatus").textContent = "Migration starting...";
  try {
    await migrateStorage(target, {
      interactiveAuth: true,
      onProgress(state) {
        $("#migrationStatus").textContent = `Migration ${state.phase}: ${Number(state.completed_entries || 0)}/${Number(state.total_entries || 0)} entries verified.`;
      }
    });
  } catch (error) {
    const state = await getStorageMigrationState().catch(() => null);
    const diagnostic = error?.message && error.message !== formatError(error)
      ? ` (${error.code || "MIGRATION_FAILED"}: ${error.message})`
      : "";
    $("#migrationStatus").textContent = `${formatError(error)}${diagnostic}`;
    if (state?.phase === "post_switch") await refreshActiveBackendLabel();
    throw error;
  }
  setStatus("Storage migration completed");
  return true;
}

async function activateMysqlFromLocalClicked() {
  const active = decodeRemoteProviderId(await getSetting(SETTING_KEY.REMOTE_BACKEND, REMOTE_PROVIDER_ID.GOOGLE_SHEETS));
  if (active === REMOTE_PROVIDER_ID.MYSQL) throw Object.assign(new Error("MySQL is already the active backend."), { code: "MIGRATION_SOURCE_UNSAFE" });
  if (globalThis.confirm && !globalThis.confirm("This will not read Google Sheets. It will use only this Firefox profile's local data and initialize MySQL. Existing MySQL records that do not match local data will block the switch. Continue?")) return false;
  $("#migrationStatus").textContent = "Starting MySQL from local data...";
  try {
    await activateProviderFromLocal(REMOTE_PROVIDER_ID.MYSQL, {
      onProgress(state) {
        $("#migrationStatus").textContent = `MySQL setup ${state.phase}: ${Number(state.completed_entries || 0)}/${Number(state.total_entries || 0)} entries verified.`;
      }
    });
  } catch (error) {
    const state = await getStorageMigrationState().catch(() => null);
    const diagnostic = error?.message && error.message !== formatError(error)
      ? ` (${error.code || "MYSQL_SETUP_FAILED"}: ${error.message})`
      : "";
    $("#migrationStatus").textContent = `${formatError(error)}${diagnostic}`;
    if (state?.phase === "post_switch") await refreshActiveBackendLabel();
    throw error;
  }
  setStatus("MySQL is now the active storage backend");
  return true;
}

async function activateMysqlFromRemoteClicked() {
  const active = decodeRemoteProviderId(await getSetting(SETTING_KEY.REMOTE_BACKEND, REMOTE_PROVIDER_ID.GOOGLE_SHEETS));
  if (active === REMOTE_PROVIDER_ID.MYSQL) throw Object.assign(new Error("MySQL is already the active backend."), { code: "MIGRATION_SOURCE_UNSAFE" });
  if (globalThis.confirm && !globalThis.confirm("This will not read Google Sheets. It will make the existing MySQL data the active data for this Firefox profile and import it locally. Any conflicting local entries will block the switch. Continue?")) return false;
  $("#migrationStatus").textContent = "Adopting existing MySQL data...";
  try {
    await activateProviderFromRemote(REMOTE_PROVIDER_ID.MYSQL, {
      onProgress(state) {
        $("#migrationStatus").textContent = `MySQL adoption ${state.phase}: ${Number(state.completed_entries || 0)}/${Number(state.total_entries || 0)} entries verified.`;
      }
    });
  } catch (error) {
    const state = await getStorageMigrationState().catch(() => null);
    const diagnostic = error?.message && error.message !== formatError(error)
      ? ` (${error.code || "MYSQL_ADOPTION_FAILED"}: ${error.message})`
      : "";
    $("#migrationStatus").textContent = `${formatError(error)}${diagnostic}`;
    if (state?.phase === "post_switch") await refreshActiveBackendLabel();
    throw error;
  }
  setStatus("Existing MySQL data is now active");
  return true;
}

async function activateCloudflareD1Clicked(source) {
  const active = decodeRemoteProviderId(await getSetting(SETTING_KEY.REMOTE_BACKEND, REMOTE_PROVIDER_ID.GOOGLE_SHEETS));
  if (active === REMOTE_PROVIDER_ID.CLOUDFLARE_D1) throw Object.assign(new Error("Cloudflare D1 is already the active backend."), { code: ERROR_CODE.MIGRATION_SOURCE_UNSAFE });
  const action = source === "remote" ? "adopt the existing D1 data" : "start D1 from this profile's local data";
  if (globalThis.confirm && !globalThis.confirm(`This will ${action} after full verification. The token stays in this Firefox profile. Continue?`)) return false;
  $("#migrationStatus").textContent = source === "remote" ? "Adopting existing D1 data..." : "Starting D1 from local data...";
  await (source === "remote" ? activateProviderFromRemote : activateProviderFromLocal)(REMOTE_PROVIDER_ID.CLOUDFLARE_D1, {
    onProgress(state) {
      $("#migrationStatus").textContent = `Cloudflare D1 setup ${state.phase}: ${Number(state.completed_entries || 0)}/${Number(state.total_entries || 0)} entries verified.`;
    }
  });
  setStatus("Cloudflare D1 is now the active storage backend");
  return true;
}

function renderFirstRun(established) {
  $("#firstRunSetup").hidden = established;
  $("#settingsLayout").hidden = !established;
  if (!established) {
    settingsLayoutWasVisible = false;
    history.replaceState(null, "", "#setup");
    setStatus("Choose a storage backend to begin");
    return;
  }
  // The layout is hidden during first-run setup, so reveal-and-scroll once to
  // honor an initial section hash. Refreshes after saves must not move the
  // user's viewport back to the first section.
  syncSectionNavigation({ scroll: !settingsLayoutWasVisible });
  settingsLayoutWasVisible = true;
}

function selectFirstRunProvider(providerId) {
  const google = providerId === REMOTE_PROVIDER_ID.GOOGLE_SHEETS;
  const mysql = providerId === REMOTE_PROVIDER_ID.MYSQL;
  $("#setupProviderChoices").hidden = true;
  $("#setupGoogle").hidden = !google;
  $("#setupMysql").hidden = !mysql;
  $("#setupCloudflareD1").hidden = providerId !== REMOTE_PROVIDER_ID.CLOUDFLARE_D1;
}

async function setupGoogleClicked() {
  await setOAuthClientCredentials($("#setupGoogleClientId").value, $("#setupGoogleClientSecret").value);
  setStatus("Opening Google sign-in...");
  await signIn({
    onDeviceCode(details) {
      setSetupDeviceAuthPanel(details);
      setStatus("Enter the Google device code, then leave this page open...");
    }
  });
  setSetupDeviceAuthPanel(null);
  setStatus("Signed in. Looking for your spreadsheet...");
  await syncNow({ force: true });
  await markBackendEstablished(REMOTE_PROVIDER_ID.GOOGLE_SHEETS);
  setStatus("Google Sheets is ready");
  return true;
}

async function setupMysqlClicked(source) {
  const { baseUrl } = await saveMysqlSettingsValues($("#setupMysqlApiBaseUrl").value, $("#setupMysqlApiToken").value);
  $("#mysqlApiBaseUrl").value = baseUrl;
  $("#mysqlApiToken").value = $("#setupMysqlApiToken").value.trim();
  $("#migrationStatus").textContent = source === "remote"
    ? "Adopting existing MySQL data..."
    : "Starting MySQL from local data...";
  const activate = source === "remote" ? activateProviderFromRemote : activateProviderFromLocal;
  await activate(REMOTE_PROVIDER_ID.MYSQL, {
    onProgress(state) {
      $("#migrationStatus").textContent = `MySQL setup ${state.phase}: ${Number(state.completed_entries || 0)}/${Number(state.total_entries || 0)} entries verified.`;
    }
  });
  setStatus("MySQL is ready");
  return true;
}

async function setupCloudflareD1Clicked(source) {
  await saveCloudflareD1SettingsValues($("#setupCloudflareD1ApiBaseUrl").value, $("#setupCloudflareD1ApiToken").value);
  $("#cloudflareD1ApiBaseUrl").value = $("#setupCloudflareD1ApiBaseUrl").value.trim();
  $("#cloudflareD1ApiToken").value = $("#setupCloudflareD1ApiToken").value.trim();
  await activateCloudflareD1Clicked(source);
  setStatus("Cloudflare Worker + D1 is ready");
  return true;
}

function renderSpreadsheet(spreadsheetId) {
  const link = $("#spreadsheetLink");
  $("#spreadsheetId").textContent = spreadsheetId || "not set";
  $("#copySpreadsheetId").disabled = !spreadsheetId;

  if (!spreadsheetId) {
    link.textContent = "Not set up yet";
    link.removeAttribute("href");
    return;
  }
  link.textContent = "Open spreadsheet in Google Sheets";
  link.href = spreadsheetUrl(spreadsheetId);
}

async function renderSpreadsheetBackupInfo() {
  const entries = await getAllEntries();
  const liveEntries = entries.filter((entry) => !entry.deleted_at).length;
  const deletedEntries = entries.length - liveEntries;
  const liveText = `${liveEntries} ${liveEntries === 1 ? "entry" : "entries"}`;
  const suffix = deletedEntries
    ? ` and ${deletedEntries} deleted record${deletedEntries === 1 ? "" : "s"}`
    : "";
  $("#spreadsheetBackupInfo").textContent = `Local backup: ${liveText}${suffix}.`;
}

function renderDiagnostics() {
  const latest = diagnostics.at(-1);
  const summary = diagnostics.length
    ? `${diagnostics.length} recovery record${diagnostics.length === 1 ? "" : "s"}. Latest: ${latest.code} during ${latest.phase}.`
    : "No recovery records on this device.";
  $("#diagnosticsSummary").textContent = summary;
  $("#copyDiagnostics").disabled = diagnostics.length === 0;
  $("#exportDiagnostics").disabled = diagnostics.length === 0;
  $("#clearDiagnostics").disabled = diagnostics.length === 0;
}

async function refresh() {
  const config = await getConfig();
  const auth = await getAuthStatus({ config });
  $("#deviceId").textContent = await getDeviceId();
  $("#googleClientId").value = config.GOOGLE_CLIENT_ID || "";
  $("#googleClientSecret").value = config.GOOGLE_CLIENT_SECRET || "";
  $("#setupGoogleClientId").value = config.GOOGLE_CLIENT_ID || "";
  $("#setupGoogleClientSecret").value = config.GOOGLE_CLIENT_SECRET || "";
  const activeBackend = await getSetting(SETTING_KEY.REMOTE_BACKEND, REMOTE_PROVIDER_ID.GOOGLE_SHEETS);
  renderStorage(activeBackend);
  renderMigration(activeBackend, await getStorageMigrationState());
  $("#mysqlApiBaseUrl").value = await getSetting(SETTING_KEY.MYSQL_API_BASE_URL, DEFAULT_MYSQL_API_BASE_URL);
  $("#mysqlApiToken").value = await getSetting(SETTING_KEY.MYSQL_API_TOKEN, "");
  $("#setupMysqlApiBaseUrl").value = $("#mysqlApiBaseUrl").value;
  $("#setupMysqlApiToken").value = $("#mysqlApiToken").value;
  $("#cloudflareD1ApiBaseUrl").value = await getSetting(SETTING_KEY.CLOUDFLARE_D1_API_BASE_URL, DEFAULT_CLOUDFLARE_D1_API_BASE_URL);
  $("#cloudflareD1ApiToken").value = await getSetting(SETTING_KEY.CLOUDFLARE_D1_API_TOKEN, "");
  $("#setupCloudflareD1ApiBaseUrl").value = $("#cloudflareD1ApiBaseUrl").value;
  $("#setupCloudflareD1ApiToken").value = $("#cloudflareD1ApiToken").value;
  renderSpreadsheet(await getSpreadsheetId());
  await renderSpreadsheetBackupInfo();
  diagnostics = await getDiagnostics();
  renderDiagnostics();
  $("#syncInterval").value = String(await getSetting(SETTING_KEY.SYNC_INTERVAL_SECONDS, 60));
  $("#durationMultiplier").value = String(await getSetting(SETTING_KEY.DURATION_MULTIPLIER, 1));
  $("#workdayStartHour").value = String(await getSetting(SETTING_KEY.WORKDAY_START_HOUR, DEFAULT_WORKDAY_START_HOUR));
  $("#tempoApiToken").value = await getSetting(SETTING_KEY.TEMPO_API_TOKEN, "");
  $("#tempoAuthorAccountId").value = await getSetting(SETTING_KEY.TEMPO_AUTHOR_ACCOUNT_ID, "");
  renderTempoMappings(await getSetting(SETTING_KEY.TEMPO_TASK_ISSUE_IDS, {}));

  if (auth.missingClientId) {
    $("#authStatus").textContent = "Google client ID missing";
  } else if (auth.missingClientSecret) {
    $("#authStatus").textContent = "Google client secret missing";
  } else {
    $("#authStatus").textContent = auth.signedIn ? "signed in or refreshable" : "not signed in";
  }
  $("#signInButton").hidden = auth.signedIn;
  $("#signOutButton").hidden = !auth.signedIn;
  const established = await backendIsEstablished();
  renderFirstRun(established);
  if (established) await initializeAuxiliaryPages();
}

async function signInClicked() {
  setStatus("Opening Google sign-in...");
  await signIn({
    onDeviceCode(details) {
      setDeviceAuthPanel(details);
      setStatus("Enter the Google device code, then leave this page open...");
    }
  });
  setDeviceAuthPanel(null);
  // Provisioning lives in the sync cycle, so this both finds or creates the
  // spreadsheet and shows its ID without a separate code path.
  setStatus("Signed in. Looking for your spreadsheet...");
  await syncNow({ force: true });
  if (decodeRemoteProviderId(await getSetting(SETTING_KEY.REMOTE_BACKEND, REMOTE_PROVIDER_ID.GOOGLE_SHEETS)) === REMOTE_PROVIDER_ID.GOOGLE_SHEETS) {
    await markBackendEstablished(REMOTE_PROVIDER_ID.GOOGLE_SHEETS);
  }
  if (await getSpreadsheetId()) setStatus("Signed in and spreadsheet ready");
}

async function signOutClicked() {
  await signOut();
  setStatus("Signed out");
}

async function copySpreadsheetIdClicked() {
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) return;
  try {
    await navigator.clipboard.writeText(spreadsheetId);
    setStatus("Spreadsheet ID copied to the clipboard");
  } catch (error) {
    setStatus(`Could not copy: ${formatError(error)}`);
  }
}

async function reconnectSpreadsheetClicked() {
  setStatus("Reconnecting to the current spreadsheet...");
  await syncNow({ force: true, interactiveAuth: true });
  setStatus("Connected to the current spreadsheet");
}

async function connectSpreadsheetClicked() {
  const spreadsheetId = $("#replacementSpreadsheetId").value.trim();
  if (!spreadsheetId) {
    setStatus("Enter the spreadsheet ID to connect it");
    return false;
  }
  if (!window.confirm("Connect this spreadsheet and sync the local backup to it? Its time_entries header must match this extension exactly.")) {
    return false;
  }

  setStatus("Checking the selected spreadsheet...");
  await adoptSpreadsheet(spreadsheetId, { interactiveAuth: true });
  setStatus("Connecting the selected spreadsheet and syncing local entries...");
  await syncNow({ force: true, interactiveAuth: true });
  $("#replacementSpreadsheetId").value = "";
  setStatus("Connected and synchronized the selected spreadsheet");
}

async function createReplacementSpreadsheetClicked() {
  const currentId = await getSpreadsheetId();
  const message = currentId
    ? "Create a new spreadsheet and sync the local backup to it? This changes the selected spreadsheet, but does not delete the current spreadsheet or any local entries."
    : "Create a new spreadsheet and sync the local backup to it?";
  if (!window.confirm(message)) return false;

  setStatus("Creating a replacement spreadsheet...");
  await createReplacementSpreadsheet({ interactiveAuth: true });
  setStatus("Syncing the local backup to the replacement spreadsheet...");
  await syncNow({ force: true, interactiveAuth: true });
  setStatus("Replacement spreadsheet created and synchronized");
}

async function copyDiagnosticsClicked() {
  if (!diagnostics.length) return;
  try {
    await navigator.clipboard.writeText(diagnosticsText(diagnostics));
    setStatus("Diagnostics copied to the clipboard");
  } catch (error) {
    setStatus(`Could not copy diagnostics: ${formatError(error)}`);
  }
}

function exportDiagnosticsClicked() {
  if (!diagnostics.length) return;
  const blob = new Blob([`${diagnosticsText(diagnostics)}\n`], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "personal-time-logger-diagnostics.txt";
  link.click();
  URL.revokeObjectURL(url);
  setStatus("Diagnostics download started");
}

async function clearDiagnosticsClicked() {
  await clearDiagnostics();
  diagnostics = [];
  renderDiagnostics();
  setStatus("Diagnostics cleared");
}

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;
  bindThemeControls({
    themeSelect: $("#themeSelect"),
    contrastToggle: $("#highContrast"),
    onChange(preferences) {
      renderThemeSelection(preferences);
      setStatus(`${THEME_OPTIONS.find(({ id }) => id === preferences.theme)?.label || "Theme"}${preferences.highContrast ? " · High contrast" : ""} applied`);
    }
  });
  renderThemeSelection({
    theme: $("#themeSelect").value,
    highContrast: $("#highContrast").checked
  });
  $("#saveSettings").addEventListener("click", (event) => runOptionsAction("save-settings", saveSettings, event.currentTarget));
  $("#copySpreadsheetId").addEventListener("click", copySpreadsheetIdClicked);
  $("#reconnectSpreadsheet").addEventListener("click", (event) => runOptionsAction("reconnect-spreadsheet", reconnectSpreadsheetClicked, event.currentTarget));
  $("#connectSpreadsheet").addEventListener("click", (event) => runOptionsAction("connect-spreadsheet", connectSpreadsheetClicked, event.currentTarget));
  $("#createReplacementSpreadsheet").addEventListener("click", (event) => runOptionsAction("create-replacement-spreadsheet", createReplacementSpreadsheetClicked, event.currentTarget));
  $("#copyDiagnostics").addEventListener("click", copyDiagnosticsClicked);
  $("#exportDiagnostics").addEventListener("click", exportDiagnosticsClicked);
  $("#clearDiagnostics").addEventListener("click", (event) => runOptionsAction("clear-diagnostics", clearDiagnosticsClicked, event.currentTarget));
  $("#exportBackup").addEventListener("click", (event) => runOptionsAction("export-backup", exportBackupClicked, event.currentTarget));
  $("#chooseBackupFile").addEventListener("click", () => $("#importBackupFile").click());
  $("#importBackupFile").addEventListener("change", (event) => {
    const input = event.currentTarget;
    void runOptionsAction("import-backup", () => importBackupClicked(input.files?.[0]))
      .finally(() => { input.value = ""; });
  });
  $("#addTempoMapping").addEventListener("click", () => {
    const row = createTempoMappingRow();
    $("#tempoMappings").append(row);
    updateTempoMappingsEmptyState();
    row.querySelector(".tempo-task").focus();
  });
  $("#saveTempoSettings").addEventListener("click", (event) => runOptionsAction("save-tempo-settings", saveTempoSettings, event.currentTarget));

  $("#saveGoogleCredentials").addEventListener("click", (event) => runOptionsAction("save-google-credentials", saveGoogleCredentials, event.currentTarget));
  $("#signInButton").addEventListener("click", (event) => runOptionsAction("google-sign-in", signInClicked, event.currentTarget));
  $("#signOutButton").addEventListener("click", (event) => runOptionsAction("google-sign-out", signOutClicked, event.currentTarget));
  $("#remoteBackendTarget").addEventListener("change", () => {
    void renderStorageTarget();
  });
  $("#remoteBackendTarget").addEventListener("change", async () => renderMigration(
    await getSetting(SETTING_KEY.REMOTE_BACKEND, REMOTE_PROVIDER_ID.GOOGLE_SHEETS),
    await getStorageMigrationState()
  ));
  $("#saveMysqlSettings").addEventListener("click", (event) => runOptionsAction("save-mysql-settings", saveMysqlSettings, event.currentTarget, { refreshOnError: false }));
  $("#testMysqlConnection").addEventListener("click", (event) => runOptionsAction("test-mysql-connection", testMysqlConnection, event.currentTarget, { refreshOnError: false }));
  $("#saveCloudflareD1Settings").addEventListener("click", (event) => runOptionsAction("save-cloudflare-d1-settings", saveCloudflareD1Settings, event.currentTarget, { refreshOnError: false }));
  $("#testCloudflareD1Connection").addEventListener("click", (event) => runOptionsAction("test-cloudflare-d1-connection", testCloudflareD1Connection, event.currentTarget, { refreshOnError: false }));
  $("#migrateStorage").addEventListener("click", (event) => runOptionsAction("migrate-storage", migrateStorageClicked, event.currentTarget, { refreshOnError: false }));
  $("#activateMysqlFromLocal").addEventListener("click", (event) => runOptionsAction("activate-mysql-from-local", activateMysqlFromLocalClicked, event.currentTarget, { refreshOnError: false }));
  $("#activateMysqlFromRemote").addEventListener("click", (event) => runOptionsAction("activate-mysql-from-remote", activateMysqlFromRemoteClicked, event.currentTarget, { refreshOnError: false }));
  $("#activateCloudflareD1FromLocal").addEventListener("click", (event) => runOptionsAction("activate-cloudflare-d1-from-local", () => activateCloudflareD1Clicked("local"), event.currentTarget, { refreshOnError: false }));
  $("#activateCloudflareD1FromRemote").addEventListener("click", (event) => runOptionsAction("activate-cloudflare-d1-from-remote", () => activateCloudflareD1Clicked("remote"), event.currentTarget, { refreshOnError: false }));
  $("#chooseGoogleSetup").addEventListener("click", () => selectFirstRunProvider(REMOTE_PROVIDER_ID.GOOGLE_SHEETS));
  $("#chooseMysqlSetup").addEventListener("click", () => selectFirstRunProvider(REMOTE_PROVIDER_ID.MYSQL));
  $("#chooseCloudflareD1Setup").addEventListener("click", () => selectFirstRunProvider(REMOTE_PROVIDER_ID.CLOUDFLARE_D1));
  $("#setupGoogleBack").addEventListener("click", () => {
    setSetupDeviceAuthPanel(null);
    $("#setupProviderChoices").hidden = false;
    $("#setupGoogle").hidden = true;
  });
  $("#setupMysqlBack").addEventListener("click", () => {
    $("#setupProviderChoices").hidden = false;
    $("#setupMysql").hidden = true;
  });
  $("#setupGoogleButton").addEventListener("click", (event) => runOptionsAction("setup-google", setupGoogleClicked, event.currentTarget, { refreshOnError: false }));
  $("#setupMysqlExistingButton").addEventListener("click", (event) => runOptionsAction("setup-mysql-existing", () => setupMysqlClicked("remote"), event.currentTarget, { refreshOnError: false }));
  $("#setupMysqlLocalButton").addEventListener("click", (event) => runOptionsAction("setup-mysql-local", () => setupMysqlClicked("local"), event.currentTarget, { refreshOnError: false }));
  $("#setupCloudflareD1Back").addEventListener("click", () => {
    $("#setupProviderChoices").hidden = false;
    $("#setupCloudflareD1").hidden = true;
  });
  $("#setupCloudflareD1ExistingButton").addEventListener("click", (event) => runOptionsAction("setup-cloudflare-d1-existing", () => setupCloudflareD1Clicked("remote"), event.currentTarget, { refreshOnError: false }));
  $("#setupCloudflareD1LocalButton").addEventListener("click", (event) => runOptionsAction("setup-cloudflare-d1-local", () => setupCloudflareD1Clicked("local"), event.currentTarget, { refreshOnError: false }));

  window.addEventListener("focus", () => {
    void refreshActiveBackendLabel().catch(() => {});
  });

}

async function init() {
  bindEvents();
  bindSectionNavigation();
  await refresh();
  if (await backendIsEstablished()) setStatus("Ready");
}

startPage({ page: "options", title: "Options", init });

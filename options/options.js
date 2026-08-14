import { getAllEntries, getSetting, mutateSettings } from "../src/db.js";
import { runAction } from "../src/action-runner.js";
import { getDeviceId } from "../src/entries.js";
import { getAuthStatus, signIn, signOut } from "../src/auth.js";
import { getConfig, setOAuthClientCredentials } from "../src/config-loader.js";
import { clearDiagnostics, diagnosticsText, getDiagnostics } from "../src/diagnostics.js";
import { NEXT_DUE_KEY, scheduleSyncHeartbeat } from "../src/background-schedule.js";
import {
  adoptSpreadsheet,
  createReplacementSpreadsheet,
  spreadsheetUrl
} from "../src/sheets.js";
import { syncNow } from "../src/sync.js";
import { runPageTask, startPage } from "../src/page-runtime.js";
import { SETTING_KEY } from "../src/setting-keys.js";
import { $, formatError } from "../src/ui-helpers.js";
import { nowIso } from "../src/time.js";
import { normalizeTempoIssueId, normalizeTempoTaskIssueIds } from "../src/tempo.js";
import { initReconcilePage } from "../reconcile/reconcile.js";
import { initUsagePage } from "../usage/usage.js";
import {
  DEFAULT_WORKDAY_START_HOUR,
  normalizeOptionsSettings,
  normalizeWorkdayStartHour,
  planOptionsSettingsSave
} from "../src/options-settings.js";

let diagnostics = [];
let eventsBound = false;

function bindSectionNavigation() {
  const links = [...document.querySelectorAll(".section-nav a[href^='#']")];
  const setActive = (id) => {
    for (const link of links) link.classList.toggle("active", link.hash === `#${id}`);
  };
  for (const link of links) {
    link.addEventListener("click", () => setActive(link.hash.slice(1)));
  }
  const initialId = window.location.hash.slice(1) || links[0]?.hash.slice(1);
  if (initialId) setActive(initialId);
  window.addEventListener("hashchange", () => setActive(window.location.hash.slice(1)));
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
  $("#statusLine").textContent = message;
}

function runOptionsAction(key, action, button) {
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
  await refresh();
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
  const auth = await getAuthStatus();
  $("#deviceId").textContent = await getDeviceId();
  $("#googleClientId").value = config.GOOGLE_CLIENT_ID || "";
  $("#googleClientSecret").value = config.GOOGLE_CLIENT_SECRET || "";
  renderSpreadsheet(await getSetting(SETTING_KEY.SPREADSHEET_ID, ""));
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
}

async function signInClicked() {
  const button = $("#signInButton");
  try {
    setStatus("Opening Google sign-in...");
    button.disabled = true;
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
    await syncNow({ force: true }).catch((error) => {
      setStatus(formatError(error));
    });
    if (await getSetting(SETTING_KEY.SPREADSHEET_ID, "")) setStatus("Signed in and spreadsheet ready");
  } catch (error) {
    setStatus(formatError(error));
  } finally {
    button.disabled = false;
  }
  await refresh();
}

async function signOutClicked() {
  await signOut();
  setStatus("Signed out");
  await refresh();
}

async function copySpreadsheetIdClicked() {
  const spreadsheetId = await getSetting(SETTING_KEY.SPREADSHEET_ID, "");
  if (!spreadsheetId) return;
  try {
    await navigator.clipboard.writeText(spreadsheetId);
    setStatus("Spreadsheet ID copied to the clipboard");
  } catch (error) {
    setStatus(`Could not copy: ${formatError(error)}`);
  }
}

async function reconnectSpreadsheetClicked() {
  const button = $("#reconnectSpreadsheet");
  button.disabled = true;
  try {
    setStatus("Reconnecting to the current spreadsheet...");
    await syncNow({ force: true, interactiveAuth: true });
    setStatus("Connected to the current spreadsheet");
  } catch (error) {
    setStatus(`Could not reconnect: ${formatError(error)}`);
  } finally {
    button.disabled = false;
    await refresh();
  }
}

async function connectSpreadsheetClicked() {
  const button = $("#connectSpreadsheet");
  const spreadsheetId = $("#replacementSpreadsheetId").value.trim();
  if (!spreadsheetId) {
    setStatus("Enter the spreadsheet ID to connect it");
    return;
  }
  if (!window.confirm("Connect this spreadsheet and sync the local backup to it? Its time_entries header must match this extension exactly.")) {
    return;
  }

  button.disabled = true;
  try {
    setStatus("Checking the selected spreadsheet...");
    await adoptSpreadsheet(spreadsheetId, { interactiveAuth: true });
    setStatus("Connecting the selected spreadsheet and syncing local entries...");
    await syncNow({ force: true, interactiveAuth: true });
    $("#replacementSpreadsheetId").value = "";
    setStatus("Connected and synchronized the selected spreadsheet");
  } catch (error) {
    setStatus(`Could not connect the spreadsheet: ${formatError(error)}`);
  } finally {
    button.disabled = false;
    await refresh();
  }
}

async function createReplacementSpreadsheetClicked() {
  const button = $("#createReplacementSpreadsheet");
  const currentId = await getSetting(SETTING_KEY.SPREADSHEET_ID, "");
  const message = currentId
    ? "Create a new spreadsheet and sync the local backup to it? This changes the selected spreadsheet, but does not delete the current spreadsheet or any local entries."
    : "Create a new spreadsheet and sync the local backup to it?";
  if (!window.confirm(message)) return;

  button.disabled = true;
  try {
    setStatus("Creating a replacement spreadsheet...");
    await createReplacementSpreadsheet({ interactiveAuth: true });
    setStatus("Syncing the local backup to the replacement spreadsheet...");
    await syncNow({ force: true, interactiveAuth: true });
    setStatus("Replacement spreadsheet created and synchronized");
  } catch (error) {
    setStatus(`Could not create a replacement: ${formatError(error)}`);
  } finally {
    button.disabled = false;
    await refresh();
  }
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
  $("#saveSettings").addEventListener("click", (event) => runOptionsAction("save-settings", saveSettings, event.currentTarget));
  $("#copySpreadsheetId").addEventListener("click", copySpreadsheetIdClicked);
  $("#reconnectSpreadsheet").addEventListener("click", (event) => runOptionsAction("reconnect-spreadsheet", reconnectSpreadsheetClicked, event.currentTarget));
  $("#connectSpreadsheet").addEventListener("click", (event) => runOptionsAction("connect-spreadsheet", connectSpreadsheetClicked, event.currentTarget));
  $("#createReplacementSpreadsheet").addEventListener("click", (event) => runOptionsAction("create-replacement-spreadsheet", createReplacementSpreadsheetClicked, event.currentTarget));
  $("#copyDiagnostics").addEventListener("click", copyDiagnosticsClicked);
  $("#exportDiagnostics").addEventListener("click", exportDiagnosticsClicked);
  $("#clearDiagnostics").addEventListener("click", (event) => runOptionsAction("clear-diagnostics", clearDiagnosticsClicked, event.currentTarget));
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

}

async function init() {
  bindEvents();
  bindSectionNavigation();
  await refresh();
  await Promise.all([initUsagePage(), initReconcilePage()]);
  setStatus("Ready");
}

startPage({ page: "options", title: "Options", init });

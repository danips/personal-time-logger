import { getAllEntries, getSetting, mutateSettings } from "../src/db.js";
import { runAction } from "../src/action-runner.js";
import { getDeviceId, normalizeMultiplierText } from "../src/entries.js";
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
import { $, formatError } from "../src/ui-helpers.js";
import { nowIso } from "../src/time.js";

let diagnostics = [];

function setStatus(message) {
  $("#statusLine").textContent = message;
}

function runOptionsAction(key, action, button) {
  return runAction(key, action, {
    setBusy(next) {
      if (button) button.disabled = next;
    },
    onError(error) {
      setStatus(formatError(error));
    },
    onFinally() {
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
  const interval = Math.max(30, Number($("#syncInterval").value) || 60);
  const multiplier = normalizeMultiplierText($("#durationMultiplier").value) || "1";
  const multiplierUpdatedAt = nowIso();
  await mutateSettings([
    "sync_interval_seconds",
    "duration_multiplier",
    "duration_multiplier_updated_at",
    NEXT_DUE_KEY
  ], (settings) => {
    settings.set("sync_interval_seconds", interval);
    settings.set("duration_multiplier", multiplier);
    settings.set("duration_multiplier_updated_at", multiplierUpdatedAt);
    // Discard the old long-interval due time before replacing the alarm.
    settings.set(NEXT_DUE_KEY, 0);
  });
  $("#syncInterval").value = String(interval);
  $("#durationMultiplier").value = String(multiplier);
  try {
    if (!scheduleSyncHeartbeat(interval)) throw new Error("Browser alarms are unavailable");
    setStatus("Settings saved and sync schedule reset");
  } catch (error) {
    setStatus(`Settings saved, but could not reset the schedule: ${formatError(error)}`);
  }
  syncNow({ force: true }).catch(() => {});
  await refresh();
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
  renderSpreadsheet(await getSetting("spreadsheet_id", ""));
  await renderSpreadsheetBackupInfo();
  diagnostics = await getDiagnostics();
  renderDiagnostics();
  $("#syncInterval").value = String(await getSetting("sync_interval_seconds", 60));
  $("#durationMultiplier").value = String(await getSetting("duration_multiplier", 1));

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
    if (await getSetting("spreadsheet_id", "")) setStatus("Signed in and spreadsheet ready");
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
  const spreadsheetId = await getSetting("spreadsheet_id", "");
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
  const currentId = await getSetting("spreadsheet_id", "");
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
  $("#saveSettings").addEventListener("click", (event) => runOptionsAction("save-settings", saveSettings, event.currentTarget));
  $("#copySpreadsheetId").addEventListener("click", copySpreadsheetIdClicked);
  $("#reconnectSpreadsheet").addEventListener("click", (event) => runOptionsAction("reconnect-spreadsheet", reconnectSpreadsheetClicked, event.currentTarget));
  $("#connectSpreadsheet").addEventListener("click", (event) => runOptionsAction("connect-spreadsheet", connectSpreadsheetClicked, event.currentTarget));
  $("#createReplacementSpreadsheet").addEventListener("click", (event) => runOptionsAction("create-replacement-spreadsheet", createReplacementSpreadsheetClicked, event.currentTarget));
  $("#copyDiagnostics").addEventListener("click", copyDiagnosticsClicked);
  $("#exportDiagnostics").addEventListener("click", exportDiagnosticsClicked);
  $("#clearDiagnostics").addEventListener("click", (event) => runOptionsAction("clear-diagnostics", clearDiagnosticsClicked, event.currentTarget));

  $("#saveGoogleCredentials").addEventListener("click", (event) => runOptionsAction("save-google-credentials", saveGoogleCredentials, event.currentTarget));
  $("#signInButton").addEventListener("click", (event) => runOptionsAction("google-sign-in", signInClicked, event.currentTarget));
  $("#signOutButton").addEventListener("click", (event) => runOptionsAction("google-sign-out", signOutClicked, event.currentTarget));

}

async function init() {
  bindEvents();
  await refresh();
  setStatus("Ready");
}

init();

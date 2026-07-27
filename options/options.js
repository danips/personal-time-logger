import { getSetting, setSetting } from "../src/db.js";
import { getDeviceId, normalizeMultiplierText } from "../src/entries.js";
import { getAuthStatus, signIn, signOut } from "../src/auth.js";
import { getConfig } from "../src/config-loader.js";
import { copyToOwnedSpreadsheet, createOrInitializeSpreadsheet, setSpreadsheetId } from "../src/sheets.js";
import { clearRemoteReadMarker, syncNow } from "../src/sync.js";
import { $, formatError } from "../src/ui-helpers.js";
import { nowIso } from "../src/time.js";

function setStatus(message) {
  $("#statusLine").textContent = message;
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
  const spreadsheetId = $("#spreadsheetId").value.trim();
  const interval = Math.max(30, Number($("#syncInterval").value) || 60);
  const multiplier = normalizeMultiplierText($("#durationMultiplier").value) || "1";
  await setSpreadsheetId(spreadsheetId);
  await setSetting("sync_interval_seconds", interval);
  const multiplierUpdatedAt = nowIso();
  await setSetting("duration_multiplier", multiplier);
  await setSetting("duration_multiplier_updated_at", multiplierUpdatedAt);
  $("#syncInterval").value = String(interval);
  $("#durationMultiplier").value = String(multiplier);
  setStatus("Settings saved");
  syncNow({ force: true }).catch(() => {});
  await refresh();
}

async function saveGoogleCredentials() {
  const previousConfig = await getConfig();
  const clientId = $("#googleClientId").value.trim();
  const clientSecret = $("#googleClientSecret").value.trim();

  await setSetting("google_oauth_client_id", clientId);
  await setSetting("google_oauth_client_secret", clientSecret);

  if (
    clientId !== previousConfig.GOOGLE_CLIENT_ID
    || clientSecret !== previousConfig.GOOGLE_CLIENT_SECRET
  ) {
    await signOut();
  }

  setStatus("Google credentials saved on this device");
  await refresh();
}

async function refresh() {
  const config = await getConfig();
  const auth = await getAuthStatus();
  $("#deviceId").textContent = await getDeviceId();
  $("#googleClientId").value = config.GOOGLE_CLIENT_ID || "";
  $("#googleClientSecret").value = config.GOOGLE_CLIENT_SECRET || "";
  $("#spreadsheetId").value = await getSetting("spreadsheet_id", "");
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
    setStatus("Signed in");
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

async function initializeClicked() {
  try {
    await saveSettings();
    setStatus("Initializing spreadsheet...");
    const result = await createOrInitializeSpreadsheet({ interactiveAuth: true });
    $("#spreadsheetId").value = result.spreadsheetId;
    setStatus("Spreadsheet initialized");
  } catch (error) {
    setStatus(formatError(error));
  }
  await refresh();
}

async function copyToOwnedSheetClicked() {
  const button = $("#copyToOwnedSheet");
  const confirmed = confirm(
    "Create a new spreadsheet owned by this extension, copy every row into it, and switch to it?\n\n"
    + "The current spreadsheet is left untouched as a backup, and its ID is shown when the copy finishes. "
    + "The new spreadsheet has a different URL."
  );
  if (!confirmed) return;

  try {
    button.disabled = true;
    setStatus("Copying to a new spreadsheet...");
    const result = await copyToOwnedSpreadsheet({ interactiveAuth: true });
    $("#spreadsheetId").value = result.spreadsheetId;
    // The new file has its own modification history, so the skip-read marker
    // from the old one must not be trusted.
    await clearRemoteReadMarker();
    setStatus(`Copied ${result.rowCount} entry rows. Now using ${result.spreadsheetId}. Backup: ${result.previousSpreadsheetId}`);
    syncNow({ force: true }).catch(() => {});
  } catch (error) {
    setStatus(formatError(error));
  } finally {
    button.disabled = false;
  }
  await refresh();
}

function bindEvents() {
  $("#saveSettings").addEventListener("click", saveSettings);
  $("#copyToOwnedSheet").addEventListener("click", copyToOwnedSheetClicked);
  $("#saveGoogleCredentials").addEventListener("click", saveGoogleCredentials);
  $("#signInButton").addEventListener("click", signInClicked);
  $("#signOutButton").addEventListener("click", signOutClicked);
  $("#initSheet").addEventListener("click", initializeClicked);
}

async function init() {
  bindEvents();
  await refresh();
  setStatus("Ready");
}

init();

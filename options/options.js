import { getSetting, setSetting } from "../src/db.js";
import { getDeviceId, normalizeMultiplierText } from "../src/entries.js";
import { getAuthStatus, signIn, signOut } from "../src/auth.js";
import { getConfig, setOAuthClientCredentials } from "../src/config-loader.js";
import { spreadsheetUrl } from "../src/sheets.js";
import { syncNow } from "../src/sync.js";
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
  const interval = Math.max(30, Number($("#syncInterval").value) || 60);
  const multiplier = normalizeMultiplierText($("#durationMultiplier").value) || "1";
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

  await setOAuthClientCredentials(clientId, clientSecret);

  if (
    clientId !== previousConfig.GOOGLE_CLIENT_ID
    || clientSecret !== previousConfig.GOOGLE_CLIENT_SECRET
  ) {
    await signOut();
  }

  setStatus("Google credentials saved to Firefox Sync");
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

async function refresh() {
  const config = await getConfig();
  const auth = await getAuthStatus();
  $("#deviceId").textContent = await getDeviceId();
  $("#googleClientId").value = config.GOOGLE_CLIENT_ID || "";
  $("#googleClientSecret").value = config.GOOGLE_CLIENT_SECRET || "";
  renderSpreadsheet(await getSetting("spreadsheet_id", ""));
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

function bindEvents() {
  $("#saveSettings").addEventListener("click", saveSettings);
  $("#copySpreadsheetId").addEventListener("click", copySpreadsheetIdClicked);

  $("#saveGoogleCredentials").addEventListener("click", saveGoogleCredentials);
  $("#signInButton").addEventListener("click", signInClicked);
  $("#signOutButton").addEventListener("click", signOutClicked);

}

async function init() {
  bindEvents();
  await refresh();
  setStatus("Ready");
}

init();

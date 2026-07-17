import { getSetting, setSetting } from "../src/db.js";
import { getDeviceId, normalizeMultiplierText } from "../src/entries.js";
import { getAuthStatus, signIn, signOut } from "../src/auth.js";
import { getConfig, resetConfigCache } from "../src/config-loader.js";
import { createOrInitializeSpreadsheet, setSpreadsheetId, testConnection } from "../src/sheets.js";
import { $, formatError } from "../src/ui-helpers.js";

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
  await setSetting("duration_multiplier", multiplier);
  $("#syncInterval").value = String(interval);
  $("#durationMultiplier").value = String(multiplier);
  setStatus("Settings saved");
}

async function saveGoogleCredentials() {
  const previousConfig = await getConfig();
  const clientId = $("#googleClientId").value.trim();
  const clientSecret = $("#googleClientSecret").value.trim();

  await setSetting("google_oauth_client_id", clientId);
  await setSetting("google_oauth_client_secret", clientSecret);
  resetConfigCache();

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
  $("#oauthClientId").textContent = auth.clientId || "(missing)";
  $("#spreadsheetId").value = await getSetting("spreadsheet_id", "");
  $("#syncInterval").value = String(await getSetting("sync_interval_seconds", 60));
  $("#durationMultiplier").value = String(await getSetting("duration_multiplier", 1));

  if (config.USE_MOCK_SHEETS) {
    $("#authStatus").textContent = "mock mode, no Google sign-in required";
  } else if (auth.missingClientId) {
    $("#authStatus").textContent = "Google client ID missing";
  } else if (auth.missingClientSecret) {
    $("#authStatus").textContent = "Google client secret missing";
  } else {
    $("#authStatus").textContent = auth.signedIn ? "signed in or refreshable" : "not signed in";
  }
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

async function copyClientId() {
  const clientId = $("#oauthClientId").textContent.trim();
  if (!clientId || clientId === "(missing)") return;
  await navigator.clipboard.writeText(clientId);
  setStatus("OAuth client ID copied");
}

async function copyOAuthSetup() {
  const clientId = $("#oauthClientId").textContent.trim();
  const text = [
    "Time Logger OAuth setup",
    "OAuth client type: TVs and Limited Input devices",
    `OAuth client ID: ${clientId}`,
    "",
    "Device authorization does not use redirect URIs or JavaScript origins."
  ].join("\n");
  await navigator.clipboard.writeText(text);
  setStatus("OAuth setup copied");
}

async function initializeClicked() {
  try {
    await saveSettings();
    setStatus("Initializing spreadsheet...");
    const result = await createOrInitializeSpreadsheet({ interactiveAuth: true });
    $("#spreadsheetId").value = result.spreadsheetId;
    setStatus(result.mock ? "Mock spreadsheet initialized" : "Spreadsheet initialized");
  } catch (error) {
    setStatus(formatError(error));
  }
  await refresh();
}

async function testClicked() {
  try {
    await saveSettings();
    setStatus("Testing connection...");
    await testConnection({ interactiveAuth: true });
    setStatus("Connection OK");
  } catch (error) {
    setStatus(formatError(error));
  }
  await refresh();
}

function bindEvents() {
  $("#saveSettings").addEventListener("click", saveSettings);
  $("#saveGoogleCredentials").addEventListener("click", saveGoogleCredentials);
  $("#signInButton").addEventListener("click", signInClicked);
  $("#signOutButton").addEventListener("click", signOutClicked);
  $("#copyClientId").addEventListener("click", copyClientId);
  $("#copyOAuthSetup").addEventListener("click", copyOAuthSetup);
  $("#initSheet").addEventListener("click", initializeClicked);
  $("#testConnection").addEventListener("click", testClicked);
}

async function init() {
  bindEvents();
  await refresh();
  setStatus("Ready");
}

init();

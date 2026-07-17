import { getSetting, removeSetting, setSetting } from "./db.js";
import { getConfig } from "./config-loader.js";

const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_KEY = "token_data";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function formRequest(url, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString()
  });

  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function tokenRequest(params) {
  const { response, data } = await formRequest(TOKEN_URL, params);

  if (!response.ok) {
    const detail = [data.error, data.error_description].filter(Boolean).join(": ");
    throw codedError("AUTH_FAILED", detail || `Google token request failed with HTTP ${response.status}`);
  }

  return data;
}

async function deviceCodeRequest(config) {
  const { response, data } = await formRequest(DEVICE_CODE_URL, {
    client_id: config.GOOGLE_CLIENT_ID,
    scope: config.GOOGLE_SCOPES.join(" ")
  });

  if (!response.ok) {
    const detail = [data.error, data.error_description, data.error_code].filter(Boolean).join(": ");
    throw codedError("AUTH_FAILED", detail || `Google device code request failed with HTTP ${response.status}`);
  }

  return data;
}

async function deviceTokenPollRequest(config, deviceCode) {
  const params = {
    client_id: config.GOOGLE_CLIENT_ID,
    client_secret: config.GOOGLE_CLIENT_SECRET,
    device_code: deviceCode,
    grant_type: DEVICE_GRANT_TYPE
  };
  return formRequest(TOKEN_URL, params);
}

function tokenRefreshParams(config, refreshToken) {
  const params = {
    client_id: config.GOOGLE_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken
  };
  if (config.GOOGLE_CLIENT_SECRET) params.client_secret = config.GOOGLE_CLIENT_SECRET;
  return params;
}

function authConfigError(config) {
  if (!config.GOOGLE_CLIENT_ID) return codedError("CONFIG_MISSING", "Set the Google OAuth client ID in Options");
  if (!config.GOOGLE_CLIENT_SECRET) return codedError("CONFIG_MISSING", "Set the Google OAuth client secret in Options");
  return null;
}

function tokenError(data, fallbackStatus) {
  const detail = [data.error, data.error_description].filter(Boolean).join(": ");
  return detail || `Google token request failed with HTTP ${fallbackStatus}`;
}

async function pollForDeviceToken(config, deviceCodeData) {
  const expiresAt = Date.now() + Number(deviceCodeData.expires_in || 1800) * 1000;
  let intervalMs = Math.max(5, Number(deviceCodeData.interval || 5)) * 1000;

  while (Date.now() < expiresAt) {
    await sleep(intervalMs);
    const { response, data } = await deviceTokenPollRequest(config, deviceCodeData.device_code);

    if (response.ok) return data;

    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (data.error === "access_denied") {
      throw codedError("AUTH_FAILED", "Google sign-in was denied");
    }
    if (data.error === "expired_token") {
      throw codedError("AUTH_EXPIRED", "Google device code expired. Start sign-in again.");
    }

    throw codedError("AUTH_FAILED", tokenError(data, response.status));
  }

  throw codedError("AUTH_EXPIRED", "Google device code expired. Start sign-in again.");
}

function withExpiry(tokenData) {
  const expiresIn = Number(tokenData.expires_in || 3600);
  return {
    ...tokenData,
    expires_at: Date.now() + Math.max(60, expiresIn - 60) * 1000
  };
}

function isUsable(tokenData) {
  return Boolean(tokenData && tokenData.access_token && tokenData.expires_at > Date.now());
}

async function getTokenData() {
  return getSetting(TOKEN_KEY);
}

async function saveTokenData(tokenData) {
  await setSetting(TOKEN_KEY, tokenData);
  return tokenData;
}

export async function getAuthStatus() {
  const config = await getConfig();
  const tokenData = await getTokenData();

  if (config.USE_MOCK_SHEETS) {
    return {
      signedIn: true,
      mock: true,
      clientId: config.GOOGLE_CLIENT_ID || "",
      hasClientSecret: Boolean(config.GOOGLE_CLIENT_SECRET),
      message: "mock mode"
    };
  }

  if (!config.configLoaded || !config.GOOGLE_CLIENT_ID) {
    return {
      signedIn: false,
      mock: false,
      clientId: config.GOOGLE_CLIENT_ID || "",
      hasClientSecret: Boolean(config.GOOGLE_CLIENT_SECRET),
      missingClientId: true,
      message: "Google client ID missing"
    };
  }

  return {
    signedIn: isUsable(tokenData) || Boolean(tokenData && tokenData.refresh_token),
    mock: false,
    clientId: config.GOOGLE_CLIENT_ID || "",
    hasClientSecret: Boolean(config.GOOGLE_CLIENT_SECRET),
    missingClientSecret: !config.GOOGLE_CLIENT_SECRET,
    expiresAt: tokenData ? tokenData.expires_at : null,
    message: tokenData ? "token stored" : "not signed in"
  };
}

export async function signIn({ onDeviceCode } = {}) {
  const config = await getConfig();
  if (config.USE_MOCK_SHEETS) return { access_token: "mock", expires_at: Date.now() + 3600000 };
  const configError = authConfigError(config);
  if (configError) throw configError;

  return signInDevice(config, { onDeviceCode });
}

async function signInDevice(config, { onDeviceCode } = {}) {
  const deviceCodeData = await deviceCodeRequest(config);
  if (!deviceCodeData.device_code || !deviceCodeData.user_code || !deviceCodeData.verification_url) {
    throw codedError("AUTH_FAILED", "Google device code response was missing required fields");
  }

  if (onDeviceCode) onDeviceCode(deviceCodeData);

  const tokenData = await pollForDeviceToken(config, deviceCodeData);
  return saveTokenData(withExpiry({
    ...tokenData,
    flow: "device"
  }));
}

export async function refreshToken() {
  const config = await getConfig();
  const tokenData = await getTokenData();
  if (config.USE_MOCK_SHEETS) return { access_token: "mock", expires_at: Date.now() + 3600000 };
  const configError = authConfigError(config);
  if (configError) throw configError;
  if (!tokenData || !tokenData.refresh_token) throw codedError("AUTH_EXPIRED", "Please sign in again");

  const refreshed = await tokenRequest(tokenRefreshParams(config, tokenData.refresh_token));

  return saveTokenData(withExpiry({
    ...tokenData,
    ...refreshed,
    refresh_token: refreshed.refresh_token || tokenData.refresh_token
  }));
}

export async function getAccessToken({ interactive = false } = {}) {
  const config = await getConfig();
  if (config.USE_MOCK_SHEETS) return "mock";
  const configError = authConfigError(config);
  if (configError) throw configError;

  const tokenData = await getTokenData();
  if (isUsable(tokenData)) return tokenData.access_token;

  if (tokenData && tokenData.refresh_token) {
    const refreshed = await refreshToken();
    return refreshed.access_token;
  }

  if (interactive) {
    const signedIn = await signIn();
    return signedIn.access_token;
  }

  throw codedError("AUTH_REQUIRED", "Please sign in from the options page");
}

export async function signOut() {
  await removeSetting(TOKEN_KEY);
}

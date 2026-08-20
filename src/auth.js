import { claimLock, getSetting, mutateSettings, releaseLock } from "./db.js";
import { AUTH_GENERATION_KEY, getConfig, TOKEN_KEY } from "./config-loader.js";
import { recordDiagnostic } from "./diagnostics.js";
import { ERROR_CODE } from "./error-codes.js";

const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_REFRESH_LOCK_KEY = "token_refresh_lock";
const TOKEN_REFRESH_LOCK_TTL_MS = 30_000;
const TOKEN_REFRESH_POLL_MS = 50;
const OAUTH_REQUEST_TIMEOUT_MS = 30_000;
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

let refreshInFlight = null;
let refreshInFlightForced = false;
const KNOWN_ERROR_CODES = new Set(Object.values(ERROR_CODE));

function codedError(code, message) {
  if (!KNOWN_ERROR_CODES.has(code)) throw new TypeError(`Unknown extension error code: ${code}`);
  const error = new Error(message);
  error.code = code;
  return error;
}

async function recordAuthDiagnostic(phase, error) {
  try {
    await recordDiagnostic({
      subsystem: "auth",
      phase,
      error,
      recovery: ["AUTH_REQUIRED", "AUTH_EXPIRED", "CONFIG_MISSING"].includes(error?.code)
        ? "Open Options and complete Google sign-in."
        : "Retry Google sign-in from Options."
    });
  } catch {
    // Keep authentication errors actionable even if IndexedDB is unavailable.
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function formRequest(url, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OAUTH_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } catch (error) {
    if (controller.signal.aborted) throw codedError("API_TIMEOUT", "Google OAuth request timed out");
    if (error?.code) throw error;
    throw codedError("API_NETWORK", error?.message || "Google OAuth network request failed");
  } finally {
    clearTimeout(timeout);
  }
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
  if (!tokenData || typeof tokenData.access_token !== "string" || !tokenData.access_token) {
    throw codedError("AUTH_FAILED", "Google token response was missing an access token");
  }
  const expiresIn = tokenData.expires_in === undefined ? 3600 : Number(tokenData.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw codedError("AUTH_FAILED", "Google token response had an invalid expiry");
  }
  return {
    ...tokenData,
    expires_at: Date.now() + Math.max(0, expiresIn) * 1000
  };
}

function isUsable(tokenData) {
  return Boolean(tokenData && tokenData.access_token && tokenData.expires_at > Date.now());
}

async function getTokenData() {
  return getSetting(TOKEN_KEY);
}

function nextGeneration(settings) {
  const generation = Number(settings.get(AUTH_GENERATION_KEY) || 0) + 1;
  settings.set(AUTH_GENERATION_KEY, generation);
  return generation;
}

async function beginAuthOperation() {
  return mutateSettings([AUTH_GENERATION_KEY], (settings) => nextGeneration(settings));
}

async function saveTokenData(tokenData, { expectedGeneration, expectedRefreshToken } = {}) {
  return mutateSettings([TOKEN_KEY, AUTH_GENERATION_KEY], (settings) => {
    const current = settings.get(TOKEN_KEY) || null;
    const generation = Number(settings.get(AUTH_GENERATION_KEY) || 0);
    if (expectedGeneration !== undefined && generation !== Number(expectedGeneration)) {
      return { applied: false, tokenData: current };
    }
    if (expectedRefreshToken !== undefined && String(current?.refresh_token || "") !== String(expectedRefreshToken || "")) {
      return { applied: false, tokenData: current };
    }
    settings.set(TOKEN_KEY, tokenData);
    nextGeneration(settings);
    return { applied: true, tokenData };
  });
}

async function clearTokenData({ expectedGeneration, expectedRefreshToken } = {}) {
  return mutateSettings([TOKEN_KEY, AUTH_GENERATION_KEY], (settings) => {
    const current = settings.get(TOKEN_KEY) || null;
    const generation = Number(settings.get(AUTH_GENERATION_KEY) || 0);
    if (expectedGeneration !== undefined && generation !== Number(expectedGeneration)) return false;
    if (expectedRefreshToken !== undefined && String(current?.refresh_token || "") !== String(expectedRefreshToken || "")) return false;
    settings.delete(TOKEN_KEY);
    nextGeneration(settings);
    return true;
  });
}

export async function getAuthStatus() {
  const config = await getConfig();
  const tokenData = await getTokenData();

  if (!config.configLoaded) {
    return {
      signedIn: false,
      clientId: config.GOOGLE_CLIENT_ID || "",
      hasClientSecret: Boolean(config.GOOGLE_CLIENT_SECRET),
      missingClientId: !config.GOOGLE_CLIENT_ID,
      missingClientSecret: !config.GOOGLE_CLIENT_SECRET,
      message: config.configIncomplete ? "Google client configuration is incomplete" : "Google client ID missing"
    };
  }

  return {
    signedIn: isUsable(tokenData) || Boolean(tokenData && tokenData.refresh_token),
    clientId: config.GOOGLE_CLIENT_ID || "",
    hasClientSecret: Boolean(config.GOOGLE_CLIENT_SECRET),
    missingClientSecret: !config.GOOGLE_CLIENT_SECRET,
    expiresAt: tokenData ? tokenData.expires_at : null,
    message: tokenData ? "token stored" : "not signed in"
  };
}

export async function signIn({ onDeviceCode } = {}) {
  try {
    const config = await getConfig();
    const configError = authConfigError(config);
    if (configError) throw configError;

    return await signInDevice(config, { onDeviceCode });
  } catch (error) {
    await recordAuthDiagnostic("sign_in", error);
    throw error;
  }
}

async function signInDevice(config, { onDeviceCode } = {}) {
  const generation = await beginAuthOperation();
  const deviceCodeData = await deviceCodeRequest(config);
  if (!deviceCodeData.device_code || !deviceCodeData.user_code || !deviceCodeData.verification_url) {
    throw codedError("AUTH_FAILED", "Google device code response was missing required fields");
  }

  if (onDeviceCode) onDeviceCode(deviceCodeData);

  const tokenData = await pollForDeviceToken(config, deviceCodeData);
  const saved = await saveTokenData(withExpiry({
    ...tokenData,
    flow: "device"
  }), { expectedGeneration: generation });
  if (!saved.applied) throw codedError("AUTH_STALE", "Sign-in was superseded by a newer authentication action");
  return saved.tokenData;
}

async function refreshToken({ force = false } = {}) {
  if (refreshInFlight && force && !refreshInFlightForced) {
    return refreshInFlight.then(() => refreshTokenOnce({ force: true }));
  }
  if (!refreshInFlight) {
    refreshInFlightForced = force;
    const pending = refreshTokenOnce({ force }).finally(() => {
      if (refreshInFlight === pending) {
        refreshInFlight = null;
        refreshInFlightForced = false;
      }
    });
    refreshInFlight = pending;
  }
  return refreshInFlight;
}

function refreshLockHolder() {
  return `refresh-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
}

async function refreshTokenOnce({ force }) {
  const config = await getConfig();
  const configError = authConfigError(config);
  if (configError) throw configError;

  const holder = refreshLockHolder();
  const deadline = Date.now() + TOKEN_REFRESH_LOCK_TTL_MS;
  while (Date.now() < deadline) {
    const lock = await claimLock(TOKEN_REFRESH_LOCK_KEY, holder, TOKEN_REFRESH_LOCK_TTL_MS);
    if (lock) {
      try {
        const tokenData = await getTokenData();
        if (!force && isUsable(tokenData)) return tokenData;
        if (!tokenData || !tokenData.refresh_token) {
          throw codedError("AUTH_EXPIRED", "Please sign in again");
        }
        const generation = Number(await getSetting(AUTH_GENERATION_KEY, 0) || 0);

        const { response, data: refreshed } = await formRequest(
          TOKEN_URL,
          tokenRefreshParams(config, tokenData.refresh_token)
        );
        if (!response.ok) {
          if (refreshed.error === "invalid_grant") {
            await clearTokenData({ expectedGeneration: generation, expectedRefreshToken: tokenData.refresh_token });
            throw codedError("AUTH_EXPIRED", "Google sign-in expired or was revoked. Please sign in again.");
          }
          throw codedError("AUTH_FAILED", tokenError(refreshed, response.status));
        }
        if (typeof refreshed.access_token !== "string" || !refreshed.access_token) {
          throw codedError("AUTH_FAILED", "Google token response was missing an access token");
        }

        const saved = await saveTokenData(withExpiry({
          ...tokenData,
          ...refreshed,
          refresh_token: refreshed.refresh_token || tokenData.refresh_token
        }), { expectedGeneration: generation, expectedRefreshToken: tokenData.refresh_token });
        if (saved.applied) return saved.tokenData;
        if (isUsable(saved.tokenData)) return saved.tokenData;
        throw codedError("AUTH_STALE", "Token refresh was superseded by a newer authentication action");
      } finally {
        await releaseLock(lock);
      }
    }

    const tokenData = await getTokenData();
    if (isUsable(tokenData)) return tokenData;
    await sleep(TOKEN_REFRESH_POLL_MS);
  }

  throw codedError("AUTH_EXPIRED", "Token refresh is taking too long. Please try again.");
}

export async function getAccessToken({ interactive = false, forceRefresh = false } = {}) {
  try {
    const config = await getConfig();
    const configError = authConfigError(config);
    if (configError) throw configError;

    const tokenData = await getTokenData();
    if (!forceRefresh && isUsable(tokenData)) return tokenData.access_token;

    if (tokenData && tokenData.refresh_token) {
      const refreshed = await refreshToken({ force: forceRefresh });
      return refreshed.access_token;
    }

    if (interactive) {
      const signedIn = await signIn();
      return signedIn.access_token;
    }

    throw codedError("AUTH_REQUIRED", "Please sign in from the options page");
  } catch (error) {
    await recordAuthDiagnostic("access_token", error);
    throw error;
  }
}

export async function signOut() {
  await clearTokenData();
}

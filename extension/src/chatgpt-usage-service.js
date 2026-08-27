import { getSetting, mutateSetting, mutateSettings, removeSetting, setSetting } from "./db.js";
import { normalizeUsageResponse, UsageError } from "./codex-usage.js";
import { platform } from "./platform.js";
import { SETTING_KEY } from "./setting-keys.js";

export const CHATGPT_HOST_PERMISSION = "https://chatgpt.com/*";
export const CHATGPT_USAGE_STATE_KEY = SETTING_KEY.CHATGPT_USAGE_STATE;
export const CHATGPT_SESSION_TOKEN_CONSENT_KEY = SETTING_KEY.CHATGPT_USAGE_SESSION_TOKEN_CONSENT;
export const REFRESH_COOLDOWN_MS = 60_000;

const AUTH_SESSION_URL = "https://chatgpt.com/api/auth/session";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_PATH = "/backend-api/wham/usage";
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

let inFlightRefresh = null;

function usageError(code, message, details = {}) {
  return new UsageError(code, message, details);
}

function dependencies(overrides = {}) {
  const get = overrides.getSetting || getSetting;
  const set = overrides.setSetting || setSetting;
  const remove = overrides.removeSetting || removeSetting;
  return {
    platform: overrides.platform || platform,
    fetch: overrides.fetch || globalThis.fetch,
    getSetting: get,
    setSetting: set,
    removeSetting: remove,
    mutateSetting: overrides.mutateSetting || (overrides.getSetting || overrides.setSetting || overrides.removeSetting
      ? async (key, mutator) => {
        const next = mutator(await get(key));
        if (next === undefined) await remove(key);
        else await set(key, next);
        return next;
      }
      : mutateSetting),
    mutateSettings: overrides.mutateSettings || mutateSettings,
    now: overrides.now || (() => Date.now()),
    language: overrides.language || globalThis.navigator?.language || "en-US"
  };
}

export function normalizeChatGptUsageState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      snapshot: null,
      last_attempt_at: 0,
      last_error: null
    };
  }
  return {
    snapshot: value.snapshot && typeof value.snapshot === "object" ? value.snapshot : null,
    last_attempt_at: Number.isFinite(Number(value.last_attempt_at)) ? Number(value.last_attempt_at) : 0,
    last_error: value.last_error && typeof value.last_error === "object" ? value.last_error : null
  };
}

function retryAfterSeconds(response) {
  const value = response.headers.get("Retry-After");
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

async function readBoundedJson(response) {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw usageError("schema_changed", "ChatGPT usage response is too large");
  }

  let text = "";
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytesRead = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw usageError("schema_changed", "ChatGPT usage response is too large");
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  } else {
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw usageError("schema_changed", "ChatGPT usage response is too large");
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw usageError("schema_changed", "ChatGPT returned malformed JSON");
  }
}

function decodeJwtPayload(token) {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function findAccessToken(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return null;
  for (const [key, entry] of Object.entries(value)) {
    if (/^access_?token$/i.test(key) && typeof entry === "string" && entry.split(".").length === 3) return entry;
  }
  for (const entry of Object.values(value)) {
    const token = findAccessToken(entry, depth + 1);
    if (token) return token;
  }
  return null;
}

async function fetchWithTimeout(fetchImpl, url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    throw usageError("network_error", "The ChatGPT usage request could not reach the service", { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

async function responseErrorCode(response) {
  try {
    const body = await readBoundedJson(response);
    return typeof body?.detail?.code === "string" ? body.detail.code : null;
  } catch {
    return null;
  }
}

async function throwForResponse(response) {
  if (response.ok) return;
  if (response.status === 401) throw usageError("sign_in_required", "Sign in to ChatGPT in Firefox", { http_status: 401 });
  if (response.status === 403) throw usageError("access_denied", "ChatGPT denied usage access", { http_status: 403 });
  if (response.status === 404 || response.status === 410) {
    throw usageError("endpoint_unavailable", "ChatGPT usage endpoint is unavailable", { http_status: response.status });
  }
  if (response.status === 429) {
    throw usageError("temporarily_rate_limited", "ChatGPT temporarily rate-limited this request", {
      http_status: 429,
      retry_after_seconds: retryAfterSeconds(response)
    });
  }
  if (response.status === 402 && await responseErrorCode(response) === "deactivated_workspace") {
    throw usageError(
      "workspace_deactivated",
      "ChatGPT is signed in to a deactivated workspace. Switch to your personal workspace, then refresh.",
      { http_status: 402 }
    );
  }
  throw usageError("service_error", "ChatGPT usage returned an error", { http_status: response.status });
}

export async function requestCurrentChatGptUsage(overrides = {}) {
  const deps = dependencies(overrides);
  if (typeof deps.fetch !== "function") throw usageError("network_error", "Fetch is unavailable");

  const sessionResponse = await fetchWithTimeout(deps.fetch, AUTH_SESSION_URL, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    redirect: "follow"
  });
  await throwForResponse(sessionResponse);
  const session = await readBoundedJson(sessionResponse);
  const accessToken = findAccessToken(session);
  if (!accessToken) throw usageError("sign_in_required", "Sign in to ChatGPT in Firefox");

  const claims = decodeJwtPayload(accessToken);
  const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id || null;
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
    "oai-language": deps.language,
    "x-openai-target-path": USAGE_PATH,
    "x-openai-target-route": USAGE_PATH
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;

  const usageResponse = await fetchWithTimeout(deps.fetch, USAGE_URL, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    redirect: "follow",
    headers
  });
  await throwForResponse(usageResponse);
  const body = await readBoundedJson(usageResponse);
  return normalizeUsageResponse(body, { collectedAt: new Date(deps.now()).toISOString() });
}

export async function getChatGptUsageState(overrides = {}) {
  const deps = dependencies(overrides);
  return normalizeChatGptUsageState(await deps.getSetting(CHATGPT_USAGE_STATE_KEY, null));
}

export async function refreshChatGptUsage(overrides = {}) {
  if (inFlightRefresh) return inFlightRefresh;
  const deps = dependencies(overrides);
  inFlightRefresh = (async () => {
    if (!(await deps.platform.hasOptionalHostPermission(CHATGPT_HOST_PERMISSION))) {
      throw usageError("permission_required", "Grant ChatGPT access before refreshing usage");
    }
    if (!(await deps.getSetting(CHATGPT_SESSION_TOKEN_CONSENT_KEY, false))) {
      throw usageError("consent_required", "Confirm session-token use before refreshing usage");
    }

    const current = await getChatGptUsageState(overrides);
    const retryAfterMs = Number(current.last_error?.retry_after_seconds || 0) * 1000;
    const cooldownMs = Math.max(REFRESH_COOLDOWN_MS, retryAfterMs);
    if (!overrides.ignoreCooldown && deps.now() - current.last_attempt_at < cooldownMs) {
      return { kind: "skipped", reason: "cooldown", state: current };
    }

    const attemptedAt = deps.now();
    await deps.mutateSetting(CHATGPT_USAGE_STATE_KEY, (value) => ({
      ...normalizeChatGptUsageState(value),
      last_attempt_at: attemptedAt
    }));

    try {
      const snapshot = await requestCurrentChatGptUsage({ ...overrides, now: deps.now, fetch: deps.fetch, language: deps.language });
      const state = {
        snapshot,
        last_attempt_at: attemptedAt,
        last_error: null
      };
      await deps.setSetting(CHATGPT_USAGE_STATE_KEY, state);
      return { kind: "refreshed", state };
    } catch (error) {
      const safeError = error instanceof UsageError ? error : usageError("service_error", "ChatGPT usage refresh failed");
      const failure = {
        code: safeError.code,
        message: String(safeError.message || "ChatGPT usage refresh failed").slice(0, 240),
        occurred_at: new Date(deps.now()).toISOString(),
        retry_after_seconds: Number.isFinite(safeError.retry_after_seconds) ? safeError.retry_after_seconds : null
      };
      await deps.mutateSetting(CHATGPT_USAGE_STATE_KEY, (value) => ({
        ...normalizeChatGptUsageState(value),
        last_attempt_at: attemptedAt,
        last_error: failure
      }));
      throw safeError;
    }
  })().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

export async function clearChatGptUsageData(overrides = {}) {
  const deps = dependencies(overrides);
  const keys = [CHATGPT_USAGE_STATE_KEY, CHATGPT_SESSION_TOKEN_CONSENT_KEY];
  if (overrides.mutateSettings || (!overrides.getSetting && !overrides.setSetting && !overrides.removeSetting)) {
    await deps.mutateSettings(keys, (settings) => {
      for (const key of keys) settings.delete(key);
    });
    return;
  }
  await Promise.all(keys.map((key) => deps.removeSetting(key)));
}

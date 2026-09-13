import { getSetting, mutateSettings } from "./db.js";
import { readBoundedJson } from "./bounded-json.js";
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
  const persistenceKeys = ["getSetting", "mutateSettings", "setSetting", "removeSetting", "mutateSetting"];
  const injectedPersistence = persistenceKeys.some((key) => Object.hasOwn(overrides, key));
  if (injectedPersistence && (typeof overrides.getSetting !== "function" || typeof overrides.mutateSettings !== "function")) {
    throw new TypeError("ChatGPT usage persistence must provide getSetting and mutateSettings together.");
  }
  if (Object.hasOwn(overrides, "setSetting") || Object.hasOwn(overrides, "removeSetting") || Object.hasOwn(overrides, "mutateSetting")) {
    throw new TypeError("ChatGPT usage persistence must use getSetting and mutateSettings.");
  }
  return {
    platform: overrides.platform || platform,
    fetch: overrides.fetch || globalThis.fetch,
    getSetting: overrides.getSetting || getSetting,
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

const readChatGptJson = (response) => readBoundedJson(
  response,
  MAX_RESPONSE_BYTES,
  (reason) => usageError("schema_changed", `ChatGPT ${reason}`)
);

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

async function fetchWithTimeout(fetchImpl, url, options, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    return consume ? await consume(response) : response;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if (controller.signal.aborted) throw usageError("network_error", "The ChatGPT usage request timed out", { timed_out: true });
    throw usageError("network_error", "The ChatGPT usage request could not reach the service", { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

async function responseErrorCode(response) {
  try {
    const body = await readChatGptJson(response);
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

  const session = await fetchWithTimeout(deps.fetch, AUTH_SESSION_URL, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    redirect: "follow"
  }, async (response) => { await throwForResponse(response); return readChatGptJson(response); });
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

  const body = await fetchWithTimeout(deps.fetch, USAGE_URL, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    redirect: "follow",
    headers
  }, async (response) => { await throwForResponse(response); return readChatGptJson(response); });
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

    const attemptedAt = deps.now();
    let generation;
    let current;
    const claim = await deps.mutateSettings([
      CHATGPT_USAGE_STATE_KEY, CHATGPT_SESSION_TOKEN_CONSENT_KEY, SETTING_KEY.CHATGPT_USAGE_GENERATION
    ], (settings) => {
      if (!settings.get(CHATGPT_SESSION_TOKEN_CONSENT_KEY)) throw usageError("consent_required", "Confirm session-token use before refreshing usage");
      const state = normalizeChatGptUsageState(settings.get(CHATGPT_USAGE_STATE_KEY));
      const cooldownMs = Math.max(REFRESH_COOLDOWN_MS, Number(state.last_error?.retry_after_seconds || 0) * 1000);
      if (!overrides.ignoreCooldown && attemptedAt - state.last_attempt_at < cooldownMs) return { skipped: true, state };
      generation = Number(settings.get(SETTING_KEY.CHATGPT_USAGE_GENERATION) || 0) + 1;
      settings.set(SETTING_KEY.CHATGPT_USAGE_GENERATION, generation);
      settings.set(CHATGPT_USAGE_STATE_KEY, { ...state, last_attempt_at: attemptedAt });
      return { skipped: false, state };
    });
    current = claim.state;
    if (claim.skipped) return { kind: "skipped", reason: "cooldown", state: current };

    try {
      const snapshot = await requestCurrentChatGptUsage({ ...overrides, now: deps.now, fetch: deps.fetch, language: deps.language });
      const state = {
        snapshot,
        last_attempt_at: attemptedAt,
        last_error: null
      };
      await deps.mutateSettings([CHATGPT_USAGE_STATE_KEY, CHATGPT_SESSION_TOKEN_CONSENT_KEY, SETTING_KEY.CHATGPT_USAGE_GENERATION], (settings) => {
        if (Number(settings.get(SETTING_KEY.CHATGPT_USAGE_GENERATION) || 0) !== generation
          || !settings.get(CHATGPT_SESSION_TOKEN_CONSENT_KEY)) return;
        settings.set(CHATGPT_USAGE_STATE_KEY, state);
      });
      return { kind: "refreshed", state };
    } catch (error) {
      const safeError = error instanceof UsageError ? error : usageError("service_error", "ChatGPT usage refresh failed");
      const failure = {
        code: safeError.code,
        message: String(safeError.message || "ChatGPT usage refresh failed").slice(0, 240),
        occurred_at: new Date(deps.now()).toISOString(),
        retry_after_seconds: Number.isFinite(safeError.retry_after_seconds) ? safeError.retry_after_seconds : null
      };
      await deps.mutateSettings([CHATGPT_USAGE_STATE_KEY, CHATGPT_SESSION_TOKEN_CONSENT_KEY, SETTING_KEY.CHATGPT_USAGE_GENERATION], (settings) => {
        if (Number(settings.get(SETTING_KEY.CHATGPT_USAGE_GENERATION) || 0) !== generation
          || !settings.get(CHATGPT_SESSION_TOKEN_CONSENT_KEY)) return;
        settings.set(CHATGPT_USAGE_STATE_KEY, { ...normalizeChatGptUsageState(settings.get(CHATGPT_USAGE_STATE_KEY)), last_attempt_at: attemptedAt, last_error: failure });
      });
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
  await deps.mutateSettings([...keys, SETTING_KEY.CHATGPT_USAGE_GENERATION], (settings) => {
    for (const key of keys) settings.delete(key);
    settings.set(SETTING_KEY.CHATGPT_USAGE_GENERATION, Number(settings.get(SETTING_KEY.CHATGPT_USAGE_GENERATION) || 0) + 1);
  });
}

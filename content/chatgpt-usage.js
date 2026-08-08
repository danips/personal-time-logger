const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_BRIDGE_MESSAGE_CHARS = MAX_RESPONSE_BYTES * 6 + 4096;
const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_BRIDGE_TIMEOUT_MS = 12_000;
const MESSAGE_TYPE = "GET_CHATGPT_USAGE";
const REQUEST_EVENT = "worklog-chatgpt-usage-request-v1";
const RESPONSE_EVENT = "worklog-chatgpt-usage-response-v1";

function retryAfterSeconds(response) {
  const value = response.headers.get("Retry-After");
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

function resultError(status, errorCode, response = null) {
  return {
    ok: false,
    status,
    error_code: errorCode,
    retry_after_seconds: response ? retryAfterSeconds(response) : null
  };
}

async function readUsageIsolated() {
  if (location.origin !== "https://chatgpt.com") return resultError(403, "access_denied");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(USAGE_ENDPOINT, {
      method: "GET",
      credentials: "include",
      signal: controller.signal
    });

    if (response.status === 401) return resultError(response.status, "sign_in_required", response);
    if (response.status === 403) return resultError(response.status, "access_denied", response);
    if (response.status === 404 || response.status === 410) return resultError(response.status, "endpoint_unavailable", response);
    if (response.status === 429) return resultError(response.status, "temporarily_rate_limited", response);
    if (!response.ok) return resultError(response.status, "service_error", response);

    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      return resultError(response.status, "schema_changed", response);
    }
    try {
      return { ok: true, status: response.status, body: JSON.parse(text) };
    } catch {
      return resultError(response.status, "schema_changed", response);
    }
  } catch (error) {
    return resultError(0, error && error.name === "AbortError" ? "network_error" : "network_error");
  } finally {
    clearTimeout(timer);
  }
}

function randomRequestId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readUsageInPageWorld() {
  const requestId = randomRequestId();
  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      document.removeEventListener(RESPONSE_EVENT, onResponse);
    };
    const onResponse = (event) => {
      if (typeof event.detail !== "string" || event.detail.length > MAX_BRIDGE_MESSAGE_CHARS) return;
      try {
        const payload = JSON.parse(event.detail);
        if (payload.request_id !== requestId || !payload.result || typeof payload.result !== "object") return;
        cleanup();
        resolve(payload.result);
      } catch {
        // Ignore malformed page-world messages and wait for the correlated response.
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(resultError(0, "network_error"));
    }, PAGE_BRIDGE_TIMEOUT_MS);
    document.addEventListener(RESPONSE_EVENT, onResponse);
    document.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: requestId }));
  });
}

async function readUsage() {
  const isolatedResult = await readUsageIsolated();
  if (isolatedResult.status !== 401) return isolatedResult;
  return readUsageInPageWorld();
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== MESSAGE_TYPE) return undefined;
  return readUsage();
});

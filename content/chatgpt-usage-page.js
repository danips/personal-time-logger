(() => {
  const AUTH_SESSION_ENDPOINT = "https://chatgpt.com/api/auth/session";
  const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
  const USAGE_PATH = "/backend-api/wham/usage";
  const REQUEST_EVENT = "worklog-chatgpt-usage-request-v1";
  const RESPONSE_EVENT = "worklog-chatgpt-usage-response-v1";
  const MAX_RESPONSE_BYTES = 256 * 1024;
  const REQUEST_TIMEOUT_MS = 10_000;
  const REQUEST_ID_PATTERN = /^[a-f0-9]{32}$/;

  if (window.top !== window || location.origin !== "https://chatgpt.com") return;

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

  async function readJson(response) {
    const declaredLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error("response_too_large");
    if (!response.body || typeof response.body.getReader !== "function") {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("response_too_large");
      return JSON.parse(text);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("response_too_large");
        }
        chunks.push(value);
      }
    } finally {
      reader["releaseLock"]();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
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
      if (/^access_?token$/i.test(key) && typeof entry === "string" && entry.split(".").length === 3) {
        return entry;
      }
    }
    for (const entry of Object.values(value)) {
      const token = findAccessToken(entry, depth + 1);
      if (token) return token;
    }
    return null;
  }

  async function getSessionHeaders() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(AUTH_SESSION_ENDPOINT, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal
      });
      if (response.status === 401) return resultError(response.status, "sign_in_required", response);
      if (response.status === 403) return resultError(response.status, "access_denied", response);
      if (!response.ok) return resultError(response.status, "service_error", response);

      let session;
      try {
        session = await readJson(response);
      } catch {
        return resultError(response.status, "schema_changed", response);
      }
      const accessToken = findAccessToken(session);
      if (!accessToken) return resultError(response.status, "sign_in_required", response);
      const claims = decodeJwtPayload(accessToken);
      const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id || null;
      const headers = {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "oai-language": navigator.language || "en-US",
        "x-openai-target-path": USAGE_PATH,
        "x-openai-target-route": USAGE_PATH
      };
      if (accountId) headers["chatgpt-account-id"] = accountId;
      return { ok: true, headers };
    } catch {
      return resultError(0, "network_error");
    } finally {
      clearTimeout(timer);
    }
  }

  async function readUsageInPageWorld() {
    const session = await getSessionHeaders();
    if (!session.ok) return session;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(USAGE_ENDPOINT, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: session.headers,
        signal: controller.signal
      });
      if (response.status === 401) return resultError(response.status, "sign_in_required", response);
      if (response.status === 403) return resultError(response.status, "access_denied", response);
      if (response.status === 404 || response.status === 410) return resultError(response.status, "endpoint_unavailable", response);
      if (response.status === 429) return resultError(response.status, "temporarily_rate_limited", response);
      if (!response.ok) return resultError(response.status, "service_error", response);

      try {
        return { ok: true, status: response.status, body: await readJson(response), transport: "page_world_session" };
      } catch {
        return resultError(response.status, "schema_changed", response);
      }
    } catch {
      return resultError(0, "network_error");
    } finally {
      clearTimeout(timer);
    }
  }

  document.addEventListener(REQUEST_EVENT, (event) => {
    const requestId = typeof event.detail === "string" ? event.detail : "";
    if (!REQUEST_ID_PATTERN.test(requestId)) return;
    readUsageInPageWorld().then((result) => {
      const detail = JSON.stringify({ request_id: requestId, result });
      document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail }));
    });
  });
})();

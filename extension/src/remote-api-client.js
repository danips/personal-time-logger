import { decodePersistedEntry } from "./entries.js";
import { readBoundedJson } from "./bounded-json.js";
import { ERROR_CODE } from "./error-codes.js";
import { platform } from "./platform.js";

export const API_VERSION = 1;
export const SCHEMA_VERSION = 1;
export const API_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const PERSISTED_ENTRY_FIELDS = Object.freeze([
  "id", "project", "task", "description", "start_at", "end_at", "duration_seconds",
  "status", "created_at", "updated_at", "deleted_at", "device_id", "revision", "multiply"
]);
const KNOWN_ERROR_CODES = new Set(Object.values(ERROR_CODE));

function codedError(code, message, cause) {
  if (!KNOWN_ERROR_CODES.has(code)) throw new TypeError(`Unknown extension error code: ${code}`);
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function labelText(providerLabel) {
  return providerLabel || "remote API";
}

export function normalizeRemoteApiBaseUrl(value, {
  allowHttp = false,
  invalidConfigCode = ERROR_CODE.REMOTE_API_INCOMPATIBLE,
  providerLabel = "remote API"
} = {}) {
  const invalid = (message) => codedError(invalidConfigCode, message);
  if (typeof value !== "string" || !value.trim()) {
    throw invalid(`Enter the ${labelText(providerLabel)} HTTPS URL.`);
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalid(`The ${labelText(providerLabel)} URL is invalid.`);
  }
  if (!allowHttp && url.protocol !== "https:") {
    throw invalid(`The ${labelText(providerLabel)} URL must use HTTPS.`);
  }
  if (url.username || url.password || url.search || url.hash || !url.hostname) {
    throw invalid(`The ${labelText(providerLabel)} URL cannot contain credentials, a query, or a fragment.`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function remoteHostPermission(baseUrl, normalize = normalizeRemoteApiBaseUrl) {
  const url = new URL(normalize(baseUrl, { allowHttp: true }));
  return `${url.origin}/*`;
}

function mapApiError(status, serverCode = "") {
  if (status === 401) return ERROR_CODE.REMOTE_AUTH_REQUIRED;
  if (status === 403 && serverCode === "ORIGIN_NOT_ALLOWED") return ERROR_CODE.REMOTE_ORIGIN_NOT_ALLOWED;
  if (status === 403) return ERROR_CODE.REMOTE_PERMISSION;
  if (status === 404) return ERROR_CODE.REMOTE_API_INCOMPATIBLE;
  if (status === 409) {
    if (serverCode === ERROR_CODE.REMOTE_APPEND_CONFLICT) return ERROR_CODE.REMOTE_APPEND_CONFLICT;
    if (serverCode === ERROR_CODE.CONFIG_CONFLICT) return ERROR_CODE.CONFIG_CONFLICT;
    return ERROR_CODE.REMOTE_VERSION_STALE;
  }
  if (status === 429) return ERROR_CODE.RATE_LIMIT;
  if (status >= 500) return ERROR_CODE.API_ERROR;
  return ERROR_CODE.REMOTE_API_INCOMPATIBLE;
}

function safeApiMessage(code, providerLabel) {
  const label = labelText(providerLabel);
  const messages = {
    [ERROR_CODE.REMOTE_AUTH_REQUIRED]: `The ${label} rejected the configured token.`,
    [ERROR_CODE.REMOTE_ORIGIN_NOT_ALLOWED]: `The ${label} rejected the Firefox extension origin.`,
    [ERROR_CODE.REMOTE_PERMISSION]: `The ${label} origin or token does not permit this request.`,
    [ERROR_CODE.REMOTE_API_INCOMPATIBLE]: "The response did not match the Personal Time Logger API contract.",
    [ERROR_CODE.REMOTE_APPEND_CONFLICT]: `The ${label} has a different entry with the same ID.`,
    [ERROR_CODE.CONFIG_CONFLICT]: "The remote configuration changed before it could be updated.",
    [ERROR_CODE.REMOTE_VERSION_STALE]: "The remote record changed before this operation could be applied.",
    [ERROR_CODE.RATE_LIMIT]: `The ${label} is temporarily rate limiting requests.`,
    [ERROR_CODE.API_ERROR]: `The ${label} returned a server error.`
  };
  return messages[code] || `The ${label} request failed.`;
}

export function createRemoteApiClient({
  baseUrl,
  token,
  providerLabel = "remote API",
  missingConfigCode = ERROR_CODE.REMOTE_API_INCOMPATIBLE,
  invalidConfigCode = ERROR_CODE.REMOTE_API_INCOMPATIBLE,
  normalizeBaseUrl = normalizeRemoteApiBaseUrl,
  hostPermission = remoteHostPermission,
  fetchImpl = globalThis.fetch,
  platformApi = platform,
  requestPermission = false,
  timeoutMs = API_TIMEOUT_MS
} = {}) {
  const requestJson = async (path, { method = "GET", body } = {}) => {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl, {
      invalidConfigCode,
      providerLabel
    });
    if (typeof token !== "string" || !token.trim()) {
      throw codedError(missingConfigCode, `Save a ${labelText(providerLabel)} URL and token before connecting.`);
    }
    if (!platformApi.isOnline()) throw codedError(ERROR_CODE.OFFLINE, "Network is offline.");
    if (typeof fetchImpl !== "function") throw codedError(ERROR_CODE.API_NETWORK, "Fetch is unavailable.");

    const permission = hostPermission(normalizedBaseUrl, normalizeBaseUrl);
    let permitted = await platformApi.hasOptionalHostPermission(permission);
    if (!permitted && requestPermission) permitted = await platformApi.requestOptionalHostPermission(permission);
    if (!permitted) throw codedError(ERROR_CODE.REMOTE_PERMISSION, `Firefox did not grant the ${labelText(providerLabel)} host permission.`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let data;
    try {
      response = await fetchImpl(`${normalizedBaseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      data = await readBoundedJson(response, MAX_RESPONSE_BYTES, (reason) => (
        codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, `The remote API ${reason}.`)
      ));
    } catch (error) {
      if (error?.code) throw error;
      if (controller.signal.aborted) throw codedError(ERROR_CODE.API_TIMEOUT, `The ${labelText(providerLabel)} request timed out.`);
      throw codedError(ERROR_CODE.API_NETWORK, `The ${labelText(providerLabel)} network request failed.`, error);
    } finally {
      clearTimeout(timeout);
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "The remote API returned an invalid response.");
    }
    if (!response.ok) {
      const serverCode = typeof data.error?.code === "string" ? data.error.code : "";
      const code = mapApiError(response.status, serverCode);
      throw codedError(code, safeApiMessage(code, providerLabel));
    }
    return data;
  };
  const request = (path, options = {}) => requestJson(path, options);
  return Object.freeze({
    health: () => request("/v1/health"),
    changeToken: () => request("/v1/change-token"),
    snapshot: () => request("/v1/snapshot"),
    append: (entries) => request("/v1/entries/append", { method: "POST", body: { entries } }),
    update: (updates) => request("/v1/entries/update", { method: "POST", body: { updates } }),
    delete: (preconditions) => request("/v1/entries/delete", { method: "POST", body: { preconditions } }),
    updateConfig: (payload) => request("/v1/config/update", { method: "POST", body: payload })
  });
}

export function persistedEntry(entry) {
  return Object.fromEntries(PERSISTED_ENTRY_FIELDS.map((field) => [field, entry[field]]));
}

export function parseRemoteVersion(value, invalidCode = ERROR_CODE.REMOTE_API_INCOMPATIBLE) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw codedError(invalidCode, "The remote API returned an invalid record version.");
  }
  return version;
}

export function normalizeRemoteEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const normalized = { ...entry };
  for (const field of ["end_at", "deleted_at", "multiply"]) {
    if (normalized[field] === null) normalized[field] = "";
  }
  return normalized;
}

export function parseRemoteSnapshot(data, {
  entryRefKind,
  configRefKind,
  providerLabel = "remote API"
} = {}) {
  if (!Array.isArray(data.entries) || !Array.isArray(data.config)) {
    throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, `The ${labelText(providerLabel)} snapshot shape is invalid.`);
  }
  const entries = [];
  const entryRefs = new Map();
  const quarantined = [];
  for (const record of data.entries) {
    try {
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("record");
      const entry = decodePersistedEntry(normalizeRemoteEntry(record.entry));
      if (entryRefs.has(entry.id)) throw new Error("duplicate");
      entries.push(entry);
      entryRefs.set(entry.id, { kind: entryRefKind, version: parseRemoteVersion(record.version) });
    } catch {
      const version = Number(record?.version);
      quarantined.push({
        id: String(record?.entry?.id || ""),
        reason: "invalid_entry",
        ref: Number.isSafeInteger(version) && version > 0 ? { kind: entryRefKind, version } : null
      });
    }
  }

  const config = {};
  const configRefs = new Map();
  for (const record of data.config) {
    if (!record || typeof record !== "object" || Array.isArray(record)
      || typeof record.key !== "string" || typeof record.value !== "string"
      || typeof record.updated_at !== "string") {
      throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, `The ${labelText(providerLabel)} config shape is invalid.`);
    }
    if (configRefs.has(record.key)) throw codedError(ERROR_CODE.CONFIG_CONFLICT, `The ${labelText(providerLabel)} returned duplicate config keys.`);
    config[record.key] = { value: record.value, updated_at: record.updated_at };
    configRefs.set(record.key, { kind: configRefKind, version: parseRemoteVersion(record.version) });
  }
  if (data.changeToken === undefined || data.changeToken === null) {
    throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, `The ${labelText(providerLabel)} snapshot has no change token.`);
  }
  return { entries, entryRefs, duplicates: [], quarantined, config, configRefs, changeToken: String(data.changeToken) };
}

export function requireRemoteHealth(data, {
  providerLabel = "remote API",
  validateHealth = () => true
} = {}) {
  if (data?.ok !== true || data.service !== "personal-time-logger"
    || data.apiVersion !== API_VERSION || data.schemaVersion !== SCHEMA_VERSION || !validateHealth(data)) {
    throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, `The ${labelText(providerLabel)} version is not compatible with this extension.`);
  }
  return data;
}

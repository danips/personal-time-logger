import { getSetting } from "./db.js";
import { decodePersistedEntry } from "./entries.js";
import { ERROR_CODE } from "./error-codes.js";
import { platform } from "./platform.js";
import { SETTING_KEY } from "./setting-keys.js";

export const DEFAULT_MYSQL_API_BASE_URL = "https://time-api.cordoceo.com";
const API_VERSION = 1;
const SCHEMA_VERSION = 1;
const API_TIMEOUT_MS = 30_000;
const ENTRY_REF_KIND = "mysql-row";
const CONFIG_REF_KIND = "mysql-config-row";
const PERSISTED_ENTRY_FIELDS = [
  "id", "project", "task", "description", "start_at", "end_at", "duration_seconds",
  "status", "created_at", "updated_at", "deleted_at", "device_id", "revision", "multiply"
];
const KNOWN_ERROR_CODES = new Set(Object.values(ERROR_CODE));

function codedError(code, message, cause) {
  if (!KNOWN_ERROR_CODES.has(code)) throw new TypeError(`Unknown extension error code: ${code}`);
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export function normalizeMysqlApiBaseUrl(value, { allowHttp = false } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw codedError(ERROR_CODE.MYSQL_CONFIG_INVALID, "Enter the MySQL API HTTPS URL.");
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw codedError(ERROR_CODE.MYSQL_CONFIG_INVALID, "The MySQL API URL is invalid.");
  }
  if (!allowHttp && url.protocol !== "https:") {
    throw codedError(ERROR_CODE.MYSQL_CONFIG_INVALID, "The MySQL API URL must use HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash || !url.hostname) {
    throw codedError(ERROR_CODE.MYSQL_CONFIG_INVALID, "The MySQL API URL cannot contain credentials, a query, or a fragment.");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function mysqlHostPermission(baseUrl) {
  const url = new URL(normalizeMysqlApiBaseUrl(baseUrl, { allowHttp: true }));
  return `${url.origin}/*`;
}

function mapApiError(status, serverCode = "") {
  if (status === 401) return ERROR_CODE.REMOTE_AUTH_REQUIRED;
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

function safeApiMessage(code) {
  const messages = {
    [ERROR_CODE.REMOTE_AUTH_REQUIRED]: "The MySQL API rejected the configured token.",
    [ERROR_CODE.REMOTE_PERMISSION]: "The MySQL API origin or token does not permit this request.",
    [ERROR_CODE.REMOTE_API_INCOMPATIBLE]: "The response did not match the Personal Time Logger API contract.",
    [ERROR_CODE.REMOTE_APPEND_CONFLICT]: "The MySQL API has a different entry with the same ID.",
    [ERROR_CODE.CONFIG_CONFLICT]: "The remote configuration changed before it could be updated.",
    [ERROR_CODE.REMOTE_VERSION_STALE]: "The remote record changed before this operation could be applied.",
    [ERROR_CODE.RATE_LIMIT]: "The MySQL API is temporarily rate limiting requests.",
    [ERROR_CODE.API_ERROR]: "The MySQL API returned a server error."
  };
  return messages[code] || "The MySQL API request failed.";
}

async function requestJson(path, {
  baseUrl,
  token,
  method = "GET",
  body,
  requestPermission = false,
  fetchImpl = globalThis.fetch,
  platformApi = platform,
  timeoutMs = API_TIMEOUT_MS
} = {}) {
  const normalizedBaseUrl = normalizeMysqlApiBaseUrl(baseUrl);
  if (typeof token !== "string" || !token.trim()) {
    throw codedError(ERROR_CODE.MYSQL_CONFIG_MISSING, "Save a MySQL API URL and token before connecting.");
  }
  if (!platformApi.isOnline()) throw codedError(ERROR_CODE.OFFLINE, "Network is offline.");
  if (typeof fetchImpl !== "function") throw codedError(ERROR_CODE.API_NETWORK, "Fetch is unavailable.");

  const permission = mysqlHostPermission(normalizedBaseUrl);
  let permitted = await platformApi.hasOptionalHostPermission(permission);
  if (!permitted && requestPermission) permitted = await platformApi.requestOptionalHostPermission(permission);
  if (!permitted) throw codedError(ERROR_CODE.REMOTE_PERMISSION, "Firefox did not grant the MySQL API host permission.");

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
    const text = await response.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch (error) {
      throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "The MySQL API returned malformed JSON.", error);
    }
  } catch (error) {
    if (error?.code) throw error;
    if (controller.signal.aborted) throw codedError(ERROR_CODE.API_TIMEOUT, "The MySQL API request timed out.");
    throw codedError(ERROR_CODE.API_NETWORK, "The MySQL API network request failed.", error);
  } finally {
    clearTimeout(timeout);
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "The MySQL API returned an invalid response.");
  }
  if (!response.ok) {
    const serverCode = typeof data.error?.code === "string" ? data.error.code : "";
    const code = mapApiError(response.status, serverCode);
    throw codedError(code, safeApiMessage(code));
  }
  return data;
}

export function createMysqlApiClient({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  platformApi = platform,
  requestPermission = false,
  timeoutMs = API_TIMEOUT_MS
} = {}) {
  const request = (path, options = {}) => requestJson(path, {
    baseUrl,
    token,
    fetchImpl,
    platformApi,
    requestPermission,
    timeoutMs,
    ...options
  });
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

async function configuredClient(options = {}) {
  const baseUrl = options.baseUrl ?? await getSetting(SETTING_KEY.MYSQL_API_BASE_URL, DEFAULT_MYSQL_API_BASE_URL);
  const token = options.token ?? await getSetting(SETTING_KEY.MYSQL_API_TOKEN, "");
  return createMysqlApiClient({ ...options, baseUrl, token });
}

function requireHealthCompatibility(data) {
  if (data?.ok !== true || data.apiVersion !== API_VERSION || data.schemaVersion !== SCHEMA_VERSION) {
    throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "The MySQL API version is not compatible with this extension.");
  }
  return data;
}

function parseVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "The MySQL API returned an invalid record version.");
  }
  return version;
}

function ref(kind, version) {
  return { kind, version: parseVersion(version) };
}

function persistedEntry(entry) {
  return Object.fromEntries(PERSISTED_ENTRY_FIELDS.map((field) => [field, entry[field]]));
}

function normalizeApiEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const normalized = { ...entry };
  for (const field of ["end_at", "deleted_at", "multiply"]) {
    if (normalized[field] === null) normalized[field] = "";
  }
  return normalized;
}

function mapSnapshot(data) {
  if (!Array.isArray(data.entries) || !Array.isArray(data.config)) {
    throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "The MySQL API snapshot shape is invalid.");
  }
  const entries = [];
  const entryRefs = new Map();
  const quarantined = [];
  for (const record of data.entries) {
    try {
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("record");
      const entry = decodePersistedEntry(normalizeApiEntry(record.entry));
      if (entryRefs.has(entry.id)) throw new Error("duplicate");
      entries.push(entry);
      entryRefs.set(entry.id, ref(ENTRY_REF_KIND, record.version));
    } catch {
      quarantined.push({ id: String(record?.entry?.id || ""), reason: "invalid_entry" });
    }
  }

  const config = {};
  const configRefs = new Map();
  for (const record of data.config) {
    if (!record || typeof record !== "object" || Array.isArray(record)
      || typeof record.key !== "string" || typeof record.value !== "string"
      || typeof record.updated_at !== "string") {
      throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "The MySQL API config shape is invalid.");
    }
    if (configRefs.has(record.key)) throw codedError(ERROR_CODE.CONFIG_CONFLICT, "The MySQL API returned duplicate config keys.");
    config[record.key] = { value: record.value, updated_at: record.updated_at };
    configRefs.set(record.key, ref(CONFIG_REF_KIND, record.version));
  }

  if (data.changeToken === undefined || data.changeToken === null) {
    throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "The MySQL API snapshot has no change token.");
  }
  return { entries, entryRefs, duplicates: [], quarantined, config, configRefs, changeToken: String(data.changeToken) };
}

export const mysqlProvider = Object.freeze({
  id: "mysql",
  label: "MySQL 8.4",
  capabilities: Object.freeze({
    duplicateRemoteRecords: false
  }),

  async ensureReady(options = {}) {
    requireHealthCompatibility(await (await configuredClient(options)).health());
    return null;
  },

  async testConnection(options = {}) {
    const data = requireHealthCompatibility(await (await configuredClient({ ...options, requestPermission: true })).health());
    return data;
  },

  async getChangeToken(options = {}) {
    const data = await (await configuredClient(options)).changeToken();
    if (data.changeToken === undefined || data.changeToken === null) {
      throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "The MySQL API returned no change token.");
    }
    return String(data.changeToken);
  },

  async readSnapshot(options = {}) {
    return mapSnapshot(await (await configuredClient(options)).snapshot());
  },

  async appendEntries(entries, options = {}) {
    if (!entries.length) return [];
    const data = await (await configuredClient(options)).append(entries.map(persistedEntry));
    if (!Array.isArray(data.entries)) throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "The MySQL API append response is invalid.");
    return data.entries.map((record) => ({ id: String(record.id), ref: ref(ENTRY_REF_KIND, record.version) }));
  },

  async updateEntries(updates, options = {}) {
    if (!updates.length) return;
    const payload = updates.map(({ entry, expectedRef }) => ({
      entry: persistedEntry(entry),
      expectedVersion: parseVersion(expectedRef?.version)
    }));
    await (await configuredClient(options)).update(payload);
  },

  async deleteEntries(preconditions, options = {}) {
    if (!preconditions.length) return;
    const payload = preconditions.map(({ id, expectedRef }) => ({
      id,
      expectedVersion: parseVersion(expectedRef?.version)
    }));
    await (await configuredClient(options)).delete(payload);
  },

  async updateConfig(key, value, updatedAt, { expectedRef, ...options } = {}) {
    await (await configuredClient(options)).updateConfig({
      key,
      value,
      updated_at: updatedAt,
      ...(expectedRef ? { expectedVersion: parseVersion(expectedRef.version) } : {})
    });
  },

  async ensureAppMarker() {
    return false;
  }
});

export async function testMysqlConnection(options = {}) {
  return mysqlProvider.testConnection(options);
}

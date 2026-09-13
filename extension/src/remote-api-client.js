import { decodePersistedEntry } from "./entries.js";
import { readBoundedJson } from "./bounded-json.js";
import { ERROR_CODE } from "./error-codes.js";
import { codedError } from "./coded-error.js";
import { platform } from "./platform.js";
import { ENTRY_FIELDS } from "./entry-contract.js";

export const API_VERSION = 1;
export const SCHEMA_VERSION = 1;
export const API_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const PERSISTED_ENTRY_FIELDS = ENTRY_FIELDS;
const requestEncoder = new TextEncoder();

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
  const requestJson = async (path, { method = "GET", body, encodedBody } = {}) => {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl, {
      invalidConfigCode,
      providerLabel
    });
    if (typeof token !== "string" || !token.trim()) {
      throw codedError(missingConfigCode, `Save a ${labelText(providerLabel)} URL and token before connecting.`);
    }
    if (!platformApi.isOnline()) throw codedError(ERROR_CODE.OFFLINE, "Network is offline.");
    if (typeof fetchImpl !== "function") throw codedError(ERROR_CODE.API_NETWORK, "Fetch is unavailable.");
    const requestBody = encodedBody === undefined ? JSON.stringify(body) : encodedBody;

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
          ...(requestBody === undefined ? {} : { "Content-Type": "application/json" })
        },
        ...(requestBody === undefined ? {} : { body: requestBody })
      });
      if (!response.ok) {
        // Status is authoritative for an error response. Intermediaries often
        // return HTML/text for 429/503, which must not become an incompatible
        // API report merely because that body is not JSON.
        try { data = await readBoundedJson(response, MAX_RESPONSE_BYTES, (reason) => (
          codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, `The remote API ${reason}.`)
        )); } catch {
          if (controller.signal.aborted) throw codedError(ERROR_CODE.API_TIMEOUT, `The ${labelText(providerLabel)} request timed out.`);
          data = null;
        }
      } else {
        data = await readBoundedJson(response, MAX_RESPONSE_BYTES, (reason) => (
          codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, `The remote API ${reason}.`)
        ));
        }
    } catch (error) {
      if (error?.code) throw error;
      if (controller.signal.aborted) throw codedError(ERROR_CODE.API_TIMEOUT, `The ${labelText(providerLabel)} request timed out.`);
      throw codedError(ERROR_CODE.API_NETWORK, `The ${labelText(providerLabel)} network request failed.`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const serverCode = typeof data?.error?.code === "string" ? data.error.code : "";
      const code = mapApiError(response.status, serverCode);
      throw codedError(code, safeApiMessage(code, providerLabel));
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "The remote API returned an invalid response.");
    }
    return data;
  };
  const request = (path, options = {}) => requestJson(path, options);
  return Object.freeze({
    health: () => request("/v1/health"),
    changeToken: () => request("/v1/change-token"),
    snapshot: () => request("/v1/snapshot"),
    append: (entries) => request("/v1/entries/append", { method: "POST", body: { entries } }),
    appendEncoded: (body) => request("/v1/entries/append", { method: "POST", encodedBody: body }),
    update: (updates) => request("/v1/entries/update", { method: "POST", body: { updates } }),
    updateEncoded: (body) => request("/v1/entries/update", { method: "POST", encodedBody: body }),
    delete: (preconditions) => request("/v1/entries/delete", { method: "POST", body: { preconditions } }),
    deleteEncoded: (body) => request("/v1/entries/delete", { method: "POST", encodedBody: body }),
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

/** Validate an append acknowledgement without losing order or duplicate IDs. */
export function parseAppendAcknowledgements(records, submittedIds, refKind) {
  if (!Array.isArray(records) || !Array.isArray(submittedIds)) {
    throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "The remote API append acknowledgement is invalid.");
  }
  if (records.length !== submittedIds.length) {
    throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "The remote API did not acknowledge every submitted entry.");
  }
  const expected = new Set(submittedIds.map((id) => String(id)));
  const seen = new Set();
  const byId = new Map();
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)
      || typeof record.id !== "string" || !expected.has(record.id) || seen.has(record.id)) {
      throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "The remote API append acknowledgement contains unexpected or duplicate IDs.");
    }
    const version = parseRemoteVersion(record.version);
    seen.add(record.id);
    byId.set(record.id, { id: record.id, ref: { kind: refKind, version } });
  }
  if (seen.size !== expected.size) {
    throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "The remote API append acknowledgement is incomplete.");
  }
  return submittedIds.map((id) => byId.get(String(id)));
}

export function chunkByEncodedBytes(values, {
  maxBytes,
  maxItems = Infinity,
  envelopeKey,
  encode = (value) => value
} = {}) {
  const result = [];
  let current = [];
  const emptyBody = JSON.stringify({ [envelopeKey]: [] });
  const arrayStart = emptyBody.indexOf("[]");
  const prefix = emptyBody.slice(0, arrayStart + 1);
  const suffix = emptyBody.slice(arrayStart + 1);
  const prefixBytes = requestEncoder.encode(prefix).byteLength;
  const suffixBytes = requestEncoder.encode(suffix).byteLength;
  const commaBytes = requestEncoder.encode(",").byteLength;
  let currentBytes = prefixBytes + suffixBytes;

  const flush = () => {
    if (!current.length) return;
    const body = `${prefix}${current.map(({ encoded }) => encoded).join(",")}${suffix}`;
    const valuesForChunk = current.map(({ value }) => value);
    Object.defineProperty(valuesForChunk, "encodedBody", { value: body });
    result.push(valuesForChunk);
    current = [];
    currentBytes = prefixBytes + suffixBytes;
  };

  for (const value of values) {
    const encoded = JSON.stringify(encode(value));
    const itemBytes = requestEncoder.encode(encoded).byteLength;
    const nextBytes = currentBytes + (current.length ? commaBytes : 0) + itemBytes;
    if (nextBytes > maxBytes || current.length >= maxItems) {
      if (!current.length) throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "A single remote entry is too large for the API request limit.");
      flush();
      if (prefixBytes + suffixBytes + itemBytes > maxBytes) {
        throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "A single remote entry is too large for the API request limit.");
      }
    }
    const separatorBytes = current.length ? commaBytes : 0;
    current.push({ value, encoded });
    currentBytes += separatorBytes + itemBytes;
  }
  flush();
  return result;
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
  if (!data || typeof data !== "object" || Array.isArray(data)
    || !Array.isArray(data.entries) || !Array.isArray(data.config)) {
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
      // Validate the provider reference before mutating either accepted
      // collection. Invalid versions must remain quarantine-only records.
      const version = parseRemoteVersion(record.version);
      entries.push(entry);
      entryRefs.set(entry.id, { kind: entryRefKind, version });
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
  return { entries, entryRefs, quarantined, config, configRefs, changeToken: String(data.changeToken) };
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

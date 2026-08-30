import { getSetting } from "./db.js";
import { ERROR_CODE } from "./error-codes.js";
import {
  createRemoteApiClient,
  normalizeRemoteApiBaseUrl,
  parseRemoteSnapshot,
  parseRemoteVersion,
  persistedEntry,
  requireRemoteHealth,
  remoteHostPermission
} from "./remote-api-client.js";
import { SETTING_KEY } from "./setting-keys.js";

export const DEFAULT_CLOUDFLARE_D1_API_BASE_URL = "";
const LABEL = "Cloudflare Worker + D1";
const ENTRY_REF_KIND = "cloudflare-d1-row";
const CONFIG_REF_KIND = "cloudflare-d1-config-row";
const CHUNK_SIZE = 15;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function normalizeCloudflareD1ApiBaseUrl(value, { allowHttp = false } = {}) {
  const normalized = normalizeRemoteApiBaseUrl(value, {
    allowHttp,
    invalidConfigCode: ERROR_CODE.CLOUDFLARE_D1_CONFIG_INVALID,
    providerLabel: LABEL
  });
  const hostname = new URL(normalized).hostname.toLowerCase();
  if (hostname !== "workers.dev" && !hostname.endsWith(".workers.dev")) {
    throw codedError(ERROR_CODE.CLOUDFLARE_D1_CONFIG_INVALID, "The Worker URL must use a workers.dev hostname.");
  }
  return normalized;
}

export function cloudflareD1HostPermission(baseUrl) {
  return remoteHostPermission(baseUrl, normalizeCloudflareD1ApiBaseUrl);
}

export function createCloudflareD1ApiClient(options = {}) {
  return createRemoteApiClient({
    ...options,
    providerLabel: LABEL,
    missingConfigCode: ERROR_CODE.CLOUDFLARE_D1_CONFIG_MISSING,
    invalidConfigCode: ERROR_CODE.CLOUDFLARE_D1_CONFIG_INVALID,
    normalizeBaseUrl: normalizeCloudflareD1ApiBaseUrl,
    hostPermission: cloudflareD1HostPermission
  });
}

async function configuredClient(options = {}) {
  const baseUrl = options.baseUrl ?? await getSetting(SETTING_KEY.CLOUDFLARE_D1_API_BASE_URL, DEFAULT_CLOUDFLARE_D1_API_BASE_URL);
  const token = options.token ?? await getSetting(SETTING_KEY.CLOUDFLARE_D1_API_TOKEN, "");
  return createCloudflareD1ApiClient({ ...options, baseUrl, token });
}

function health(data) {
  return requireRemoteHealth(data, {
    providerLabel: LABEL,
    validateHealth: (value) => value.storage === "cloudflare-d1"
  });
}

function ref(kind, version) {
  return { kind, version: parseRemoteVersion(version) };
}

async function chunks(values, callback) {
  for (let index = 0; index < values.length; index += CHUNK_SIZE) {
    await callback(values.slice(index, index + CHUNK_SIZE));
  }
}

export const cloudflareD1Provider = Object.freeze({
  id: "cloudflare-d1",
  label: LABEL,
  capabilities: Object.freeze({ duplicateRemoteRecords: false }),

  async ensureReady(options = {}) {
    health(await (await configuredClient(options)).health());
    return null;
  },

  async testConnection(options = {}) {
    return health(await (await configuredClient({ ...options, requestPermission: true })).health());
  },

  async getChangeToken(options = {}) {
    const data = await (await configuredClient(options)).changeToken();
    if (data.changeToken === undefined || data.changeToken === null) throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "The Cloudflare Worker returned no change token.");
    return String(data.changeToken);
  },

  async readSnapshot(options = {}) {
    return parseRemoteSnapshot(await (await configuredClient(options)).snapshot(), {
      entryRefKind: ENTRY_REF_KIND, configRefKind: CONFIG_REF_KIND, providerLabel: LABEL
    });
  },

  async appendEntries(entries, options = {}) {
    const result = [];
    await chunks(entries, async (chunk) => {
      const data = await (await configuredClient(options)).append(chunk.map(persistedEntry));
      if (!Array.isArray(data.entries)) throw codedError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, "The Cloudflare Worker append response is invalid.");
      result.push(...data.entries.map((record) => ({ id: String(record.id), ref: ref(ENTRY_REF_KIND, record.version) })));
    });
    const byId = new Map(result.map((record) => [record.id, record]));
    return entries.map((entry) => byId.get(entry.id));
  },

  async updateEntries(updates, options = {}) {
    await chunks(updates, async (chunk) => {
      await (await configuredClient(options)).update(chunk.map(({ entry, expectedRef }) => ({
        entry: persistedEntry(entry), expectedVersion: parseRemoteVersion(expectedRef?.version)
      })));
    });
  },

  async deleteEntries(preconditions, options = {}) {
    await chunks(preconditions, async (chunk) => {
      await (await configuredClient(options)).delete(chunk.map(({ id, expectedRef }) => ({
        id, expectedVersion: parseRemoteVersion(expectedRef?.version)
      })));
    });
  },

  async updateConfig(key, value, updatedAt, { expectedRef, ...options } = {}) {
    await (await configuredClient(options)).updateConfig({
      key, value, updated_at: updatedAt,
      ...(expectedRef ? { expectedVersion: parseRemoteVersion(expectedRef.version) } : {})
    });
  },

  async ensureAppMarker() {
    return false;
  }
});

export async function testCloudflareD1Connection(options = {}) {
  return cloudflareD1Provider.testConnection(options);
}

export { CHUNK_SIZE };

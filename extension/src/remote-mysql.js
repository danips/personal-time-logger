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

export const DEFAULT_MYSQL_API_BASE_URL = "https://time-api.cordoceo.com";
const PROVIDER_LABEL = "MySQL API";
const ENTRY_REF_KIND = "mysql-row";
const CONFIG_REF_KIND = "mysql-config-row";

export function normalizeMysqlApiBaseUrl(value, options = {}) {
  return normalizeRemoteApiBaseUrl(value, {
    ...options,
    invalidConfigCode: ERROR_CODE.MYSQL_CONFIG_INVALID,
    providerLabel: "MySQL API"
  });
}

export function mysqlHostPermission(baseUrl) {
  return remoteHostPermission(baseUrl, normalizeMysqlApiBaseUrl);
}

export function createMysqlApiClient(options = {}) {
  return createRemoteApiClient({
    ...options,
    providerLabel: PROVIDER_LABEL,
    missingConfigCode: ERROR_CODE.MYSQL_CONFIG_MISSING,
    invalidConfigCode: ERROR_CODE.MYSQL_CONFIG_INVALID,
    normalizeBaseUrl: normalizeMysqlApiBaseUrl,
    hostPermission: mysqlHostPermission
  });
}

async function configuredClient(options = {}) {
  const baseUrl = options.baseUrl ?? await getSetting(SETTING_KEY.MYSQL_API_BASE_URL, DEFAULT_MYSQL_API_BASE_URL);
  const token = options.token ?? await getSetting(SETTING_KEY.MYSQL_API_TOKEN, "");
  return createMysqlApiClient({ ...options, baseUrl, token });
}

function requireMysqlHealth(data) {
  return requireRemoteHealth(data, {
    providerLabel: PROVIDER_LABEL,
    validateHealth: (health) => typeof health.mysql === "string"
      && /^8\.(?:[4-9]|[1-9]\d+)$/.test(health.mysql)
  });
}

function ref(kind, version) {
  return { kind, version: parseRemoteVersion(version) };
}

export const mysqlProvider = Object.freeze({
  id: "mysql",
  label: "MySQL 8.4",
  capabilities: Object.freeze({ duplicateRemoteRecords: false }),

  async ensureReady(options = {}) {
    requireMysqlHealth(await (await configuredClient(options)).health());
    return null;
  },

  async testConnection(options = {}) {
    return requireMysqlHealth(await (await configuredClient({ ...options, requestPermission: true })).health());
  },

  async getChangeToken(options = {}) {
    const data = await (await configuredClient(options)).changeToken();
    if (data.changeToken === undefined || data.changeToken === null) {
      throw Object.assign(new Error("The MySQL API returned no change token."), { code: ERROR_CODE.REMOTE_API_INCOMPATIBLE });
    }
    return String(data.changeToken);
  },

  async readSnapshot(options = {}) {
    return parseRemoteSnapshot(await (await configuredClient(options)).snapshot(), {
      entryRefKind: ENTRY_REF_KIND,
      configRefKind: CONFIG_REF_KIND,
      providerLabel: PROVIDER_LABEL
    });
  },

  async appendEntries(entries, options = {}) {
    if (!entries.length) return [];
    const data = await (await configuredClient(options)).append(entries.map(persistedEntry));
    if (!Array.isArray(data.entries)) throw Object.assign(new Error("The MySQL API append response is invalid."), { code: ERROR_CODE.REMOTE_API_INCOMPATIBLE });
    return data.entries.map((record) => ({ id: String(record.id), ref: ref(ENTRY_REF_KIND, record.version) }));
  },

  async updateEntries(updates, options = {}) {
    if (!updates.length) return;
    await (await configuredClient(options)).update(updates.map(({ entry, expectedRef }) => ({
      entry: persistedEntry(entry), expectedVersion: parseRemoteVersion(expectedRef?.version)
    })));
  },

  async deleteEntries(preconditions, options = {}) {
    if (!preconditions.length) return;
    await (await configuredClient(options)).delete(preconditions.map(({ id, expectedRef }) => ({
      id, expectedVersion: parseRemoteVersion(expectedRef?.version)
    })));
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

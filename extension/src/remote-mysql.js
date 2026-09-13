import { getAllSettings } from "./db.js";
import { ERROR_CODE } from "./error-codes.js";
import {
  createRemoteApiClient,
  normalizeRemoteApiBaseUrl,
  parseRemoteSnapshot,
  requireRemoteHealth,
  remoteHostPermission
} from "./remote-api-client.js";
import { createVersionedMutationOperations } from "./remote-versioned-mutations.js";
import { SETTING_KEY } from "./setting-keys.js";

export const DEFAULT_MYSQL_API_BASE_URL = "https://time-api.cordoceo.com";
const PROVIDER_LABEL = "MySQL API";
const ENTRY_REF_KIND = "mysql-row";
const CONFIG_REF_KIND = "mysql-config-row";
const MAX_REQUEST_BYTES = 1_900_000;

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
  if (options.client) return options.client;
  if (options.baseUrl !== undefined && options.token !== undefined) {
    return createMysqlApiClient(options);
  }
  const settings = await getAllSettings();
  const baseUrl = options.baseUrl ?? settings[SETTING_KEY.MYSQL_API_BASE_URL] ?? DEFAULT_MYSQL_API_BASE_URL;
  const token = options.token ?? settings[SETTING_KEY.MYSQL_API_TOKEN] ?? "";
  return createMysqlApiClient({ ...options, baseUrl, token });
}

function requireMysqlHealth(data) {
  return requireRemoteHealth(data, {
    providerLabel: PROVIDER_LABEL,
    validateHealth: (health) => typeof health.mysql === "string"
      && /^8\.(?:[4-9]|[1-9]\d+)$/.test(health.mysql)
  });
}

const versionedMutations = createVersionedMutationOperations({
  configuredClient,
  chunkOptions: { maxBytes: MAX_REQUEST_BYTES },
  entryRefKind: ENTRY_REF_KIND
});

export const mysqlProvider = Object.freeze({
  id: "mysql",
  label: "MySQL 8.4",
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

  ...versionedMutations
});

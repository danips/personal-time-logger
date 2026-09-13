import { getAllSettings } from "./db.js";
import { ERROR_CODE } from "./error-codes.js";
import { codedError } from "./coded-error.js";
import {
  createRemoteApiClient,
  normalizeRemoteApiBaseUrl,
  parseRemoteSnapshot,
  requireRemoteHealth,
  remoteHostPermission
} from "./remote-api-client.js";
import { createVersionedMutationOperations } from "./remote-versioned-mutations.js";
import { SETTING_KEY } from "./setting-keys.js";

export const DEFAULT_CLOUDFLARE_D1_API_BASE_URL = "";
const LABEL = "Cloudflare Worker + D1";
const ENTRY_REF_KIND = "cloudflare-d1-row";
const CONFIG_REF_KIND = "cloudflare-d1-config-row";
const CHUNK_SIZE = 15;
const MAX_REQUEST_BYTES = 480 * 1024;

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
  if (options.client) return options.client;
  if (options.baseUrl !== undefined && options.token !== undefined) {
    return createCloudflareD1ApiClient(options);
  }
  const settings = await getAllSettings();
  const baseUrl = options.baseUrl ?? settings[SETTING_KEY.CLOUDFLARE_D1_API_BASE_URL] ?? DEFAULT_CLOUDFLARE_D1_API_BASE_URL;
  const token = options.token ?? settings[SETTING_KEY.CLOUDFLARE_D1_API_TOKEN] ?? "";
  return createCloudflareD1ApiClient({ ...options, baseUrl, token });
}

function health(data) {
  return requireRemoteHealth(data, {
    providerLabel: LABEL,
    validateHealth: (value) => value.storage === "cloudflare-d1"
  });
}

const versionedMutations = createVersionedMutationOperations({
  configuredClient,
  chunkOptions: { maxBytes: MAX_REQUEST_BYTES, maxItems: CHUNK_SIZE },
  entryRefKind: ENTRY_REF_KIND
});

export const cloudflareD1Provider = Object.freeze({
  id: "cloudflare-d1",
  label: LABEL,
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

  ...versionedMutations
});

export { CHUNK_SIZE };

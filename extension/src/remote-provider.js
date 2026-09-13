import { getSetting } from "./db.js";
import { ERROR_CODE } from "./error-codes.js";
import { codedError } from "./coded-error.js";
import { mysqlProvider } from "./remote-mysql.js";
import { cloudflareD1Provider } from "./remote-cloudflare-d1.js";
import { SETTING_KEY } from "./setting-keys.js";

export const REMOTE_PROVIDER_ID = Object.freeze({
  MYSQL: "mysql",
  CLOUDFLARE_D1: "cloudflare-d1"
});

const PROVIDERS = new Map([
  [REMOTE_PROVIDER_ID.MYSQL, mysqlProvider],
  [REMOTE_PROVIDER_ID.CLOUDFLARE_D1, cloudflareD1Provider]
]);

export function decodeRemoteProviderId(value) {
  return String(value || "").trim();
}

export function getRemoteProvider(id = "") {
  const providerId = decodeRemoteProviderId(id);
  const provider = PROVIDERS.get(providerId);
  if (!provider) {
    throw codedError(
      ERROR_CODE.REMOTE_BACKEND_UNSUPPORTED,
      `Remote storage backend is not supported: ${providerId}`
    );
  }
  return provider;
}

export async function getActiveRemoteProvider() {
  return getRemoteProvider(await getSetting(SETTING_KEY.REMOTE_BACKEND, ""));
}

export function registeredRemoteProviderIds() {
  return [...PROVIDERS.keys()];
}

import { getSetting } from "./db.js";
import { ERROR_CODE } from "./error-codes.js";
import { googleSheetsProvider } from "./remote-google-sheets.js";
import { mysqlProvider } from "./remote-mysql.js";
import { cloudflareD1Provider } from "./remote-cloudflare-d1.js";
import { SETTING_KEY } from "./setting-keys.js";

export const REMOTE_PROVIDER_ID = Object.freeze({
  GOOGLE_SHEETS: "google-sheets",
  MYSQL: "mysql",
  CLOUDFLARE_D1: "cloudflare-d1"
});

const PROVIDERS = new Map([
  [REMOTE_PROVIDER_ID.GOOGLE_SHEETS, googleSheetsProvider],
  [REMOTE_PROVIDER_ID.MYSQL, mysqlProvider],
  [REMOTE_PROVIDER_ID.CLOUDFLARE_D1, cloudflareD1Provider]
]);
const KNOWN_ERROR_CODES = new Set(Object.values(ERROR_CODE));

function codedError(code, message) {
  if (!KNOWN_ERROR_CODES.has(code)) throw new TypeError(`Unknown extension error code: ${code}`);
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Missing and legacy installations continue to use Google Sheets. */
export function decodeRemoteProviderId(value) {
  const id = String(value || "").trim();
  return id || REMOTE_PROVIDER_ID.GOOGLE_SHEETS;
}

export function getRemoteProvider(id = REMOTE_PROVIDER_ID.GOOGLE_SHEETS) {
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

export function getRemoteProviderCapabilities(provider) {
  return Object.freeze({
    duplicateRemoteRecords: provider?.capabilities?.duplicateRemoteRecords === true
  });
}

export function registeredRemoteProviderIds() {
  return [...PROVIDERS.keys()];
}

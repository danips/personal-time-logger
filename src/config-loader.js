import { getSetting, removeSetting } from "./db.js";
import { platform } from "./platform.js";

const CLIENT_ID_KEY = "google_oauth_client_id";
const CLIENT_SECRET_KEY = "google_oauth_client_secret";
const CLIENT_CONFIG_KEYS = [CLIENT_ID_KEY, CLIENT_SECRET_KEY];

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  // Per-file Drive access, used only to read the spreadsheet's modifiedTime so an
  // unchanged sheet is not downloaded on every sync. The device authorization
  // flow accepts a fixed scope list that includes drive.file but not the broader
  // drive.metadata.readonly, which it rejects with invalid_scope. Access applies
  // to spreadsheets this extension created; for a spreadsheet ID pasted in by
  // hand Drive answers 404 and sync falls back to reading every cycle.
  "https://www.googleapis.com/auth/drive.file"
];

/**
 * Reads the OAuth config on every call. Caching it per context would leave
 * long-lived contexts such as the background page holding credentials that
 * Firefox Sync or the user had already replaced.
 */
export async function getOAuthClientCredentials() {
  const synced = await platform.getSyncedStorage(CLIENT_CONFIG_KEYS);
  const hasSyncedConfig = CLIENT_CONFIG_KEYS.some((key) => Object.hasOwn(synced, key));

  if (hasSyncedConfig) {
    return {
      clientId: String(synced[CLIENT_ID_KEY] || "").trim(),
      clientSecret: String(synced[CLIENT_SECRET_KEY] || "").trim()
    };
  }

  // Versions before sync storage kept these values in IndexedDB. Seed Firefox
  // Sync once, but only when neither synchronized key exists. Empty synchronized
  // keys are intentional and must not resurrect old local credentials.
  const clientId = String(await getSetting(CLIENT_ID_KEY, "") || "").trim();
  const clientSecret = String(await getSetting(CLIENT_SECRET_KEY, "") || "").trim();
  if (clientId || clientSecret) {
    await platform.setSyncedStorage({
      [CLIENT_ID_KEY]: clientId,
      [CLIENT_SECRET_KEY]: clientSecret
    });
    await Promise.all(CLIENT_CONFIG_KEYS.map((key) => removeSetting(key)));
  }

  return { clientId, clientSecret };
}

export async function setOAuthClientCredentials(clientId, clientSecret) {
  const normalized = {
    [CLIENT_ID_KEY]: String(clientId || "").trim(),
    [CLIENT_SECRET_KEY]: String(clientSecret || "").trim()
  };
  await platform.setSyncedStorage(normalized);
  await Promise.all(CLIENT_CONFIG_KEYS.map((key) => removeSetting(key)));
  return {
    clientId: normalized[CLIENT_ID_KEY],
    clientSecret: normalized[CLIENT_SECRET_KEY]
  };
}

export async function getConfig() {
  const { clientId, clientSecret } = await getOAuthClientCredentials();

  return {
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_SCOPES,
    configLoaded: Boolean(clientId || clientSecret)
  };
}

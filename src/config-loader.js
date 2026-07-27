import { getSetting } from "./db.js";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  // Read-only file metadata, used only to check the spreadsheet's modifiedTime so
  // an unchanged sheet is not downloaded on every sync. Sync degrades to
  // unconditional reads if this scope is not granted.
  "https://www.googleapis.com/auth/drive.metadata.readonly"
];

/**
 * Reads the OAuth config on every call. It is two IndexedDB reads, and caching
 * it per context left long-lived contexts such as the background page holding
 * credentials the user had already replaced.
 */
export async function getConfig() {
  const clientId = String(await getSetting("google_oauth_client_id", "") || "").trim();
  const clientSecret = String(await getSetting("google_oauth_client_secret", "") || "").trim();

  return {
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_SCOPES,
    configLoaded: Boolean(clientId || clientSecret)
  };
}

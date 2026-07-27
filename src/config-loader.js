import { getSetting } from "./db.js";

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

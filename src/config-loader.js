import { getSetting } from "./db.js";

const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

let cachedConfig = null;

export async function getConfig() {
  if (cachedConfig) return cachedConfig;

  const storedClientId = String(await getSetting("google_oauth_client_id", "") || "").trim();
  const storedClientSecret = String(await getSetting("google_oauth_client_secret", "") || "").trim();
  const useMockSheets = Boolean(await getSetting("use_mock_sheets", false));

  cachedConfig = {
    GOOGLE_CLIENT_ID: storedClientId,
    GOOGLE_CLIENT_SECRET: storedClientSecret,
    GOOGLE_SCOPES,
    USE_MOCK_SHEETS: useMockSheets,
    configLoaded: useMockSheets || Boolean(storedClientId || storedClientSecret)
  };

  return cachedConfig;
}

export function resetConfigCache() {
  cachedConfig = null;
}

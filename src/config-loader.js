import { platform } from "./platform.js";
import { getSetting } from "./db.js";

const DEFAULT_CONFIG = {
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  GOOGLE_SCOPES: ["https://www.googleapis.com/auth/spreadsheets"],
  USE_MOCK_SHEETS: false
};

let cachedConfig = null;

export async function getConfig() {
  if (cachedConfig) return cachedConfig;

  let fileConfig = null;
  try {
    const module = await import(platform.getURL("config.js"));
    fileConfig = {
      GOOGLE_CLIENT_ID: String(module.GOOGLE_CLIENT_ID || "").trim(),
      GOOGLE_CLIENT_SECRET: String(module.GOOGLE_CLIENT_SECRET || "").trim(),
      GOOGLE_SCOPES: Array.isArray(module.GOOGLE_SCOPES) && module.GOOGLE_SCOPES.length
        ? module.GOOGLE_SCOPES
        : DEFAULT_CONFIG.GOOGLE_SCOPES,
      USE_MOCK_SHEETS: Boolean(module.USE_MOCK_SHEETS)
    };
  } catch (error) {
    fileConfig = { ...DEFAULT_CONFIG };
  }

  const storedClientId = String(await getSetting("google_oauth_client_id", "") || "").trim();
  const storedClientSecret = String(await getSetting("google_oauth_client_secret", "") || "").trim();
  const usesStoredCredentials = Boolean(storedClientId || storedClientSecret);

  cachedConfig = {
    ...fileConfig,
    GOOGLE_CLIENT_ID: storedClientId || fileConfig.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: storedClientSecret || fileConfig.GOOGLE_CLIENT_SECRET,
    configLoaded: usesStoredCredentials || Boolean(
      fileConfig.GOOGLE_CLIENT_ID || fileConfig.GOOGLE_CLIENT_SECRET || fileConfig.USE_MOCK_SHEETS
    ),
    configSource: usesStoredCredentials ? "settings" : "file"
  };

  return cachedConfig;
}

export function resetConfigCache() {
  cachedConfig = null;
}

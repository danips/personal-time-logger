import { mutateSettings } from "./db.js";
import { SETTING_KEY } from "./setting-keys.js";

export const TOKEN_KEY = SETTING_KEY.GOOGLE_TOKEN_DATA;
export const AUTH_GENERATION_KEY = SETTING_KEY.AUTH_GENERATION;

function nextGeneration(settings) {
  const generation = Number(settings.get(AUTH_GENERATION_KEY) || 0) + 1;
  settings.set(AUTH_GENERATION_KEY, generation);
  return generation;
}

export async function getAuthSessionSnapshot() {
  return mutateSettings([TOKEN_KEY, AUTH_GENERATION_KEY], (settings) => ({
    tokenData: settings.get(TOKEN_KEY) || null,
    generation: Number(settings.get(AUTH_GENERATION_KEY) || 0)
  }));
}

export async function beginAuthSession() {
  return mutateSettings([AUTH_GENERATION_KEY], (settings) => nextGeneration(settings));
}

export async function replaceAuthToken(tokenData, { expectedGeneration, expectedRefreshToken } = {}) {
  return mutateSettings([TOKEN_KEY, AUTH_GENERATION_KEY], (settings) => {
    const current = settings.get(TOKEN_KEY) || null;
    const generation = Number(settings.get(AUTH_GENERATION_KEY) || 0);
    if (expectedGeneration !== undefined && generation !== Number(expectedGeneration)) {
      return { applied: false, tokenData: current, generation };
    }
    if (expectedRefreshToken !== undefined
      && String(current?.refresh_token || "") !== String(expectedRefreshToken || "")) {
      return { applied: false, tokenData: current, generation };
    }
    settings.set(TOKEN_KEY, tokenData);
    return { applied: true, tokenData, generation: nextGeneration(settings) };
  });
}

export async function clearAuthSession({ expectedGeneration, expectedRefreshToken } = {}) {
  return mutateSettings([TOKEN_KEY, AUTH_GENERATION_KEY], (settings) => {
    const current = settings.get(TOKEN_KEY) || null;
    const generation = Number(settings.get(AUTH_GENERATION_KEY) || 0);
    if (expectedGeneration !== undefined && generation !== Number(expectedGeneration)) return false;
    if (expectedRefreshToken !== undefined
      && String(current?.refresh_token || "") !== String(expectedRefreshToken || "")) return false;
    settings.delete(TOKEN_KEY);
    nextGeneration(settings);
    return true;
  });
}

export async function invalidateAuthSession() {
  return clearAuthSession();
}

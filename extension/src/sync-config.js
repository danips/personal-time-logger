import { getSetting, mutateSettings, setSetting } from "./db.js";
import { normalizeMultiplierText } from "./entries.js";
import { SETTING_KEY } from "./setting-keys.js";

const MULTIPLIER_KEY = SETTING_KEY.DURATION_MULTIPLIER;
const MULTIPLIER_UPDATED_KEY = SETTING_KEY.DURATION_MULTIPLIER_UPDATED_AT;
const MULTIPLIER_SYNCED_KEY = SETTING_KEY.DURATION_MULTIPLIER_SYNCED_AT;

export async function hasPendingConfig() {
  const localUpdatedAt = String(await getSetting(MULTIPLIER_UPDATED_KEY, "") || "");
  if (!localUpdatedAt) return false;
  return localUpdatedAt !== String(await getSetting(MULTIPLIER_SYNCED_KEY, "") || "");
}

/** Reconciles the duration multiplier in an already-read remote snapshot. */
export async function syncConfig(remoteConfig, configRefs, { lease, provider } = {}) {
  const remote = remoteConfig[MULTIPLIER_KEY];
  const remoteUpdatedAt = remote ? String(remote.updated_at || "") : "";
  const remoteValue = remote ? String(remote.value || "") : "";
  const normalizedRemote = remoteValue ? normalizeMultiplierText(remoteValue) : "";
  if (remote && (!normalizedRemote || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(remoteUpdatedAt)
    || new Date(remoteUpdatedAt).getTime() > Date.now())) {
    return { conflict: true, changed: false };
  }
  const localPair = await mutateSettings([MULTIPLIER_KEY, MULTIPLIER_UPDATED_KEY], (settings) => ({
    value: String(settings.get(MULTIPLIER_KEY) || "1"),
    updatedAt: String(settings.get(MULTIPLIER_UPDATED_KEY) || "")
  }));
  const localUpdatedAt = localPair.updatedAt;
  const localValue = localPair.value;

  if (remoteUpdatedAt && remoteUpdatedAt > localUpdatedAt) {
    await lease?.assert();
    const applied = await mutateSettings([MULTIPLIER_KEY, MULTIPLIER_UPDATED_KEY, MULTIPLIER_SYNCED_KEY], (settings) => {
      if (String(settings.get(MULTIPLIER_UPDATED_KEY) || "") > remoteUpdatedAt) return false;
      settings.set(MULTIPLIER_KEY, normalizedRemote);
      settings.set(MULTIPLIER_UPDATED_KEY, remoteUpdatedAt);
      settings.set(MULTIPLIER_SYNCED_KEY, remoteUpdatedAt);
      return true;
    });
    return { changed: Boolean(applied), pulled: Boolean(applied) };
  }

  if (!localUpdatedAt) return { changed: false };
  if (remoteUpdatedAt === localUpdatedAt && normalizedRemote !== normalizeMultiplierText(localValue)) return { conflict: true, changed: false };
  if (remoteUpdatedAt === localUpdatedAt && normalizedRemote === normalizeMultiplierText(localValue)) {
    await lease?.assert();
    await setSetting(MULTIPLIER_SYNCED_KEY, localUpdatedAt);
    return { changed: false };
  }

  await lease?.assert();
  await provider.updateConfig(MULTIPLIER_KEY, localValue, localUpdatedAt, {
    expectedRef: configRefs.get(MULTIPLIER_KEY),
  });
  await lease?.assert();
  await setSetting(MULTIPLIER_SYNCED_KEY, localUpdatedAt);
  return { changed: true, pushed: true };
}

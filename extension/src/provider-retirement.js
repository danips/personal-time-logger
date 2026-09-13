import { mutateSettings } from "./db.js";
import { platform } from "./platform.js";
import { SETTING_KEY } from "./setting-keys.js";

const RETIRED_PROVIDER = "google-sheets";

// These names intentionally remain raw compatibility keys. They are not part
// of the active setting registry and must only be removed by this scrub.
export const RETIRED_LOCAL_KEYS = Object.freeze([
  "auth_generation",
  "google_oauth_client_id",
  "google_oauth_client_secret",
  "token_data",
  "remote_change_token",
  "remote_modified_time",
  "spreadsheet_id",
  "spreadsheet_provision_pending",
  "time_entries_sheet_id"
]);
const RETIRED_SYNC_KEYS = Object.freeze([
  "google_oauth_client_id",
  "google_oauth_client_secret"
]);
const RETIRED_STATE_KEYS = Object.freeze([
  ...RETIRED_LOCAL_KEYS,
  SETTING_KEY.REMOTE_BACKEND,
  SETTING_KEY.REMOTE_BACKEND_ESTABLISHED,
  SETTING_KEY.STORAGE_MIGRATION_STATE,
  SETTING_KEY.RECONCILIATION_INTENTS
]);

function mentionsRetiredProvider(value) {
  return JSON.stringify(value || "").toLowerCase().includes(RETIRED_PROVIDER);
}

function scrubRetiredIntents(intents) {
  if (!Array.isArray(intents)) return intents;
  return intents.filter((intent) => !mentionsRetiredProvider(intent));
}

/** Remove unreachable Google state without reading or contacting a network. */
export async function retireGoogleState() {
  await mutateSettings(RETIRED_STATE_KEYS, (settings) => {
    const backend = String(settings.get(SETTING_KEY.REMOTE_BACKEND) || "").trim();
    const migration = settings.get(SETTING_KEY.STORAGE_MIGRATION_STATE);
    const intents = settings.get(SETTING_KEY.RECONCILIATION_INTENTS);
    const legacyUnconfigured = !backend || backend === RETIRED_PROVIDER;
    const retiredMigration = mentionsRetiredProvider(migration);
    const retiredIntents = mentionsRetiredProvider(intents);

    for (const key of RETIRED_LOCAL_KEYS) settings.delete(key);
    if (legacyUnconfigured) {
      settings.set(SETTING_KEY.REMOTE_BACKEND, "");
      settings.set(SETTING_KEY.REMOTE_BACKEND_ESTABLISHED, false);
    }
    if (retiredMigration) settings.delete(SETTING_KEY.STORAGE_MIGRATION_STATE);
    if (Array.isArray(intents)) {
      const scrubbed = scrubRetiredIntents(intents);
      if (scrubbed.length !== intents.length) settings.set(SETTING_KEY.RECONCILIATION_INTENTS, scrubbed);
    } else if (retiredIntents) {
      settings.delete(SETTING_KEY.RECONCILIATION_INTENTS);
    }
  });

  await platform.removeSyncedStorage(RETIRED_SYNC_KEYS);
}

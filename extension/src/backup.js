import { getBackupSnapshot, mutateAllLocalState } from "./db.js";
import { decodePersistedEntry } from "./entries.js";
import { entryFingerprint } from "./fingerprints.js";
import { ERROR_CODE } from "./error-codes.js";
import { BACKUP_SETTING_KEYS, normalizeBackupSettings } from "./options-settings.js";
import { SETTING_KEY } from "./setting-keys.js";
import { nowIso } from "./time.js";
import { notifyEntriesChanged } from "./events.js";

export const BACKUP_FORMAT = "personal-time-logger-backup";
export const BACKUP_SCHEMA_VERSION = 1;
export const MAX_BACKUP_BYTES = 128 * 1024 * 1024;

function backupError(message = "The backup operation could not complete.") {
  return Object.assign(new Error(message), { code: ERROR_CODE.BACKUP_INVALID });
}

export function assertBackupSize(bytes) {
  if (Number(bytes) > MAX_BACKUP_BYTES) {
    throw backupError("This backup exceeds the 128 MiB UTF-8 limit. Use a smaller exported backup or the documented alternate recovery path.");
  }
}

export function parseBackup(text) {
  assertBackupSize(new TextEncoder().encode(String(text)).byteLength);
  let value;
  try { value = JSON.parse(text); } catch { throw backupError(); }
  if (!value || value.format !== BACKUP_FORMAT || value.schema_version !== BACKUP_SCHEMA_VERSION
    || !Array.isArray(value.entries) || !value.settings || typeof value.settings !== "object" || Array.isArray(value.settings)) {
    throw backupError();
  }
  const ids = new Set();
  const entries = value.entries.map((entry) => {
    let decoded;
    try { decoded = decodePersistedEntry(entry); } catch { throw backupError(); }
    if (decoded.dirty || ids.has(decoded.id)) throw backupError();
    ids.add(decoded.id);
    return { ...decoded, dirty: false, last_sync_at: "", sync_error: "" };
  });
  let settings;
  try { settings = normalizeBackupSettings(value.settings); } catch { throw backupError(); }
  const appearance = value.appearance && typeof value.appearance === "object" && !Array.isArray(value.appearance)
    ? value.appearance : null;
  return { entries, settings, appearance };
}

export function serializeBackup({ entries, settings, appearance, exportedAt = nowIso() }) {
  const backup = { format: BACKUP_FORMAT, schema_version: BACKUP_SCHEMA_VERSION, exported_at: exportedAt, settings, appearance, entries };
  const text = `${JSON.stringify(backup, null, 2)}\n`;
  assertBackupSize(new TextEncoder().encode(text).byteLength);
  return text;
}

export async function readPortableBackupSnapshot() {
  const snapshot = await getBackupSnapshot([
    ...BACKUP_SETTING_KEYS, SETTING_KEY.DURATION_MULTIPLIER_UPDATED_AT
  ]);
  if (snapshot.entries.some((entry) => entry.dirty)) {
    throw Object.assign(new Error("The captured backup snapshot contains an unsynchronized edit. Synchronize again and retry."), { code: ERROR_CODE.BACKUP_NOT_SYNCED });
  }
  const settings = Object.fromEntries(BACKUP_SETTING_KEYS
    .filter((key) => Object.hasOwn(snapshot.settings, key))
    .map((key) => [key, snapshot.settings[key]]));
  return { entries: snapshot.entries, settings };
}

export async function restoreBackup(backup) {
  const summary = { added: 0, settingsChanged: 0, conflicts: [] };
  await mutateAllLocalState([...BACKUP_SETTING_KEYS, SETTING_KEY.DURATION_MULTIPLIER_UPDATED_AT], ({ entries, settings }) => {
    for (const [key, value] of Object.entries(backup.settings)) {
      if (JSON.stringify(settings.get(key)) !== JSON.stringify(value)) {
        settings.set(key, value);
        if (key === SETTING_KEY.DURATION_MULTIPLIER) settings.set(SETTING_KEY.DURATION_MULTIPLIER_UPDATED_AT, nowIso());
        summary.settingsChanged += 1;
      }
    }
    for (const entry of backup.entries) {
      const current = entries.get(entry.id);
      if (!current) { entries.set(entry.id, { ...entry, dirty: true }); summary.added += 1; }
      else if (entryFingerprint(current) !== entryFingerprint(entry)) summary.conflicts.push(entry.id);
    }
  });
  if (summary.added) notifyEntriesChanged({ action: "backup_restore", ids: backup.entries.map((entry) => entry.id) });
  return summary;
}

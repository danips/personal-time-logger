import { getBackupSnapshot, mutateAllLocalState } from "./db.js";
import { decodePersistedEntry } from "./entries.js";
import { entryFingerprint } from "./fingerprints.js";
import { ENTRY_FIELDS } from "./entry-contract.js";
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
    throw backupError("This backup exceeds the 128 MiB UTF-8 limit. Chunked import is not supported; use a smaller backup.");
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
  return { entries, settings };
}

function portableEntry(entry) {
  const canonical = decodePersistedEntry(entry);
  return { ...canonical, dirty: false, last_sync_at: "", sync_error: "" };
}

export function serializeBackup({ entries, settings, exportedAt = nowIso() }) {
  const backup = {
    format: BACKUP_FORMAT,
    schema_version: BACKUP_SCHEMA_VERSION,
    exported_at: exportedAt,
    settings,
    entries: entries.map(portableEntry)
  };
  const text = `${JSON.stringify(backup, null, 2)}\n`;
  assertBackupSize(new TextEncoder().encode(text).byteLength);
  return text;
}

export async function readPortableBackupSnapshot() {
  const snapshot = await getBackupSnapshot([
    ...BACKUP_SETTING_KEYS, SETTING_KEY.DURATION_MULTIPLIER_UPDATED_AT
  ]);
  const settings = Object.fromEntries(BACKUP_SETTING_KEYS
    .filter((key) => Object.hasOwn(snapshot.settings, key))
    .map((key) => [key, snapshot.settings[key]]));
  return { entries: snapshot.entries.map(portableEntry), settings };
}

function entryDifferences(local, incoming) {
  return ENTRY_FIELDS
    .filter((field) => local?.[field] !== incoming?.[field])
    .map((field) => ({ field, local: local?.[field], backup: incoming?.[field] }));
}

function backupSettingsKeys() {
  return [...BACKUP_SETTING_KEYS, SETTING_KEY.DURATION_MULTIPLIER_UPDATED_AT];
}

export async function previewBackup(backup) {
  const snapshot = await getBackupSnapshot(backupSettingsKeys());
  const localById = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  const additions = [];
  const identical = [];
  const conflicts = [];
  for (const entry of backup.entries) {
    const current = localById.get(entry.id);
    if (!current) additions.push(entry);
    else if (entryFingerprint(current) === entryFingerprint(entry)) identical.push(entry);
    else conflicts.push({ id: entry.id, local: current, backup: entry, differences: entryDifferences(current, entry) });
  }
  const settingsChanges = Object.entries(backup.settings)
    .filter(([key, value]) => JSON.stringify(snapshot.settings[key]) !== JSON.stringify(value))
    .map(([key, value]) => ({ key, current: snapshot.settings[key], backup: value }));
  return { additions, identical, conflicts, settingsChanges };
}

export async function restoreBackup(backup, { restoreSettings = true } = {}) {
  const summary = {
    added: 0,
    addedEntries: [],
    identical: 0,
    identicalEntries: [],
    settingsChanged: 0,
    settingsChanges: [],
    conflicts: [],
    conflictDetails: []
  };
  await mutateAllLocalState([
    ...BACKUP_SETTING_KEYS,
    SETTING_KEY.DURATION_MULTIPLIER_UPDATED_AT,
    SETTING_KEY.SYNC_RECOVERY_PENDING
  ], ({ entries, settings }) => {
    const pending = new Set(Array.isArray(settings.get(SETTING_KEY.SYNC_RECOVERY_PENDING))
      ? settings.get(SETTING_KEY.SYNC_RECOVERY_PENDING)
      : []);
    for (const [key, value] of Object.entries(restoreSettings ? backup.settings : {})) {
      const currentValue = settings.get(key);
      if (JSON.stringify(currentValue) !== JSON.stringify(value)) {
        settings.set(key, value);
        if (key === SETTING_KEY.DURATION_MULTIPLIER) settings.set(SETTING_KEY.DURATION_MULTIPLIER_UPDATED_AT, nowIso());
        summary.settingsChanged += 1;
        summary.settingsChanges.push({ key, current: currentValue, backup: value });
      }
    }
    for (const entry of backup.entries) {
      const current = entries.get(entry.id);
      if (!current) {
        entries.set(entry.id, { ...entry, dirty: true });
        pending.add(entry.id);
        summary.added += 1;
        summary.addedEntries.push(entry);
      }
      else if (entryFingerprint(current) !== entryFingerprint(entry)) {
        summary.conflicts.push(entry.id);
        summary.conflictDetails.push({ id: entry.id, local: current, backup: entry, differences: entryDifferences(current, entry) });
      } else {
        summary.identical += 1;
        summary.identicalEntries.push(entry);
      }
    }
    settings.set(SETTING_KEY.SYNC_RECOVERY_PENDING, [...pending]);
  });
  if (summary.added) notifyEntriesChanged({ action: "backup_restore", ids: backup.entries.map((entry) => entry.id) });
  return summary;
}

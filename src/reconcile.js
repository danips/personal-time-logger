import { getAllEntries, getEntry, mutateLocalState, putEntry, StorageConflictError } from "./db.js";
import { SHEET_HEADERS, entryToRow, normalizeEntry, softDeleteEntry } from "./entries.js";
import { notifyEntriesChanged } from "./events.js";
import { deleteRemoteRows, readRemoteSnapshot } from "./sheets.js";
import { nowIso } from "./time.js";

// Only the columns that live in the sheet are compared. dirty, last_sync_at and
// sync_error are local bookkeeping, so a difference there is not a divergence.
const COMPARED_FIELDS = SHEET_HEADERS.filter((field) => field !== "id");
export const RECONCILIATION_INTENTS_KEY = "reconciliation_intents";

export function entryFingerprint(entry) {
  return entryToRow(entry).join("\u0000");
}

/**
 * Fields where a local entry and its remote row disagree, compared through the
 * same row serialization sync uses, so what shows up here is exactly what a push
 * or pull would change.
 */
export function fieldDifferences(localEntry, remoteEntry) {
  const localRow = entryToRow(localEntry);
  const remoteRow = entryToRow(remoteEntry);

  return COMPARED_FIELDS.map((field) => {
    const index = SHEET_HEADERS.indexOf(field);
    return { field, local: localRow[index], remote: remoteRow[index] };
  }).filter((difference) => difference.local !== difference.remote);
}

function newerSide(localEntry, remoteEntry) {
  const local = String(localEntry.updated_at || "");
  const remote = String(remoteEntry.updated_at || "");
  if (local === remote) return "same";
  return local > remote ? "local" : "remote";
}

/**
 * Sorts every entry into in-sync, differing, local-only, or remote-only.
 * Pure, so the classification can be exercised without touching the network.
 */
export function compareEntries(localEntries, remoteEntries, duplicates = []) {
  const remoteById = new Map(remoteEntries.map((entry) => [entry.id, entry]));
  const localIds = new Set(localEntries.map((entry) => entry.id));

  const different = [];
  const localOnly = [];
  const remoteOnly = [];
  let inSync = 0;

  for (const local of localEntries) {
    const remote = remoteById.get(local.id);
    if (!remote) {
      localOnly.push({ id: local.id, local });
      continue;
    }

    const differences = fieldDifferences(local, remote);
    if (!differences.length) {
      inSync += 1;
      continue;
    }

    different.push({ id: local.id, local, remote, differences, newer: newerSide(local, remote) });
  }

  for (const remote of remoteEntries) {
    if (!localIds.has(remote.id)) remoteOnly.push({ id: remote.id, remote });
  }

  const duplicateRowCount = duplicates.reduce((total, item) => total + item.extraRowIndexes.length, 0);

  return {
    inSync,
    different,
    localOnly,
    remoteOnly,
    duplicates,
    localCount: localEntries.length,
    // Unique ids, which is what remoteEntries holds. Duplicate rows are counted
    // separately, otherwise the totals appear not to add up.
    remoteCount: remoteEntries.length,
    remoteRowCount: remoteEntries.length + duplicateRowCount,
    duplicateRowCount
  };
}

/**
 * Reads both sides and compares them. Read-only: nothing is pushed, pulled, or
 * resolved until the user picks a side.
 */
export async function loadReconciliation({ interactiveAuth = false } = {}) {
  const [localEntries, snapshot] = await Promise.all([
    getAllEntries(),
    readRemoteSnapshot({ interactiveAuth })
  ]);

  return {
    ...compareEntries(localEntries.map(normalizeEntry), snapshot.entries, snapshot.duplicates || []),
    scannedAt: nowIso()
  };
}

/**
 * Deletes the surplus rows for a duplicated id, keeping the one sync uses.
 *
 * This is the one resolution that writes to the sheet directly, because a
 * duplicate row has no local counterpart to mark and therefore nothing for sync
 * to carry.
 */
export async function deleteDuplicateRows(extraRows, { interactiveAuth = false } = {}) {
  if (!extraRows.length) return 0;
  await deleteRemoteRows(extraRows, { interactiveAuth });
  return extraRows.length;
}

/**
 * Flags the local copy for push without altering its contents. updated_at and
 * revision stay put, so choosing a side never looks like a fresh edit to the
 * other devices.
 */
export async function keepLocal(id, remoteEntry = null, { expectedRevision } = {}) {
  const entry = await mutateLocalState([RECONCILIATION_INTENTS_KEY], ({ entries, settings }) => {
    const existing = entries.get(id);
    if (!existing) throw new StorageConflictError("Entry no longer exists", { id, reason: "missing" });
    if (expectedRevision !== undefined && Number(existing.revision || 0) !== Number(expectedRevision)) {
      throw new StorageConflictError("Entry was changed in another context", {
        id,
        reason: "revision_mismatch",
        expectedRevision: Number(expectedRevision),
        actualRevision: Number(existing.revision || 0)
      });
    }

    const next = normalizeEntry({ ...existing, dirty: true, sync_error: "" });
    entries.set(id, next);
    if (remoteEntry) {
      const intents = Array.isArray(settings.get(RECONCILIATION_INTENTS_KEY))
        ? settings.get(RECONCILIATION_INTENTS_KEY)
        : [];
      const intent = {
        entry_id: id,
        chosen_side: "local",
        local_revision: Number(existing.revision || 0),
        remote_fingerprint: entryFingerprint(remoteEntry),
        resolution_id: `${id}:${existing.revision}:${remoteEntry.updated_at || ""}`
      };
      settings.set(RECONCILIATION_INTENTS_KEY, [
        ...intents.filter((candidate) => candidate && candidate.entry_id !== id),
        intent
      ]);
    }
    return next;
  });
  notifyEntriesChanged({ action: "reconcile", ids: [id] });
  return entry;
}

/**
 * Overwrites the local copy with the remote row and marks it clean, which is also
 * how a remote-only row is imported.
 */
export async function keepRemote(remoteEntry) {
  const entry = normalizeEntry({
    ...remoteEntry,
    dirty: false,
    last_sync_at: nowIso(),
    sync_error: ""
  });
  await putEntry(entry);
  notifyEntriesChanged({ action: "reconcile", ids: [entry.id] });
  return entry;
}

/**
 * Removes an entry from both sides. A remote-only row has to be imported first so
 * there is a local record to carry the tombstone that sync then pushes.
 */
export async function deleteEverywhere(id, remoteEntry = null) {
  if (!await getEntry(id)) {
    if (!remoteEntry) throw new Error("Entry not found");
    await keepRemote(remoteEntry);
  }
  return softDeleteEntry(id);
}

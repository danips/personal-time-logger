import { getAllEntries, getEntry, putEntry } from "./db.js";
import { SHEET_HEADERS, entryToRow, normalizeEntry, softDeleteEntry } from "./entries.js";
import { notifyEntriesChanged } from "./events.js";
import { readRemoteSnapshot } from "./sheets.js";
import { nowIso } from "./time.js";

// Only the columns that live in the sheet are compared. dirty, last_sync_at and
// sync_error are local bookkeeping, so a difference there is not a divergence.
const COMPARED_FIELDS = SHEET_HEADERS.filter((field) => field !== "id");

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
export function compareEntries(localEntries, remoteEntries) {
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

  return {
    inSync,
    different,
    localOnly,
    remoteOnly,
    localCount: localEntries.length,
    remoteCount: remoteEntries.length
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
    ...compareEntries(localEntries.map(normalizeEntry), snapshot.entries),
    scannedAt: nowIso()
  };
}

/**
 * Flags the local copy for push without altering its contents. updated_at and
 * revision stay put, so choosing a side never looks like a fresh edit to the
 * other devices.
 */
export async function keepLocal(id) {
  const existing = await getEntry(id);
  if (!existing) throw new Error("Entry not found");
  const entry = normalizeEntry({ ...existing, dirty: true, sync_error: "" });
  await putEntry(entry);
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

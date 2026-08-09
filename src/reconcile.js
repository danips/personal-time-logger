import { getAllEntries, mutateEntries, mutateLocalState, mutateSettings, StorageConflictError } from "./db.js";
import { SHEET_HEADERS, entryToRow, normalizeEntry } from "./entries.js";
import { notifyEntriesChanged } from "./events.js";
import { deleteRemoteRows, readRemoteSnapshot } from "./sheets.js";
import { nowIso } from "./time.js";

// Only the columns that live in the sheet are compared. dirty, last_sync_at and
// sync_error are local bookkeeping, so a difference there is not a divergence.
const COMPARED_FIELDS = SHEET_HEADERS.filter((field) => field !== "id");
export const RECONCILIATION_INTENTS_KEY = "reconciliation_intents";
export const STALE_RECONCILIATION_INTENTS_KEY = "stale_reconciliation_intents";
export const RECONCILIATION_INTENT_PENDING = "pending_remote_push";
export const RECONCILIATION_INTENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STALE_RECONCILIATION_INTENTS = 20;

export function entryFingerprint(entry) {
  return entryToRow(entry).join("\u0000");
}

function localResolutionIntent(entry, remoteEntry, now = Date.now()) {
  return {
    entry_id: entry.id,
    chosen_side: "local",
    state: RECONCILIATION_INTENT_PENDING,
    local_revision: Number(entry.revision || 0),
    remote_fingerprint: entryFingerprint(remoteEntry),
    resolution_id: `${entry.id}:${entry.revision}:${remoteEntry.updated_at || ""}`,
    created_at: new Date(now).toISOString(),
    expires_at: now + RECONCILIATION_INTENT_TTL_MS
  };
}

export function isPendingReconciliationIntent(intent, now = Date.now()) {
  return Boolean(intent
    && intent.chosen_side === "local"
    && intent.state === RECONCILIATION_INTENT_PENDING
    && typeof intent.resolution_id === "string"
    && Number.isFinite(Number(intent.expires_at))
    && Number(intent.expires_at) > now);
}

/** Moves expired/legacy intents to a small local diagnostic record. */
export async function pruneExpiredReconciliationIntents({ now = Date.now() } = {}) {
  return mutateSettings([RECONCILIATION_INTENTS_KEY, STALE_RECONCILIATION_INTENTS_KEY], (settings) => {
    const intents = Array.isArray(settings.get(RECONCILIATION_INTENTS_KEY))
      ? settings.get(RECONCILIATION_INTENTS_KEY)
      : [];
    const active = [];
    const stale = [];
    for (const intent of intents) {
      if (isPendingReconciliationIntent(intent, now)) active.push(intent);
      else if (intent?.entry_id || intent?.resolution_id) {
        stale.push({
          entry_id: String(intent.entry_id || ""),
          resolution_id: String(intent.resolution_id || ""),
          state: String(intent.state || "legacy"),
          expired_at: new Date(now).toISOString()
        });
      }
    }
    settings.set(RECONCILIATION_INTENTS_KEY, active);
    if (stale.length) {
      const previous = Array.isArray(settings.get(STALE_RECONCILIATION_INTENTS_KEY))
        ? settings.get(STALE_RECONCILIATION_INTENTS_KEY)
        : [];
      settings.set(STALE_RECONCILIATION_INTENTS_KEY, [
        ...previous,
        ...stale
      ].slice(-MAX_STALE_RECONCILIATION_INTENTS));
    }
    return stale;
  });
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
  if (local === remote) return entryFingerprint(localEntry) === entryFingerprint(remoteEntry) ? "same" : "conflict";
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
    const intents = Array.isArray(settings.get(RECONCILIATION_INTENTS_KEY))
      ? settings.get(RECONCILIATION_INTENTS_KEY)
      : [];
    const nextIntents = intents.filter((candidate) => candidate && candidate.entry_id !== id);
    if (remoteEntry) nextIntents.push(localResolutionIntent(existing, remoteEntry));
    settings.set(RECONCILIATION_INTENTS_KEY, nextIntents);
    return next;
  });
  notifyEntriesChanged({ action: "reconcile", ids: [id] });
  return entry;
}

function batchResolutionError(message) {
  const error = new TypeError(message);
  error.code = "RECONCILIATION_BATCH_INVALID";
  return error;
}

function normalizeBatchResolution(resolution) {
  const action = String(resolution?.action || "");
  const remoteEntry = resolution?.remoteEntry || null;
  const id = String(resolution?.id || remoteEntry?.id || "");
  if (!["keepLocal", "keepRemote", "deleteEverywhere"].includes(action) || !id) {
    throw batchResolutionError("Each bulk reconciliation item needs an action and entry id.");
  }
  if (remoteEntry && remoteEntry.id !== id) {
    throw batchResolutionError("A bulk reconciliation item has mismatched local and remote ids.");
  }
  if ((action === "keepRemote" || action === "deleteEverywhere") && !remoteEntry) {
    throw batchResolutionError(`${action} requires the remote entry shown in the reconciliation report.`);
  }
  if (action === "keepLocal" && resolution.expectedRevision === undefined) {
    throw batchResolutionError("Bulk local resolutions require the revision shown in the reconciliation report.");
  }
  return {
    action,
    id,
    remoteEntry,
    expectedRevision: resolution.expectedRevision,
    expectedLocalRevision: resolution.expectedLocalRevision,
    expectedRemoteFingerprint: resolution.expectedRemoteFingerprint
      || (remoteEntry ? entryFingerprint(remoteEntry) : "")
  };
}

async function verifyBatchRemoteResolutions(resolutions, { interactiveAuth = false } = {}) {
  const snapshot = await readRemoteSnapshot({ interactiveAuth });
  const remoteById = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  for (const resolution of resolutions) {
    const current = remoteById.get(resolution.id) || null;
    if (resolution.expectedRemoteFingerprint) {
      if (!current || entryFingerprint(current) !== resolution.expectedRemoteFingerprint) {
        throw new StorageConflictError("Spreadsheet row changed since reconciliation", {
          id: resolution.id,
          reason: "remote_fingerprint_mismatch"
        });
      }
    } else if (current) {
      throw new StorageConflictError("Spreadsheet row appeared since reconciliation", {
        id: resolution.id,
        reason: "remote_unexpected"
      });
    }
  }
  return remoteById;
}

function assertBatchLocalRevision(existing, id, expectedRevision, { absentOnly = false } = {}) {
  if (absentOnly) {
    if (!existing) return;
    throw new StorageConflictError("Entry changed since reconciliation", {
      id,
      reason: "revision_mismatch",
      expectedRevision: undefined,
      actualRevision: Number(existing.revision || 0)
    });
  }
  if (!existing) {
    throw new StorageConflictError("Entry no longer exists", { id, reason: "missing" });
  }
  if (Number(existing.revision || 0) !== Number(expectedRevision)) {
    throw new StorageConflictError("Entry changed since reconciliation", {
      id,
      reason: "revision_mismatch",
      expectedRevision: Number(expectedRevision),
      actualRevision: Number(existing.revision || 0)
    });
  }
}

/**
 * Applies a set of choices from one reconciliation report. The remote rows are
 * all checked from one snapshot before a single local transaction validates the
 * displayed revisions and records every local consequence. Remote state can
 * still change after the snapshot, so the returned result is explicit per id;
 * the forced sync that follows remains responsible for the remote commit.
 */
export async function resolveReconciliationBatch(items, { interactiveAuth = false } = {}) {
  const resolutions = items.map(normalizeBatchResolution);
  if (!resolutions.length) return { results: [] };
  const ids = new Set();
  for (const resolution of resolutions) {
    if (ids.has(resolution.id)) throw batchResolutionError(`Entry ${resolution.id} was selected more than once.`);
    ids.add(resolution.id);
  }

  const remoteById = await verifyBatchRemoteResolutions(resolutions, { interactiveAuth });
  const results = await mutateLocalState([RECONCILIATION_INTENTS_KEY], ({ entries, settings }) => {
    const intents = Array.isArray(settings.get(RECONCILIATION_INTENTS_KEY))
      ? settings.get(RECONCILIATION_INTENTS_KEY)
      : [];
    const nextIntents = intents.filter((intent) => !ids.has(intent?.entry_id));
    const applied = [];

    for (const resolution of resolutions) {
      const existing = entries.get(resolution.id);
      const verifiedRemote = remoteById.get(resolution.id) || null;
      let next;
      if (resolution.action === "keepLocal") {
        assertBatchLocalRevision(existing, resolution.id, resolution.expectedRevision);
        next = normalizeEntry({ ...existing, dirty: true, sync_error: "" });
        entries.set(resolution.id, next);
        if (verifiedRemote) {
          nextIntents.push(localResolutionIntent(existing, verifiedRemote));
        }
      } else if (resolution.action === "keepRemote") {
        assertBatchLocalRevision(existing, resolution.id, resolution.expectedLocalRevision, {
          absentOnly: resolution.expectedLocalRevision === undefined
        });
        next = normalizeEntry({ ...verifiedRemote, dirty: false, last_sync_at: nowIso(), sync_error: "" });
        entries.set(resolution.id, next);
      } else {
        if (resolution.expectedLocalRevision === undefined) {
          assertBatchLocalRevision(existing, resolution.id, undefined, { absentOnly: true });
        } else {
          assertBatchLocalRevision(existing, resolution.id, resolution.expectedLocalRevision);
        }
        const source = existing || verifiedRemote;
        const timestamp = nowIso();
        next = normalizeEntry({
          ...source,
          deleted_at: timestamp,
          updated_at: timestamp,
          revision: Number(source.revision || 0) + 1,
          dirty: true,
          sync_error: ""
        });
        entries.set(resolution.id, next);
      }
      applied.push({ id: resolution.id, action: resolution.action, status: "applied", entry: next });
    }
    settings.set(RECONCILIATION_INTENTS_KEY, nextIntents);
    return applied;
  });
  notifyEntriesChanged({ action: "reconcile", ids: [...ids] });
  return { results };
}

async function verifyReconciliationRemote(id, expectedRemoteFingerprint, { interactiveAuth = false } = {}) {
  const snapshot = await readRemoteSnapshot({ interactiveAuth });
  const current = snapshot.entries.find((entry) => entry.id === id) || null;
  if (expectedRemoteFingerprint) {
    if (!current || entryFingerprint(current) !== expectedRemoteFingerprint) {
      throw new StorageConflictError("Spreadsheet row changed since reconciliation", { id, reason: "remote_fingerprint_mismatch" });
    }
  } else if (current) {
    throw new StorageConflictError("Spreadsheet row appeared since reconciliation", { id, reason: "remote_unexpected" });
  }
  return current;
}

/**
 * Overwrites the local copy with the remote row and marks it clean, which is also
 * how a remote-only row is imported.
 */
export async function keepRemote(remoteEntry, { expectedLocalRevision, expectedRemoteFingerprint = entryFingerprint(remoteEntry) } = {}) {
  const verifiedRemote = await verifyReconciliationRemote(remoteEntry.id, expectedRemoteFingerprint);
  const entry = await mutateLocalState([RECONCILIATION_INTENTS_KEY], ({ entries, settings }) => {
    const existing = entries.get(remoteEntry.id);
    if (expectedLocalRevision === undefined ? Boolean(existing) : Number(existing?.revision || 0) !== Number(expectedLocalRevision)) {
      throw new StorageConflictError("Entry changed since reconciliation", { id: remoteEntry.id, reason: "revision_mismatch" });
    }
    const next = normalizeEntry({ ...verifiedRemote, dirty: false, last_sync_at: nowIso(), sync_error: "" });
    entries.set(next.id, next);
    const intents = Array.isArray(settings.get(RECONCILIATION_INTENTS_KEY))
      ? settings.get(RECONCILIATION_INTENTS_KEY)
      : [];
    settings.set(RECONCILIATION_INTENTS_KEY, intents.filter((intent) => intent?.entry_id !== remoteEntry.id));
    return next;
  });
  notifyEntriesChanged({ action: "reconcile", ids: [entry.id] });
  return entry;
}

/**
 * Removes an entry from both sides by transactionally creating a local tombstone
 * that sync then pushes. A remote-only row is never persisted as a clean import.
 */
export async function deleteEverywhere(id, remoteEntry = null, { expectedLocalRevision, expectedRemoteFingerprint = remoteEntry ? entryFingerprint(remoteEntry) : "" } = {}) {
  const verifiedRemote = await verifyReconciliationRemote(id, expectedRemoteFingerprint);
  const entry = await mutateLocalState([RECONCILIATION_INTENTS_KEY], ({ entries, settings }) => {
    const existing = entries.get(id);
    if (expectedLocalRevision === undefined ? Boolean(existing) : Number(existing?.revision || 0) !== Number(expectedLocalRevision)) {
      throw new StorageConflictError("Entry changed since reconciliation", { id, reason: "revision_mismatch" });
    }
    const source = existing || verifiedRemote;
    if (!source) throw new StorageConflictError("Entry no longer exists", { id, reason: "missing" });
    const timestamp = nowIso();
    const next = normalizeEntry({ ...source, deleted_at: timestamp, updated_at: timestamp, revision: Number(source.revision || 0) + 1, dirty: true, sync_error: "" });
    entries.set(id, next);
    const intents = Array.isArray(settings.get(RECONCILIATION_INTENTS_KEY))
      ? settings.get(RECONCILIATION_INTENTS_KEY)
      : [];
    settings.set(RECONCILIATION_INTENTS_KEY, intents.filter((intent) => intent?.entry_id !== id));
    return next;
  });
  notifyEntriesChanged({ action: "reconcile", ids: [id] });
  return entry;
}

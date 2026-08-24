import { getAllEntries, mutateEntryState, mutateSettings, StorageConflictError } from "./db.js";
import { SHEET_HEADERS, entryToRow, normalizeEntry } from "./entries.js";
import { notifyEntriesChanged } from "./events.js";
import { getActiveRemoteProvider, getRemoteProviderCapabilities } from "./remote-provider.js";
import { nowIso, uuid } from "./time.js";
import { recordDiagnostic } from "./diagnostics.js";
import { ERROR_CODE } from "./error-codes.js";
import { RECONCILIATION_INTENT_STATE } from "./operation-states.js";
import { SETTING_KEY } from "./setting-keys.js";

// Only the columns that live in the sheet are compared. dirty, last_sync_at and
// sync_error are local bookkeeping, so a difference there is not a divergence.
const COMPARED_FIELDS = SHEET_HEADERS.filter((field) => field !== "id");
export const RECONCILIATION_INTENTS_KEY = SETTING_KEY.RECONCILIATION_INTENTS;
export const STALE_RECONCILIATION_INTENTS_KEY = SETTING_KEY.STALE_RECONCILIATION_INTENTS;
export const RECONCILIATION_INTENT_PENDING = RECONCILIATION_INTENT_STATE.PENDING_REMOTE_PUSH;
export const RECONCILIATION_INTENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STALE_RECONCILIATION_INTENTS = 20;

async function activeProvider(provider) {
  return provider || getActiveRemoteProvider();
}

export function entryFingerprint(entry) {
  return entryToRow(entry).join("\u0000");
}

function presentExpectation(revision) {
  return revision === undefined
    ? { kind: "present" }
    : { kind: "present", revision: Number(revision) };
}

function remoteExpectation(remoteEntry, fingerprint) {
  const expected = fingerprint ?? (remoteEntry ? entryFingerprint(remoteEntry) : "");
  return expected ? { kind: "present", fingerprint: expected } : { kind: "absent" };
}

/** Converts singular UI arguments and bulk row commands into one explicit model. */
export function normalizeReconciliationCommand(input, { batch = false } = {}) {
  const action = String(input?.action || "");
  const remoteEntry = input?.remoteEntry || null;
  const id = String(input?.id || remoteEntry?.id || "");
  if (!["keepLocal", "keepRemote", "deleteEverywhere"].includes(action) || !id) {
    throw batchResolutionError("Each reconciliation item needs an action and entry id.");
  }
  if (remoteEntry && remoteEntry.id !== id) {
    throw batchResolutionError("A reconciliation item has mismatched local and remote ids.");
  }
  if ((action === "keepRemote" || (batch && action === "deleteEverywhere")) && !remoteEntry) {
    throw batchResolutionError(`${action} requires the remote entry shown in the reconciliation report.`);
  }
  if (batch && action === "keepLocal" && input.expectedRevision === undefined) {
    throw batchResolutionError("Bulk local resolutions require the revision shown in the reconciliation report.");
  }

  const localRevision = action === "keepLocal" ? input.expectedRevision : input.expectedLocalRevision;
  const local = action === "keepLocal"
    ? presentExpectation(localRevision)
    : localRevision === undefined
      ? { kind: "absent" }
      : presentExpectation(localRevision);
  const expectedFingerprint = input.expectedRemoteFingerprint
    ?? (remoteEntry ? entryFingerprint(remoteEntry) : "");
  return {
    action,
    id,
    local,
    remote: remoteExpectation(remoteEntry, expectedFingerprint),
    reportedRemote: remoteEntry
  };
}

function localResolutionIntent(entry, remoteEntry, now = Date.now()) {
  return {
    entry_id: entry.id,
    chosen_side: "local",
    state: RECONCILIATION_INTENT_PENDING,
    local_revision: Number(entry.revision || 0),
    remote_fingerprint: entryFingerprint(remoteEntry),
    // This identifies one specific choice while its forced remote push is in
    // flight. It must not be derived from the entry revision or remote row:
    // either can be the same when a user chooses again before sync completes.
    resolution_id: uuid(),
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
  const stale = await mutateSettings([RECONCILIATION_INTENTS_KEY, STALE_RECONCILIATION_INTENTS_KEY], (settings) => {
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
  if (stale.length) {
    await recordDiagnostic({
      subsystem: "reconciliation",
      phase: "intent_expiry",
      code: "RECONCILIATION_INTENT_EXPIRED",
      entryCount: stale.length,
      recovery: "Rescan reconciliation before choosing a side."
    });
  }
  return stale;
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
export async function loadReconciliation({ interactiveAuth = false, provider } = {}) {
  const remoteProvider = provider || await getActiveRemoteProvider();
  const [localEntries, snapshot] = await Promise.all([
    getAllEntries(),
    remoteProvider.readSnapshot({ interactiveAuth })
  ]);

  return {
    ...compareEntries(localEntries.map(normalizeEntry), snapshot.entries, snapshot.duplicates || []),
    provider: {
      id: String(remoteProvider.id || ""),
      label: String(remoteProvider.label || remoteProvider.id || "Remote storage"),
      capabilities: getRemoteProviderCapabilities(remoteProvider)
    },
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
export async function deleteDuplicateRows(extraRows, { interactiveAuth = false, provider } = {}) {
  if (!extraRows.length) return 0;
  const remoteProvider = await activeProvider(provider);
  await remoteProvider.deleteEntries(extraRows.map((row) => ({
    id: row.id,
    expectedRef: row.ref
  })), { interactiveAuth });
  return extraRows.length;
}

function assertLocalExpectation(existing, command) {
  if (command.local.kind === "absent") {
    if (!existing) return;
    throw new StorageConflictError("Entry changed since reconciliation", {
      id: command.id,
      reason: "revision_mismatch",
      expectedRevision: undefined,
      actualRevision: Number(existing.revision || 0)
    });
  }
  if (!existing) {
    throw new StorageConflictError("Entry no longer exists", { id: command.id, reason: "missing" });
  }
  if (command.local.revision !== undefined
    && Number(existing.revision || 0) !== command.local.revision) {
    throw new StorageConflictError("Entry changed since reconciliation", {
      id: command.id,
      reason: "revision_mismatch",
      expectedRevision: command.local.revision,
      actualRevision: Number(existing.revision || 0)
    });
  }
}

function assertRemoteExpectation(current, command) {
  if (command.remote.kind === "present") {
    if (!current || entryFingerprint(current) !== command.remote.fingerprint) {
      throw new StorageConflictError("Remote entry changed since reconciliation", {
        id: command.id,
        reason: "remote_fingerprint_mismatch"
      });
    }
    return;
  }
  if (current) {
    throw new StorageConflictError("Remote entry appeared since reconciliation", {
      id: command.id,
      reason: "remote_unexpected"
    });
  }
}

function replaceReconciliationIntent(settings, id, intent = null) {
  const intents = Array.isArray(settings.get(RECONCILIATION_INTENTS_KEY))
    ? settings.get(RECONCILIATION_INTENTS_KEY)
    : [];
  const next = intents.filter((candidate) => candidate?.entry_id !== id);
  if (intent) next.push(intent);
  settings.set(RECONCILIATION_INTENTS_KEY, next);
}

/** Single local transition owner for singular and bulk reconciliation commands. */
function applyReconciliationCommand(command, { entries, settings, remoteEntry = null } = {}) {
  const existing = entries.get(command.id);
  assertLocalExpectation(existing, command);
  let next;

  if (command.action === "keepLocal") {
    next = normalizeEntry({ ...existing, dirty: true, sync_error: "" });
    entries.set(command.id, next);
    const intentRemote = remoteEntry || command.reportedRemote;
    replaceReconciliationIntent(
      settings,
      command.id,
      intentRemote ? localResolutionIntent(existing, intentRemote) : null
    );
    return next;
  }

  if (command.action === "keepRemote") {
    next = normalizeEntry({ ...remoteEntry, dirty: false, last_sync_at: nowIso(), sync_error: "" });
    entries.set(command.id, next);
    replaceReconciliationIntent(settings, command.id);
    return next;
  }

  const source = existing || remoteEntry;
  if (!source) throw new StorageConflictError("Entry no longer exists", { id: command.id, reason: "missing" });
  const timestamp = nowIso();
  next = normalizeEntry({
    ...source,
    deleted_at: timestamp,
    updated_at: timestamp,
    revision: Number(source.revision || 0) + 1,
    dirty: true,
    sync_error: ""
  });
  entries.set(command.id, next);
  replaceReconciliationIntent(settings, command.id);
  return next;
}

/**
 * Flags the local copy for push without altering its contents. updated_at and
 * revision stay put, so choosing a side never looks like a fresh edit to the
 * other devices.
 */
export async function keepLocal(id, remoteEntry = null, { expectedRevision } = {}) {
  const command = normalizeReconciliationCommand({
    action: "keepLocal",
    id,
    remoteEntry,
    expectedRevision
  });
  const entry = await mutateEntryState({
    entryIds: [command.id],
    settingKeys: [RECONCILIATION_INTENTS_KEY]
  }, ({ entries, settings }) => {
    return applyReconciliationCommand(command, { entries, settings });
  });
  notifyEntriesChanged({ action: "reconcile", ids: [command.id] });
  return entry;
}

function batchResolutionError(message) {
  const error = new TypeError(message);
  error.code = ERROR_CODE.RECONCILIATION_BATCH_INVALID;
  return error;
}

function normalizeBatchResolution(resolution) {
  return normalizeReconciliationCommand(resolution, { batch: true });
}

async function verifyBatchRemoteResolutions(resolutions, { interactiveAuth = false, provider } = {}) {
  const remoteProvider = await activeProvider(provider);
  const snapshot = await remoteProvider.readSnapshot({ interactiveAuth });
  const remoteById = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  for (const resolution of resolutions) {
    const current = remoteById.get(resolution.id) || null;
    assertRemoteExpectation(current, resolution);
  }
  return remoteById;
}

/**
 * Applies a set of choices from one reconciliation report. The remote rows are
 * all checked from one snapshot before a single local transaction validates the
 * displayed revisions and records every local consequence. Remote state can
 * still change after the snapshot, so the returned result is explicit per id;
 * the forced sync that follows remains responsible for the remote commit.
 */
export async function resolveReconciliationBatch(items, { interactiveAuth = false, provider } = {}) {
  const resolutions = items.map(normalizeBatchResolution);
  if (!resolutions.length) return { results: [] };
  const ids = new Set();
  for (const resolution of resolutions) {
    if (ids.has(resolution.id)) throw batchResolutionError(`Entry ${resolution.id} was selected more than once.`);
    ids.add(resolution.id);
  }

  const remoteById = await verifyBatchRemoteResolutions(resolutions, { interactiveAuth, provider });
  const results = await mutateEntryState({
    entryIds: ids,
    settingKeys: [RECONCILIATION_INTENTS_KEY]
  }, ({ entries, settings }) => {
    const intents = Array.isArray(settings.get(RECONCILIATION_INTENTS_KEY))
      ? settings.get(RECONCILIATION_INTENTS_KEY)
      : [];
    settings.set(RECONCILIATION_INTENTS_KEY, intents);
    const applied = [];

    for (const resolution of resolutions) {
      const verifiedRemote = remoteById.get(resolution.id) || null;
      const next = applyReconciliationCommand(resolution, {
        entries,
        settings,
        remoteEntry: verifiedRemote
      });
      applied.push({ id: resolution.id, action: resolution.action, status: "applied", entry: next });
    }
    return applied;
  });
  notifyEntriesChanged({ action: "reconcile", ids: [...ids] });
  return { results };
}

async function verifyReconciliationRemote(command, { interactiveAuth = false, provider } = {}) {
  const remoteProvider = await activeProvider(provider);
  const snapshot = await remoteProvider.readSnapshot({ interactiveAuth });
  const current = snapshot.entries.find((entry) => entry.id === command.id) || null;
  assertRemoteExpectation(current, command);
  return current;
}

/**
 * Overwrites the local copy with the remote row and marks it clean, which is also
 * how a remote-only row is imported.
 */
export async function keepRemote(remoteEntry, {
  expectedLocalRevision,
  expectedRemoteFingerprint = entryFingerprint(remoteEntry),
  provider
} = {}) {
  const command = normalizeReconciliationCommand({
    action: "keepRemote",
    id: remoteEntry.id,
    remoteEntry,
    expectedLocalRevision,
    expectedRemoteFingerprint
  });
  const verifiedRemote = await verifyReconciliationRemote(command, { provider });
  const entry = await mutateEntryState({
    entryIds: [command.id],
    settingKeys: [RECONCILIATION_INTENTS_KEY]
  }, ({ entries, settings }) => {
    return applyReconciliationCommand(command, { entries, settings, remoteEntry: verifiedRemote });
  });
  notifyEntriesChanged({ action: "reconcile", ids: [entry.id] });
  return entry;
}

/**
 * Removes an entry from both sides by transactionally creating a local tombstone
 * that sync then pushes. A remote-only row is never persisted as a clean import.
 */
export async function deleteEverywhere(id, remoteEntry = null, {
  expectedLocalRevision,
  expectedRemoteFingerprint = remoteEntry ? entryFingerprint(remoteEntry) : "",
  provider
} = {}) {
  const command = normalizeReconciliationCommand({
    action: "deleteEverywhere",
    id,
    remoteEntry,
    expectedLocalRevision,
    expectedRemoteFingerprint
  });
  const verifiedRemote = await verifyReconciliationRemote(command, { provider });
  const entry = await mutateEntryState({
    entryIds: [command.id],
    settingKeys: [RECONCILIATION_INTENTS_KEY]
  }, ({ entries, settings }) => {
    return applyReconciliationCommand(command, { entries, settings, remoteEntry: verifiedRemote });
  });
  notifyEntriesChanged({ action: "reconcile", ids: [command.id] });
  return entry;
}

import { claimLock, getAllEntries, getEntry, isLockCurrent, mutateAllLocalState, mutateEntries, mutateSettings, releaseLock, renewLock, setSetting, getSetting, StorageConflictError } from "./db.js";
import {
  appendRemoteEntries,
  deleteRemoteRows,
  ensureAppMarker,
  getRemoteModifiedTime,
  getDriveGateDiagnostics,
  getSpreadsheetId,
  isSpreadsheetGone,
  provisionSpreadsheet,
  readRemoteSnapshot,
  updateRemoteConfig,
  updateRemoteEntries
} from "./sheets.js";
import { notifyEntriesChanged } from "./events.js";
import {
  entryFingerprint,
  isPendingReconciliationIntent,
  pruneExpiredReconciliationIntents,
  RECONCILIATION_INTENTS_KEY
} from "./reconcile.js";
import { hasEqualTimestampConflict, isRemoteNewer, normalizeEntry } from "./entries.js";
import { recordDiagnostic } from "./diagnostics.js";
import { ERROR_CODE } from "./error-codes.js";
import { addDays, nowIso, uuid } from "./time.js";

import { platform } from "./platform.js";
import { SETTING_KEY } from "./setting-keys.js";

const MAX_BACKOFF_SECONDS = 300;
const SYNC_LOCK_KEY = "sync_lock";
const SYNC_LOCK_TTL_MS = 120000;
const REMOTE_MODIFIED_KEY = SETTING_KEY.REMOTE_MODIFIED_TIME;
const MULTIPLIER_KEY = SETTING_KEY.DURATION_MULTIPLIER;
const MULTIPLIER_UPDATED_KEY = SETTING_KEY.DURATION_MULTIPLIER_UPDATED_AT;
const MULTIPLIER_SYNCED_KEY = SETTING_KEY.DURATION_MULTIPLIER_SYNCED_AT;
const IDLE_STREAK_KEY = SETTING_KEY.SYNC_IDLE_STREAK;
// Multipliers applied to the configured interval as idle cycles accumulate.
const IDLE_BACKOFF_STEPS = [1, 2, 5, 10];
const MAX_IDLE_INTERVAL_MINUTES = 15;
const PULL_MUTATION_BATCH_SIZE = 250;

// Identifies this module instance, which is one per extension context (popup,
// calendar page, background). Used as the sync lock holder.
const CONTEXT_ID = uuid();
let inFlightSync = null;
let inFlightOptions = null;
let currentSync = null;
let queuedSync = null;
let queuedOptions = null;
const KNOWN_ERROR_CODES = new Set(Object.values(ERROR_CODE));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function codedError(code, message) {
  if (!KNOWN_ERROR_CODES.has(code)) throw new TypeError(`Unknown extension error code: ${code}`);
  const error = new Error(message);
  error.code = code;
  return error;
}

function syncRecovery(error) {
  if (["AUTH_REQUIRED", "AUTH_EXPIRED", "SCOPE_MISSING"].includes(error?.code)) {
    return "Open Options and sign in again.";
  }
  if (["SHEET_MISSING", "SPREADSHEET_MISSING", "SHEET_SCHEMA_UNSUPPORTED"].includes(error?.code)) {
    return "Open Options to reconnect or replace the spreadsheet.";
  }
  if (error?.code === "SYNC_BUSY") return "Retry after the other sync finishes.";
  if (["RATE_LIMIT", "API_TIMEOUT", "API_NETWORK", "OFFLINE", "BACKOFF"].includes(error?.code)) {
    return "Wait for the retry deadline, then sync again.";
  }
  return "Retry the sync. Open Options diagnostics if it continues.";
}

async function recordSyncDiagnostic(phase, error, entryCount = 0, retryAt = 0) {
  try {
    await recordDiagnostic({
      subsystem: "sync",
      phase,
      error,
      entryCount,
      retryAt,
      recovery: syncRecovery(error)
    });
  } catch {
    // A diagnostic must never hide the original sync failure.
  }
}

/**
 * Clears the dirty flag for an entry that was just pushed. The push snapshot can
 * be stale by the time the request returns, so an entry edited mid-flight is
 * left dirty for the next cycle rather than being overwritten.
 */
export async function markSynced(entry, { lease } = {}) {
  try {
    await lease?.assert();
    return await mutateEntries([entry.id], { [entry.id]: Number(entry.revision || 0) }, (entries) => {
      const current = entries.get(entry.id);
      if (!current || entryFingerprint(current) !== entryFingerprint(entry)) {
        return { entry: current || null, applied: false };
      }
      const clean = normalizeEntry({
        ...current,
        dirty: false,
        last_sync_at: nowIso(),
        sync_error: ""
      });
      entries.set(entry.id, clean);
      return { entry: clean, applied: true };
    });
  } catch (error) {
    if (!(error instanceof StorageConflictError)) throw error;
    return { entry: (await getEntry(entry.id)) || null, applied: false };
  }
}

async function recordBackoff(error) {
  if (!["RATE_LIMIT", "API_ERROR", "API_TIMEOUT", "API_NETWORK", "OFFLINE"].includes(error.code)) return 0;
  const current = Number(await getSetting(SETTING_KEY.SYNC_BACKOFF_SECONDS, 0)) || 0;
  const next = current ? Math.min(current * 2, MAX_BACKOFF_SECONDS) : 30;
  const retryAt = Date.now() + next * 1000;
  await mutateSettings([SETTING_KEY.SYNC_BACKOFF_SECONDS, SETTING_KEY.SYNC_BACKOFF_UNTIL], (settings) => {
    settings.set(SETTING_KEY.SYNC_BACKOFF_SECONDS, next);
    settings.set(SETTING_KEY.SYNC_BACKOFF_UNTIL, retryAt);
  });
  return retryAt;
}

async function clearBackoff() {
  await mutateSettings([SETTING_KEY.SYNC_BACKOFF_SECONDS, SETTING_KEY.SYNC_BACKOFF_UNTIL], (settings) => {
    settings.set(SETTING_KEY.SYNC_BACKOFF_SECONDS, 0);
    settings.set(SETTING_KEY.SYNC_BACKOFF_UNTIL, 0);
  });
}

/**
 * One in-memory view of the entry table, loaded once per cycle and updated as
 * steps write to it, so a sync no longer scans the whole store five times.
 */
function localState(entries) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    all() {
      return [...byId.values()];
    },
    apply(changed) {
      for (const entry of changed) byId.set(entry.id, entry);
      return changed;
    },
    forget(id) {
      byId.delete(id);
    }
  };
}

function remoteFingerprintSets(snapshot) {
  const fingerprints = new Map();
  const add = (id, fingerprint) => {
    if (!id || !fingerprint) return;
    if (!fingerprints.has(id)) fingerprints.set(id, new Set());
    fingerprints.get(id).add(fingerprint);
  };
  for (const entry of snapshot.entries) add(entry.id, entryFingerprint(entry));
  for (const duplicate of snapshot.duplicates || []) {
    for (const row of [duplicate.keepRow, ...(duplicate.extraRows || [])]) {
      add(duplicate.id, row?.expectedFingerprint);
    }
  }
  return fingerprints;
}

async function confirmAmbiguousAppends(entries, { interactiveAuth, lease }) {
  await lease?.assert();
  const snapshot = await readRemoteSnapshot({ interactiveAuth });
  await lease?.assert();
  const remoteFingerprints = remoteFingerprintSets(snapshot);
  const confirmed = [];
  const conflicts = [];

  for (const entry of entries) {
    const observed = remoteFingerprints.get(entry.id);
    if (observed?.has(entryFingerprint(entry))) {
      confirmed.push({ id: entry.id, rowIndex: snapshot.rowMap.get(entry.id) || 0 });
    } else if (observed?.size) {
      conflicts.push(entry.id);
    }
  }

  return { confirmed, conflicts };
}

async function acknowledgePushedEntries(local, entries, pushedIds, { lease } = {}) {
  for (const entry of entries) {
    const acknowledgement = await markSynced(entry, { lease });
    if (acknowledgement.entry) local.apply([acknowledgement.entry]);
    if (acknowledgement.applied) pushedIds.add(entry.id);
  }
}

/**
 * Writes local changes to the sheet and returns the ids that were pushed, so the
 * pull step can skip them: the snapshot it works from predates these writes.
 * All row rewrites go in one request and all new rows in another, so the cost is
 * two calls regardless of how many entries are pending.
 */
export async function pushDirtyEntries(local, remoteEntries, rowMap, { interactiveAuth, forcedIds = new Set(), lease } = {}) {
  const remoteById = new Map(remoteEntries.map((entry) => [entry.id, entry]));
  const updates = [];
  const appends = [];

  for (const entry of local.all()) {
    if (!entry.dirty) continue;
    const remote = remoteById.get(entry.id);
    if (remote && !forcedIds.has(entry.id)
      && (isRemoteNewer(remote, entry) || hasEqualTimestampConflict(remote, entry))) continue;
    if (rowMap.has(entry.id)) {
      updates.push({ rowIndex: rowMap.get(entry.id), entry, expectedFingerprint: entryFingerprint(remote) });
    } else {
      appends.push(entry);
    }
  }

  const pushedIds = new Set();
  if (!updates.length && !appends.length) return pushedIds;

  await lease?.assert();
  await updateRemoteEntries(updates, { interactiveAuth });
  await lease?.assert();

  let appendFailure = null;
  let appendMappings = [];
  try {
    await lease?.assert();
    appendMappings = await appendRemoteEntries(appends, { interactiveAuth });
    await lease?.assert();
  } catch (error) {
    await lease?.assert();
    appendFailure = error;
  }

  const confirmedAppendIds = new Set(appendMappings.map(({ id }) => id));
  let appendConflicts = [];
  if (appendFailure || confirmedAppendIds.size < appends.length) {
    let recovery;
    try {
      recovery = await confirmAmbiguousAppends(appends.filter((entry) => !confirmedAppendIds.has(entry.id)), { interactiveAuth, lease });
    } catch (error) {
      if (appendFailure) throw appendFailure;
      throw error;
    }
    for (const { id, rowIndex } of recovery.confirmed) {
      confirmedAppendIds.add(id);
      if (rowIndex) rowMap.set(id, rowIndex);
    }
    appendConflicts = recovery.conflicts;
    await recordDiagnostic({
      subsystem: "sync",
      phase: "append_recovery",
      code: "REMOTE_APPEND_AMBIGUOUS",
      entryCount: appends.length - confirmedAppendIds.size,
      recovery: "The next sync will verify any remaining append before retrying."
    });
  }

  for (const { id, rowIndex } of appendMappings) {
    if (confirmedAppendIds.has(id)) rowMap.set(id, rowIndex);
  }
  const confirmedAppends = appends.filter((entry) => confirmedAppendIds.has(entry.id));
  await acknowledgePushedEntries(local, [...updates.map((update) => update.entry), ...confirmedAppends], pushedIds, { lease });

  if (appendConflicts.length) {
    throw codedError("REMOTE_APPEND_CONFLICT", `Spreadsheet rows conflict with append${appendConflicts.length === 1 ? "" : "s"}: ${appendConflicts.join(", ")}`);
  }
  if (appendFailure) throw appendFailure;

  return pushedIds;
}

async function verifiedLocalResolutions(local, remoteEntries) {
  const intents = await getSetting(RECONCILIATION_INTENTS_KEY, []);
  if (!Array.isArray(intents) || !intents.length) return new Map();
  const remoteById = new Map(remoteEntries.map((entry) => [entry.id, entry]));
  const localById = new Map(local.all().map((entry) => [entry.id, entry]));
  const verified = new Map();
  for (const intent of intents) {
    if (!isPendingReconciliationIntent(intent)) continue;
    const localEntry = localById.get(intent.entry_id);
    const remoteEntry = remoteById.get(intent.entry_id);
    if (!localEntry || !remoteEntry) continue;
    if (Number(localEntry.revision || 0) !== Number(intent.local_revision)) continue;
    if (entryFingerprint(remoteEntry) !== intent.remote_fingerprint) continue;
    verified.set(intent.entry_id, intent.resolution_id);
  }
  return verified;
}

async function clearCompletedResolutions(resolutionIds, { lease } = {}) {
  if (!resolutionIds.size) return;
  await lease?.assert();
  await mutateSettings([RECONCILIATION_INTENTS_KEY], (settings) => {
    const intents = Array.isArray(settings.get(RECONCILIATION_INTENTS_KEY))
      ? settings.get(RECONCILIATION_INTENTS_KEY)
      : [];
    // A newer choice for the same entry can be recorded while the Sheets write
    // is in flight. Clear only the resolution this cycle actually verified.
    settings.set(RECONCILIATION_INTENTS_KEY, intents.filter((intent) => !resolutionIds.has(intent?.resolution_id)));
  });
}

export async function pullRemoteEntries(local, remoteEntries, pushedIds = new Set(), { lease } = {}) {
  const localById = new Map(local.all().map((entry) => [entry.id, entry]));
  const applied = [];
  const candidates = remoteEntries
    .filter((remote) => !pushedIds.has(remote.id))
    .map((remote) => ({ remote, observed: localById.get(remote.id) }))
    // A remote value which was not newer than the snapshot cannot win. Recheck
    // inside the transaction because the local entry may change while sync I/O
    // is in flight.
    .filter(({ remote, observed }) => !observed || isRemoteNewer(remote, observed));

  for (let start = 0; start < candidates.length; start += PULL_MUTATION_BATCH_SIZE) {
    await lease?.assert();
    const batch = candidates.slice(start, start + PULL_MUTATION_BATCH_SIZE);
    const changed = await mutateEntries(batch.map(({ remote }) => remote.id), (entries) => {
      const batchApplied = [];
      for (const { remote, observed } of batch) {
        const current = entries.get(remote.id);
        // A previously absent entry that appeared during the network read is a
        // local write, not permission to import over it. Likewise, do not
        // overwrite an entry that was edited or deleted after the snapshot.
        if (!observed ? Boolean(current) : !current || Number(current.revision || 0) !== Number(observed.revision || 0)) {
          continue;
        }
        if (current && !isRemoteNewer(remote, current)) continue;

        const next = normalizeEntry({
          ...remote,
          dirty: false,
          last_sync_at: nowIso(),
          sync_error: ""
        });
        entries.set(remote.id, next);
        batchApplied.push(next);
      }
      return batchApplied;
    });
    applied.push(...changed);
  }

  local.apply(applied);
  return applied.length;
}

export async function markMultipleActiveTimers(local, { lease } = {}) {
  const active = local.all()
    .filter((entry) => !entry.deleted_at && !entry.end_at)
    .sort((a, b) => String(b.start_at).localeCompare(String(a.start_at)));

  if (active.length <= 1) return [];

  const older = active.slice(1);
  await lease?.assert();
  const expectedById = new Map(older.map((entry) => [entry.id, entryFingerprint(entry)]));
  const changed = await mutateEntries(older.map((entry) => entry.id), (entries) => {
    const applied = [];
    for (const [id, expectedFingerprint] of expectedById) {
      const current = entries.get(id);
      if (!current) {
        entries.delete(id);
        continue;
      }
      if (entryFingerprint(current) !== expectedFingerprint || current.deleted_at || current.end_at || current.status === "needs_review") {
        continue;
      }
      const next = normalizeEntry({
        ...current,
        status: "needs_review",
        updated_at: nowIso(),
        revision: Number(current.revision || 0) + 1,
        dirty: true,
        sync_error: "Multiple active timers detected"
      });
      entries.set(id, next);
      applied.push(next);
    }
    return applied;
  });
  return local.apply(changed);
}

function isExpiredDeletion(deletedAt) {
  if (!deletedAt) return false;
  const time = new Date(deletedAt).getTime();
  return Number.isFinite(time) && time < addDays(new Date(), -14).getTime();
}

export async function purgeDeletedEntries(local, remoteEntries, rowMap, duplicates = [], { interactiveAuth = false, lease } = {}) {
  const expiredRows = remoteEntries
    .filter((entry) => isExpiredDeletion(entry.deleted_at) && rowMap.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      rowIndex: rowMap.get(entry.id),
      expectedFingerprint: entryFingerprint(entry)
    }));
  for (const duplicate of duplicates) {
    if (!duplicate?.entry || !isExpiredDeletion(duplicate.entry.deleted_at)) continue;
    for (const row of duplicate.extraRows || []) {
      expiredRows.push(row);
    }
  }

  // deleteRemoteRows orders the deletions itself; one request covers every row.
  let blockedIds = new Set();
  if (expiredRows.length) {
    try {
      await lease?.assert();
      await deleteRemoteRows(expiredRows, { interactiveAuth });
      await lease?.assert();
      for (const { id } of expiredRows) rowMap.delete(id);
    } catch (error) {
      // Keep the local copies so the rows are retried on the next sync.
      blockedIds = new Set(expiredRows.map((row) => row.id));
      await recordDiagnostic({
        subsystem: "sync",
        phase: "purge",
        error,
        entryCount: blockedIds.size,
        recovery: "Expired deletions will retry during the next sync."
      });
    }
  }

  const candidates = local.all().filter((entry) => isExpiredDeletion(entry.deleted_at) && !blockedIds.has(entry.id));
  const expectedById = new Map(candidates.map((entry) => [entry.id, entryFingerprint(entry)]));
  await lease?.assert();
  const deletedIds = await mutateEntries(candidates.map((entry) => entry.id), (entries) => {
    const applied = [];
    for (const [id, expectedFingerprint] of expectedById) {
      const current = entries.get(id);
      if (!current) {
        entries.delete(id);
        continue;
      }
      if (entryFingerprint(current) !== expectedFingerprint || !isExpiredDeletion(current.deleted_at)) continue;
      entries.delete(id);
      applied.push(id);
    }
    return applied;
  });
  for (const id of deletedIds) local.forget(id);
  return deletedIds.length;
}

/**
 * Flags every live entry for push and forgets the read marker.
 *
 * Required whenever the spreadsheet changes. Local entries are clean after their
 * last sync, so without this the newly adopted or created sheet would receive
 * nothing and sit empty while the UI looked perfectly healthy. updated_at and
 * revision are deliberately untouched, so reconciling against a sheet that
 * already holds rows still resolves by age rather than by which side is newer.
 */
export async function reseedForNewSpreadsheet(local, { lease } = {}) {
  await lease?.assert();
  const candidateIds = new Set(local.all().map((entry) => entry.id));
  const reseeded = await mutateAllLocalState([RECONCILIATION_INTENTS_KEY, REMOTE_MODIFIED_KEY], ({ entries, settings }) => {
    const applied = [];
    for (const id of candidateIds) {
      const current = entries.get(id);
      if (!current) {
        continue;
      }
      if (current.dirty && !current.sync_error) continue;
      const next = { ...current, dirty: true, sync_error: "" };
      entries.set(id, next);
      applied.push(next);
    }
    // Intent fingerprints name the previous remote snapshot. They cannot prove
    // anything about a replacement sheet, so discard them with the reseed.
    settings.set(RECONCILIATION_INTENTS_KEY, []);
    settings.set(REMOTE_MODIFIED_KEY, "");
    return applied;
  });
  local.apply(reseeded);
  return reseeded.length;
}

/**
 * Makes sure a spreadsheet is selected, adopting the most recently modified one
 * this extension created or creating one when there are none.
 */
async function ensureSpreadsheet(local, { interactiveAuth, lease }) {
  const spreadsheetId = await getSpreadsheetId();
  const provisioningPending = await getSetting(SETTING_KEY.SPREADSHEET_PROVISION_PENDING, "");
  if (spreadsheetId && provisioningPending !== spreadsheetId) return null;

  await lease?.assert();
  const provisioned = await provisionSpreadsheet({ interactiveAuth });
  await lease?.assert();
  await reseedForNewSpreadsheet(local, { lease });
  return provisioned;
}

/**
 * Recovers from a spreadsheet that has been deleted or trashed, by detecting or
 * creating a replacement and re-seeding it from local data.
 *
 * Only acts once Drive confirms the file is actually gone, so an unreachable but
 * intact spreadsheet still reports its error rather than being silently replaced.
 */
async function reprovisionIfSpreadsheetGone(error, local, { interactiveAuth, lease }) {
  if (error.code !== "API_ERROR" && error.code !== "SHEET_MISSING") return null;
  if (!await isSpreadsheetGone({ interactiveAuth })) return null;

  await lease?.assert();
  const provisioned = await provisionSpreadsheet({ interactiveAuth });
  await lease?.assert();
  await reseedForNewSpreadsheet(local, { lease });
  return provisioned;
}

/**
 * True when the local multiplier has moved since it was last exchanged with the
 * sheet. Needed so a config change is still pushed on a cycle where the remote
 * file is otherwise unchanged and the read is skipped.
 */
async function hasPendingConfig() {
  const localUpdatedAt = String(await getSetting(MULTIPLIER_UPDATED_KEY, "") || "");
  if (!localUpdatedAt) return false;
  return localUpdatedAt !== String(await getSetting(MULTIPLIER_SYNCED_KEY, "") || "");
}

/**
 * Reconciles duration_multiplier against the config rows already in the
 * snapshot, and writes only when the local value is genuinely newer. Returns
 * true when it wrote to the sheet.
 */
async function syncConfig(remoteConfig, configRows, { interactiveAuth, lease } = {}) {
  const remote = remoteConfig[MULTIPLIER_KEY];
  const remoteUpdatedAt = remote ? String(remote.updated_at || "") : "";
  const remoteValue = remote ? String(remote.value || "") : "";
  const localUpdatedAt = String(await getSetting(MULTIPLIER_UPDATED_KEY, "") || "");
  const localValue = String(await getSetting(MULTIPLIER_KEY, "1"));

  if (remoteUpdatedAt && remoteUpdatedAt > localUpdatedAt) {
    await lease?.assert();
    await mutateSettings([MULTIPLIER_KEY, MULTIPLIER_UPDATED_KEY, MULTIPLIER_SYNCED_KEY], (settings) => {
      // A newer local save that landed after the snapshot must win and be
      // pushed on the following cycle instead of being overwritten piecemeal.
      if (String(settings.get(MULTIPLIER_UPDATED_KEY) || "") > remoteUpdatedAt) return false;
      settings.set(MULTIPLIER_KEY, remoteValue);
      settings.set(MULTIPLIER_UPDATED_KEY, remoteUpdatedAt);
      settings.set(MULTIPLIER_SYNCED_KEY, remoteUpdatedAt);
      return true;
    });
    return false;
  }

  if (!localUpdatedAt) return false;
  if (remoteUpdatedAt === localUpdatedAt && remoteValue !== localValue) return false;
  if (remoteUpdatedAt === localUpdatedAt && remoteValue === localValue) {
    await lease?.assert();
    await setSetting(MULTIPLIER_SYNCED_KEY, localUpdatedAt);
    return false;
  }

  await lease?.assert();
  const configRow = configRows.get(MULTIPLIER_KEY) || {};
  await updateRemoteConfig(MULTIPLIER_KEY, localValue, localUpdatedAt, {
    rowIndex: configRow.rowIndex || 0,
    expectedFingerprint: configRow.expectedFingerprint || "",
    interactiveAuth
  });
  await lease?.assert();
  await setSetting(MULTIPLIER_SYNCED_KEY, localUpdatedAt);
  return true;
}

async function runSyncCycle({ interactiveAuth, force }) {
  let phase = "preflight";
  let entryCount = 0;
  if (!platform.isOnline()) {
    const error = codedError("OFFLINE", "offline");
    const retryAt = await recordBackoff(error);
    await recordSyncDiagnostic(phase, error, 0, retryAt);
    throw error;
  }

  const backoffUntil = Number(await getSetting(SETTING_KEY.SYNC_BACKOFF_UNTIL, 0)) || 0;
  if (!force && backoffUntil > Date.now()) {
    const error = codedError("BACKOFF", `retry after ${Math.ceil((backoffUntil - Date.now()) / 1000)}s`);
    await recordSyncDiagnostic(phase, error, 0, backoffUntil);
    throw error;
  }

  // The popup, the calendar page, and the background alarm all sync
  // independently. Without this lock two cycles can each miss the other's rows
  // and append the same entry twice.
  const lock = await claimLock(SYNC_LOCK_KEY, CONTEXT_ID, SYNC_LOCK_TTL_MS);
  if (!lock) {
    const error = codedError("SYNC_BUSY", "another sync is already running");
    await recordSyncDiagnostic("lock", error);
    throw error;
  }

  let leaseLost = false;
  const lease = {
    async assert() {
      if (leaseLost || !await isLockCurrent(SYNC_LOCK_KEY, CONTEXT_ID, lock.generation, SYNC_LOCK_TTL_MS)) {
        leaseLost = true;
        throw codedError("SYNC_BUSY", "sync lease was lost; retrying from a fresh snapshot is required");
      }
    }
  };
  const leaseTimer = setInterval(() => {
    renewLock(SYNC_LOCK_KEY, CONTEXT_ID, lock.generation).then((renewed) => {
      if (!renewed) leaseLost = true;
    }).catch(() => {
      leaseLost = true;
    });
  }, Math.floor(SYNC_LOCK_TTL_MS / 3));

  try {
    phase = "read_local";
    await lease.assert();
    const local = localState(await getAllEntries());
    entryCount = local.all().length;
    await lease.assert();
    phase = "intent_cleanup";
    await pruneExpiredReconciliationIntents();
    await lease.assert();
    // A timer left running overnight stays running. Only genuinely competing
    // timers are flagged, and that is done before the push so the markers travel
    // in the same pass.
    phase = "active_timer_check";
    const conflictChanges = await markMultipleActiveTimers(local, { lease });
    // Under the sync lock, so two contexts cannot both decide none exists and
    // each create one.
    phase = "provisioning";
    let provisioned = await ensureSpreadsheet(local, { interactiveAuth, lease });

    // Both marking passes set dirty, so either of them producing changes makes
    // hasLocalWork true and forces the read below.
    const hasLocalWork = local.all().some((entry) => entry.dirty || isExpiredDeletion(entry.deleted_at))
      || await hasPendingConfig();

    // Drive reports when the file last changed for a fraction of the cost of
    // downloading it, but only when the answer can change the outcome. With work
    // to push the read happens regardless, so asking first would just burn a
    // request. An empty modifiedTime means Drive cannot answer, so the read
    // happens unconditionally.
    //
    // A forced sync always reads. Skipping on a user's explicit request hides
    // anything that can only be noticed by reading, such as a layout that needs
    // migrating, and leaves the sync button reporting success without looking.
    let modifiedTime = "";
    if (!hasLocalWork && !force) {
      phase = "remote_gate";
      await lease.assert();
      modifiedTime = await getRemoteModifiedTime({ interactiveAuth });
      await lease.assert();
      const driveGate = getDriveGateDiagnostics();
      if (driveGate.unavailable || driveGate.retryAt > Date.now()) {
        await recordDiagnostic({
          subsystem: "sync",
          phase: "remote_gate",
          code: "DRIVE_GATE_UNAVAILABLE",
          retryAt: driveGate.retryAt,
          recovery: "Sync reads the spreadsheet directly until Drive metadata recovers."
        });
      }
      const lastSeenModified = String(await getSetting(REMOTE_MODIFIED_KEY, "") || "");
      if (modifiedTime && lastSeenModified && modifiedTime === lastSeenModified) {
        await lease.assert();
        await clearBackoff();
        await recordCycleActivity({ changed: false, force });
        return { status: "synced", warning: "", syncedAt: nowIso(), changed: false };
      }
    }

    let snapshot;
    try {
      phase = "remote_read";
      await lease.assert();
      snapshot = await readRemoteSnapshot({ interactiveAuth });
      await lease.assert();
    } catch (error) {
      const recovered = await reprovisionIfSpreadsheetGone(error, local, { interactiveAuth, lease });
      if (!recovered) throw error;
      provisioned = recovered;
      await lease.assert();
      snapshot = await readRemoteSnapshot({ interactiveAuth });
      await lease.assert();
    }

    await lease.assert();

    if (snapshot.quarantined?.length) {
      await recordDiagnostic({
        subsystem: "sync",
        phase: "remote_read",
        code: "REMOTE_ROWS_QUARANTINED",
        entryCount: snapshot.quarantined.length,
        recovery: "Open Reconcile and correct the invalid spreadsheet rows."
      });
    }

    const forcedResolutions = await verifiedLocalResolutions(local, snapshot.entries);
    phase = "push";
    const pushedIds = await pushDirtyEntries(local, snapshot.entries, snapshot.rowMap, {
      interactiveAuth,
      forcedIds: new Set(forcedResolutions.keys()),
      lease
    });
    const completedResolutionIds = new Set([...forcedResolutions]
      .filter(([id]) => pushedIds.has(id))
      .map(([, resolutionId]) => resolutionId));
    await clearCompletedResolutions(completedResolutionIds, { lease });
    phase = "pull";
    const pulled = await pullRemoteEntries(local, snapshot.entries, pushedIds, { lease });
    // Purge last: it consumes the same snapshot, and deleting rows first would
    // let the pull re-insert what it removed.
    phase = "purge";
    const purged = await purgeDeletedEntries(local, snapshot.entries, snapshot.rowMap, snapshot.duplicates, { interactiveAuth, lease });
    phase = "config";
    const configPushed = await syncConfig(snapshot.config, snapshot.configRows, { interactiveAuth, lease });
    // Backfills spreadsheets created before the marker existed, once.
    await lease.assert();
    const markerWritten = await ensureAppMarker(snapshot.config, snapshot.configRows, { interactiveAuth });
    await lease.assert();

    // Our own writes bump modifiedTime, so it is re-read to avoid a needless
    // download next cycle. If Drive lags, the gate simply opens once more.
    const wroteRemotely = pushedIds.size > 0 || purged > 0 || configPushed || markerWritten;
    phase = "remote_marker";
    const nextModified = wroteRemotely || !modifiedTime
      ? await getRemoteModifiedTime({ interactiveAuth })
      : modifiedTime;
    await lease.assert();
    await setSetting(REMOTE_MODIFIED_KEY, nextModified || "");

    phase = "complete";
    const changed = wroteRemotely
      || pulled > 0
      || conflictChanges.length > 0
      || Boolean(provisioned);
    const timestamp = nowIso();
    await lease.assert();
    await clearBackoff();
    await recordCycleActivity({ changed, force });
    notifyEntriesChanged({ action: "sync" });
    return {
      status: conflictChanges.length ? "needs review" : "synced",
      warning: conflictChanges.length ? "multiple active timers flagged" : "",
      syncedAt: timestamp,
      changed
    };
  } catch (error) {
    const retryAt = await recordBackoff(error);
    await recordSyncDiagnostic(phase, error, entryCount, retryAt);
    throw error;
  } finally {
    clearInterval(leaseTimer);
    await releaseLock(SYNC_LOCK_KEY, CONTEXT_ID, lock.generation);
  }
}

/**
 * Forgets the last seen remote modification time, so the next sync reads the
 * spreadsheet instead of trusting the gate. Called after an extension update,
 * where a new version may need to see the sheet to migrate or repair it.
 */
export async function clearRemoteReadMarker() {
  await setSetting(REMOTE_MODIFIED_KEY, "");
}

/**
 * Tracks how many cycles in a row found nothing to do. A cycle that moved data,
 * or any user-initiated sync, resets the count.
 */
async function recordCycleActivity({ changed, force }) {
  if (changed || force) {
    await setSetting(IDLE_STREAK_KEY, 0);
    return;
  }
  const streak = Number(await getSetting(IDLE_STREAK_KEY, 0)) || 0;
  await setSetting(IDLE_STREAK_KEY, Math.min(streak + 1, IDLE_BACKOFF_STEPS.length));
}

/**
 * How long the background poller should wait before its next sync. An idle
 * profile stretches the interval out to at most MAX_IDLE_INTERVAL_MINUTES, and it
 * snaps back to the configured interval as soon as anything happens.
 */
export async function nextSyncDelayMinutes() {
  const configured = Number(await getSetting(SETTING_KEY.SYNC_INTERVAL_SECONDS, 60)) || 60;
  const baseMinutes = Math.max(1, Math.round(Math.max(30, configured) / 60));
  const streak = Number(await getSetting(IDLE_STREAK_KEY, 0)) || 0;
  const factor = IDLE_BACKOFF_STEPS[Math.min(streak, IDLE_BACKOFF_STEPS.length - 1)];
  return Math.min(baseMinutes * factor, MAX_IDLE_INTERVAL_MINUTES);
}



function startSyncCycle(options) {
  inFlightOptions = options;
  currentSync = runSyncCycle(options);
  return currentSync;
}

function startSyncDrain(options) {
  let cycle = startSyncCycle(options);
  // Keep this promise registered until every stronger request that arrived
  // during the active cycle has run. The individual cycle promises preserve
  // caller-specific success/failure while this drain remains the context gate.
  inFlightSync = (async () => {
    while (cycle) {
      try {
        await cycle;
      } catch {
        // A queued stronger request must still run after a failed cycle.
      }

      if (!queuedSync) return;
      const next = queuedSync;
      const nextOptions = queuedOptions;
      queuedSync = null;
      queuedOptions = null;
      cycle = startSyncCycle(nextOptions);
      cycle.then(next.resolve, next.reject);
    }
  })().finally(() => {
    inFlightSync = null;
    inFlightOptions = null;
    currentSync = null;
  });
  return cycle;
}

export function syncNow({ interactiveAuth = false, force = false } = {}) {
  // Collapse overlapping calls from the same context, such as the poller firing
  // while a user action is still syncing.
  if (!inFlightSync) return startSyncDrain({ interactiveAuth, force });

  const stronger = force && !inFlightOptions.force || interactiveAuth && !inFlightOptions.interactiveAuth;
  if (!stronger) return queuedSync?.promise || currentSync;

  queuedOptions = {
    force: force || queuedOptions?.force || false,
    interactiveAuth: interactiveAuth || queuedOptions?.interactiveAuth || false
  };
  queuedSync ||= deferred();
  return queuedSync.promise;
}

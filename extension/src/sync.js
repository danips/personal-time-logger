import { claimLock, getAllEntries, getEntry, isLockCurrent, mutateEntries, mutateSettings, releaseLock, renewLock, setSetting, getSetting, StorageConflictError } from "./db.js";
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
import { codedError } from "./coded-error.js";
import { addDays, nowIso, uuid } from "./time.js";

import { platform } from "./platform.js";
import { getActiveRemoteProvider, getRemoteProvider } from "./remote-provider.js";
import { SETTING_KEY } from "./setting-keys.js";
import { hasPendingConfig, syncConfig } from "./sync-config.js";

const MAX_BACKOFF_SECONDS = 300;
const SYNC_LOCK_KEY = "sync_lock";
const SYNC_LOCK_TTL_MS = 120000;
const MYSQL_REMOTE_CHANGE_TOKEN_KEY = SETTING_KEY.MYSQL_REMOTE_CHANGE_TOKEN;
const CLOUDFLARE_D1_REMOTE_CHANGE_TOKEN_KEY = SETTING_KEY.CLOUDFLARE_D1_REMOTE_CHANGE_TOKEN;
const IDLE_STREAK_KEY = SETTING_KEY.SYNC_IDLE_STREAK;
const SYNC_RECOVERY_REQUIRED = "Remote recovery requires review before upload.";
// Multipliers applied to the configured interval as idle cycles accumulate.
const IDLE_BACKOFF_STEPS = [1, 2, 5, 10];
const MAX_IDLE_INTERVAL_MINUTES = 15;
const PULL_MUTATION_BATCH_SIZE = 250;

// Identifies this module instance, which is one per extension context (popup,
// calendar page, background). Used as the sync lock holder.
const CONTEXT_ID = uuid();
let syncDrain = null;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function providerOrDefault(provider) {
  return provider || getRemoteProvider();
}

async function assertMigrationMaySync(migrationId = "") {
  const state = await getSetting(SETTING_KEY.STORAGE_MIGRATION_STATE, null);
  const active = state && typeof state === "object"
    && state.phase && !["complete", "failed"].includes(state.phase);
  if (active && state.migration_id !== migrationId) {
    throw codedError(ERROR_CODE.MIGRATION_IN_PROGRESS, "Storage migration is active.");
  }
}

function changeTokenSettingKey(provider) {
  if (provider?.id === "mysql") return MYSQL_REMOTE_CHANGE_TOKEN_KEY;
  if (provider?.id === "cloudflare-d1") return CLOUDFLARE_D1_REMOTE_CHANGE_TOKEN_KEY;
  return MYSQL_REMOTE_CHANGE_TOKEN_KEY;
}

function syncRecovery(error) {
  if (error?.code === ERROR_CODE.MIGRATION_IN_PROGRESS) {
    return "Wait for the storage migration to finish, then retry sync.";
  }
  if ([
    ERROR_CODE.MYSQL_CONFIG_INVALID,
    ERROR_CODE.MYSQL_CONFIG_MISSING,
    ERROR_CODE.CLOUDFLARE_D1_CONFIG_INVALID,
    ERROR_CODE.CLOUDFLARE_D1_CONFIG_MISSING,
    ERROR_CODE.REMOTE_AUTH_REQUIRED,
    ERROR_CODE.REMOTE_ORIGIN_NOT_ALLOWED,
    ERROR_CODE.REMOTE_PERMISSION,
    ERROR_CODE.REMOTE_API_INCOMPATIBLE
  ].includes(error?.code)) {
    return "Open Options Storage settings and verify the remote URL, token, and host permission.";
  }
  if (error?.code === "SYNC_BUSY") return "Retry after the other sync finishes.";
  if (["RATE_LIMIT", "API_TIMEOUT", "API_NETWORK", "OFFLINE", "BACKOFF"].includes(error?.code)) {
    return "Wait for the retry deadline, then sync again.";
  }
  return "Retry the sync. Open Options diagnostics if it continues.";
}

async function recordSyncDiagnostic(phase, error, entryCount = 0, retryAt = 0, context = {}) {
  try {
    const lastSuccessAt = String(await getSetting(SETTING_KEY.SYNC_LAST_SUCCESS_AT, "") || "");
    await recordDiagnostic({
      subsystem: "sync",
      phase,
      error,
      entryCount,
      retryAt,
      ...context,
      freshness: context.freshness || (lastSuccessAt ? `last success ${lastSuccessAt}` : "not yet"),
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
  return new Map(entries.map((entry) => [entry.id, entry]));
}

function applyEntries(local, changed) {
  for (const entry of changed) local.set(entry.id, entry);
  return changed;
}

async function confirmAmbiguousAppends(entries, { lease, provider }) {
  await lease?.assert();
  const snapshot = await providerOrDefault(provider).readSnapshot();
  await lease?.assert();
  const remoteById = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  const confirmed = [];
  const conflicts = [];

  for (const entry of entries) {
    const observed = remoteById.get(entry.id);
    if (observed && entryFingerprint(observed) === entryFingerprint(entry)) {
      confirmed.push({ id: entry.id, ref: snapshot.entryRefs.get(entry.id) || null });
    } else if (observed) {
      conflicts.push(entry.id);
    }
  }

  return { confirmed, conflicts };
}

async function acknowledgePushedEntries(local, entries, pushedIds, { lease } = {}) {
  for (const entry of entries) {
    const acknowledgement = await markSynced(entry, { lease });
    if (acknowledgement.entry) local.set(acknowledgement.entry.id, acknowledgement.entry);
    if (acknowledgement.applied) pushedIds.add(entry.id);
  }
}

/**
 * Prevents a previously synchronized or backup-restored entry from silently
 * becoming a new remote record when its deletion evidence is absent. A dirty
 * live edit also cannot overwrite a retained remote tombstone without an
 * explicit reconciliation choice. Genuinely new local entries have no prior
 * sync state and remain eligible for the append path.
 */
export async function protectDeletionRecovery(local, remoteEntries, pendingBackupIds, forcedIds, { lease } = {}) {
  const remoteById = new Map(remoteEntries.map((entry) => [entry.id, entry]));
  const blockedIds = new Set();
  const candidates = [];
  for (const entry of local.values()) {
    if (forcedIds.has(entry.id)) continue;
    const remote = remoteById.get(entry.id);
    const missingPreviouslySynced = !remote && (Boolean(entry.last_sync_at) || pendingBackupIds.has(entry.id));
    const dirtyAgainstTombstone = remote?.deleted_at && !entry.deleted_at && entry.dirty;
    if (!missingPreviouslySynced && !dirtyAgainstTombstone) continue;
    blockedIds.add(entry.id);
    if (entry.sync_error !== SYNC_RECOVERY_REQUIRED) candidates.push(entry);
  }

  if (!candidates.length) return blockedIds;
  await lease?.assert();
  const changed = await mutateEntries(candidates.map((entry) => entry.id), (entries) => {
    const applied = [];
    for (const expected of candidates) {
      const current = entries.get(expected.id);
      if (!current || entryFingerprint(current) !== entryFingerprint(expected)) continue;
      entries.set(expected.id, normalizeEntry({ ...current, sync_error: SYNC_RECOVERY_REQUIRED }));
      applied.push(expected);
    }
    return applied;
  });
  applyEntries(local, changed);
  await recordDiagnostic({
    subsystem: "sync",
    phase: "remote_recovery",
    code: "REMOTE_RECOVERY_REQUIRED",
    entryCount: changed.length,
    recovery: "Open Reconcile, review the missing or deleted entry, then choose a side before syncing again."
  });
  return blockedIds;
}

/**
 * Writes local changes to the remote API and returns the ids that were pushed, so the
 * pull step can skip them: the snapshot it works from predates these writes.
 * All row rewrites go in one request and all new rows in another, so the cost is
 * two calls regardless of how many entries are pending.
 */
export async function pushDirtyEntries(local, remoteEntries, entryRefs, {
  blockedIds = new Set(),
  forcedIds = new Set(),
  lease,
  provider
} = {}) {
  const remoteProvider = providerOrDefault(provider);
  const remoteById = new Map(remoteEntries.map((entry) => [entry.id, entry]));
  const updates = [];
  const appends = [];
  const localMatches = [];

  for (const entry of local.values()) {
    if (!entry.dirty || blockedIds.has(entry.id)) continue;
    const remote = remoteById.get(entry.id);
    if (remote && !forcedIds.has(entry.id)
      && (isRemoteNewer(remote, entry) || hasEqualTimestampConflict(remote, entry))) continue;
    if (remote && !forcedIds.has(entry.id) && entryRefs.has(entry.id)
      && entryFingerprint(remote) === entryFingerprint(entry)) {
      localMatches.push(entry);
      continue;
    }
    if (entryRefs.has(entry.id)) {
      updates.push({ entry, expectedRef: entryRefs.get(entry.id) });
    } else {
      appends.push(entry);
    }
  }

  const pushedIds = new Set();
  if (!updates.length && !appends.length) {
    await acknowledgePushedEntries(local, localMatches, pushedIds, { lease });
    return pushedIds;
  }

  await lease?.assert();
  await remoteProvider.updateEntries(updates);
  await lease?.assert();

  let appendFailure = null;
  let appendMappings = [];
  try {
    await lease?.assert();
    appendMappings = await remoteProvider.appendEntries(appends);
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
      recovery = await confirmAmbiguousAppends(
        appends.filter((entry) => !confirmedAppendIds.has(entry.id)),
        { lease, provider: remoteProvider }
      );
    } catch (error) {
      if (appendFailure) throw appendFailure;
      throw error;
    }
    for (const { id, ref } of recovery.confirmed) {
      confirmedAppendIds.add(id);
      if (ref) entryRefs.set(id, ref);
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

  for (const { id, ref } of appendMappings) {
    if (confirmedAppendIds.has(id) && ref) entryRefs.set(id, ref);
  }
  const confirmedAppends = appends.filter((entry) => confirmedAppendIds.has(entry.id));
  await acknowledgePushedEntries(local, [
    ...localMatches,
    ...updates.map((update) => update.entry),
    ...confirmedAppends
  ], pushedIds, { lease });

  if (appendConflicts.length) {
    throw codedError("REMOTE_APPEND_CONFLICT", `Remote rows conflict with append${appendConflicts.length === 1 ? "" : "s"}: ${appendConflicts.join(", ")}`);
  }
  if (appendFailure) throw appendFailure;

  return pushedIds;
}

async function verifiedLocalResolutions(local, remoteEntries) {
  const intents = await getSetting(RECONCILIATION_INTENTS_KEY, []);
  if (!Array.isArray(intents) || !intents.length) return new Map();
  const remoteById = new Map(remoteEntries.map((entry) => [entry.id, entry]));
  const localById = local;
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
    // A newer choice for the same entry can be recorded while the remote
    // mutation is in flight. Clear only the resolution this cycle verified.
    settings.set(RECONCILIATION_INTENTS_KEY, intents.filter((intent) => !resolutionIds.has(intent?.resolution_id)));
  });
}

export async function pullRemoteEntries(local, remoteEntries, pushedIds = new Set(), { blockedIds = new Set(), lease } = {}) {
  const localById = local;
  const applied = [];
  const candidates = remoteEntries
    .filter((remote) => !pushedIds.has(remote.id) && !blockedIds.has(remote.id))
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
        if (!observed ? Boolean(current) : !current
          || Number(current.revision || 0) !== Number(observed.revision || 0)
          || entryFingerprint(current) !== entryFingerprint(observed)) {
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

  applyEntries(local, applied);
  return applied.length;
}

export async function markMultipleActiveTimers(local, { lease } = {}) {
  const active = [...local.values()]
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
  return applyEntries(local, changed);
}

function isExpiredDeletion(deletedAt) {
  if (!deletedAt) return false;
  const time = new Date(deletedAt).getTime();
  return Number.isFinite(time) && time < addDays(new Date(), -14).getTime();
}

async function ensureRemoteReady(provider, { lease }) {
  return provider.ensureReady({ lease });
}

async function runSyncCycle({ force, migrationId = "", provider: injectedProvider = null }) {
  let phase = "preflight";
  let entryCount = 0;
  await assertMigrationMaySync(migrationId);
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
      if (leaseLost || !await isLockCurrent(lock)) {
        leaseLost = true;
        throw codedError("SYNC_BUSY", "sync lease was lost; retrying from a fresh snapshot is required");
      }
    }
  };
  const leaseTimer = setInterval(() => {
    renewLock(lock).then((renewed) => {
      if (!renewed) leaseLost = true;
    }).catch(() => {
      leaseLost = true;
    });
  }, Math.floor(SYNC_LOCK_TTL_MS / 3));

  let activeProvider = null;
  try {
    const provider = injectedProvider || await getActiveRemoteProvider();
    activeProvider = provider;
    const changeTokenKey = changeTokenSettingKey(provider);
    phase = "read_local";
    await lease.assert();
    const local = localState(await getAllEntries());
    entryCount = local.size;
    await lease.assert();
    phase = "intent_cleanup";
    await pruneExpiredReconciliationIntents();
    await lease.assert();
    // A timer left running overnight stays running. Only genuinely competing
    // timers are flagged, and that is done before the push so the state travels
    // in the same pass.
    phase = "active_timer_check";
    const conflictChanges = await markMultipleActiveTimers(local, { lease });
    // Under the sync lock, so two contexts cannot both decide none exists and
    // each create one.
    phase = "ensure_ready";
    const readinessChanged = await ensureRemoteReady(provider, { lease });

    // Both marking passes set dirty, so either of them producing changes makes
    // hasLocalWork true and forces the read below.
    const hasLocalWork = [...local.values()].some((entry) => entry.dirty || isExpiredDeletion(entry.deleted_at))
      || await hasPendingConfig();

    // A forced sync always reads. Idle cycles can use the provider change token
    // to avoid downloading an unchanged snapshot.
    let changeToken = "";
    if (!hasLocalWork && !force) {
      phase = "remote_gate";
      await lease.assert();
      changeToken = await provider.getChangeToken();
      await lease.assert();
      const lastSeenToken = String(await getSetting(changeTokenKey, "") || "");
      if (changeToken && lastSeenToken && changeToken === lastSeenToken) {
        await lease.assert();
        await clearBackoff();
        const timestamp = nowIso();
        await recordCycleActivity({ changed: false, force, status: "synced", succeededAt: timestamp });
        return { status: "synced", warning: "", syncedAt: timestamp, changed: false };
      }
    }

    phase = "remote_read";
    await lease.assert();
    const snapshot = await provider.readSnapshot();
    await lease.assert();

    await lease.assert();

    if (snapshot.quarantined?.length) {
      await recordDiagnostic({
        subsystem: "sync",
        phase: "remote_read",
        code: "REMOTE_ROWS_QUARANTINED",
        entryCount: snapshot.quarantined.length,
        recovery: "Open Reconcile and correct the invalid remote records."
      });
    }

    const quarantinedIds = new Set((snapshot.quarantined || []).map((item) => item.id).filter(Boolean));

    const forcedResolutions = await verifiedLocalResolutions(local, snapshot.entries);
    const pendingBackupSetting = await getSetting(SETTING_KEY.SYNC_RECOVERY_PENDING, []);
    const pendingBackupIds = new Set(Array.isArray(pendingBackupSetting) ? pendingBackupSetting : []);
    const recoveryBlockedIds = await protectDeletionRecovery(
      local,
      snapshot.entries,
      pendingBackupIds,
      new Set(forcedResolutions.keys()),
      { lease }
    );
    const blockedIds = new Set([...quarantinedIds, ...recoveryBlockedIds]);
    phase = "push";
    const pushedIds = await pushDirtyEntries(local, snapshot.entries, snapshot.entryRefs, {
      blockedIds,
      forcedIds: new Set(forcedResolutions.keys()),
      lease,
      provider
    });
    const completedResolutionIds = new Set([...forcedResolutions]
      .filter(([id]) => pushedIds.has(id))
      .map(([, resolutionId]) => resolutionId));
    await clearCompletedResolutions(completedResolutionIds, { lease });
    phase = "pull";
    const pulled = await pullRemoteEntries(local, snapshot.entries, pushedIds, { blockedIds, lease });
    phase = "config";
    const configOutcome = await syncConfig(snapshot.config, snapshot.configRefs, { lease, provider });

    // Refresh the provider token after our own writes to avoid an unnecessary
    // snapshot download on the next idle cycle.
    const wroteRemotely = pushedIds.size > 0 || configOutcome.changed;
    phase = "remote_token";
    const nextToken = wroteRemotely ? await provider.getChangeToken() : snapshot.changeToken;
    await lease.assert();
    await setSetting(changeTokenKey, nextToken || "");

    phase = "complete";
    const reviewCount = (snapshot.quarantined?.length || 0)
      + snapshot.entries.filter((remote) => hasEqualTimestampConflict(remote, local.get(remote.id))).length
      + [...local.values()].filter((entry) => entry.status === "needs_review").length
      + (configOutcome.conflict ? 1 : 0);
    const changed = wroteRemotely
      || pulled > 0
      || conflictChanges.length > 0
      || Boolean(readinessChanged);
    const timestamp = nowIso();
    await lease.assert();
    await clearBackoff();
    const status = reviewCount ? "needs review" : "synced";
    const warning = reviewCount ? `${reviewCount} item${reviewCount === 1 ? "" : "s"} need review` : "";
    await recordCycleActivity({ changed, force, status, warning, succeededAt: timestamp });
    if (changed) notifyEntriesChanged({ action: "sync" });
    return {
      status,
      warning,
      syncedAt: timestamp,
      changed
    };
  } catch (error) {
    const retryAt = await recordBackoff(error);
    await recordSyncDiagnostic(phase, error, entryCount, retryAt, { provider: activeProvider?.label });
    throw error;
  } finally {
    clearInterval(leaseTimer);
    await releaseLock(lock);
  }
}

/**
 * Forgets the last seen remote modification time, so the next sync reads the
 * remote API instead of trusting the gate. Called after an extension update,
 * where a new version may need to read a provider snapshot again.
 */
export async function clearRemoteReadMarker() {
  await setSetting(MYSQL_REMOTE_CHANGE_TOKEN_KEY, "");
  await setSetting(CLOUDFLARE_D1_REMOTE_CHANGE_TOKEN_KEY, "");
}

/**
 * Tracks how many cycles in a row found nothing to do. A cycle that moved data,
 * or any user-initiated sync, resets the count.
 */
async function recordCycleActivity({ changed, force, status = "synced", succeededAt = nowIso() }) {
  await mutateSettings([
    IDLE_STREAK_KEY,
    SETTING_KEY.SYNC_LAST_SUCCESS_AT,
    SETTING_KEY.SYNC_LAST_STATUS
  ], (settings) => {
    settings.set(SETTING_KEY.SYNC_LAST_SUCCESS_AT, succeededAt);
    settings.set(SETTING_KEY.SYNC_LAST_STATUS, status);
    if (changed || force) {
      settings.set(IDLE_STREAK_KEY, 0);
      return;
    }
    const streak = Number(settings.get(IDLE_STREAK_KEY)) || 0;
    settings.set(IDLE_STREAK_KEY, Math.min(streak + 1, IDLE_BACKOFF_STEPS.length));
  });
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



function startSyncCycle(drain, options) {
  const promise = runSyncCycle(options);
  drain.current = { promise, options };
  return promise;
}

function startSyncDrain(options) {
  const drain = { current: null, queued: null, drainPromise: null };
  syncDrain = drain;
  let cycle = startSyncCycle(drain, options);
  // Keep this promise registered until every stronger request that arrived
  // during the active cycle has run. The individual cycle promises preserve
  // caller-specific success/failure while this drain remains the context gate.
  drain.drainPromise = (async () => {
    while (cycle) {
      try {
        await cycle;
      } catch {
        // A queued stronger request must still run after a failed cycle.
      }

      if (!drain.queued) return;
      const next = drain.queued;
      drain.queued = null;
      cycle = startSyncCycle(drain, next.options);
      cycle.then(next.deferred.resolve, next.deferred.reject);
    }
  })().finally(() => {
    if (syncDrain === drain) syncDrain = null;
  });
  return cycle;
}

export function syncNow({ force = false, migrationId = "", provider = null } = {}) {
  // Collapse overlapping calls from the same context, such as the poller firing
  // while a user action is still syncing.
  if (!syncDrain) return startSyncDrain({ force, migrationId, provider });

  const stronger = force && !syncDrain.current.options.force;
  if (!stronger) return syncDrain.queued?.deferred.promise || syncDrain.current.promise;

  const queued = syncDrain.queued || {
    deferred: deferred(),
    options: { force: false, migrationId: "", provider: null }
  };
  queued.options = {
    force: force || queued.options.force,
    migrationId: migrationId || queued.options.migrationId,
    provider: provider || queued.options.provider
  };
  syncDrain.queued = queued;
  return queued.deferred.promise;
}

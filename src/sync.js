import { claimLock, deleteEntry, getAllEntries, getEntry, putEntry, putEntries, releaseLock, setSetting, getSetting } from "./db.js";
import {
  appendRemoteEntries,
  deleteRemoteRows,
  getRemoteModifiedTime,
  readRemoteSnapshot,
  updateRemoteConfig,
  updateRemoteEntries
} from "./sheets.js";
import { notifyEntriesChanged } from "./events.js";
import { isRemoteNewer, normalizeEntry } from "./entries.js";
import { addDays, nowIso, startOfLocalDay, uuid } from "./time.js";
import { platform } from "./platform.js";

const MAX_BACKOFF_SECONDS = 300;
const SYNC_LOCK_KEY = "sync_lock";
const SYNC_LOCK_TTL_MS = 120000;
const REMOTE_MODIFIED_KEY = "remote_modified_time";
const MULTIPLIER_KEY = "duration_multiplier";
const MULTIPLIER_UPDATED_KEY = "duration_multiplier_updated_at";
const MULTIPLIER_SYNCED_KEY = "duration_multiplier_synced_at";

// Identifies this module instance, which is one per extension context (popup,
// calendar page, background). Used as the sync lock holder.
const CONTEXT_ID = uuid();
let inFlightSync = null;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Clears the dirty flag for an entry that was just pushed. The push snapshot can
 * be stale by the time the request returns, so an entry edited mid-flight is
 * left dirty for the next cycle rather than being overwritten.
 */
async function markSynced(entry) {
  const current = await getEntry(entry.id);
  if (current && (current.updated_at !== entry.updated_at
    || Number(current.revision || 0) !== Number(entry.revision || 0))) {
    return current;
  }

  const timestamp = nowIso();
  const clean = normalizeEntry({
    ...entry,
    dirty: false,
    last_sync_at: timestamp,
    sync_error: ""
  });
  await putEntry(clean);
  return clean;
}

async function recordBackoff(error) {
  if (!["RATE_LIMIT", "API_ERROR", "OFFLINE"].includes(error.code)) return;
  const current = Number(await getSetting("sync_backoff_seconds", 0)) || 0;
  const next = current ? Math.min(current * 2, MAX_BACKOFF_SECONDS) : 30;
  await setSetting("sync_backoff_seconds", next);
  await setSetting("sync_backoff_until", Date.now() + next * 1000);
}

async function clearBackoff() {
  await setSetting("sync_backoff_seconds", 0);
  await setSetting("sync_backoff_until", 0);
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

/**
 * Writes local changes to the sheet and returns the ids that were pushed, so the
 * pull step can skip them: the snapshot it works from predates these writes.
 * All row rewrites go in one request and all new rows in another, so the cost is
 * two calls regardless of how many entries are pending.
 */
async function pushDirtyEntries(local, remoteEntries, rowMap, { interactiveAuth }) {
  const remoteById = new Map(remoteEntries.map((entry) => [entry.id, entry]));
  const updates = [];
  const appends = [];

  for (const entry of local.all()) {
    if (!entry.dirty) continue;
    const remote = remoteById.get(entry.id);
    if (remote && isRemoteNewer(remote, entry)) continue;
    if (rowMap.has(entry.id)) {
      updates.push({ rowIndex: rowMap.get(entry.id), entry });
    } else {
      appends.push(entry);
    }
  }

  const pushedIds = new Set();
  if (!updates.length && !appends.length) return pushedIds;

  await updateRemoteEntries(updates, { interactiveAuth });
  // Rows come back from the API; an unmapped entry is matched by id on the next
  // read rather than written to a guessed row.
  for (const { id, rowIndex } of await appendRemoteEntries(appends, { interactiveAuth })) {
    rowMap.set(id, rowIndex);
  }

  for (const entry of [...updates.map((update) => update.entry), ...appends]) {
    pushedIds.add(entry.id);
    local.apply([await markSynced(entry)]);
  }

  return pushedIds;
}

async function pullRemoteEntries(local, remoteEntries, pushedIds = new Set()) {
  const localById = new Map(local.all().map((entry) => [entry.id, entry]));
  const toSave = [];

  for (const remote of remoteEntries) {
    if (pushedIds.has(remote.id)) continue;
    const existing = localById.get(remote.id);
    if (!existing || !existing.dirty || isRemoteNewer(remote, existing)) {
      toSave.push(normalizeEntry({
        ...remote,
        dirty: false,
        last_sync_at: nowIso(),
        sync_error: ""
      }));
    }
  }

  await putEntries(toSave);
  local.apply(toSave);
  return toSave.length;
}

async function markMultipleActiveTimers(local) {
  const active = local.all()
    .filter((entry) => !entry.deleted_at && !entry.end_at)
    .sort((a, b) => String(b.start_at).localeCompare(String(a.start_at)));

  if (active.length <= 1) return [];

  const older = active.slice(1);
  const timestamp = nowIso();
  const changed = older
    .filter((entry) => entry.status !== "needs_review")
    .map((entry) => normalizeEntry({
      ...entry,
      status: "needs_review",
      updated_at: timestamp,
      revision: Number(entry.revision || 0) + 1,
      dirty: true,
      sync_error: "Multiple active timers detected"
    }));

  await putEntries(changed);
  return local.apply(changed);
}

function isExpiredDeletion(deletedAt) {
  if (!deletedAt) return false;
  const time = new Date(deletedAt).getTime();
  return Number.isFinite(time) && time < addDays(new Date(), -14).getTime();
}

async function purgeDeletedEntries(local, remoteEntries, rowMap, { interactiveAuth = false } = {}) {
  const expiredRows = remoteEntries
    .filter((entry) => isExpiredDeletion(entry.deleted_at) && rowMap.has(entry.id))
    .map((entry) => ({ id: entry.id, rowIndex: rowMap.get(entry.id) }));

  // deleteRemoteRows orders the deletions itself; one request covers every row.
  let blockedIds = new Set();
  if (expiredRows.length) {
    try {
      await deleteRemoteRows(expiredRows.map((row) => row.rowIndex), { interactiveAuth });
      for (const { id } of expiredRows) rowMap.delete(id);
    } catch {
      // Keep the local copies so the rows are retried on the next sync.
      blockedIds = new Set(expiredRows.map((row) => row.id));
    }
  }

  const toDelete = local.all().filter((entry) => isExpiredDeletion(entry.deleted_at) && !blockedIds.has(entry.id));
  for (const entry of toDelete) {
    await deleteEntry(entry.id);
    local.forget(entry.id);
  }
  return toDelete.length;
}

async function markStaleActiveTimers(local) {
  const todayStartMs = startOfLocalDay(new Date()).getTime();
  const stale = local.all().filter((entry) => {
    if (entry.deleted_at) return false;
    if (entry.end_at) return false;
    // Entries already flagged needs_review are still open timers and must be
    // closed too, otherwise they stay active forever.
    const startMs = new Date(entry.start_at).getTime();
    if (!Number.isFinite(startMs)) return true;
    return startMs < todayStartMs;
  });
  if (!stale.length) return [];
  const timestamp = nowIso();
  const changed = stale.map((entry) =>
    normalizeEntry({
      ...entry,
      end_at: timestamp,
      status: "needs_review",
      updated_at: timestamp,
      revision: Number(entry.revision || 0) + 1,
      dirty: true,
      sync_error: "Stale timer detected"
    })
  );
  await putEntries(changed);
  return local.apply(changed);
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
async function syncConfig(remoteConfig, configRows, { interactiveAuth }) {
  const remote = remoteConfig[MULTIPLIER_KEY];
  const remoteUpdatedAt = remote ? String(remote.updated_at || "") : "";
  const remoteValue = remote ? String(remote.value || "") : "";
  const localUpdatedAt = String(await getSetting(MULTIPLIER_UPDATED_KEY, "") || "");
  const localValue = String(await getSetting(MULTIPLIER_KEY, "1"));

  if (remoteUpdatedAt && remoteUpdatedAt > localUpdatedAt) {
    await setSetting(MULTIPLIER_KEY, remoteValue);
    await setSetting(MULTIPLIER_UPDATED_KEY, remoteUpdatedAt);
    await setSetting(MULTIPLIER_SYNCED_KEY, remoteUpdatedAt);
    return false;
  }

  if (!localUpdatedAt) return false;
  if (remoteUpdatedAt === localUpdatedAt && remoteValue === localValue) {
    await setSetting(MULTIPLIER_SYNCED_KEY, localUpdatedAt);
    return false;
  }

  await updateRemoteConfig(MULTIPLIER_KEY, localValue, localUpdatedAt, {
    rowIndex: configRows.get(MULTIPLIER_KEY) || 0,
    interactiveAuth
  });
  await setSetting(MULTIPLIER_SYNCED_KEY, localUpdatedAt);
  return true;
}

async function runSyncCycle({ interactiveAuth, force }) {
  if (!platform.isOnline()) {
    const error = codedError("OFFLINE", "offline");
    await recordBackoff(error);
    throw error;
  }

  const backoffUntil = Number(await getSetting("sync_backoff_until", 0)) || 0;
  if (!force && backoffUntil > Date.now()) {
    throw codedError("BACKOFF", `retry after ${Math.ceil((backoffUntil - Date.now()) / 1000)}s`);
  }

  // The popup, the calendar page, and the background alarm all sync
  // independently. Without this lock two cycles can each miss the other's rows
  // and append the same entry twice.
  if (!(await claimLock(SYNC_LOCK_KEY, CONTEXT_ID, SYNC_LOCK_TTL_MS))) {
    throw codedError("SYNC_BUSY", "another sync is already running");
  }

  try {
    const local = localState(await getAllEntries());
    const staleChanges = await markStaleActiveTimers(local);
    // Flagged before the push so the conflict markers travel in the same pass.
    const conflictChanges = await markMultipleActiveTimers(local);

    const hasLocalWork = local.all().some((entry) => entry.dirty || isExpiredDeletion(entry.deleted_at))
      || await hasPendingConfig();

    // Drive reports when the file last changed for a fraction of the cost of
    // downloading it. With nothing to push and no remote change since the last
    // read, the whole exchange is skipped. An empty modifiedTime means Drive is
    // unavailable or the scope was never granted, so the read always happens.
    const modifiedTime = await getRemoteModifiedTime({ interactiveAuth });
    const lastSeenModified = String(await getSetting(REMOTE_MODIFIED_KEY, "") || "");
    if (modifiedTime && lastSeenModified && modifiedTime === lastSeenModified && !hasLocalWork) {
      await clearBackoff();
      if (staleChanges.length || conflictChanges.length) notifyEntriesChanged({ action: "sync" });
      return {
        status: conflictChanges.length ? "needs review" : "synced",
        warning: conflictChanges.length ? "multiple active timers flagged" : "",
        syncedAt: nowIso(),
        remoteRead: false
      };
    }

    const snapshot = await readRemoteSnapshot({ interactiveAuth });
    const pushedIds = await pushDirtyEntries(local, snapshot.entries, snapshot.rowMap, { interactiveAuth });
    await pullRemoteEntries(local, snapshot.entries, pushedIds);
    // Purge last: it consumes the same snapshot, and deleting rows first would
    // let the pull re-insert what it removed.
    const purged = await purgeDeletedEntries(local, snapshot.entries, snapshot.rowMap, { interactiveAuth });
    const configPushed = await syncConfig(snapshot.config, snapshot.configRows, { interactiveAuth });

    // Our own writes bump modifiedTime, so it is re-read to avoid a needless
    // download next cycle. If Drive lags, the gate simply opens once more.
    const wroteRemotely = pushedIds.size > 0 || purged > 0 || configPushed;
    const nextModified = wroteRemotely ? await getRemoteModifiedTime({ interactiveAuth }) : modifiedTime;
    await setSetting(REMOTE_MODIFIED_KEY, nextModified || "");

    const timestamp = nowIso();
    await clearBackoff();
    notifyEntriesChanged({ action: "sync" });
    return {
      status: conflictChanges.length ? "needs review" : "synced",
      warning: conflictChanges.length ? "multiple active timers flagged" : "",
      syncedAt: timestamp,
      remoteRead: true
    };
  } catch (error) {
    await recordBackoff(error);
    throw error;
  } finally {
    await releaseLock(SYNC_LOCK_KEY, CONTEXT_ID);
  }
}

export async function syncNow({ interactiveAuth = false, force = false } = {}) {
  // Collapse overlapping calls from the same context, such as the poller firing
  // while a user action is still syncing.
  if (inFlightSync) return inFlightSync;

  inFlightSync = runSyncCycle({ interactiveAuth, force }).finally(() => {
    inFlightSync = null;
  });
  return inFlightSync;
}

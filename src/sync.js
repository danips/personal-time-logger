import { claimLock, deleteEntry, getAllEntries, getEntry, mutateEntries, mutateSettings, putEntry, putEntries, releaseLock, setSetting, getSetting } from "./db.js";
import {
  appendRemoteEntries,
  deleteRemoteRows,
  ensureAppMarker,
  getRemoteModifiedTime,
  getSpreadsheetId,
  isSpreadsheetGone,
  provisionSpreadsheet,
  readRemoteSnapshot,
  updateRemoteConfig,
  updateRemoteEntries
} from "./sheets.js";
import { notifyEntriesChanged } from "./events.js";
import { entryFingerprint, RECONCILIATION_INTENTS_KEY } from "./reconcile.js";
import { isRemoteNewer, normalizeEntry } from "./entries.js";
import { addDays, nowIso, uuid } from "./time.js";

import { platform } from "./platform.js";

const MAX_BACKOFF_SECONDS = 300;
const SYNC_LOCK_KEY = "sync_lock";
const SYNC_LOCK_TTL_MS = 120000;
const REMOTE_MODIFIED_KEY = "remote_modified_time";
const MULTIPLIER_KEY = "duration_multiplier";
const MULTIPLIER_UPDATED_KEY = "duration_multiplier_updated_at";
const MULTIPLIER_SYNCED_KEY = "duration_multiplier_synced_at";
const IDLE_STREAK_KEY = "sync_idle_streak";
// Multipliers applied to the configured interval as idle cycles accumulate.
const IDLE_BACKOFF_STEPS = [1, 2, 5, 10];
const MAX_IDLE_INTERVAL_MINUTES = 15;

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
async function pushDirtyEntries(local, remoteEntries, rowMap, { interactiveAuth, forcedIds = new Set() }) {
  const remoteById = new Map(remoteEntries.map((entry) => [entry.id, entry]));
  const updates = [];
  const appends = [];

  for (const entry of local.all()) {
    if (!entry.dirty) continue;
    const remote = remoteById.get(entry.id);
    if (remote && isRemoteNewer(remote, entry) && !forcedIds.has(entry.id)) continue;
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

async function verifiedLocalResolutionIds(local, remoteEntries) {
  const intents = await getSetting(RECONCILIATION_INTENTS_KEY, []);
  if (!Array.isArray(intents) || !intents.length) return new Set();
  const remoteById = new Map(remoteEntries.map((entry) => [entry.id, entry]));
  const localById = new Map(local.all().map((entry) => [entry.id, entry]));
  const verified = new Set();
  for (const intent of intents) {
    if (!intent || intent.chosen_side !== "local") continue;
    const localEntry = localById.get(intent.entry_id);
    const remoteEntry = remoteById.get(intent.entry_id);
    if (!localEntry || !remoteEntry) continue;
    if (Number(localEntry.revision || 0) !== Number(intent.local_revision)) continue;
    if (entryFingerprint(remoteEntry) !== intent.remote_fingerprint) continue;
    verified.add(intent.entry_id);
  }
  return verified;
}

async function clearCompletedResolutions(ids) {
  if (!ids.size) return;
  await mutateSettings([RECONCILIATION_INTENTS_KEY], (settings) => {
    const intents = Array.isArray(settings.get(RECONCILIATION_INTENTS_KEY))
      ? settings.get(RECONCILIATION_INTENTS_KEY)
      : [];
    settings.set(RECONCILIATION_INTENTS_KEY, intents.filter((intent) => !ids.has(intent?.entry_id)));
  });
}

export async function pullRemoteEntries(local, remoteEntries, pushedIds = new Set()) {
  const localById = new Map(local.all().map((entry) => [entry.id, entry]));
  const applied = [];

  for (const remote of remoteEntries) {
    if (pushedIds.has(remote.id)) continue;
    const observed = localById.get(remote.id);
    const result = await mutateEntries([remote.id], observed ? observed.revision : undefined, (entries) => {
      const current = entries.get(remote.id);
      // A previously absent entry that appeared during the network read is a
      // local write, not permission to import over it.
      if (!observed && current) return { applied: false };
      if (observed && !current) return { applied: false };
      if (current && !current.dirty && !isRemoteNewer(remote, current)) return { applied: false };
      if (current && current.dirty && !isRemoteNewer(remote, current)) return { applied: false };

      const next = normalizeEntry({
        ...remote,
        dirty: false,
        last_sync_at: nowIso(),
        sync_error: ""
      });
      entries.set(remote.id, next);
      return { applied: true, entry: next };
    }).catch((error) => {
      if (error.code === "STORAGE_CONFLICT") return { applied: false };
      throw error;
    });
    if (result.applied) applied.push(result.entry);
  }

  local.apply(applied);
  return applied.length;
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
      await deleteRemoteRows(expiredRows, { interactiveAuth });
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

/**
 * Flags every live entry for push and forgets the read marker.
 *
 * Required whenever the spreadsheet changes. Local entries are clean after their
 * last sync, so without this the newly adopted or created sheet would receive
 * nothing and sit empty while the UI looked perfectly healthy. updated_at and
 * revision are deliberately untouched, so reconciling against a sheet that
 * already holds rows still resolves by age rather than by which side is newer.
 */
async function reseedForNewSpreadsheet(local) {
  const reseeded = local.all()
    .filter((entry) => !entry.deleted_at && !entry.dirty)
    .map((entry) => ({ ...entry, dirty: true, sync_error: "" }));

  await putEntries(reseeded);
  local.apply(reseeded);
  await setSetting(REMOTE_MODIFIED_KEY, "");
  return reseeded.length;
}

/**
 * Makes sure a spreadsheet is selected, adopting the most recently modified one
 * this extension created or creating one when there are none.
 */
async function ensureSpreadsheet(local, { interactiveAuth }) {
  if (await getSpreadsheetId()) return null;

  const provisioned = await provisionSpreadsheet({ interactiveAuth });
  await reseedForNewSpreadsheet(local);
  return provisioned;
}

/**
 * Recovers from a spreadsheet that has been deleted or trashed, by detecting or
 * creating a replacement and re-seeding it from local data.
 *
 * Only acts once Drive confirms the file is actually gone, so an unreachable but
 * intact spreadsheet still reports its error rather than being silently replaced.
 */
async function reprovisionIfSpreadsheetGone(error, local, { interactiveAuth }) {
  if (error.code !== "API_ERROR" && error.code !== "SHEET_MISSING") return null;
  if (!await isSpreadsheetGone({ interactiveAuth })) return null;

  const provisioned = await provisionSpreadsheet({ interactiveAuth });
  await reseedForNewSpreadsheet(local);
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
    // A timer left running overnight stays running. Only genuinely competing
    // timers are flagged, and that is done before the push so the markers travel
    // in the same pass.
    const conflictChanges = await markMultipleActiveTimers(local);
    // Under the sync lock, so two contexts cannot both decide none exists and
    // each create one.
    let provisioned = await ensureSpreadsheet(local, { interactiveAuth });

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
      modifiedTime = await getRemoteModifiedTime({ interactiveAuth });
      const lastSeenModified = String(await getSetting(REMOTE_MODIFIED_KEY, "") || "");
      if (modifiedTime && lastSeenModified && modifiedTime === lastSeenModified) {
        await clearBackoff();
        await recordCycleActivity({ changed: false, force });
        return { status: "synced", warning: "", syncedAt: nowIso(), changed: false };
      }
    }

    let snapshot;
    try {
      snapshot = await readRemoteSnapshot({ interactiveAuth });
    } catch (error) {
      const recovered = await reprovisionIfSpreadsheetGone(error, local, { interactiveAuth });
      if (!recovered) throw error;
      provisioned = recovered;
      snapshot = await readRemoteSnapshot({ interactiveAuth });
    }

    const forcedResolutionIds = await verifiedLocalResolutionIds(local, snapshot.entries);
    const pushedIds = await pushDirtyEntries(local, snapshot.entries, snapshot.rowMap, {
      interactiveAuth,
      forcedIds: forcedResolutionIds
    });
    await clearCompletedResolutions(new Set([...forcedResolutionIds].filter((id) => pushedIds.has(id))));
    const pulled = await pullRemoteEntries(local, snapshot.entries, pushedIds);
    // Purge last: it consumes the same snapshot, and deleting rows first would
    // let the pull re-insert what it removed.
    const purged = await purgeDeletedEntries(local, snapshot.entries, snapshot.rowMap, { interactiveAuth });
    const configPushed = await syncConfig(snapshot.config, snapshot.configRows, { interactiveAuth });
    // Backfills spreadsheets created before the marker existed, once.
    const markerWritten = await ensureAppMarker(snapshot.config, snapshot.configRows, { interactiveAuth });

    // Our own writes bump modifiedTime, so it is re-read to avoid a needless
    // download next cycle. If Drive lags, the gate simply opens once more.
    const wroteRemotely = pushedIds.size > 0 || purged > 0 || configPushed || markerWritten;
    const nextModified = wroteRemotely || !modifiedTime
      ? await getRemoteModifiedTime({ interactiveAuth })
      : modifiedTime;
    await setSetting(REMOTE_MODIFIED_KEY, nextModified || "");

    const changed = wroteRemotely
      || pulled > 0
      || conflictChanges.length > 0
      || Boolean(provisioned);
    const timestamp = nowIso();
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
    await recordBackoff(error);
    throw error;
  } finally {
    await releaseLock(SYNC_LOCK_KEY, CONTEXT_ID);
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
  const configured = Number(await getSetting("sync_interval_seconds", 60)) || 60;
  const baseMinutes = Math.max(1, Math.round(Math.max(30, configured) / 60));
  const streak = Number(await getSetting(IDLE_STREAK_KEY, 0)) || 0;
  const factor = IDLE_BACKOFF_STEPS[Math.min(streak, IDLE_BACKOFF_STEPS.length - 1)];
  return Math.min(baseMinutes * factor, MAX_IDLE_INTERVAL_MINUTES);
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

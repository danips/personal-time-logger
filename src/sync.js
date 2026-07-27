import { deleteEntry, getAllEntries, getDirtyEntries, putEntry, putEntries, setSetting, getSetting } from "./db.js";
import { appendRemoteEntry, deleteRemoteRow, readRemoteConfig, readRemoteEntries, updateRemoteConfig, updateRemoteEntry } from "./sheets.js";
import { notifyEntriesChanged } from "./events.js";
import { isRemoteNewer, normalizeEntry } from "./entries.js";
import { addDays, nowIso, startOfLocalDay } from "./time.js";
import { platform } from "./platform.js";

const MAX_BACKOFF_SECONDS = 300;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function markSynced(entry) {
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

async function pushDirtyEntries(remoteEntries, rowMap, { interactiveAuth }) {
  const remoteById = new Map(remoteEntries.map((entry) => [entry.id, entry]));
  const dirtyEntries = await getDirtyEntries();

  for (const local of dirtyEntries) {
    const remote = remoteById.get(local.id);

    if (remote && isRemoteNewer(remote, local)) continue;

    if (rowMap.has(local.id)) {
      await updateRemoteEntry(rowMap.get(local.id), local, { interactiveAuth });
    } else {
      await appendRemoteEntry(local, { interactiveAuth });
      const nextRow = rowMap.size + 2;
      rowMap.set(local.id, nextRow);
    }
    await markSynced(local);
  }
}

async function pullRemoteEntries(remoteEntries) {
  const localEntries = await getAllEntries();
  const localById = new Map(localEntries.map((entry) => [entry.id, entry]));
  const toSave = [];

  for (const remote of remoteEntries) {
    const local = localById.get(remote.id);
    if (!local || !local.dirty || isRemoteNewer(remote, local)) {
      toSave.push(normalizeEntry({
        ...remote,
        dirty: false,
        last_sync_at: nowIso(),
        sync_error: ""
      }));
    }
  }

  await putEntries(toSave);
}

async function markMultipleActiveTimers() {
  const entries = await getAllEntries();
  const active = entries
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
  return changed;
}

async function purgeDeletedEntries(remoteEntries = null, rowMap = null, { interactiveAuth = false } = {}) {
  const cutoffMs = addDays(new Date(), -14).getTime();
  const isExpired = (deletedAt) => {
    const time = new Date(deletedAt).getTime();
    return Number.isFinite(time) && time < cutoffMs;
  };
  const failedRemoteIds = new Set();

  if (remoteEntries && rowMap) {
    // deleteRemoteRow shifts every row below it up by one, so the indices in
    // rowMap only stay valid while deleting from the bottom of the sheet up.
    const expiredRows = remoteEntries
      .filter((entry) => entry.deleted_at && isExpired(entry.deleted_at) && rowMap.has(entry.id))
      .map((entry) => ({ id: entry.id, rowIndex: rowMap.get(entry.id) }))
      .sort((first, second) => second.rowIndex - first.rowIndex);

    for (const { id, rowIndex } of expiredRows) {
      try {
        await deleteRemoteRow(rowIndex, { interactiveAuth });
        rowMap.delete(id);
      } catch {
        // Keep the local copy so the row is retried on the next sync.
        failedRemoteIds.add(id);
      }
    }
  }

  const localEntries = await getAllEntries();
  const toDelete = localEntries.filter((entry) => entry.deleted_at
    && isExpired(entry.deleted_at)
    && !failedRemoteIds.has(entry.id));
  for (const entry of toDelete) {
    await deleteEntry(entry.id);
  }
  return toDelete.length;
}

async function markStaleActiveTimers() {
  const todayStartMs = startOfLocalDay(new Date()).getTime();
  const entries = await getAllEntries();
  const stale = entries.filter((entry) => {
    if (entry.deleted_at) return false;
    if (entry.end_at) return false;
    // Entries already flagged needs_review are still open timers and must be
    // closed too, otherwise they stay active forever.
    const startMs = new Date(entry.start_at).getTime();
    if (!Number.isFinite(startMs)) return true;
    return startMs < todayStartMs;
  });
  if (!stale.length) return 0;
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
  return changed.length;
}

async function pushLocalConfig({ interactiveAuth }) {
  const localValue = await getSetting("duration_multiplier", "1");
  const localUpdatedAt = await getSetting("duration_multiplier_updated_at", "");
  if (!localUpdatedAt) return;
  await updateRemoteConfig("duration_multiplier", String(localValue), localUpdatedAt, { interactiveAuth });
}

async function pullRemoteConfig({ interactiveAuth }) {
  const remoteConfig = await readRemoteConfig({ interactiveAuth });
  const remote = remoteConfig["duration_multiplier"];
  if (remote && remote.updated_at) {
    const localUpdatedAt = await getSetting("duration_multiplier_updated_at", "");
    if (remote.updated_at > localUpdatedAt) {
      await setSetting("duration_multiplier", remote.value);
      await setSetting("duration_multiplier_updated_at", remote.updated_at);
    }
  }
}

export async function syncNow({ interactiveAuth = false, force = false } = {}) {
  if (!platform.isOnline()) {
    const error = codedError("OFFLINE", "offline");
    await recordBackoff(error);
    throw error;
  }

  const backoffUntil = Number(await getSetting("sync_backoff_until", 0)) || 0;
  if (!force && backoffUntil > Date.now()) {
    throw codedError("BACKOFF", `retry after ${Math.ceil((backoffUntil - Date.now()) / 1000)}s`);
  }

  try {
    await markStaleActiveTimers();

    const firstRead = await readRemoteEntries({ interactiveAuth });
    await pushDirtyEntries(firstRead.entries, firstRead.rowMap, { interactiveAuth });

    const secondRead = await readRemoteEntries({ interactiveAuth });
    // Pull before purging: purge works from this same snapshot, so purging
    // first would let the pull re-insert the rows it just removed.
    await pullRemoteEntries(secondRead.entries);
    await purgeDeletedEntries(secondRead.entries, secondRead.rowMap, { interactiveAuth });

    const conflictChanges = await markMultipleActiveTimers();
    if (conflictChanges.length) {
      const thirdRead = await readRemoteEntries({ interactiveAuth });
      await pushDirtyEntries(thirdRead.entries, thirdRead.rowMap, { interactiveAuth });
    }

    await pullRemoteConfig({ interactiveAuth });
    await pushLocalConfig({ interactiveAuth });

    const timestamp = nowIso();
    await clearBackoff();
    notifyEntriesChanged({ action: "sync" });
    return {
      status: conflictChanges.length ? "error" : "synced",
      warning: conflictChanges.length ? "sync conflict / multiple active timers" : "",
      syncedAt: timestamp
    };
  } catch (error) {
    await recordBackoff(error);
    throw error;
  }
}

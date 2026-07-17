import { getAllEntries, getDirtyEntries, putEntry, putEntries, setSetting, getSetting } from "./db.js";
import { appendRemoteEntry, readRemoteEntries, updateRemoteEntry } from "./sheets.js";
import { notifyEntriesChanged } from "./events.js";
import { isRemoteNewer, normalizeEntry } from "./entries.js";
import { nowIso } from "./time.js";
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
    const firstRead = await readRemoteEntries({ interactiveAuth });
    await pushDirtyEntries(firstRead.entries, firstRead.rowMap, { interactiveAuth });

    const secondRead = await readRemoteEntries({ interactiveAuth });
    await pullRemoteEntries(secondRead.entries);

    const conflictChanges = await markMultipleActiveTimers();
    if (conflictChanges.length) {
      const thirdRead = await readRemoteEntries({ interactiveAuth });
      await pushDirtyEntries(thirdRead.entries, thirdRead.rowMap, { interactiveAuth });
    }

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

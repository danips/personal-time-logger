import { getSetting, setSetting } from "../src/db.js";
import { clearRemoteReadMarker, nextSyncDelayMinutes, syncNow } from "../src/sync.js";
import { NEXT_DUE_KEY, scheduleSyncHeartbeat, SYNC_ALARM } from "../src/background-schedule.js";
import { platform } from "../src/platform.js";

/**
 * The alarm is a fixed heartbeat and the actual sync interval is a due time in
 * settings. Adapting the alarm period itself would mean one-shot alarms, where a
 * failure to re-arm leaves the profile never syncing again; a heartbeat that
 * mostly returns early cannot get stuck, and costs nothing when it does.
 */
async function runBackgroundSync() {
  const dueAt = Number(await getSetting(NEXT_DUE_KEY, 0)) || 0;
  if (Date.now() < dueAt) return;

  try {
    await syncNow({ interactiveAuth: false });
  } catch {
    // Offline, backoff, another context already syncing, missing config, and
    // expired auth are all expected here. syncNow records its own backoff and the
    // UI surfaces sync status, so there is nothing to report from the background.
  }

  // Set from the idle streak, so a quiet profile stretches its polling out and
  // snaps back to the configured interval as soon as anything changes.
  await setSetting(NEXT_DUE_KEY, Date.now() + await nextSyncDelayMinutes() * 60000);
}

async function scheduleHeartbeat() {
  const configured = await getSetting("sync_interval_seconds", 60);
  return scheduleSyncHeartbeat(configured);
}

platform.onAlarm((alarm) => {
  if (alarm.name !== SYNC_ALARM) return;
  runBackgroundSync().then(scheduleHeartbeat);
});

// A new version may need to see the spreadsheet to migrate or repair it, so the
// read gate is cleared and the next sync brought forward.
platform.onInstalled(({ reason }) => {
  if (reason !== "install" && reason !== "update") return;
  clearRemoteReadMarker()
    .then(() => setSetting(NEXT_DUE_KEY, 0))
    .catch(() => {});
});

scheduleHeartbeat();

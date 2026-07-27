import { getSetting, setSetting } from "../src/db.js";
import { nextSyncDelayMinutes, syncNow } from "../src/sync.js";
import { platform } from "../src/platform.js";

const SYNC_ALARM = "timelogger-sync";
const NEXT_DUE_KEY = "background_sync_due_at";
const MIN_INTERVAL_SECONDS = 30;

async function heartbeatMinutes() {
  const configured = Number(await getSetting("sync_interval_seconds", 60)) || 60;
  const seconds = Math.max(MIN_INTERVAL_SECONDS, configured);
  // Alarms are minute-granular, so anything faster than a minute is clamped.
  return Math.max(1, Math.round(seconds / 60));
}

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
  // Re-creating the alarm with the same name replaces it, so this also picks up
  // changes to sync_interval_seconds made in the options page.
  platform.scheduleAlarm(SYNC_ALARM, await heartbeatMinutes());
}

platform.onAlarm((alarm) => {
  if (alarm.name !== SYNC_ALARM) return;
  runBackgroundSync().then(scheduleHeartbeat);
});

scheduleHeartbeat();

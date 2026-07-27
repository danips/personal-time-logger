import { getSetting } from "../src/db.js";
import { syncNow } from "../src/sync.js";
import { platform } from "../src/platform.js";

const SYNC_ALARM = "timelogger-sync";
const MIN_INTERVAL_SECONDS = 30;

async function syncIntervalMinutes() {
  const configured = Number(await getSetting("sync_interval_seconds", 60)) || 60;
  const seconds = Math.max(MIN_INTERVAL_SECONDS, configured);
  // Alarms are minute-granular, so anything faster than a minute is clamped.
  return Math.max(1, Math.round(seconds / 60));
}

async function runBackgroundSync() {
  try {
    await syncNow({ interactiveAuth: false });
  } catch {
    // Offline, backoff, missing config, and expired auth are all expected here.
    // syncNow records its own backoff, and the popup surfaces sync status, so
    // there is nothing to report from the background context.
  }
}

async function scheduleSync() {
  // Re-creating the alarm with the same name replaces it, so this also picks up
  // changes to sync_interval_seconds made in the options page.
  platform.scheduleAlarm(SYNC_ALARM, await syncIntervalMinutes());
}

platform.onAlarm((alarm) => {
  if (alarm.name !== SYNC_ALARM) return;
  runBackgroundSync().then(scheduleSync);
});

scheduleSync();

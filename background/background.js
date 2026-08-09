import { getSetting, setSetting } from "../src/db.js";
import { clearRemoteReadMarker, nextSyncDelayMinutes, syncNow } from "../src/sync.js";
import {
  MIN_SYNC_INTERVAL_SECONDS,
  NEXT_DUE_KEY,
  scheduleSyncHeartbeat,
  scheduleWithFallback,
  SYNC_ALARM
} from "../src/background-schedule.js";
import { platform } from "../src/platform.js";

const SCHEDULE_ERROR_KEY = "background_schedule_error";

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
  return scheduleWithFallback({
    async schedule() {
      const configured = await getSetting("sync_interval_seconds", 60);
      return scheduleSyncHeartbeat(configured);
    },
    scheduleFallback() {
      return scheduleSyncHeartbeat(MIN_SYNC_INTERVAL_SECONDS);
    },
    saveDiagnostic(diagnostic) {
      return setSetting(SCHEDULE_ERROR_KEY, diagnostic);
    }
  });
}

async function runAlarmLifecycle() {
  try {
    await runBackgroundSync();
  } catch {
    // Sync failures are expected and are handled by syncNow's backoff state.
  } finally {
    // This must be awaited so a failed due-time or sync operation cannot strand
    // future periodic work without attempting a conservative fallback alarm.
    await scheduleHeartbeat();
  }
}

platform.onAlarm((alarm) => {
  if (alarm.name !== SYNC_ALARM) return;
  void runAlarmLifecycle();
});

// A new version may need to see the spreadsheet to migrate or repair it, so the
// read gate is cleared and the next sync brought forward.
async function handleInstalled({ reason }) {
  if (reason !== "install" && reason !== "update") return;
  try {
    await clearRemoteReadMarker();
    await setSetting(NEXT_DUE_KEY, 0);
  } catch {
    // The guaranteed scheduling attempt in finally still gives this context a
    // chance to recover once IndexedDB is available again.
  } finally {
    await scheduleHeartbeat();
  }
}

platform.onInstalled((details) => {
  void handleInstalled(details);
});

void scheduleHeartbeat();

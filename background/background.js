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
import { recordDiagnostic } from "../src/diagnostics.js";
import { SETTING_KEY } from "../src/setting-keys.js";
import { ERROR_CODE } from "../src/error-codes.js";
import {
  sendTempoWorklogs,
  TEMPO_UPLOAD_MESSAGE,
  tempoXhrRequest
} from "../src/tempo.js";

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
  } catch (error) {
    // Offline, backoff, another context already syncing, missing config, and
    // expired auth are all expected here. syncNow records its own backoff and the
    // UI surfaces sync status, so there is nothing to report from the background.
    await recordDiagnostic({
      subsystem: "background",
      phase: "sync_cycle",
      error,
      recovery: "Open Options, review diagnostics, then retry sync."
    }).catch(() => {});
  }

  // Set from the idle streak, so a quiet profile stretches its polling out and
  // snaps back to the configured interval as soon as anything changes.
  await setSetting(NEXT_DUE_KEY, Date.now() + await nextSyncDelayMinutes() * 60000);
}

async function scheduleHeartbeat() {
  return scheduleWithFallback({
    async schedule() {
      const configured = await getSetting(SETTING_KEY.SYNC_INTERVAL_SECONDS, 60);
      return scheduleSyncHeartbeat(configured);
    },
    scheduleFallback() {
      return scheduleSyncHeartbeat(MIN_SYNC_INTERVAL_SECONDS);
    },
    async saveDiagnostic(diagnostic) {
      if (diagnostic) {
        await recordDiagnostic({
          subsystem: "background",
          phase: "schedule",
          code: diagnostic.code,
          recovery: "Open Options and retry after browser alarms are available."
        });
      }
    }
  });
}

async function runAlarmLifecycle() {
  try {
    await runBackgroundSync();
  } catch (error) {
    // Sync failures are expected and are handled by syncNow's backoff state.
    await recordDiagnostic({
      subsystem: "background",
      phase: "alarm_lifecycle",
      error,
      recovery: "Open Options, review diagnostics, then retry sync."
    }).catch(() => {});
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
  } catch (error) {
    // The guaranteed scheduling attempt in finally still gives this context a
    // chance to recover once IndexedDB is available again.
    await recordDiagnostic({
      subsystem: "background",
      phase: "install",
      error,
      recovery: "Restart the extension, then review Options diagnostics."
    }).catch(() => {});
  } finally {
    await scheduleHeartbeat();
  }
}

platform.onInstalled((details) => {
  void handleInstalled(details);
});

const TEMPO_ERROR_CODES = new Set([
  ERROR_CODE.TEMPO_API_ERROR,
  ERROR_CODE.TEMPO_CONFIG_MISSING,
  ERROR_CODE.TEMPO_NETWORK,
  ERROR_CODE.TEMPO_PARTIAL,
  ERROR_CODE.TEMPO_PERMISSION_MISSING
]);

async function uploadTempoWorklogs(message, sender) {
  const calendarUrl = platform.getURL("calendar/calendar.html");
  if (sender?.url !== calendarUrl || !Array.isArray(message.groups)) {
    return { ok: false, error: { code: ERROR_CODE.TEMPO_PERMISSION_MISSING } };
  }
  try {
    const token = await getSetting(SETTING_KEY.TEMPO_API_TOKEN, "");
    const result = await sendTempoWorklogs(message.groups, {
      token,
      fetchImpl: tempoXhrRequest
    });
    return { ok: true, result };
  } catch (error) {
    const code = TEMPO_ERROR_CODES.has(error?.code)
      ? error.code
      : ERROR_CODE.TEMPO_NETWORK;
    return { ok: false, error: { code } };
  }
}

platform.onRuntimeMessage((message, sender) => {
  if (message?.type !== TEMPO_UPLOAD_MESSAGE) return undefined;
  return uploadTempoWorklogs(message, sender);
});

void scheduleHeartbeat();

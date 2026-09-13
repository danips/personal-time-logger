import { getActiveEntries, getSetting, setSetting } from "../src/db.js";
import { clearRemoteReadMarker, nextSyncDelayMinutes, syncNow } from "../src/sync.js";
import {
  MIN_SYNC_INTERVAL_SECONDS,
  NEXT_DUE_KEY,
  scheduleSyncHeartbeat,
  scheduleWithFallback,
  SYNC_ALARM,
  UPDATE_CHECK_ALARM
} from "../src/background-schedule.js";
import { platform } from "../src/platform.js";
import { ERROR_CODE } from "../src/error-codes.js";
import { recordDiagnostic } from "../src/diagnostics.js";
import { SETTING_KEY } from "../src/setting-keys.js";
import { createToolbarIndicatorRefresher, updateActiveIcon } from "../src/icon.js";
import { runStaleTimerReminders } from "../src/timer-reminders.js";
import { onEntriesChanged } from "../src/events.js";
import {
  SYNC_REQUEST_MESSAGE,
  UPDATE_CHECK_MESSAGE,
  UPDATE_INSTALL_MESSAGE
} from "../src/sync-request.js";
import {
  TEMPO_CANCEL_MESSAGE,
  TEMPO_UPLOAD_MESSAGE,
  createTempoUploadHandler
} from "../src/tempo-upload-handler.js";
const UPDATE_CHECK_MINUTES = 24 * 60;

// The browser smoke package uses this non-routable update URL. Keep the alarm
// probe behind that marker so ordinary installations have no test control
// surface or altered toolbar bookkeeping.
const BROWSER_SMOKE_UPDATE_URL = "https://example.invalid/personal-time-logger/updates.json";
const BROWSER_SMOKE_ARM_ALARM_MESSAGE = "browser_smoke_arm_alarm";
const BROWSER_SMOKE_STATE_MESSAGE = "browser_smoke_alarm_state";
let browserSmokeAlarmRuns = 0;
let browserSmokeToolbarActive = null;
let browserSmokeLastAlarmError = null;

function browserSmokeEnabled() {
  const api = globalThis.browser || globalThis.chrome;
  return api?.runtime?.getManifest?.()?.browser_specific_settings?.gecko?.update_url
    === BROWSER_SMOKE_UPDATE_URL;
}

const refreshToolbarIndicator = createToolbarIndicatorRefresher({
  readActiveEntries: getActiveEntries,
  async updateIcon(active) {
    const applied = await updateActiveIcon(active);
    if (applied && browserSmokeEnabled()) browserSmokeToolbarActive = active;
    return applied;
  }
});

async function refreshToolbarIndicatorSafely() {
  try {
    await refreshToolbarIndicator();
  } catch (error) {
    await recordDiagnostic({
      subsystem: "background",
      phase: "toolbar-refresh",
      error,
      recovery: "The toolbar icon may be stale. Reopen the popup, then check Options diagnostics."
    }).catch(() => {});
  }
}

onEntriesChanged(() => { void refreshToolbarIndicatorSafely(); });

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
    if (browserSmokeEnabled()) browserSmokeLastAlarmError = {
      code: error?.code || "",
      message: error?.message || String(error)
    };
  }

  // Set from the idle streak, so a quiet profile stretches its polling out and
  // snaps back to the configured interval as soon as anything changes.
  await setSetting(NEXT_DUE_KEY, Date.now() + await nextSyncDelayMinutes() * 60000);
}

async function runStaleTimerReminderCycle() {
  const enabled = Boolean(await getSetting(SETTING_KEY.STALE_TIMER_REMINDER_ENABLED, false));
  const notified = await getSetting(SETTING_KEY.STALE_TIMER_REMINDER_STATE, {});
  const notifications = globalThis.browser?.notifications || globalThis.chrome?.notifications;
  if (enabled && !notifications?.create) throw new Error("Browser notifications are unavailable");
  const result = await runStaleTimerReminders({
    enabled,
    entries: await getActiveEntries(),
    notified,
    notify: (id, details) => notifications.create(id, details)
  });
  await setSetting(SETTING_KEY.STALE_TIMER_REMINDER_STATE, result.notified);
  return result;
}

async function runRequestedSync(message) {
  try {
    const result = await syncNow({
      interactiveAuth: false,
      force: Boolean(message?.force)
    });
    return { ok: true, result };
  } catch (error) {
    await recordDiagnostic({
      subsystem: "background",
      phase: "requested_sync",
      error,
      recovery: "Open Options, review diagnostics, then retry sync."
    }).catch(() => {});
    return {
      ok: false,
      error: { code: error?.code || "SYNC_FAILED", message: error?.message || "Sync failed" }
    };
  } finally {
    // A failed requested sync must still bring the next alarm forward. Without
    // this, an idle backoff due time could defer recovery long after a new edit.
    try {
      await setSetting(NEXT_DUE_KEY, Date.now() + await nextSyncDelayMinutes() * 60000);
    } catch {
      // The existing heartbeat remains armed if its due time cannot be updated.
    }
    await scheduleHeartbeat();
    await refreshToolbarIndicatorSafely();
  }
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

async function runUpdateCheck() {
  try {
    const result = await platform.requestUpdateCheck();
    if (result?.status === "update_available" && result.version) {
      await setSetting(SETTING_KEY.UPDATE_AVAILABLE_VERSION, result.version);
    } else if (result?.status === "no_update") {
      await setSetting(SETTING_KEY.UPDATE_AVAILABLE_VERSION, "");
    }
  } catch (error) {
    await recordDiagnostic({
      subsystem: "background",
      phase: "update_check",
      error,
      recovery: "Firefox will retry the extension update check later."
    }).catch(() => {});
    return { ok: false };
  }
  return { ok: true };
}

function scheduleUpdateCheck() {
  return platform.scheduleAlarm(UPDATE_CHECK_ALARM, UPDATE_CHECK_MINUTES);
}

async function installAvailableUpdate() {
  const result = await platform.requestUpdateCheck();
  if (result?.status === "update_available" && result.version) {
    await setSetting(SETTING_KEY.UPDATE_AVAILABLE_VERSION, result.version);
    await platform.reload();
    return { ok: true, version: result.version };
  }
  const availableVersion = await getSetting(SETTING_KEY.UPDATE_AVAILABLE_VERSION, "");
  if (!availableVersion) return { ok: false, available: false };
  await platform.reload();
  return { ok: true, version: availableVersion };
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
    await refreshToolbarIndicatorSafely();
    try {
      await runStaleTimerReminderCycle();
    } catch (error) {
      await recordDiagnostic({
        subsystem: "background",
        phase: "stale_timer_reminder",
        error,
        recovery: "Open Options and check whether stale-timer reminders are enabled and supported."
      }).catch(() => {});
    }
    if (browserSmokeEnabled()) browserSmokeAlarmRuns += 1;
  }
}

platform.onAlarm((alarm) => {
  if (alarm.name === UPDATE_CHECK_ALARM) {
    void runUpdateCheck();
    return;
  }
  if (alarm.name !== SYNC_ALARM) return;
  void runAlarmLifecycle();
});

platform.onUpdateAvailable(({ version } = {}) => {
  if (!version) return;
  void setSetting(SETTING_KEY.UPDATE_AVAILABLE_VERSION, version).catch(() => {});
});

// A new version may need to see the spreadsheet to migrate or repair it, so the
// read gate is cleared and the next sync brought forward.
async function handleInstalled({ reason }) {
  if (reason !== "install" && reason !== "update") return;
  try {
    await clearRemoteReadMarker();
    await setSetting(NEXT_DUE_KEY, 0);
    await setSetting(SETTING_KEY.UPDATE_AVAILABLE_VERSION, "");
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
    await refreshToolbarIndicatorSafely();
  }
}

platform.onInstalled((details) => {
  void handleInstalled(details);
});

const browserNotifications = globalThis.browser?.notifications || globalThis.chrome?.notifications;
browserNotifications?.onClicked?.addListener((notificationId) => {
  if (!String(notificationId).startsWith("personal-time-logger-stale-")) return;
  void platform.openExtensionPage("popup/popup.html").catch(() => {});
});

const cancelledTempoUploads = new Set();
const uploadTempoWorklogs = createTempoUploadHandler({
  platform,
  isCancelled: (operationId) => cancelledTempoUploads.has(operationId)
});

platform.onRuntimeMessage((message, sender) => {
  if (browserSmokeEnabled() && message?.type === BROWSER_SMOKE_ARM_ALARM_MESSAGE) {
    const alarms = globalThis.browser?.alarms || globalThis.chrome?.alarms;
    if (!alarms?.create) return { ok: false, error: { code: "ALARM_UNAVAILABLE" } };
    browserSmokeLastAlarmError = null;
    return Promise.resolve(alarms.clear?.(SYNC_ALARM)).then(() => {
      alarms.create(SYNC_ALARM, { when: Date.now() + 1000 });
      return { ok: true };
    });
  }
  if (browserSmokeEnabled() && message?.type === BROWSER_SMOKE_STATE_MESSAGE) {
    return {
      ok: true,
      alarmRuns: browserSmokeAlarmRuns,
      toolbarActive: browserSmokeToolbarActive,
      lastAlarmError: browserSmokeLastAlarmError
    };
  }
  if (message?.type === SYNC_REQUEST_MESSAGE) return runRequestedSync(message);
  if (message?.type === UPDATE_CHECK_MESSAGE) return runUpdateCheck();
  if (message?.type === UPDATE_INSTALL_MESSAGE) return installAvailableUpdate();
  if (message?.type === TEMPO_CANCEL_MESSAGE) {
    if (sender?.url !== platform.getURL("calendar/calendar.html") || !String(message?.operationId ?? "").trim()) {
      return { ok: false, error: { code: ERROR_CODE.TEMPO_PERMISSION_MISSING } };
    }
    cancelledTempoUploads.add(String(message.operationId).trim());
    return { ok: true };
  }
  if (message?.type !== TEMPO_UPLOAD_MESSAGE) return undefined;
  return uploadTempoWorklogs(message, sender).finally(() => {
    const operationId = String(message?.operationId ?? "").trim();
    if (operationId) cancelledTempoUploads.delete(operationId);
  });
});

void scheduleHeartbeat();
void scheduleUpdateCheck();
void runUpdateCheck();
void refreshToolbarIndicatorSafely();

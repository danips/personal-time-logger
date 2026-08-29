import { platform } from "./platform.js";
import { SETTING_KEY } from "./setting-keys.js";

export const SYNC_ALARM = "timelogger-sync";
export const UPDATE_CHECK_ALARM = "timelogger-update-check";
export const NEXT_DUE_KEY = SETTING_KEY.BACKGROUND_SYNC_DUE_AT;
export const MIN_SYNC_INTERVAL_SECONDS = 30;

export function syncAlarmMinutes(intervalSeconds) {
  const configured = Number(intervalSeconds) || 60;
  const seconds = Math.max(MIN_SYNC_INTERVAL_SECONDS, configured);
  // Browser alarms are minute-granular, so anything faster is one minute.
  return Math.max(1, Math.round(seconds / 60));
}

/** Re-creating a named alarm replaces its previous period and due time. */
export function scheduleSyncHeartbeat(intervalSeconds) {
  return platform.scheduleAlarm(SYNC_ALARM, syncAlarmMinutes(intervalSeconds));
}

function schedulingDiagnostic(error, fallbackError = null) {
  return {
    code: error?.code || "BACKGROUND_SCHEDULE_FAILED",
    message: error?.message || "Could not schedule background sync",
    fallback_error: fallbackError
      ? { code: fallbackError.code || "BACKGROUND_FALLBACK_FAILED", message: fallbackError.message || String(fallbackError) }
      : null,
    at: new Date().toISOString()
  };
}

/**
 * Runs the normal scheduler and, if it fails, tries a conservative fallback.
 * Persisting the primary failure is best-effort because a storage error must
 * not prevent the fallback alarm from being armed.
 */
export async function scheduleWithFallback({ schedule, scheduleFallback, saveDiagnostic }) {
  let failure = null;
  try {
    if (!await schedule()) throw new Error("Browser alarms are unavailable");
    await saveDiagnostic(null);
  } catch (error) {
    failure = error;
    try {
      await saveDiagnostic(schedulingDiagnostic(error));
    } catch {
      // The fallback below must still be attempted when local storage fails.
    }
  }
  if (!failure) return true;

  try {
    if (!await scheduleFallback()) throw new Error("Browser fallback alarm is unavailable");
  } catch (fallbackError) {
    try {
      await saveDiagnostic(schedulingDiagnostic(failure, fallbackError));
    } catch {
      // There is no remaining local recovery channel; avoid an unhandled rejection.
    }
  }
  return false;
}

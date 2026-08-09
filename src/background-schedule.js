import { platform } from "./platform.js";

export const SYNC_ALARM = "timelogger-sync";
export const NEXT_DUE_KEY = "background_sync_due_at";
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

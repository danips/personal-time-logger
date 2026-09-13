import { STALE_ACTIVE_SECONDS } from "./analytics.js";
import { durationSeconds } from "./time.js";

export function activeTimerState(entry, {
  elapsed = "00:00:00",
  newTimerOpen = false,
  label = entry?.task || entry?.project || "timer"
} = {}) {
  const active = Boolean(entry);
  return {
    title: entry?.task || "No task",
    description: entry?.description || "",
    elapsed,
    stopVisible: active,
    running: active,
    ariaLabel: active
      ? `Edit active timer ${label}`
      : newTimerOpen ? "Hide new timer" : "Start a new timer",
  };
}

/** Returns actionable warning metadata without changing any timer record. */
export function activeTimerWarningState(entries, { now = new Date() } = {}) {
  const nowIso = new Date(now).toISOString();
  return (entries || [])
    .filter((entry) => entry && !entry.deleted_at && !entry.end_at)
    .map((entry) => {
      const elapsedSeconds = durationSeconds(entry.start_at, nowIso);
      return {
        entry,
        elapsedSeconds,
        stale: elapsedSeconds >= STALE_ACTIVE_SECONDS
      };
    });
}

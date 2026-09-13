import { durationSeconds } from "./time.js";

export const STALE_TIMER_REMINDER_AFTER_SECONDS = 8 * 60 * 60;
export const STALE_TIMER_REMINDER_STATE_KEY = "stale_timer_reminder_state";
export const STALE_TIMER_REMINDER_PREFIX = "personal-time-logger-stale-";

function reminderId(entry) {
  return `${STALE_TIMER_REMINDER_PREFIX}${entry.id}`;
}

export function staleTimerReminderCandidates(entries, { now = new Date(), thresholdSeconds = STALE_TIMER_REMINDER_AFTER_SECONDS } = {}) {
  const nowIso = new Date(now).toISOString();
  return (entries || [])
    .filter((entry) => entry && !entry.deleted_at && !entry.end_at)
    .map((entry) => ({
      entry,
      elapsedSeconds: durationSeconds(entry.start_at, nowIso),
      notificationId: reminderId(entry)
    }))
    .filter(({ elapsedSeconds }) => elapsedSeconds >= thresholdSeconds);
}

export function staleTimerNotification(candidate) {
  const task = String(candidate.entry.task || candidate.entry.project || "active timer").trim() || "active timer";
  return {
    type: "basic",
    title: "Review a long-running timer",
    message: `${task} has been running for ${Math.floor(candidate.elapsedSeconds / 3600)} hours. Open Time Logger to edit or stop it.`,
    iconUrl: "icons/icon.svg"
  };
}

/** Creates at most one reminder per active entry revision until that revision changes. */
export async function runStaleTimerReminders({
  enabled,
  entries,
  notified = {},
  notify,
  now = new Date(),
  thresholdSeconds = STALE_TIMER_REMINDER_AFTER_SECONDS
} = {}) {
  const current = {};
  if (!enabled) return { created: [], notified: current };
  const created = [];
  for (const candidate of staleTimerReminderCandidates(entries, { now, thresholdSeconds })) {
    const revision = Number(candidate.entry.revision || 0);
    current[candidate.entry.id] = revision;
    if (Number(notified[candidate.entry.id]) === revision) continue;
    await notify(candidate.notificationId, staleTimerNotification(candidate));
    created.push(candidate.notificationId);
  }
  return { created, notified: current };
}

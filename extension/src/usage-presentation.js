export const USAGE_STALE_AFTER_MS = 15 * 60 * 1000;

export function usageWindowLabel(window, fallback) {
  const seconds = Number(window?.window_seconds);
  if (seconds === 5 * 60 * 60) return "5-hour limit";
  if (seconds === 7 * 24 * 60 * 60) return "Weekly limit";
  return fallback;
}

export function formatUsageCountdown(resetAt, now = Date.now()) {
  const remaining = new Date(resetAt).getTime() - now;
  if (!Number.isFinite(remaining)) return "reset time unavailable";
  if (remaining <= 0) return "reset time has passed; refresh to confirm the new allowance";
  const totalMinutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || !parts.length) parts.push(`${minutes}m`);
  return `in ${parts.join(" ")}`;
}

export function usageSnapshotAgeMs(snapshot, now = Date.now()) {
  return now - new Date(snapshot?.collected_at || 0).getTime();
}

export function usageSnapshotIsStale(snapshot, now = Date.now(), staleAfterMs = USAGE_STALE_AFTER_MS) {
  return usageSnapshotAgeMs(snapshot, now) > staleAfterMs;
}

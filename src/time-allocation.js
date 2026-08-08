/**
 * Canonical allocation for totals and exports. Multiplied time belongs to the
 * same real interval as the work that earned it: when a period clips that
 * interval, its effective duration is apportioned by elapsed overlap rather
 * than appended after the entry's end.
 */
function asDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function entryInterval(entry, { now = new Date() } = {}) {
  const start = asDate(entry?.start_at);
  const end = asDate(entry?.end_at || now);
  if (!start || !end || end <= start) return null;

  const actualSeconds = (end.getTime() - start.getTime()) / 1000;
  const storedSeconds = Number(entry.duration_seconds);
  const effectiveSeconds = entry.end_at && Number.isFinite(storedSeconds) && storedSeconds > 0
    ? storedSeconds
    : actualSeconds;
  return { start, end, actualSeconds, effectiveSeconds };
}

/**
 * Returns an entry's exact share of the half-open [periodStart, periodEnd)
 * interval. The start/end values are the allocated real interval; effective
 * seconds are proportional to it, preserving total duration across boundaries.
 */
export function allocateEntry(entry, periodStart, periodEnd, options = {}) {
  const interval = entryInterval(entry, options);
  const startBoundary = asDate(periodStart);
  const endBoundary = asDate(periodEnd);
  if (!interval || !startBoundary || !endBoundary || endBoundary <= startBoundary) return null;

  const start = interval.start > startBoundary ? interval.start : startBoundary;
  const end = interval.end < endBoundary ? interval.end : endBoundary;
  if (end <= start) return null;

  const actualSeconds = (end.getTime() - start.getTime()) / 1000;
  return {
    entry,
    start,
    end,
    entryStart: interval.start,
    entryEnd: interval.end,
    actualSeconds,
    effectiveSeconds: interval.effectiveSeconds * actualSeconds / interval.actualSeconds,
    entryActualSeconds: interval.actualSeconds,
    entryEffectiveSeconds: interval.effectiveSeconds
  };
}

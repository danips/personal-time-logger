import { addDays, startOfLocalDay, startOfLocalWeek } from "./time.js";
import { allocateEntry, entryInterval } from "./time-allocation.js";

export const DAY_COUNT = 7;
export const MINUTES_PER_DAY = 24 * 60;
export const SNAP_MINUTES = 15;
export const RESIZE_SNAP_MINUTES = 1;
// Calendar blocks have a 22px minimum height. Include that visual footprint in
// lane assignment so short, adjacent timers do not paint over each other's
// borders even when their recorded intervals only touch.
const MIN_RENDER_MINUTES = 28;
export const SLOT_HEIGHT = 12;
export const PX_PER_MINUTE = SLOT_HEIGHT / SNAP_MINUTES;
export const MINUTE_MS = 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

export function minutesSinceStartOfDay(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function maxDate(a, b) {
  return a.getTime() > b.getTime() ? a : b;
}

export function minDate(a, b) {
  return a.getTime() < b.getTime() ? a : b;
}

export function isSameLocalDate(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

/** Position of a date within the displayed week, or -1 when it falls outside. */
export function dayIndexInWeek(weekStart, date) {
  for (let index = 0; index < DAY_COUNT; index += 1) {
    if (isSameLocalDate(date, addDays(weekStart, index))) return index;
  }
  return -1;
}

export function isoWeekValue(date) {
  const monday = startOfLocalWeek(date);
  const thursday = addDays(monday, 3);
  const weekYear = thursday.getFullYear();
  const firstWeek = startOfLocalWeek(new Date(weekYear, 0, 4));
  const week = Math.round((monday.getTime() - firstWeek.getTime()) / (7 * DAY_MS)) + 1;
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

export function weekStartFromInput(value) {
  const match = String(value || "").match(/^(\d{4})-W(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (!year || week < 1 || week > 53) return null;
  const firstWeek = startOfLocalWeek(new Date(year, 0, 4));
  const weekStart = addDays(firstWeek, (week - 1) * 7);
  return isoWeekValue(weekStart) === value ? weekStart : null;
}

export function snapDateToGrid(date, direction) {
  const day = startOfLocalDay(date);
  const minutes = minutesSinceStartOfDay(date);
  const snapped = direction === "up"
    ? Math.ceil(minutes / RESIZE_SNAP_MINUTES) * RESIZE_SNAP_MINUTES
    : Math.floor(minutes / RESIZE_SNAP_MINUTES) * RESIZE_SNAP_MINUTES;
  return addMinutes(day, snapped);
}

/** Duration a drag preserves, never shorter than one grid slot. */
export function durationMsForDrag(entry) {
  const start = new Date(entry.start_at);
  const end = entry.end_at ? new Date(entry.end_at) : new Date();
  return Math.max(SNAP_MINUTES * MINUTE_MS, end.getTime() - start.getTime());
}

export function actualDurationSeconds(rawStart, rawEnd) {
  return Math.max(0, (rawEnd.getTime() - rawStart.getTime()) / 1000);
}

function effectiveDurationSeconds(entry, rawStart, rawEnd) {
  const actualSeconds = actualDurationSeconds(rawStart, rawEnd);
  if (!actualSeconds) return 0;
  const stored = Number(entry.duration_seconds) || 0;
  return entry.end_at && stored ? stored : actualSeconds;
}

function effectiveEnd(entry, rawStart, rawEnd) {
  const actualSeconds = actualDurationSeconds(rawStart, rawEnd);
  const effectiveSeconds = Number(entry.multiply) > 0
    ? effectiveDurationSeconds(entry, rawStart, rawEnd)
    : actualSeconds;
  return addMinutes(rawStart, Math.max(actualSeconds, effectiveSeconds) / 60);
}

/**
 * Splits entries into per-day visual segments for the displayed week. Multiplied
 * entries include a distinct effective-duration tail; `totalSeconds` remains
 * allocated only across the actual interval.
 */
export function buildSegments(entries, weekStart) {
  const weekEnd = addDays(weekStart, DAY_COUNT);
  const days = Array.from({ length: DAY_COUNT }, () => []);

  for (const entry of entries) {
    const interval = entryInterval(entry);
    if (!interval) continue;
    const entryStart = interval.start;
    const actualEnd = interval.end;
    const displayEnd = effectiveEnd(entry, entryStart, actualEnd);
    const effectiveSeconds = effectiveDurationSeconds(entry, entryStart, actualEnd);
    const displaySeconds = actualDurationSeconds(entryStart, displayEnd);
    if (entryStart >= weekEnd || displayEnd <= weekStart) continue;

    for (let index = 0; index < DAY_COUNT; index += 1) {
      const dayStart = addDays(weekStart, index);
      const dayEnd = addDays(dayStart, 1);
      const visibleStart = maxDate(entryStart, dayStart);
      const visibleEnd = minDate(displayEnd, dayEnd);
      if (visibleEnd <= visibleStart) continue;
      const allocation = allocateEntry(entry, dayStart, dayEnd, { now: actualEnd });

      days[index].push({
        entry,
        dayIndex: index,
        visibleStart,
        visibleEnd,
        actualEnd,
        displayEnd,
        effectiveSeconds,
        actualSeconds: actualDurationSeconds(entryStart, actualEnd),
        displaySeconds,
        // Reports and daily totals remain allocated across the real interval.
        // The multiplier tail is a visual warning, not time moved into a later day.
        totalSeconds: allocation?.effectiveSeconds || 0,
        startMinute: minutesSinceStartOfDay(visibleStart),
        // minutesSinceStartOfDay rolls midnight back to zero. Keep a segment
        // ending at the day boundary at the bottom of the calendar instead.
        endMinute: visibleEnd.getTime() === dayEnd.getTime()
          ? MINUTES_PER_DAY
          : minutesSinceStartOfDay(visibleEnd),
        startsEntry: visibleStart.getTime() === entryStart.getTime(),
        endsEntry: visibleStart < actualEnd && actualEnd <= visibleEnd
      });
    }
  }

  return days;
}

function layoutGroup(group) {
  const lanes = [];
  for (const segment of group) {
    let lane = lanes.findIndex((endMinute) => endMinute <= segment.startMinute);
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(0);
    }
    const renderedEnd = Math.max(
      segment.startMinute + MIN_RENDER_MINUTES,
      segment.endMinute - 5
    );
    lanes[lane] = Math.max(segment.endMinute, renderedEnd);
    segment.lane = lane;
  }
  for (const segment of group) {
    segment.laneCount = Math.max(1, lanes.length);
  }
}

/**
 * Assigns a stable swimlane to every segment in a displayed day. Keeping the
 * same lane count across the day avoids blocks widening and narrowing as an
 * overlap cluster starts or ends, which makes concurrent work easier to scan.
 */
export function layoutSegments(segments) {
  const sorted = [...segments].sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
  layoutGroup(sorted);
  return sorted;
}

export function dailyTotalsFromSegments(segmentsByDay) {
  return segmentsByDay.map((segments) => segments.reduce((total, segment) => total + segment.totalSeconds, 0));
}

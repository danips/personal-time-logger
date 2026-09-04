import { addDays, startOfLocalDay, startOfLocalWeek } from "./time.js";

export const ANALYTICS_PERIOD_PRESET = Object.freeze({
  THIS_WEEK: "this_week",
  LAST_WEEK: "last_week",
  THIS_MONTH: "this_month",
  LAST_MONTH: "last_month",
  LAST_30_DAYS: "last_30_days",
  THIS_YEAR: "this_year",
  CUSTOM: "custom"
});

const PRESETS = new Set(Object.values(ANALYTICS_PERIOD_PRESET));

function validDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError("Analytics requires a valid current date");
  return date;
}

function parseLocalDate(value, field) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new RangeError(`${field} must be a valid local date`);
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1
    || date.getDate() !== Number(match[3])) {
    throw new RangeError(`${field} must be a valid local date`);
  }
  return date;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfYear(date) {
  return new Date(date.getFullYear(), 0, 1);
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function shiftMonthClamped(date, months) {
  const monthIndex = date.getMonth() + months;
  const year = date.getFullYear() + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  return new Date(
    year,
    month,
    Math.min(date.getDate(), daysInMonth(year, month)),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  );
}

function shiftYearClamped(date, years) {
  const year = date.getFullYear() + years;
  return new Date(
    year,
    date.getMonth(),
    Math.min(date.getDate(), daysInMonth(year, date.getMonth())),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  );
}

function formatRange(start, end) {
  const formatter = new Intl.DateTimeFormat([], { year: "numeric", month: "short", day: "numeric" });
  const inclusiveEnd = new Date(end.getTime() - 1);
  const dates = formatter.format(start) === formatter.format(inclusiveEnd)
    ? formatter.format(start)
    : `${formatter.format(start)} – ${formatter.format(inclusiveEnd)}`;
  const hasPartialBoundary = start.getHours() || start.getMinutes() || start.getSeconds()
    || end.getHours() || end.getMinutes() || end.getSeconds();
  if (!hasPartialBoundary) return dates;
  const time = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
  return `${dates} (to ${time.format(end)})`;
}

function range(start, end) {
  return { start, end, label: formatRange(start, end) };
}

export function resolveAnalyticsPeriod(
  preset,
  { now = new Date(), customStart = "", customEnd = "" } = {}
) {
  if (!PRESETS.has(preset)) throw new RangeError(`Unknown analytics period: ${preset}`);
  const current = validDate(now);
  let primaryStart;
  let primaryEnd;
  let comparisonStart;
  let comparisonEnd;
  let isPartial = false;

  switch (preset) {
    case ANALYTICS_PERIOD_PRESET.THIS_WEEK:
      primaryStart = startOfLocalWeek(current);
      primaryEnd = current;
      comparisonStart = addDays(primaryStart, -7);
      comparisonEnd = addDays(primaryEnd, -7);
      isPartial = true;
      break;
    case ANALYTICS_PERIOD_PRESET.LAST_WEEK:
      primaryEnd = startOfLocalWeek(current);
      primaryStart = addDays(primaryEnd, -7);
      comparisonEnd = primaryStart;
      comparisonStart = addDays(comparisonEnd, -7);
      break;
    case ANALYTICS_PERIOD_PRESET.THIS_MONTH:
      primaryStart = startOfMonth(current);
      primaryEnd = current;
      comparisonStart = shiftMonthClamped(primaryStart, -1);
      comparisonEnd = shiftMonthClamped(primaryEnd, -1);
      isPartial = true;
      break;
    case ANALYTICS_PERIOD_PRESET.LAST_MONTH:
      primaryEnd = startOfMonth(current);
      primaryStart = shiftMonthClamped(primaryEnd, -1);
      comparisonEnd = primaryStart;
      comparisonStart = shiftMonthClamped(comparisonEnd, -1);
      break;
    case ANALYTICS_PERIOD_PRESET.LAST_30_DAYS:
      primaryEnd = current;
      primaryStart = addDays(primaryEnd, -30);
      comparisonEnd = primaryStart;
      comparisonStart = addDays(comparisonEnd, -30);
      isPartial = true;
      break;
    case ANALYTICS_PERIOD_PRESET.THIS_YEAR:
      primaryStart = startOfYear(current);
      primaryEnd = current;
      comparisonStart = shiftYearClamped(primaryStart, -1);
      comparisonEnd = shiftYearClamped(primaryEnd, -1);
      isPartial = true;
      break;
    case ANALYTICS_PERIOD_PRESET.CUSTOM: {
      primaryStart = parseLocalDate(customStart, "Custom start");
      primaryEnd = addDays(parseLocalDate(customEnd, "Custom end"), 1);
      if (primaryEnd <= primaryStart) throw new RangeError("Custom end must be on or after custom start");
      let civilDays = 0;
      for (let day = primaryStart; day < primaryEnd; day = addDays(day, 1)) civilDays += 1;
      comparisonEnd = primaryStart;
      comparisonStart = addDays(comparisonEnd, -civilDays);
      break;
    }
  }

  if (primaryEnd <= primaryStart || comparisonEnd <= comparisonStart) {
    throw new RangeError("Analytics period must have a positive duration");
  }
  return {
    preset,
    primary: range(primaryStart, primaryEnd),
    comparison: range(comparisonStart, comparisonEnd),
    isPartial
  };
}

export function analyticsDateInputValue(date = new Date()) {
  const local = startOfLocalDay(validDate(date));
  return [
    local.getFullYear(),
    String(local.getMonth() + 1).padStart(2, "0"),
    String(local.getDate()).padStart(2, "0")
  ].join("-");
}

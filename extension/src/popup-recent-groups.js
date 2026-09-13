import { allocateEntryByLocalDay } from "./time-allocation.js";
import { addDays, dayMonth, localDateKey, startOfLocalWeek, weekdayDayMonth } from "./time.js";

function localDayKey(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "unknown" : localDateKey(date);
}

function localDayLabel(iso) {
  return weekdayDayMonth(iso) || "Unknown day";
}

export function recentGroupKey(entry) {
  return [
    localDayKey(entry.start_at),
    entry.project || "",
    entry.task || "",
    entry.description || "",
    entry.multiply || ""
  ].map((part) => encodeURIComponent(part)).join("|");
}

export function compareRecentEntries(left, right) {
  const byStart = String(right.start_at || "").localeCompare(String(left.start_at || ""));
  return byStart || String(right.id || "").localeCompare(String(left.id || ""));
}

export function filterRecentEntries(entries, { text = "", project = "", task = "", status = "all" } = {}) {
  const search = String(text).trim().toLocaleLowerCase();
  const projectSearch = String(project).trim().toLocaleLowerCase();
  const taskSearch = String(task).trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    const values = [entry.project, entry.task, entry.description].map((value) => String(value || "").toLocaleLowerCase());
    return (!search || values.some((value) => value.includes(search)))
      && (!projectSearch || values[0].includes(projectSearch))
      && (!taskSearch || values[1].includes(taskSearch))
      && (status === "all" || entry.status === status);
  });
}

export function recentFieldValues(entries, field) {
  return [...new Set(entries.map((entry) => String(entry[field] || "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function weekInfo(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { key: "unknown", label: "Unknown week", start: null, totalSeconds: 0, days: [], dayMap: new Map() };
  const start = startOfLocalWeek(date);
  const end = addDays(start, 6);
  const currentWeek = startOfLocalWeek(new Date());
  const previousWeek = addDays(currentWeek, -7);
  let label = `${dayMonth(start)} - ${dayMonth(end)}`;
  if (start.getTime() === currentWeek.getTime()) label = "This week";
  if (start.getTime() === previousWeek.getTime()) label = "Last week";
  return { key: localDateKey(start), label, start, totalSeconds: 0, days: [], dayMap: new Map() };
}

export function groupRecentEntries(entries, { start, end }) {
  const weeks = [];
  const weekMap = new Map();
  for (const entry of entries) {
    for (const allocation of allocateEntryByLocalDay(entry)) {
      if (allocation.end <= start || allocation.start >= end) continue;
      const displayEntry = { ...entry, start_at: allocation.start.toISOString(), end_at: allocation.end.toISOString(), duration_seconds: allocation.effectiveSeconds };
      const weekSeed = weekInfo(displayEntry.start_at);
      if (!weekMap.has(weekSeed.key)) { weekMap.set(weekSeed.key, weekSeed); weeks.push(weekSeed); }
      const week = weekMap.get(weekSeed.key);
      const dayKey = localDayKey(displayEntry.start_at);
      if (!week.dayMap.has(dayKey)) {
        const day = { key: dayKey, label: localDayLabel(displayEntry.start_at), totalSeconds: 0, groups: [], groupMap: new Map() };
        week.dayMap.set(dayKey, day);
        week.days.push(day);
      }
      const day = week.dayMap.get(dayKey);
      const groupKey = recentGroupKey(displayEntry);
      if (!day.groupMap.has(groupKey)) {
        const group = { key: groupKey, entries: [], totalSeconds: 0 };
        day.groupMap.set(groupKey, group);
        day.groups.push(group);
      }
      const group = day.groupMap.get(groupKey);
      group.entries.push(displayEntry);
      group.totalSeconds += allocation.effectiveSeconds;
      day.totalSeconds += allocation.effectiveSeconds;
      week.totalSeconds += allocation.effectiveSeconds;
    }
  }
  for (const week of weeks) {
    delete week.dayMap;
    week.days.sort((left, right) => right.key.localeCompare(left.key));
    for (const day of week.days) {
      delete day.groupMap;
      day.groups.sort((left, right) => compareRecentEntries(left.entries[0], right.entries[0]));
      for (const group of day.groups) group.entries.sort(compareRecentEntries);
    }
  }
  return weeks.sort((left, right) => right.start.getTime() - left.start.getTime());
}

export function recentTotalSeconds(entries, range) {
  return groupRecentEntries(entries, range)
    .reduce((total, week) => total + week.totalSeconds, 0);
}

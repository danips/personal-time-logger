/**
 * Day scope for a Tempo send. Nothing here is persisted: the calendar offers the
 * whole displayed week by default and unchecking a day only narrows the next
 * send, so switching weeks always starts from a full selection again.
 */
import { addDays, localDateKey } from "./time.js";
import { normalizeTempoDayKeys } from "./tempo.js";

/** Local civil-date keys, in display order, for the days a week covers. */
export function weekDayKeys(weekStart, dayCount) {
  const start = new Date(weekStart);
  const days = Number(dayCount);
  if (Number.isNaN(start.getTime()) || !Number.isInteger(days) || days < 1) return [];
  return Array.from({ length: days }, (_, index) => localDateKey(addDays(start, index)));
}

/**
 * Restricts a selection to the days actually on offer and reports the wording
 * the send confirmation uses, so a partial send never claims to cover the whole
 * week and a repeat warning names what would be duplicated.
 */
export function tempoDaySelectionState(selectedDays, dayKeys) {
  const available = [...normalizeTempoDayKeys(dayKeys)];
  const selectedKeys = normalizeTempoDayKeys(selectedDays);
  const selected = available.filter((key) => selectedKeys.has(key));
  const allSelected = available.length > 0 && selected.length === available.length;
  const oneDay = selected.length === 1;
  return {
    includedDays: new Set(selected),
    selectedCount: selected.length,
    noneSelected: selected.length === 0,
    scopeLabel: allSelected
      ? "the displayed week"
      : `${selected.length} selected day${oneDay ? "" : "s"}`,
    repeatScopeLabel: allSelected ? "week" : (oneDay ? "day" : "days")
  };
}

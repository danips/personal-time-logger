import { formatHours } from "./time.js";
import { allocateEntry, entryInterval } from "./time-allocation.js";

export const CSV_COLUMNS = [
  "Entry ID",
  "Allocation Start (ISO)",
  "Allocation End (ISO)",
  "Project",
  "Task",
  "Description",
  "Start Date",
  "Start Time",
  "End Date",
  "End Time",
  "Duration (hours)",
  "Multiplied duration (hours)",
  "Multiply",
  "Status"
];

const CSV_LINE_ENDING = "\r\n";

function entryStatus(entry) {
  if (!entry.end_at) return "running";
  return entry.status === "needs_review" ? "needs_review" : "completed";
}

function csvEscape(value) {
  const raw = value == null ? "" : String(value);
  // Spreadsheet programs evaluate leading formula sigils even when the CSV is
  // otherwise valid. A literal apostrophe keeps the user-visible text intact.
  const text = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function localDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

function localTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
}

/**
 * Produces RFC 4180-style UTF-8 CSV. The ID, allocation ISO timestamps, hour
 * values, multiplier, and status are machine-readable; local date/time columns
 * are convenience display values and intentionally follow the browser locale.
 */
export function entriesToCsv(entries, { periodStart, periodEnd, now = new Date(), includeBom = false } = {}) {
  const clippingRequested = periodStart !== undefined || periodEnd !== undefined;
  if (clippingRequested && (periodStart === undefined || periodEnd === undefined)) {
    throw new TypeError("Both periodStart and periodEnd are required for a clipped export");
  }
  const rows = [CSV_COLUMNS];
  for (const entry of entries) {
    if (entry.deleted_at) continue;
    const allocation = clippingRequested
      ? allocateEntry(entry, periodStart, periodEnd, { now })
      : entryInterval(entry, { now });
    if (!allocation) continue;

    // Running entries are exported with empty end columns and elapsed-so-far
    // hours instead of being dropped silently.
    const running = !entry.end_at;
    const allocationStart = allocation.start.toISOString();
    const allocationEnd = allocation.end.toISOString();
    rows.push([
      entry.id,
      allocationStart,
      allocationEnd,
      entry.project,
      entry.task,
      entry.description,
      localDate(allocationStart),
      localTime(allocationStart),
      running ? "" : localDate(allocationEnd),
      running ? "" : localTime(allocationEnd),
      formatHours(allocation.actualSeconds),
      running ? "" : formatHours(allocation.effectiveSeconds),
      entry.multiply,
      entryStatus(entry)
    ]);
  }
  const csv = rows.map((row) => row.map(csvEscape).join(",")).join(CSV_LINE_ENDING);
  return includeBom ? `\uFEFF${csv}` : csv;
}

export function downloadCsv(entries, filename = `time-entries-${new Date().toISOString().slice(0, 10)}.csv`, options = {}) {
  // Excel still guesses legacy encodings in some locales. Downloads opt into a
  // UTF-8 BOM while API callers can request a BOM-free machine export.
  const csv = entriesToCsv(entries, { ...options, includeBom: options.includeBom ?? true });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

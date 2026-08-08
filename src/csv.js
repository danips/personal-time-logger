import { formatHours } from "./time.js";
import { allocateEntry, entryInterval } from "./time-allocation.js";

const CSV_COLUMNS = [
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

export function entriesToCsv(entries, { periodStart, periodEnd, now = new Date() } = {}) {
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
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

export function downloadCsv(entries, filename = `time-entries-${new Date().toISOString().slice(0, 10)}.csv`, options = {}) {
  const csv = entriesToCsv(entries, options);
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

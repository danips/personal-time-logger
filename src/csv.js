import { durationSeconds, formatHours } from "./time.js";

const CSV_COLUMNS = [
  "Project",
  "Task",
  "Description",
  "Start Date",
  "Start Time",
  "End Date",
  "End Time",
  "Duration (hours)",
  "Multiplied duration (hours)",
  "Multiply"
];

function csvEscape(value) {
  const text = value == null ? "" : String(value);
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

export function entriesToCsv(entries) {
  const rows = [CSV_COLUMNS];
  for (const entry of entries) {
    if (entry.deleted_at || !entry.end_at) continue;
    rows.push([
      entry.project,
      entry.task,
      entry.description,
      localDate(entry.start_at),
      localTime(entry.start_at),
      localDate(entry.end_at),
      localTime(entry.end_at),
      formatHours(durationSeconds(entry.start_at, entry.end_at)),
      formatHours(entry.duration_seconds),
      entry.multiply
    ]);
  }
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

export function downloadCsv(entries, filename = `time-entries-${new Date().toISOString().slice(0, 10)}.csv`) {
  const csv = entriesToCsv(entries);
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

const FORMULA_PREFIX = /^[=+\-@]/;

function text(value) {
  return String(value ?? "");
}

function csvCell(value, numeric = false) {
  let cell = text(value);
  if (!numeric && FORMULA_PREFIX.test(cell)) cell = `'${cell}`;
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

function csvRow(values, numericIndexes = []) {
  const numeric = new Set(numericIndexes);
  return values.map((value, index) => csvCell(value, numeric.has(index))).join(",");
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function percentChange(current, previous) {
  const currentValue = number(current);
  const previousValue = number(previous);
  if (previousValue === 0) return currentValue === 0 ? "0.0%" : "New";
  return `${(((currentValue - previousValue) / previousValue) * 100).toFixed(1)}%`;
}

function filterValue(value, fallback) {
  return value || fallback;
}

/**
 * Serializes the already-computed report. It deliberately receives a report
 * snapshot rather than entries, so export cannot silently use a different
 * filter, period, or duration calculation than the visible page.
 */
export function serializeAnalyticsReport(report, {
  primaryRange = "",
  comparisonRange = "",
  timezone = "",
  filters = {}
} = {}) {
  if (!report?.primary || !report?.comparison) throw new TypeError("An analytics report is required");
  const { primary, comparison, fragmentation, anomalies } = report;
  const lines = [
    csvRow(["Time Logger Analytics"]),
    csvRow(["Timezone", timezone || "Browser local time"]),
    csvRow(["Current range", primaryRange]),
    csvRow(["Compared with", comparisonRange]),
    csvRow(["Project filter", filterValue(filters.project, "All projects")]),
    csvRow(["Task filter", filterValue(filters.task, "All tasks")]),
    "",
    csvRow(["Metric", "Current", "Previous", "Change"]),
    csvRow(["Total actual time (seconds)", primary.totalActualSeconds, comparison.totalActualSeconds, percentChange(primary.totalActualSeconds, comparison.totalActualSeconds)], [1, 2]),
    csvRow(["Total effective time (seconds)", primary.totalEffectiveSeconds, comparison.totalEffectiveSeconds, percentChange(primary.totalEffectiveSeconds, comparison.totalEffectiveSeconds)], [1, 2]),
    csvRow(["Logged days", primary.loggedDays, comparison.loggedDays, percentChange(primary.loggedDays, comparison.loggedDays)], [1, 2]),
    csvRow(["Sessions", primary.sessionCount, comparison.sessionCount, percentChange(primary.sessionCount, comparison.sessionCount)], [1, 2]),
    csvRow(["Average actual session (seconds)", primary.averageActualSessionSeconds, comparison.averageActualSessionSeconds, percentChange(primary.averageActualSessionSeconds, comparison.averageActualSessionSeconds)], [1, 2]),
    csvRow(["Median actual session (seconds)", primary.medianActualSessionSeconds, comparison.medianActualSessionSeconds, percentChange(primary.medianActualSessionSeconds, comparison.medianActualSessionSeconds)], [1, 2]),
    csvRow(["Longest actual session (seconds)", primary.longestActualSessionSeconds, comparison.longestActualSessionSeconds, percentChange(primary.longestActualSessionSeconds, comparison.longestActualSessionSeconds)], [1, 2]),
    csvRow(["Project switches", fragmentation.projectSwitches, "", ""], [1]),
    csvRow(["Task switches", fragmentation.taskSwitches, "", ""], [1]),
    csvRow(["Short sessions", fragmentation.shortSessionCount, "", ""], [1]),
    csvRow(["Detected anomalies", anomalies.totalCount, "", ""], [1]),
    "",
    csvRow(["Project", "Task", "Current effective seconds", "Previous effective seconds", "Current share", "Change"])
  ];

  for (const project of report.projects || []) {
    lines.push(csvRow([project.label, "", project.currentSeconds, project.previousSeconds, project.share, percentChange(project.currentSeconds, project.previousSeconds)], [2, 3, 4]));
    for (const task of project.tasks || []) {
      lines.push(csvRow([project.label, task.label, task.currentSeconds, task.previousSeconds, task.share, percentChange(task.currentSeconds, task.previousSeconds)], [2, 3, 4]));
    }
  }

  lines.push("", csvRow(["Description", "Sessions", "Current effective seconds", "Average seconds", "Current share", "Previous effective seconds", "Change"]));
  for (const description of report.descriptions || []) {
    lines.push(csvRow([description.description, description.sessionCount, description.currentSeconds, description.averageSeconds, description.share, description.previousSeconds, percentChange(description.currentSeconds, description.previousSeconds)], [1, 2, 3, 4, 5]));
  }

  lines.push("", csvRow(["Anomaly type", "Date", "Project", "Task", "Message", "Entry ID", "Related entry ID"]));
  for (const anomaly of anomalies.rows || []) {
    lines.push(csvRow([anomaly.type, new Date(anomaly.start).toISOString(), anomaly.project, anomaly.task, anomaly.message, anomaly.entryId, anomaly.relatedEntryId]));
  }
  if (anomalies.omittedOverlapCount) {
    lines.push(csvRow(["overlap pairs omitted", "", "", "", anomalies.omittedOverlapCount, "", ""], [4]));
  }
  return `${lines.join("\r\n")}\r\n`;
}

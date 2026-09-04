import { buildAnalyticsReport } from "../src/analytics.js";
import { ANALYTICS_PERIOD_PRESET, analyticsDateInputValue, resolveAnalyticsPeriod } from "../src/analytics-period.js";
import { getEntriesIntersecting } from "../src/db.js";
import { onEntriesChanged } from "../src/events.js";
import { runPageTask, startPage } from "../src/page-runtime.js";
import { addDays, formatElapsed, shortDateTime } from "../src/time.js";
import { $ } from "../src/ui-helpers.js";

const DESCRIPTION_LIMIT = 10;
const BUCKETS = Object.freeze([
  ["under15", "< 15 min"],
  ["15to30", "15–30 min"],
  ["30to60", "30–60 min"],
  ["1to2", "1–2 h"],
  ["2to4", "2–4 h"],
  ["over4", ">= 4 h"]
]);

let selectedPeriod;
let latestReport;
let descriptionsExpanded = false;
let eventsBound = false;
let unsubscribeEntries = null;
let refreshGeneration = 0;

function setStatus(message, state = "ready") {
  const status = $("#statusLine");
  status.textContent = message;
  status.dataset.status = state;
}

function duration(seconds) {
  return formatElapsed(Math.round(Number(seconds) || 0));
}

function percent(value) {
  const numeric = Number(value);
  return `${(Number.isFinite(numeric) ? numeric * 100 : 0).toFixed(1)}%`;
}

function delta(value) {
  if (value?.kind === "new") return "New";
  const numeric = Number(value?.percent);
  if (!Number.isFinite(numeric)) return "0%";
  return `${numeric > 0 ? "+" : ""}${numeric.toFixed(1)}%`;
}

function replaceChildren(element, children) {
  element.replaceChildren(...children);
}

function element(tag, className = "", value = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== "") node.textContent = value;
  return node;
}

function summaryCard(label, value, detail = "") {
  const card = element("article", "summary-card");
  card.append(element("span", "summary-card-label", label), element("strong", "summary-card-value", value));
  if (detail) card.append(element("span", "summary-card-detail", detail));
  return card;
}

function renderSummary(report) {
  const { primary, deltas, fragmentation, anomalies } = report;
  replaceChildren($("#summaryCards"), [
    summaryCard("Total effective time", duration(primary.totalEffectiveSeconds), `${delta(deltas.totalEffectiveSeconds)} vs previous`),
    summaryCard("Logged days", String(primary.loggedDays)),
    summaryCard("Average / logged day", duration(primary.averageEffectiveSecondsPerLoggedDay)),
    summaryCard("Sessions", String(primary.sessionCount)),
    summaryCard("Average actual session", duration(primary.averageActualSessionSeconds)),
    summaryCard("Median actual session", duration(primary.medianActualSessionSeconds)),
    summaryCard("Longest actual session", duration(primary.longestActualSessionSeconds)),
    summaryCard("Project switches", String(fragmentation.projectSwitches)),
    summaryCard("Task switches", String(fragmentation.taskSwitches)),
    summaryCard("Short sessions", String(fragmentation.shortSessionCount), "Under 15 minutes"),
    summaryCard("Detected anomalies", String(anomalies.length))
  ]);
}

function shareCell(value) {
  const cell = element("td", "share-cell");
  const bar = element("span", "share-bar");
  const fill = element("span");
  fill.style.width = `${Math.max(0, Math.min(100, value * 100))}%`;
  bar.append(fill);
  cell.append(bar, document.createTextNode(percent(value)));
  return cell;
}

function reportRow(labelText, row, className = "") {
  const tr = element("tr", className);
  tr.append(
    element("td", className === "task-row" ? "task-label" : "", labelText),
    element("td", "", duration(row.currentSeconds)),
    shareCell(row.share),
    element("td", "", duration(row.previousSeconds)),
    element("td", "", delta(row.delta))
  );
  return tr;
}

function renderProjects(report) {
  const rows = [];
  for (const [index, project] of report.projects.entries()) {
    const projectRow = reportRow(project.label, project, "project-row");
    const labelCell = projectRow.firstElementChild;
    const toggle = element("button", "project-toggle", `▾ ${project.label}`);
    toggle.type = "button";
    toggle.dataset.projectIndex = String(index);
    toggle.setAttribute("aria-expanded", "true");
    labelCell.replaceChildren(toggle);
    rows.push(projectRow);
    for (const task of project.tasks) {
      const taskRow = reportRow(task.label, task, "task-row");
      taskRow.dataset.projectIndex = String(index);
      rows.push(taskRow);
    }
  }
  replaceChildren($("#projectRows"), rows);
  $("#projectsEmpty").hidden = rows.length > 0;
}

function compactMetric(labelText, value) {
  const metric = element("div", "compact-metric");
  metric.append(element("span", "", labelText), element("strong", "", value));
  return metric;
}

function renderFragmentation({ fragmentation }) {
  replaceChildren($("#fragmentationMetrics"), [
    compactMetric("Sessions", String(fragmentation.sessionCount)),
    compactMetric("Average", duration(fragmentation.averageActualSessionSeconds)),
    compactMetric("Median", duration(fragmentation.medianActualSessionSeconds)),
    compactMetric("Longest", duration(fragmentation.longestActualSessionSeconds)),
    compactMetric("Eligible transitions", String(fragmentation.switchEligibleTransitions)),
    compactMetric("Project switches", String(fragmentation.projectSwitches)),
    compactMetric("Task switches", String(fragmentation.taskSwitches)),
    compactMetric("Short sessions", String(fragmentation.shortSessionCount))
  ]);
  const maximum = Math.max(1, ...Object.values(fragmentation.buckets));
  replaceChildren($("#sessionBuckets"), BUCKETS.map(([key, labelText]) => {
    const row = element("div", "bucket-row");
    const track = element("div", "bucket-track");
    const fill = element("div", "bucket-fill");
    fill.style.width = `${fragmentation.buckets[key] / maximum * 100}%`;
    track.append(fill);
    row.append(element("span", "", labelText), track, element("strong", "", String(fragmentation.buckets[key])));
    return row;
  }));
}

function renderAnomalies({ anomalies }) {
  $("#anomalyCount").textContent = String(anomalies.length);
  replaceChildren($("#anomalyRows"), anomalies.map((anomaly) => {
    const row = element("article", "anomaly-row");
    const title = element("div");
    title.append(element("div", "anomaly-type", anomaly.type.replaceAll("_", " ")),
      element("div", "anomaly-meta", `${shortDateTime(anomaly.start)} · ${duration(anomaly.actualSeconds)}`));
    row.append(title, element("div", "", `${anomaly.project} / ${anomaly.task}`), element("div", "", anomaly.message));
    return row;
  }));
  $("#anomaliesEmpty").hidden = anomalies.length > 0;
}

function renderDescriptions() {
  const descriptions = latestReport?.descriptions || [];
  const visible = descriptionsExpanded ? descriptions : descriptions.slice(0, DESCRIPTION_LIMIT);
  replaceChildren($("#descriptionRows"), visible.map((row) => {
    const tr = element("tr");
    tr.append(
      element("td", "", row.description),
      element("td", "", String(row.sessionCount)),
      element("td", "", duration(row.currentSeconds)),
      shareCell(row.share),
      element("td", "", duration(row.previousSeconds)),
      element("td", "", delta(row.delta))
    );
    return tr;
  }));
  $("#descriptionsEmpty").hidden = descriptions.length > 0;
  const toggle = $("#toggleDescriptions");
  toggle.hidden = descriptions.length <= DESCRIPTION_LIMIT;
  toggle.textContent = descriptionsExpanded ? "Show less" : `Show all (${descriptions.length})`;
}

function renderReport(report) {
  latestReport = report;
  renderSummary(report);
  renderProjects(report);
  renderFragmentation(report);
  renderAnomalies(report);
  renderDescriptions();
}

function resolveSelectedPeriod() {
  const preset = $("#periodPreset").value;
  return resolveAnalyticsPeriod(preset, {
    customStart: $("#customStart").value,
    customEnd: $("#customEnd").value
  });
}

async function refresh() {
  const generation = ++refreshGeneration;
  const period = selectedPeriod || resolveSelectedPeriod();
  const earliest = period.primary.start < period.comparison.start ? period.primary.start : period.comparison.start;
  const latest = period.primary.end > period.comparison.end ? period.primary.end : period.comparison.end;
  setStatus("Loading…", "pending");
  const entries = await getEntriesIntersecting(earliest, latest);
  const report = buildAnalyticsReport(entries, { ...period, now: new Date() });
  if (generation !== refreshGeneration) return;
  selectedPeriod = period;
  $("#primaryRange").textContent = period.primary.label;
  $("#comparisonRange").textContent = period.comparison.label;
  renderReport(report);
  setStatus("Ready", "ready");
}

function applyPeriod() {
  try {
    selectedPeriod = resolveSelectedPeriod();
    $("#periodError").hidden = true;
  } catch (error) {
    $("#periodError").textContent = error.message;
    $("#periodError").hidden = false;
    return;
  }
  void runPageTask({
    page: "analytics",
    phase: "period-change",
    task: refresh,
    onError(error) { setStatus(error.message || "Could not load analytics", "error"); }
  });
}

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;
  $("#periodPreset").addEventListener("change", () => {
    const custom = $("#periodPreset").value === ANALYTICS_PERIOD_PRESET.CUSTOM;
    $("#customPeriod").hidden = !custom;
    if (!custom) applyPeriod();
  });
  $("#applyCustom").addEventListener("click", applyPeriod);
  $("#toggleDescriptions").addEventListener("click", () => {
    descriptionsExpanded = !descriptionsExpanded;
    renderDescriptions();
  });
  $("#projectRows").addEventListener("click", (event) => {
    const toggle = event.target.closest(".project-toggle");
    if (!toggle) return;
    const expanded = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.textContent = `${expanded ? "▾" : "▸"} ${toggle.textContent.slice(2)}`;
    for (const row of $("#projectRows").querySelectorAll(`.task-row[data-project-index="${toggle.dataset.projectIndex}"]`)) {
      row.hidden = !expanded;
    }
  });
  unsubscribeEntries = onEntriesChanged(() => {
    void runPageTask({
      page: "analytics",
      phase: "entries-changed",
      task: refresh,
      onError(error) { setStatus(error.message || "Could not refresh analytics", "error"); }
    });
  });
  globalThis.addEventListener("pagehide", () => {
    unsubscribeEntries?.();
    unsubscribeEntries = null;
  }, { once: true });
}

async function init() {
  const today = new Date();
  $("#customEnd").value = analyticsDateInputValue(today);
  $("#customStart").value = analyticsDateInputValue(addDays(today, -6));
  bindEvents();
  selectedPeriod = resolveSelectedPeriod();
  await refresh();
}

startPage({ page: "analytics", title: "Analytics", init });

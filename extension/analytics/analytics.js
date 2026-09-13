import { ANALYTICS_MISSING_FILTER, buildAnalyticsReport, filterAnalyticsEntries, resolveAnalyticsEntryTarget } from "../src/analytics.js";
import { ANALYTICS_PERIOD_PRESET, analyticsDateInputValue, resolveAnalyticsPeriod } from "../src/analytics-period.js";
import { getEntriesIntersecting } from "../src/db.js";
import { recordDiagnostic } from "../src/diagnostics.js";
import { onEntriesChanged } from "../src/events.js";
import { startPage } from "../src/page-runtime.js";
import { platform } from "../src/platform.js";
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
let anomaliesExpanded = false;
let refreshTimer = null;
let latestEntries = [];
let analyticsFilters = { project: "", task: "" };
let expandedProjects = null;

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
    summaryCard("Total actual time", duration(primary.totalActualSeconds), "Elapsed intervals; excludes multiplier tails"),
    summaryCard("Logged days", String(primary.loggedDays)),
    summaryCard("Average / logged day", duration(primary.averageEffectiveSecondsPerLoggedDay)),
    summaryCard("Sessions", String(primary.sessionCount)),
    summaryCard("Average actual session", duration(primary.averageActualSessionSeconds)),
    summaryCard("Median actual session", duration(primary.medianActualSessionSeconds)),
    summaryCard("Longest actual session", duration(primary.longestActualSessionSeconds)),
    summaryCard("Project switches", String(fragmentation.projectSwitches)),
    summaryCard("Task switches", String(fragmentation.taskSwitches)),
    summaryCard("Short sessions", String(fragmentation.shortSessionCount), "Under 15 minutes"),
    summaryCard("Detected anomalies", String(anomalies.totalCount))
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
    toggle.dataset.projectLabel = project.label;
    const expanded = expandedProjects ? expandedProjects.has(project.label) : true;
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.textContent = `${expanded ? "▾" : "▸"} ${project.label}`;
    labelCell.replaceChildren(toggle);
    rows.push(projectRow);
    for (const task of project.tasks) {
      const taskRow = reportRow(task.label, task, "task-row");
      taskRow.dataset.projectIndex = String(index);
      taskRow.hidden = !expanded;
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
  const { rows, totalCount, omittedOverlapCount } = anomalies;
  const visible = anomaliesExpanded ? rows : rows.slice(0, 100);
  $("#anomalyCount").textContent = String(totalCount);
  replaceChildren($("#anomalyRows"), visible.map((anomaly) => {
    const row = element("article", "anomaly-row");
    const title = element("div");
    title.append(element("div", "anomaly-type", anomaly.type.replaceAll("_", " ")),
      element("div", "anomaly-meta", `${shortDateTime(anomaly.start)} · ${duration(anomaly.actualSeconds)}`));
    const target = resolveAnalyticsEntryTarget(anomaly, latestEntries);
    const destination = element("div", "anomaly-destination");
    if (target) {
      const open = element("button", "anomaly-link", "Open entry");
      open.type = "button";
      open.dataset.anomalyEntryId = target.entryId;
      const query = new URLSearchParams({ entry: target.entryId, date: target.date });
      open.dataset.anomalyDestination = `calendar/calendar.html?${query}`;
      open.addEventListener("click", () => {
        const currentTarget = resolveAnalyticsEntryTarget(anomaly, latestEntries);
        if (!currentTarget) {
          setStatus("This entry is no longer available", "error");
          renderAnomalies(latestReport);
          return;
        }
        const destination = `calendar/calendar.html?${new URLSearchParams({ entry: currentTarget.entryId, date: currentTarget.date })}`;
        platform.openExtensionPage(destination).catch((error) => {
          setStatus(error.message || "Could not open the calendar entry", "error");
        });
      });
      destination.append(open);
    } else {
      destination.append(element("span", "anomaly-unavailable", "Entry unavailable"));
    }
    row.append(title, element("div", "", `${anomaly.project} / ${anomaly.task}`), element("div", "", anomaly.message), destination);
    return row;
  }));
  $("#anomaliesEmpty").hidden = totalCount > 0;
  const omitted = $("#anomaliesNote");
  omitted.hidden = omittedOverlapCount === 0;
  omitted.textContent = omittedOverlapCount
    ? `${omittedOverlapCount} overlapping pairs omitted from the detail list.`
    : "";
  const loadMore = $("#loadMoreAnomalies");
  loadMore.hidden = anomaliesExpanded || rows.length <= 100;
  loadMore.textContent = `Load more (${rows.length - 100} remaining)`;
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
      element("td", "", duration(row.averageSeconds)),
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

function filterLabel(value, fallback) {
  if (!value) return fallback;
  if (value === ANALYTICS_MISSING_FILTER) return `No ${fallback.toLowerCase()}`;
  return value;
}

function renderFilterOptions(entries) {
  for (const [field, labelText] of [["project", "projects"], ["task", "tasks"]]) {
    const select = $(`#analytics${field[0].toUpperCase()}${field.slice(1)}Filter`);
    const current = analyticsFilters[field];
    const values = [...new Set((entries || []).map((entry) => String(entry[field] || "").trim()).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }) || left.localeCompare(right));
    const options = [new Option(`All ${labelText}`, "")];
    if ((entries || []).some((entry) => !String(entry[field] || "").trim())) {
      options.push(new Option(`No ${field}`, ANALYTICS_MISSING_FILTER));
    }
    for (const value of values) options.push(new Option(value, value));
    if (current && !options.some((option) => option.value === current)) {
      options.push(new Option(`${filterLabel(current, field)} (not in loaded range)`, current));
    }
    select.replaceChildren(...options);
    select.value = current;
  }
  $("#analyticsFilterSummary").textContent = `${filterLabel(analyticsFilters.project, "All projects")} · ${filterLabel(analyticsFilters.task, "All tasks")}`;
}

function captureViewState() {
  const active = document.activeElement;
  return {
    activeId: active?.id || "",
    anomalyEntryId: active?.dataset?.anomalyEntryId || "",
    projectLabel: active?.dataset?.projectLabel || "",
    scrollTop: window.scrollY
  };
}

function restoreViewState(state) {
  if (!state) return;
  let focusTarget = state.activeId ? document.getElementById(state.activeId) : null;
  if (!focusTarget && state.anomalyEntryId) focusTarget = document.querySelector(`[data-anomaly-entry-id="${CSS.escape(state.anomalyEntryId)}"]`);
  if (!focusTarget && state.projectLabel) {
    focusTarget = [...document.querySelectorAll(".project-toggle")]
      .find((toggle) => toggle.dataset.projectLabel === state.projectLabel);
  }
  focusTarget?.focus();
  window.scrollTo(0, state.scrollTop);
}

function resolveSelectedPeriod() {
  const preset = $("#periodPreset").value;
  return resolveAnalyticsPeriod(preset, {
    customStart: $("#customStart").value,
    customEnd: $("#customEnd").value
  });
}

async function performRefresh(generation, viewState) {
  const now = new Date();
  const currentPreset = [ANALYTICS_PERIOD_PRESET.THIS_WEEK, ANALYTICS_PERIOD_PRESET.THIS_MONTH, ANALYTICS_PERIOD_PRESET.THIS_YEAR, ANALYTICS_PERIOD_PRESET.LAST_30_DAYS].includes($("#periodPreset").value);
  const period = currentPreset ? resolveAnalyticsPeriod($("#periodPreset").value, { now }) : (selectedPeriod || resolveSelectedPeriod());
  const earliest = period.primary.start < period.comparison.start ? period.primary.start : period.comparison.start;
  const latest = period.primary.end > period.comparison.end ? period.primary.end : period.comparison.end;
  const entries = await getEntriesIntersecting(earliest, latest);
  const report = buildAnalyticsReport(filterAnalyticsEntries(entries, analyticsFilters), { ...period, now });
  if (generation !== refreshGeneration) return;
  latestEntries = entries;
  renderFilterOptions(entries);
  selectedPeriod = period;
  $("#primaryRange").textContent = period.primary.label;
  $("#comparisonRange").textContent = period.comparison.label;
  renderReport(report);
  restoreViewState(viewState);
  setStatus("Ready", "ready");
}

// Every trigger goes through this owner so success and failure use the same
// generation fence. A stale failure is deliberately swallowed after the
// current request has taken over the page; the initial request still rejects
// so startPage can expose its Retry path.
function requestRefresh({ initial = false } = {}) {
  const generation = ++refreshGeneration;
  const viewState = captureViewState();
  setStatus("Loading…", "pending");
  return performRefresh(generation, viewState).catch((error) => {
    const current = generation === refreshGeneration;
    if (current) setStatus(error.message || "Could not load analytics", "error");
    if (!initial) {
      void recordDiagnostic({
        subsystem: "page",
        phase: current ? "analytics.refresh" : "analytics.refresh.stale",
        error,
        recovery: "Retry the analytics refresh."
      }).catch(() => {});
    }
    if (initial) throw error;
  });
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
  void requestRefresh();
}

function applyAnalyticsFilters() {
  analyticsFilters = {
    project: $("#analyticsProjectFilter").value,
    task: $("#analyticsTaskFilter").value
  };
  void requestRefresh();
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
  $("#analyticsProjectFilter").addEventListener("change", applyAnalyticsFilters);
  $("#analyticsTaskFilter").addEventListener("change", applyAnalyticsFilters);
  $("#toggleDescriptions").addEventListener("click", () => {
    descriptionsExpanded = !descriptionsExpanded;
    renderDescriptions();
  });
  $("#loadMoreAnomalies").addEventListener("click", () => { anomaliesExpanded = true; renderAnomalies(latestReport); });
  $("#projectRows").addEventListener("click", (event) => {
    const toggle = event.target.closest(".project-toggle");
    if (!toggle) return;
    const expanded = toggle.getAttribute("aria-expanded") !== "true";
    if (!expandedProjects) expandedProjects = new Set(latestReport?.projects.map((project) => project.label) || []);
    if (expanded) expandedProjects.add(toggle.dataset.projectLabel);
    else expandedProjects.delete(toggle.dataset.projectLabel);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.textContent = `${expanded ? "▾" : "▸"} ${toggle.textContent.slice(2)}`;
    for (const row of $("#projectRows").querySelectorAll(`.task-row[data-project-index="${toggle.dataset.projectIndex}"]`)) {
      row.hidden = !expanded;
    }
  });
  unsubscribeEntries = onEntriesChanged(() => {
    void requestRefresh();
  });
  globalThis.addEventListener("visibilitychange", () => {
    if (!document.hidden) void requestRefresh();
  });
  refreshTimer = setInterval(() => { if (!document.hidden) void requestRefresh(); }, 60_000);
  globalThis.addEventListener("pagehide", () => {
    clearInterval(refreshTimer);
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
  await requestRefresh({ initial: true });
}

startPage({ page: "analytics", title: "Analytics", init });

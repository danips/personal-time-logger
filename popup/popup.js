import { getActiveEntries, getDirtyEntryCount, getEntriesIntersecting, getEntry, getSetting, getVisibleEntries, setSetting } from "../src/db.js";
import { runAction } from "../src/action-runner.js";
import { CHATGPT_ACCOUNTS_KEY, normalizeChatGptAccounts } from "../src/chatgpt-account-cache.js";
import { canMergeEntries, hasMultiplier, mergeEntries, replaceActiveTimer, softDeleteEntry, stopEntry, updateEntry } from "../src/entries.js";
import { readEntryForm, writeEntryForm } from "../src/entry-form.js";
import { mountEntryEditor } from "../src/entry-editor.js";
import { onEntriesChanged } from "../src/events.js";
import { requestBackgroundSync } from "../src/sync-request.js";
import { allocateEntryByLocalDay } from "../src/time-allocation.js";
import {
  addDays,
  bindMinuteRollover,
  dayMonth,
  durationSeconds,
  formatElapsed,
  localDateKey,
  localTime,
  shortDateTime,
  startOfLocalWeek,
  weekdayDayMonth
} from "../src/time.js";
import {
  $,
  entryTitle,
  formatError,
  projectColor,
  setStatus,
  statusFromError
} from "../src/ui-helpers.js";
import { platform } from "../src/platform.js";
import { runPageTask, startPage } from "../src/page-runtime.js";
import { SETTING_KEY } from "../src/setting-keys.js";
import { updateActiveIcon } from "../src/icon.js";
import {
  MAX_WINDOW_SIZE,
  normalizeWindowSizePreset,
  resizeCurrentWindow
} from "../src/window-resize.js";

mountEntryEditor(document.getElementById("popupEntryEditor"), {
  formId: "editForm",
  projectId: "editProject",
  taskId: "editTask",
  descriptionId: "editDescription",
  multiplyId: "editMultiply",
  statusId: "editStatus",
  startId: "editStart",
  endId: "editEnd",
  mergeControlId: "editMergeControl",
  mergeTargetId: "mergeTarget",
  mergeButtonId: "mergeEdit",
  saveButtonId: "saveEdit",
  cancelButtonId: "cancelEdit",
  deleteButtonId: "deleteEdit"
});

let activeEntries = [];
let editingId = "";
let editingRevision = null;
let editingMultiplyValue = "";
let mergeTargetRevisions = new Map();
let ticker = null;
let unsubscribeEntryEvents = null;
let eventsBound = false;
const expandedRecentGroups = new Set();
let recentWeekCount = 1;
let recentEntries = [];
const WINDOW_SIZE_SETTING = SETTING_KEY.WINDOW_RESIZE_PRESETS;
const DEFAULT_WINDOW_SIZES = [
  { width: 2000, height: 1000, isWindow: false },
  { width: 1500, height: 1000, isWindow: false },
  { width: 1300, height: 900, isWindow: false }
];
let windowSizes = DEFAULT_WINDOW_SIZES.map((size) => ({ ...size }));
let editingWindowSizes = [];
let windowSizeEditorOpen = false;
let renderGeneration = 0;

const $activePanel = $(".active-panel");
const $activeTitle = $("#activeTitle");
const $activeDescription = $("#activeDescription");
const $elapsed = $("#elapsed");
const $stopButton = $("#stopButton");
const $activeWarning = $("#activeWarning");
const $recentEntries = $("#recentEntries");
const $loadMoreRecent = $("#loadMoreRecent");
const $dirtyBadge = $("#dirtyBadge");
const $syncStatus = $("#syncStatus");
const $editPanel = $("#editPanel");
const $editProjectDot = $("#editProjectDot");
const $editProject = $("#editProject");
const $editTask = $("#editTask");
const $editDescription = $("#editDescription");

const $editMultiply = $("#editMultiply");
const $editStart = $("#editStart");
const $editEnd = $("#editEnd");
const $editStatus = $("#editStatus");
const $mergeTarget = $("#mergeTarget");
const $mergeEdit = $("#mergeEdit");
const $mergeTools = $("#editMergeControl");
const $newTimerToggle = $("#newTimerToggle");
const $newTimerPanel = $("#newTimerPanel");
const $newTimerIcon = $(".new-timer-icon");
const $newTimerSection = $("#newTimerSection");
const $newTimerDivider = $("#newTimerDivider");
const $chatGptUsageSummary = $("#chatGptUsageSummary");
const $chatGptUsageValues = $("#chatGptUsageValues");
const $windowSizePresets = $("#windowSizePresets");
const $windowSizeEditor = $("#windowSizeEditor");
const $windowSizeFields = $("#windowSizeFields");

let renderedActiveId;

function formFields() {
  return {
    project: $("#project").value.trim(),
    task: $("#task").value.trim(),
    description: $("#description").value.trim(),
    multiply: $("#multiply").checked
  };
}

function editFields() {
  return {
    project: $editProject,
    task: $editTask,
    description: $editDescription,
    multiply: $editMultiply,
    start: $editStart,
    end: $editEnd,
    status: $editStatus
  };
}

function entryDuration(entry) {
  return Number(entry.duration_seconds) || durationSeconds(entry.start_at, entry.end_at || undefined);
}

function projectDot(entry) {
  const dot = document.createElement("span");
  dot.className = "project-dot";
  dot.style.setProperty("--project-color", projectColor(entry));
  dot.title = entry.project || "Untitled project";
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

function entryChips(entry) {
  const chips = [];
  if (entry.status === "needs_review") chips.push("Review");
  if (entry.dirty) chips.push("Pending");
  return chips;
}

function renderChips(chips) {
  if (!chips.length) return null;
  const container = document.createElement("div");
  container.className = "entry-chips";
  for (const chip of chips) {
    const element = document.createElement("span");
    element.textContent = chip;
    container.append(element);
  }
  return container;
}

function groupChips(group) {
  const chips = new Set();
  for (const entry of group.entries) {
    for (const chip of entryChips(entry)) chips.add(chip);
  }
  return [...chips];
}

function localDayKey(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return localDateKey(date);
}

function localDayLabel(iso) {
  return weekdayDayMonth(iso) || "Unknown day";
}

function weekInfo(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return {
      key: "unknown",
      label: "Unknown week",
      start: null,
      totalSeconds: 0,
      days: [],
      dayMap: new Map()
    };
  }

  const start = startOfLocalWeek(date);
  const end = addDays(start, 6);
  const currentWeek = startOfLocalWeek(new Date());
  const previousWeek = addDays(currentWeek, -7);
  let label = `${dayMonth(start)} - ${dayMonth(end)}`;
  if (start.getTime() === currentWeek.getTime()) label = "This week";
  if (start.getTime() === previousWeek.getTime()) label = "Last week";

  return {
    key: localDateKey(start),
    label,
    start,
    totalSeconds: 0,
    days: [],
    dayMap: new Map()
  };
}

function recentGroupKey(entry) {
  return [
    localDayKey(entry.start_at),
    entry.project || "",
    entry.task || "",
    entry.description || "",
    entry.multiply || ""
  ].map((part) => encodeURIComponent(part)).join("|");
}

function compareRecentEntries(left, right) {
  const byStart = String(right.start_at || "").localeCompare(String(left.start_at || ""));
  return byStart || String(right.id || "").localeCompare(String(left.id || ""));
}

function groupRecentEntries(entries, { start, end }) {
  const weeks = [];
  const weekMap = new Map();

  for (const entry of entries) {
    for (const allocation of allocateEntryByLocalDay(entry)) {
      if (allocation.end <= start || allocation.start >= end) continue;
      const displayEntry = {
        ...entry,
        start_at: allocation.start.toISOString(),
        end_at: allocation.end.toISOString(),
        duration_seconds: allocation.effectiveSeconds
      };
      const weekSeed = weekInfo(displayEntry.start_at);
      if (!weekMap.has(weekSeed.key)) {
        weekMap.set(weekSeed.key, weekSeed);
        weeks.push(weekSeed);
      }

      const week = weekMap.get(weekSeed.key);
      const dayKey = localDayKey(displayEntry.start_at);
      if (!week.dayMap.has(dayKey)) {
        const day = {
          key: dayKey,
          label: localDayLabel(displayEntry.start_at),
          totalSeconds: 0,
          groups: [],
          groupMap: new Map()
        };
        week.dayMap.set(dayKey, day);
        week.days.push(day);
      }

      const day = week.dayMap.get(dayKey);
      const groupKey = recentGroupKey(displayEntry);
      if (!day.groupMap.has(groupKey)) {
        const group = {
          key: groupKey,
          entries: [],
          totalSeconds: 0
        };
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

  weeks.sort((left, right) => right.start.getTime() - left.start.getTime());

  return weeks;
}

function renderEntryRow(entry, { child = false } = {}) {
  const duration = formatElapsed(entryDuration(entry));
  const taskLabel = entry.task || "No task";
  const descriptionLabel = entry.description || "";
  const multiplier = hasMultiplier(entry) ? `x${entry.multiply}` : "";

  const row = document.createElement("article");
  row.className = [
    "entry-row",
    child ? "entry-row-child" : "",
    entry.status === "needs_review" ? "needs-review" : ""
  ].filter(Boolean).join(" ");
  row.dataset.editId = entry.id;
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.setAttribute("aria-label", `Edit ${entryTitle(entry)}`);

  const main = document.createElement("div");
  main.className = "entry-main";

  const title = document.createElement("div");
  title.className = "entry-title";
  const titleText = document.createElement("span");
  titleText.textContent = taskLabel;
  title.append(projectDot(entry), titleText);

  const detail = document.createElement("div");
  detail.className = "entry-meta";
  if (descriptionLabel) {
    detail.title = descriptionLabel;
    detail.textContent = descriptionLabel;
  }

  main.append(title, detail);
  const chips = renderChips(entryChips(entry));
  if (chips) main.append(chips);

  const timeBlock = document.createElement("div");
  timeBlock.className = "entry-time-block";
  const timeLine = document.createElement("div");
  timeLine.className = "entry-time-line";
  timeLine.textContent = `${localTime(entry.start_at)}${entry.end_at ? ` - ${localTime(entry.end_at)}` : " - active"}`;
  const durationLine = document.createElement("div");
  durationLine.className = "entry-duration-line";
  const durationElement = document.createElement("span");
  durationElement.textContent = duration;
  durationLine.append(durationElement);
  if (multiplier) {
    const multiplierElement = document.createElement("span");
    multiplierElement.className = "entry-multiplier";
    multiplierElement.textContent = multiplier;
    durationLine.append(multiplierElement);
  }
  timeBlock.append(timeLine, durationLine);

  const actions = document.createElement("div");
  actions.className = "entry-actions";
  const play = document.createElement("button");
  play.className = "play-button";
  play.type = "button";
  play.dataset.restartId = entry.id;
  play.title = "Start from this entry";
  play.setAttribute("aria-label", `Start from ${entryTitle(entry)}`);
  play.textContent = "▶";
  actions.append(play);

  row.append(main, timeBlock, actions);
  return row;
}

function renderRecentTimerGroup(group) {
  const [entry] = group.entries;
  if (group.entries.length === 1) return renderEntryRow(entry);

  const expanded = expandedRecentGroups.has(group.key);
  const section = document.createElement("section");
  section.className = "timer-group";

  const summary = document.createElement("article");
  summary.className = `entry-row timer-group-row${entry.status === "needs_review" ? " needs-review" : ""}`;
  const main = document.createElement("div");
  main.className = "entry-main";
  const title = document.createElement("div");
  title.className = "entry-title";
  const titleText = document.createElement("span");
  titleText.textContent = entry.task || "No task";
  title.append(projectDot(entry), titleText);
  const descriptionLabel = entry.description || "";
  const detail = document.createElement("div");
  detail.className = "entry-meta";
  if (descriptionLabel) {
    detail.textContent = descriptionLabel;
  }
  main.append(title, detail);
  const chips = renderChips(groupChips(group));
  if (chips) main.append(chips);

  const actions = document.createElement("div");
  actions.className = "entry-actions";
  const duration = document.createElement("span");
  duration.className = "entry-duration-col";
  duration.textContent = formatElapsed(group.totalSeconds);
  const count = document.createElement("button");
  count.className = "count-button";
  count.type = "button";
  count.dataset.toggleGroup = group.key;
  count.setAttribute("aria-expanded", expanded ? "true" : "false");
  count.textContent = String(group.entries.length);
  const play = document.createElement("button");
  play.className = "play-button";
  play.type = "button";
  play.dataset.restartId = entry.id;
  play.title = "Start from this group";
  play.setAttribute("aria-label", `Start from ${entryTitle(entry)}`);
  play.textContent = "▶";
  actions.append(duration, count, play);
  summary.append(main, actions);

  const instances = document.createElement("div");
  instances.className = `timer-instances${expanded ? "" : " hidden"}`;
  instances.append(...group.entries.map((item) => renderEntryRow(item, { child: true })));
  section.append(summary, instances);
  return section;
}

function updateElapsed() {
  const latest = activeEntries[0];
  const hasActive = Boolean(latest);
  const activeId = latest ? latest.id : "";
  // Compare ids, not just presence: starting a timer while one is already
  // running swaps the active entry without changing `hasActive`.
  if (activeId === renderedActiveId) {
    if (hasActive) $elapsed.textContent = formatElapsed(durationSeconds(latest.start_at));
    return;
  }
  renderedActiveId = activeId;
  $activeTitle.textContent = latest?.task || "No task";
  $activeDescription.textContent = latest?.description || "";
  $activeDescription.title = latest?.description || "";
  $elapsed.textContent = latest ? formatElapsed(durationSeconds(latest.start_at)) : "00:00:00";
  $stopButton.classList.toggle("hidden", !latest);
  $activePanel.classList.toggle("is-running", hasActive);
  $activePanel.tabIndex = 0;
  $activePanel.setAttribute("role", "button");
  $activePanel.setAttribute("aria-label", latest ? `Edit active timer ${entryTitle(latest)}` : "Start a new timer");
  if (hasActive) setNewTimerOpen(false);
  void updateActiveIcon(hasActive);
}

function setNewTimerOpen(open) {
  $newTimerSection.classList.toggle("hidden", !open);
  $newTimerDivider.classList.toggle("hidden", !open);
  $newTimerToggle.setAttribute("aria-expanded", open ? "true" : "false");
  $newTimerPanel.classList.toggle("hidden", !open);
  $newTimerIcon.textContent = open ? "-" : "+";
  if (!activeEntries[0]) $activePanel.setAttribute("aria-label", open ? "Hide new timer" : "Start a new timer");
}

function toggleNewTimer() {
  setNewTimerOpen($newTimerToggle.getAttribute("aria-expanded") !== "true");
}

async function renderActive(isCurrent) {
  const entries = await getActiveEntries();
  if (!isCurrent()) return false;
  activeEntries = entries;
  updateElapsed();

  if (activeEntries.length > 1) {
    $activeWarning.textContent = `Warning: ${activeEntries.length} active timers exist. Older active entries are marked needs_review on sync.`;
    $activeWarning.classList.remove("hidden");
  } else {
    $activeWarning.classList.add("hidden");
  }
  return true;
}

function recentWeekRange(weekCount) {
  const currentWeek = startOfLocalWeek(new Date());
  return {
    start: addDays(currentWeek, -7 * (weekCount - 1)),
    end: addDays(currentWeek, 7)
  };
}

function weeksBeforeCurrentWeek(iso) {
  const entryWeek = startOfLocalWeek(new Date(iso));
  const currentWeek = startOfLocalWeek(new Date());
  const weeks = (currentWeek.getTime() - entryWeek.getTime()) / (7 * 24 * 60 * 60 * 1000);
  return Number.isFinite(weeks) ? Math.max(0, Math.round(weeks)) : 0;
}

async function renderRecent(isCurrent) {
  let range = recentWeekRange(recentWeekCount);
  let entries = await getEntriesIntersecting(range.start, range.end);
  if (!isCurrent()) return false;

  // When this week is empty, start at the most recent populated week rather
  // than making the user click through empty calendar weeks.
  if (!entries.length && recentWeekCount === 1) {
    const [newest] = await getVisibleEntries({ limit: 1 });
    if (!isCurrent()) return false;
    if (newest) {
      recentWeekCount = Math.max(recentWeekCount, weeksBeforeCurrentWeek(newest.start_at) + 1);
      range = recentWeekRange(recentWeekCount);
      entries = await getEntriesIntersecting(range.start, range.end);
      if (!isCurrent()) return false;
    }
  }
  const [older] = await getVisibleEntries({ before: range.start.toISOString(), limit: 1 });
  if (!isCurrent()) return false;
  const hasMore = Boolean(older);
  recentEntries = entries;

  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "entry-meta";
    empty.textContent = "No entries yet.";
    $recentEntries.replaceChildren(empty);
    $loadMoreRecent.classList.toggle("hidden", !hasMore);
    $loadMoreRecent.textContent = hasMore ? "Load previous week" : "";
    return true;
  }

  const weekElements = groupRecentEntries(entries, range).map((week) => {
    const section = document.createElement("section");
    section.className = "week-group";
    const header = document.createElement("header");
    header.className = "week-group-header";
    const label = document.createElement("strong");
    label.textContent = week.label;
    const total = document.createElement("span");
    total.textContent = formatElapsed(week.totalSeconds);
    header.append(label, total);

    const days = document.createElement("div");
    days.className = "week-group-days";
    for (const day of week.days) {
      const daySection = document.createElement("section");
      daySection.className = "day-group";
      const dayHeader = document.createElement("header");
      dayHeader.className = "day-group-header";
      const dayLabel = document.createElement("strong");
      dayLabel.textContent = day.label;
      const dayTotal = document.createElement("span");
      dayTotal.textContent = formatElapsed(day.totalSeconds);
      dayHeader.append(dayLabel, dayTotal);
      const groups = document.createElement("div");
      groups.className = "day-group-entries";
      groups.append(...day.groups.map(renderRecentTimerGroup));
      daySection.append(dayHeader, groups);
      days.append(daySection);
    }

    section.append(header, days);
    return section;
  });
  $recentEntries.replaceChildren(...weekElements);

  $loadMoreRecent.classList.toggle("hidden", !hasMore);
  $loadMoreRecent.textContent = hasMore ? "Load previous week" : "";
  return true;
}

async function renderDirtyBadge(isCurrent) {
  if (!$dirtyBadge) return true;
  const count = await getDirtyEntryCount();
  if (!isCurrent()) return false;
  const label = count > 99 ? "99+ pending" : `${count} pending`;
  $dirtyBadge.textContent = label;
  $dirtyBadge.title = `${count} unsynced local ${count === 1 ? "change" : "changes"}`;
  $dirtyBadge.classList.toggle("hidden", count === 0);
  return true;
}

function compactPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) return null;
  return `${Math.round(numeric * 10) / 10}%`;
}

function normalizeWindowSizes(value) {
  if (!Array.isArray(value)) return null;
  return value
    .map(normalizeWindowSizePreset)
    .filter(Boolean);
}

function windowSizeLabel(size) {
  return `${size.width}×${size.height}`;
}

function renderWindowSizePresets() {
  const buttons = windowSizes.map((size) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "window-size-button";
    button.dataset.windowWidth = String(size.width);
    button.dataset.windowHeight = String(size.height);
    button.dataset.windowMode = String(size.isWindow);
    button.textContent = windowSizeLabel(size);
    button.title = `${size.isWindow ? "Resize browser window" : "Resize viewport"} to ${size.width} by ${size.height}`;
    return button;
  });
  if (!buttons.length) {
    const empty = document.createElement("span");
    empty.className = "window-size-empty";
    empty.textContent = "No sizes";
    buttons.push(empty);
  }
  $windowSizePresets.replaceChildren(...buttons);
}

function renderWindowSizeEditor() {
  const rows = editingWindowSizes.map((size, index) => {
    const row = document.createElement("div");
    row.className = "window-size-field-row";

    const width = document.createElement("input");
    width.className = "window-size-input window-size-width";
    width.type = "number";
    width.min = "1";
    width.max = String(MAX_WINDOW_SIZE);
    width.step = "1";
    width.value = String(size.width);
    width.placeholder = "Width";
    width.setAttribute("aria-label", `Width for window size ${index + 1}`);

    const separator = document.createElement("span");
    separator.className = "window-size-separator";
    separator.textContent = "×";

    const height = document.createElement("input");
    height.className = "window-size-input window-size-height";
    height.type = "number";
    height.min = "1";
    height.max = String(MAX_WINDOW_SIZE);
    height.step = "1";
    height.value = String(size.height);
    height.placeholder = "Height";
    height.setAttribute("aria-label", `Height for window size ${index + 1}`);

    const modeLabel = document.createElement("label");
    modeLabel.className = "window-size-mode";
    modeLabel.title = "Checked: width and height apply to the outer browser window. Unchecked: they apply to the page viewport.";
    const mode = document.createElement("input");
    mode.className = "window-size-window-mode";
    mode.type = "checkbox";
    mode.checked = Boolean(size.isWindow);
    mode.setAttribute("aria-label", `Use outer window size for preset ${index + 1}`);
    const modeText = document.createElement("span");
    modeText.textContent = "Window";
    modeLabel.append(mode, modeText);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "window-size-remove danger";
    remove.dataset.removeWindowSize = String(index);
    remove.title = "Remove window size";
    remove.setAttribute("aria-label", `Remove window size ${index + 1}`);
    remove.textContent = "×";

    row.append(width, separator, height, modeLabel, remove);
    return row;
  });
  $windowSizeFields.replaceChildren(...rows);
}

function setWindowSizeEditorOpen(open) {
  windowSizeEditorOpen = open;
  if (open) {
    editingWindowSizes = windowSizes.map((size) => ({ ...size }));
    renderWindowSizeEditor();
  }
  $windowSizeEditor.classList.toggle("hidden", !open);
}

function readWindowSizeEditor() {
  return [...$windowSizeFields.querySelectorAll(".window-size-field-row")].map((row) => ({
    width: Number(row.querySelector(".window-size-width").value),
    height: Number(row.querySelector(".window-size-height").value),
    isWindow: row.querySelector(".window-size-window-mode").checked
  }));
}

async function resizeBrowserWindow(width, height, isWindow) {
  try {
    await resizeCurrentWindow({ width, height, isWindow }, platform);
  } catch (error) {
    setStatus($syncStatus, "error", formatError(error));
  }
}

async function saveWindowSizes() {
  const sizes = readWindowSizeEditor();
  const normalized = sizes.map(normalizeWindowSizePreset);
  if (normalized.some((size) => !size)) {
    setStatus($syncStatus, "error", `Window sizes must be whole numbers from 1 to ${MAX_WINDOW_SIZE}`);
    return;
  }
  windowSizes = normalized;
  await setSetting(WINDOW_SIZE_SETTING, windowSizes);
  setWindowSizeEditorOpen(false);
  renderWindowSizePresets();
}

async function loadWindowSizes() {
  const stored = normalizeWindowSizes(await getSetting(WINDOW_SIZE_SETTING, null));
  if (stored) windowSizes = stored;
  renderWindowSizePresets();
}

async function renderChatGptUsageSummary(isCurrent) {
  const summaries = normalizeChatGptAccounts(await getSetting(CHATGPT_ACCOUNTS_KEY, []))
    .map((account) => ({
      label: account.email || account.label || "ChatGPT account",
      remaining: compactPercent(account.snapshot?.primary_window?.remaining_percent),
      resetAt: account.snapshot?.primary_window?.reset_at || "",
      collectedAt: account.snapshot?.collected_at || account.last_success_at || ""
    }))
    .filter((account) => account.remaining);
  if (!isCurrent()) return false;

  $chatGptUsageSummary.classList.toggle("hidden", summaries.length === 0);
  if (!summaries.length) return true;

  const values = summaries.map((account) => {
    const nextRefresh = shortDateTime(account.resetAt) || "not provided";
    const lastUpdate = shortDateTime(account.collectedAt) || "not available";
    const detail = `Account: ${account.label}\nNext allowance refresh: ${nextRefresh}\nLast update: ${lastUpdate}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chatgpt-usage-value";
    button.textContent = account.remaining;
    button.title = detail;
    button.setAttribute("aria-label", `Open ChatGPT usage limits. ${detail.replaceAll("\n", ". ")}`);
    return button;
  });
  $chatGptUsageValues.replaceChildren(...values);
  return true;
}

async function render() {
  const generation = ++renderGeneration;
  const isCurrent = () => generation === renderGeneration;
  if (!(await renderActive(isCurrent))) return;
  if (!(await renderChatGptUsageSummary(isCurrent))) return;
  if (!(await renderDirtyBadge(isCurrent))) return;
  await renderRecent(isCurrent);
}

async function runSync({ force = false } = {}) {
  setStatus($syncStatus, "pending");
  try {
    const result = await requestBackgroundSync({ force });
    setStatus($syncStatus, result.status, result.warning);
  } catch (error) {
    setStatus($syncStatus, statusFromError(error), formatError(error));
  }
}

function queueSync() {
  // The edit is already committed locally. Let the background keep the remote
  // sync alive if this short-lived popup closes before it completes.
  void runSync({ force: false });
}

function runPopupAction(key, action, { button = null, expectedRevision } = {}) {
  return runAction(key, action, {
    expectedRevision,
    setBusy(next) {
      if (button) button.disabled = next;
    },
    onError(error) {
      setStatus($syncStatus, "error", formatError(error));
    },
    onFinally() {
      return render().catch((error) => setStatus($syncStatus, "error", formatError(error)));
    }
  });
}

async function startTimer() {
  await replaceActiveTimer(formFields());
  setNewTimerOpen(false);
  queueSync();
}

async function restartFromEntry(id) {
  const entry = await getEntry(id);
  if (!entry) return;
  await replaceActiveTimer({
    project: entry.project || "",
    task: entry.task || "",
    description: entry.description || "",
    multiply: entry.multiply || ""
  });
  hideEdit();
  queueSync();
}

async function stopTimer({ expectedRevision } = {}) {
  const active = await getActiveEntries();
  if (!active.length) return;
  await stopEntry(active[0].id, { expectedRevision: expectedRevision ?? active[0].revision });
  queueSync();
}

async function showEdit(id) {
  const entry = await getEntry(id);
  if (!entry) return;
  editingId = id;
  editingRevision = Number(entry.revision || 0);
  editingMultiplyValue = entry.multiply || "";
  $editProjectDot.classList.toggle("hidden", !entry.project);
  $editProjectDot.style.setProperty("--project-color", projectColor(entry));
  writeEntryForm(editFields(), entry);
  renderMergeTargets(entry, recentEntries);
  setNewTimerOpen(false);
  $editPanel.classList.remove("hidden");
  $editProject.focus();
}

function editActiveTimer(event) {
  if (event && event.target.closest("#stopButton")) return;
  const latest = activeEntries[0];
  if (!latest) {
    const open = $newTimerSection.classList.contains("hidden");
    setNewTimerOpen(open);
    if (open) $("#project").focus();
    return;
  }
  showEdit(latest.id).catch((error) => setStatus($syncStatus, "error", formatError(error)));
}

function editActiveTimerFromKeyboard(event) {
  if (event.target !== event.currentTarget) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  editActiveTimer(event);
}

function hideEdit() {
  editingId = "";
  editingRevision = null;
  editingMultiplyValue = "";
  mergeTargetRevisions = new Map();
  $mergeTarget.replaceChildren();
  $mergeEdit.disabled = true;
  $mergeTools.hidden = true;
  $editProjectDot.classList.add("hidden");
  $editPanel.classList.add("hidden");
}

function renderMergeTargets(entry, entries) {
  const candidates = entries.filter((candidate) => canMergeEntries(entry, candidate));
  mergeTargetRevisions = new Map(candidates.map((candidate) => [candidate.id, Number(candidate.revision || 0)]));
  const options = candidates.map((candidate) => {
    const option = document.createElement("option");
    option.value = candidate.id;
    option.textContent = `${shortDateTime(candidate.start_at)} · ${formatElapsed(candidate.duration_seconds || durationSeconds(candidate.start_at, candidate.end_at))}`;
    return option;
  });
  $mergeTarget.replaceChildren(...options);
  $mergeEdit.disabled = !candidates.length;
  $mergeTools.hidden = !candidates.length;
}

async function saveEdit() {
  if (!editingId) return;
  try {
    await updateEntry(
      editingId,
      readEntryForm(editFields(), { multiplyValue: editingMultiplyValue }),
      { expectedRevision: editingRevision }
    );
    hideEdit();
    queueSync();
  } catch (error) {
    if (error.code === "STORAGE_CONFLICT") hideEdit();
    throw error;
  }
}

function saveEditOnEnter(event) {
  if (event.key !== "Enter" || event.isComposing || event.repeat) return;
  event.preventDefault();
  runPopupAction(`save-entry:${editingId}`, saveEdit, { expectedRevision: editingRevision });
}

async function deleteEdit() {
  if (!editingId) return;
  if (!confirm("Delete this time log entry?")) return;
  try {
    await softDeleteEntry(editingId, { expectedRevision: editingRevision });
    hideEdit();
    queueSync();
  } catch (error) {
    if (error.code === "STORAGE_CONFLICT") hideEdit();
    throw error;
  }
}

async function mergeEdit() {
  if (!editingId) return;
  const sourceId = $mergeTarget.value;
  if (!sourceId) return;
  try {
    await mergeEntries(editingId, sourceId, {
      expectedRevisions: {
        [editingId]: editingRevision,
        [sourceId]: mergeTargetRevisions.get(sourceId)
      }
    });
    hideEdit();
    queueSync();
  } catch (error) {
    if (error.code === "STORAGE_CONFLICT") hideEdit();
    throw error;
  }
}

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;
  bindMinuteRollover($editStart);
  bindMinuteRollover($editEnd);
  $editStart.addEventListener("keydown", saveEditOnEnter);
  $editEnd.addEventListener("keydown", saveEditOnEnter);
  $newTimerToggle.addEventListener("click", toggleNewTimer);
  $("#startButton").addEventListener("click", (event) => runPopupAction("start-timer", startTimer, { button: event.currentTarget }));
  $("#stopButton").addEventListener("click", (event) => runPopupAction("stop-timer", stopTimer, {
    button: event.currentTarget,
    expectedRevision: activeEntries[0]?.revision
  }));
  $activePanel.addEventListener("click", editActiveTimer);
  $activePanel.addEventListener("keydown", editActiveTimerFromKeyboard);
  $("#headerSyncButton").addEventListener("click", (event) => runPopupAction("sync", () => runSync({ force: true }), { button: event.currentTarget }));
  $loadMoreRecent.addEventListener("click", () => {
    recentWeekCount += 1;
    render().catch((error) => {
      setStatus($syncStatus, "error", formatError(error));
    });
  });
  $("#openCalendar").addEventListener("click", () => platform.openExtensionPage("calendar/calendar.html").catch((error) => setStatus($syncStatus, "error", formatError(error))));
  $("#openReconcile").addEventListener("click", () => platform.openExtensionPage("reconcile/reconcile.html").catch((error) => setStatus($syncStatus, "error", formatError(error))));
  $("#openCodexUsage").addEventListener("click", () => platform.openExtensionPage("usage/usage.html").catch((error) => setStatus($syncStatus, "error", formatError(error))));
  $windowSizePresets.addEventListener("click", (event) => {
    const button = event.target.closest("[data-window-width]");
    if (!button) return;
    runPopupAction(`resize-window:${button.dataset.windowWidth}x${button.dataset.windowHeight}:${button.dataset.windowMode}`, () => (
      resizeBrowserWindow(
        Number(button.dataset.windowWidth),
        Number(button.dataset.windowHeight),
        button.dataset.windowMode === "true"
      )
    ), { button });
  });
  $("#editWindowSizes").addEventListener("click", () => setWindowSizeEditorOpen(!windowSizeEditorOpen));
  $("#addWindowSize").addEventListener("click", () => {
    editingWindowSizes = readWindowSizeEditor();
    editingWindowSizes.push({ width: 1280, height: 720, isWindow: false });
    renderWindowSizeEditor();
  });
  $windowSizeFields.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-window-size]");
    if (!remove) return;
    editingWindowSizes = readWindowSizeEditor();
    editingWindowSizes.splice(Number(remove.dataset.removeWindowSize), 1);
    renderWindowSizeEditor();
  });
  $("#saveWindowSizes").addEventListener("click", (event) => runPopupAction("save-window-sizes", saveWindowSizes, { button: event.currentTarget }));
  $("#cancelWindowSizes").addEventListener("click", () => setWindowSizeEditorOpen(false));
  $chatGptUsageValues.addEventListener("click", (event) => {
    if (event.target.closest(".chatgpt-usage-value")) {
      platform.openExtensionPage("usage/usage.html").catch((error) => setStatus($syncStatus, "error", formatError(error)));
    }
  });
  $("#openOptions").addEventListener("click", () => platform.openExtensionPage("options/options.html").catch((error) => setStatus($syncStatus, "error", formatError(error))));
  $("#saveEdit").addEventListener("click", (event) => runPopupAction(`save-entry:${editingId}`, saveEdit, {
    button: event.currentTarget,
    expectedRevision: editingRevision
  }));
  $("#mergeEdit").addEventListener("click", (event) => runPopupAction(`merge-entry:${editingId}`, mergeEdit, {
    button: event.currentTarget,
    expectedRevision: editingRevision
  }));
  $("#cancelEdit").addEventListener("click", hideEdit);
  $("#deleteEdit").addEventListener("click", (event) => runPopupAction(`delete-entry:${editingId}`, deleteEdit, {
    button: event.currentTarget,
    expectedRevision: editingRevision
  }));
  $recentEntries.addEventListener("click", (event) => {
    const groupButton = event.target.closest("[data-toggle-group]");
    if (groupButton) {
      const key = groupButton.dataset.toggleGroup;
      const expanded = expandedRecentGroups.has(key);
      if (expanded) {
        expandedRecentGroups.delete(key);
      } else {
        expandedRecentGroups.add(key);
      }
      const instances = groupButton.closest(".timer-group")?.querySelector(".timer-instances");
      if (instances) {
        instances.classList.toggle("hidden");
        groupButton.setAttribute("aria-expanded", String(!expanded));
      }
      return;
    }

    const restartButton = event.target.closest("[data-restart-id]");
    if (restartButton) {
      runPopupAction(`restart-entry:${restartButton.dataset.restartId}`, () => restartFromEntry(restartButton.dataset.restartId), {
        button: restartButton
      });
      return;
    }

    const row = event.target.closest(".entry-row[data-edit-id]");
    if (row) {
      showEdit(row.dataset.editId).catch((error) => setStatus($syncStatus, "error", formatError(error)));
    }
  });
  $recentEntries.addEventListener("keydown", (event) => {
    if (event.target.closest("button")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest(".entry-row[data-edit-id]");
    if (!row) return;
    event.preventDefault();
    showEdit(row.dataset.editId).catch((error) => setStatus($syncStatus, "error", formatError(error)));
  });
}

async function init() {
  bindEvents();
  await loadWindowSizes();
  if (!unsubscribeEntryEvents) {
    unsubscribeEntryEvents = onEntriesChanged(() => {
      void runPageTask({
        page: "popup",
        phase: "entries-changed",
        task: render,
        onError(error) {
          setStatus($syncStatus, "error", formatError(error));
        }
      });
    });
  }
  await render();
  // Periodic syncing belongs to the background alarm; its notifyEntriesChanged
  // broadcast re-renders this popup, so no local poller is needed.
  await runSync({ force: false });
  await render();
  if (!ticker) {
    ticker = setInterval(() => {
      void runPageTask({
        page: "popup",
        phase: "elapsed-tick",
        task: updateElapsed,
        onError(error) {
          setStatus($syncStatus, "error", formatError(error));
        }
      });
    }, 1000);
  }
}

window.addEventListener("pagehide", () => {
  if (ticker) clearInterval(ticker);
  if (unsubscribeEntryEvents) unsubscribeEntryEvents();
});

startPage({ page: "popup", title: "Time Logger", init });

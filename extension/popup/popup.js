import { getActiveEntries, getDirtyEntryCount, getEntriesIntersecting, getEntry, getSetting, getVisibleEntries, setSetting } from "../src/db.js";
import { runAction } from "../src/action-runner.js";
import {
  CHATGPT_HOST_PERMISSION,
  CHATGPT_SESSION_TOKEN_CONSENT_KEY,
  getChatGptUsageState,
  refreshChatGptUsage
} from "../src/chatgpt-usage-service.js";
import { canMergeEntries, deletionUndoToken, entryUpdateUndoToken, hasMultiplier, mergeEntries, mergeEntryPreview, replaceActiveTimer, softDeleteEntry, stopEntry, undoDeletedEntry, undoEntryUpdate, updateEntry } from "../src/entries.js";
import { readEntryForm, writeEntryForm } from "../src/entry-form.js";
import { mountEntryEditor, setEntryEditorMergeAvailability } from "../src/entry-editor.js";
import { activeTimerState, activeTimerWarningState } from "../src/popup-active-state.js";
import { onEntriesChanged } from "../src/events.js";
import {
  requestBackgroundSync,
  UPDATE_CHECK_MESSAGE,
  UPDATE_INSTALL_MESSAGE
} from "../src/sync-request.js";
import { filterRecentEntries, groupRecentEntries, recentFieldValues, recentTotalSeconds } from "../src/popup-recent-groups.js";
import { createWindowSizeController } from "./window-size-controller.js";
import {
  addDays,
  bindMinuteRollover,
  durationSeconds,
  formatElapsed,
  localTime,
  shortDateTime,
  startOfLocalWeek
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
import { formatUsageCountdown, usageSnapshotIsStale } from "../src/usage-presentation.js";
import { formatSyncContext, readSyncStatus } from "../src/sync-status.js";

const entryEditor = mountEntryEditor(document.getElementById("popupEntryEditor"), {
  variant: "popup"
});

let activeEntries = [];
let editorSession = null;
let editorToken = 0;
let ticker = null;
let unsubscribeEntryEvents = null;
let eventsBound = false;
const expandedRecentGroups = new Set();
let recentWeekCount = 1;
let recentAnchorWeek = null;
let recentEntries = [];
let renderGeneration = 0;
let usageCountdownTimer = null;
let lastEntryUndo = null;
let pendingEditorPreview = null;

const $activePanel = $(".active-panel");
const $activeTitle = $("#activeTitle");
const $activeDescription = $("#activeDescription");
const $elapsed = $("#elapsed");
const $stopButton = $("#stopButton");
const $activeWarning = $("#activeWarning");
const $updateNotice = $("#updateNotice");
const $installUpdate = $("#installUpdate");
const $recentEntries = $("#recentEntries");
const $loadMoreRecent = $("#loadMoreRecent");
const $recentControls = $("#recentControls");
const $toggleRecentControls = $("#toggleRecentControls");
const $recentDate = $("#recentDate");
const $jumpRecentDate = $("#jumpRecentDate");
const $currentRecentWeek = $("#currentRecentWeek");
const $recentTextFilter = $("#recentTextFilter");
const $recentProjectFilter = $("#recentProjectFilter");
const $recentTaskFilter = $("#recentTaskFilter");
const $recentReviewFilter = $("#recentReviewFilter");
const $recentProjects = $("#recentProjects");
const $recentTasks = $("#recentTasks");
const $recentRangeLabel = $("#recentRangeLabel");
const $recentTotals = $("#recentTotals");
const $dirtyBadge = $("#dirtyBadge");
const $undoDeleteButton = $("#undoDeleteButton");
const $syncStatus = $("#syncStatus");
const $brandRow = $(".brand-row");
const $statusRow = $(".status-row");
const $editPanel = $("#editPanel");
const $editProjectDot = $("#editProjectDot");
const $editProject = entryEditor.fields.project;
const $editStart = entryEditor.fields.start;
const $editEnd = entryEditor.fields.end;
const $mergeTarget = entryEditor.merge.target;
const $mergeEdit = entryEditor.merge.button;
const $mergeTools = entryEditor.merge.control;
const $editorPreview = entryEditor.preview;
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
const windowSizeController = createWindowSizeController({
  presets: $windowSizePresets,
  editor: $windowSizeEditor,
  fields: $windowSizeFields,
  getSetting,
  setSetting,
  settingKey: SETTING_KEY.WINDOW_RESIZE_PRESETS,
  platform,
  onError: (error) => setSyncStatus("error", formatError(error))
});

function setSyncStatus(status, detail = "") {
  setStatus($syncStatus, status, detail);
  if (detail) $syncStatus.title = detail;
  if (status === "synced" || status === "pending") {
    $brandRow.append($syncStatus);
    return;
  }
  $statusRow.insertBefore($syncStatus, $dirtyBadge);
}

function formFields() {
  return {
    project: $("#project").value.trim(),
    task: $("#task").value.trim(),
    description: $("#description").value.trim(),
    multiply: $("#multiply").checked
  };
}

function editFields() {
  return entryEditor.fields;
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

function tickElapsed(latest) {
  $elapsed.textContent = formatElapsed(durationSeconds(latest.start_at));
}

function renderActiveState(latest) {
  const state = activeTimerState(latest, {
    elapsed: latest ? formatElapsed(durationSeconds(latest.start_at)) : "00:00:00",
    newTimerOpen: $newTimerToggle.getAttribute("aria-expanded") === "true",
    label: latest ? entryTitle(latest) : "timer"
  });
  $activeTitle.textContent = state.title;
  $activeDescription.textContent = state.description;
  $activeDescription.title = state.description;
  $elapsed.textContent = state.elapsed;
  $stopButton.classList.toggle("hidden", !state.stopVisible);
  $activePanel.classList.toggle("is-running", state.running);
  $activePanel.tabIndex = 0;
  $activePanel.setAttribute("role", "button");
  $activePanel.setAttribute("aria-label", state.ariaLabel);
  if (state.running) setNewTimerOpen(false);
}

function renderActiveWarning() {
  const warnings = activeTimerWarningState(activeEntries);
  const stale = warnings.filter(({ stale: isStale }) => isStale);
  if (activeEntries.length < 2 && !stale.length) {
    $activeWarning.classList.add("hidden");
    $activeWarning.replaceChildren();
    return;
  }

  $activeWarning.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = stale.length
    ? "Review an old active timer"
    : "Multiple active timers need review";
  $activeWarning.append(heading);
  const intro = document.createElement("p");
  intro.textContent = stale.length
    ? "This timer has been running unusually long. Edit its recorded times or stop it when you are ready."
    : "Each timer remains active until you explicitly edit or stop it.";
  $activeWarning.append(intro);

  const list = document.createElement("div");
  list.className = "active-warning-list";
  for (const { entry, elapsedSeconds, stale: isStale } of warnings) {
    const item = document.createElement("div");
    item.className = "active-warning-item";
    const details = document.createElement("div");
    details.className = "active-warning-details";
    const title = document.createElement("strong");
    title.textContent = entryTitle(entry);
    const metadata = document.createElement("span");
    metadata.textContent = `${shortDateTime(entry.start_at) || "Unknown start"} · ${entry.device_id || "Unknown device"}${isStale ? ` · ${formatElapsed(elapsedSeconds)} active` : ""}`;
    details.append(title, metadata);
    const actions = document.createElement("div");
    actions.className = "active-warning-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.dataset.warningEditId = entry.id;
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", `Edit active timer ${entryTitle(entry)}`);
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "danger";
    stop.dataset.warningStopId = entry.id;
    stop.dataset.expectedRevision = String(entry.revision || 0);
    stop.textContent = "Stop";
    stop.setAttribute("aria-label", `Stop active timer ${entryTitle(entry)}`);
    actions.append(edit, stop);
    item.append(details, actions);
    list.append(item);
  }
  $activeWarning.append(list);
  $activeWarning.classList.remove("hidden");
}

function updateElapsed() {
  if (!activeEntries[0]) return;
  tickElapsed(activeEntries[0]);
}

function startElapsedTicker() {
  if (ticker || !activeEntries[0]) return;
  ticker = setInterval(() => {
    void runPageTask({
      page: "popup",
      phase: "elapsed-tick",
      task: updateElapsed,
      onError(error) {
        setSyncStatus("error", formatError(error));
      }
    });
  }, 1000);
}

function stopElapsedTicker() {
  if (!ticker) return;
  clearInterval(ticker);
  ticker = null;
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
  renderActiveState(activeEntries[0]);
  renderActiveWarning();
  if (activeEntries[0]) {
    startElapsedTicker();
  } else {
    stopElapsedTicker();
  }

  return true;
}

function recentWeekRange(weekCount) {
  const currentWeek = recentAnchorWeek || startOfLocalWeek(new Date());
  return {
    start: addDays(currentWeek, -7 * (weekCount - 1)),
    end: addDays(currentWeek, 7)
  };
}

function recentDateLabel(date) {
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function recentFilters() {
  return {
    text: $recentTextFilter.value,
    project: $recentProjectFilter.value,
    task: $recentTaskFilter.value,
    status: $recentReviewFilter.value
  };
}

function renderRecentControls(entries, filteredEntries, range) {
  $recentProjects.replaceChildren(...recentFieldValues(entries, "project").map((value) => {
    const option = document.createElement("option");
    option.value = value;
    return option;
  }));
  $recentTasks.replaceChildren(...recentFieldValues(entries, "task").map((value) => {
    const option = document.createElement("option");
    option.value = value;
    return option;
  }));
  const end = addDays(range.end, -1);
  $recentRangeLabel.textContent = `Loaded range: ${recentDateLabel(range.start)} – ${recentDateLabel(end)}. Filters apply only to this range.`;
  $recentTotals.textContent = `Period total: ${formatElapsed(recentTotalSeconds(entries, range))} · Filtered total: ${formatElapsed(recentTotalSeconds(filteredEntries, range))} · ${filteredEntries.length} of ${entries.length} entries`;
}

function recentFocusTarget() {
  const active = document.activeElement;
  if (!active || active === document.body) return null;
  return {
    id: active.id || "",
    editId: active.dataset.editId || "",
    toggleGroup: active.dataset.toggleGroup || ""
  };
}

function restoreRecentFocus(target) {
  if (!target) return;
  const element = target.id
    ? document.getElementById(target.id)
    : target.editId
      ? document.querySelector(`[data-edit-id="${CSS.escape(target.editId)}"]`)
      : target.toggleGroup
        ? document.querySelector(`[data-toggle-group="${CSS.escape(target.toggleGroup)}"]`)
        : null;
  if (element && typeof element.focus === "function") element.focus();
}

function weeksBeforeCurrentWeek(iso) {
  const entryWeek = startOfLocalWeek(new Date(iso));
  const currentWeek = startOfLocalWeek(new Date());
  const weeks = (currentWeek.getTime() - entryWeek.getTime()) / (7 * 24 * 60 * 60 * 1000);
  return Number.isFinite(weeks) ? Math.max(0, Math.round(weeks)) : 0;
}

async function renderRecent(isCurrent) {
  const focusTarget = recentFocusTarget();
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
  const filteredEntries = filterRecentEntries(entries, recentFilters());
  renderRecentControls(entries, filteredEntries, range);

  if (!filteredEntries.length) {
    const empty = document.createElement("p");
    empty.className = "entry-meta";
    empty.textContent = entries.length ? "No entries match the current filters in the loaded range." : "No entries in the loaded range.";
    $recentEntries.replaceChildren(empty);
    $loadMoreRecent.classList.toggle("hidden", !hasMore);
    $loadMoreRecent.textContent = hasMore ? "Load previous week" : "";
    restoreRecentFocus(focusTarget);
    return true;
  }

  const weekElements = groupRecentEntries(filteredEntries, range).map((week) => {
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
  restoreRecentFocus(focusTarget);

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

async function renderSyncContext(isCurrent) {
  try {
    const snapshot = await readSyncStatus();
    if (!isCurrent()) return false;
    $syncStatus.title = formatSyncContext(snapshot);
  } catch {
    if (!isCurrent()) return false;
    $syncStatus.title = "Sync freshness is unavailable; local entries remain the source of truth.";
  }
  return true;
}

function compactPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) return null;
  return `${Math.round(numeric * 10) / 10}%`;
}

async function loadWindowSizes() {
  await windowSizeController.load();
}

async function renderChatGptUsageSummary(isCurrent) {
  const { snapshot } = await getChatGptUsageState();
  if (!isCurrent()) return false;

  const windows = [
    { label: "5h", window: snapshot?.primary_window },
    { label: "Week", window: snapshot?.secondary_window }
  ].filter(({ window }) => compactPercent(window?.used_percent));
  $chatGptUsageSummary.classList.toggle("hidden", windows.length === 0);
  if (!windows.length) return true;

  const values = windows.map(({ label, window }) => {
    const used = compactPercent(window.used_percent);
    const remaining = compactPercent(window.remaining_percent) || "not provided";
    const nextRefresh = window.reset_at
      ? formatUsageCountdown(window.reset_at).replace(/^in\s+/, "")
      : "reset unavailable";
    const lastUpdate = shortDateTime(snapshot.collected_at) || "not available";
    const stale = usageSnapshotIsStale(snapshot);
    const detail = `${label} limit: ${used} used, ${remaining} remaining\nResets: ${nextRefresh}\nLast update: ${lastUpdate}${stale ? "\nStatus: stale" : ""}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chatgpt-usage-value";
    button.textContent = `${label} ${used} · ${nextRefresh}`;
    button.title = detail;
    button.setAttribute("aria-label", `Open ChatGPT usage limits. ${detail.replaceAll("\n", ". ")}`);
    return button;
  });
  $chatGptUsageValues.replaceChildren(...values);
  return true;
}

async function refreshChatGptUsageOnOpen() {
  const [consent, permitted] = await Promise.all([
    getSetting(CHATGPT_SESSION_TOKEN_CONSENT_KEY, false),
    platform.hasOptionalHostPermission(CHATGPT_HOST_PERMISSION)
  ]);
  if (!consent || !permitted) return;

  try {
    await refreshChatGptUsage();
  } catch {
    // Keep the last successful snapshot visible when a popup-open refresh fails.
  }
}

async function render() {
  const generation = ++renderGeneration;
  const isCurrent = () => generation === renderGeneration;
  if (!(await renderActive(isCurrent))) return;
  const updateVersion = await getSetting(SETTING_KEY.UPDATE_AVAILABLE_VERSION, "");
  if (!isCurrent()) return;
  $updateNotice.classList.toggle("hidden", !updateVersion);
  if (updateVersion) $installUpdate.textContent = `Update ${updateVersion} available — click to install`;
  if (!(await renderChatGptUsageSummary(isCurrent))) return;
  if (!(await renderDirtyBadge(isCurrent))) return;
  if (!(await renderSyncContext(isCurrent))) return;
  await renderRecent(isCurrent);
}

async function runSync({ force = false } = {}) {
  setSyncStatus("pending");
  try {
    const result = await requestBackgroundSync({ force });
    setSyncStatus(result.status, result.warning);
  } catch (error) {
    setSyncStatus(statusFromError(error), formatError(error));
  }
}

function queueSync() {
  // The edit is already committed locally. Let the background keep the remote
  // sync alive if this short-lived popup closes before it completes.
  void runSync({ force: false });
}

async function syncAndCheckForUpdate() {
  await runSync({ force: true });
  await platform.sendRuntimeMessage({ type: UPDATE_CHECK_MESSAGE });
}

async function installUpdate() {
  $installUpdate.disabled = true;
  $installUpdate.textContent = "Installing update…";
  // The background context reloads as part of the install, so the popup may
  // not get another render cycle after the persisted marker is cleared by the
  // new background context. Hide the stale notice while that happens.
  $updateNotice.classList.add("hidden");

  try {
    const response = await platform.sendRuntimeMessage({ type: UPDATE_INSTALL_MESSAGE });
    if (!response?.ok) throw new Error("Update could not be installed");
    // onInstalled clears this in the background, but clear it here as well so
    // an already-open popup cannot keep displaying the old marker.
    await setSetting(SETTING_KEY.UPDATE_AVAILABLE_VERSION, "").catch(() => {});
  } catch {
    $updateNotice.classList.remove("hidden");
    $installUpdate.disabled = false;
    $installUpdate.textContent = "Update could not be installed — try again";
  }
}

function runPopupAction(key, action, { button = null, expectedRevision } = {}) {
  return runAction(key, action, {
    expectedRevision,
    setBusy(next) {
      if (button) button.disabled = next;
    },
    onError(error) {
      setSyncStatus("error", formatError(error));
    },
    onFinally() {
      return render().catch((error) => setSyncStatus("error", formatError(error)));
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

async function stopTimer(target) {
  if (!target?.id) return;
  await stopEntry(target.id, { expectedRevision: target.expectedRevision });
  queueSync();
}

async function showEdit(id) {
  const token = ++editorToken;
  const entry = await getEntry(id);
  if (!entry || token !== editorToken) return;
  const session = {
    token,
    id,
    revision: Number(entry.revision || 0),
    multiplyValue: entry.multiply || "",
    mergeTargetRevisions: new Map()
  };
  clearEditorPreview();
  editorSession = session;
  $editProjectDot.classList.toggle("hidden", !entry.project);
  $editProjectDot.style.setProperty("--project-color", projectColor(entry));
  writeEntryForm(editFields(), entry);
  renderMergeTargets(entry, recentEntries, session);
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
  showEdit(latest.id).catch((error) => setSyncStatus("error", formatError(error)));
}

function editActiveTimerFromKeyboard(event) {
  if (event.target !== event.currentTarget) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  editActiveTimer(event);
}

function hideEdit(session = editorSession) {
  if (session && editorSession !== session) return false;
  editorToken += 1;
  editorSession = null;
  clearEditorPreview();
  $mergeTarget.replaceChildren();
  $mergeEdit.disabled = true;
  setEntryEditorMergeAvailability($mergeTools, false);
  $editProjectDot.classList.add("hidden");
  $editPanel.classList.add("hidden");
  return true;
}

function clearEditorPreview() {
  pendingEditorPreview = null;
  $editorPreview.panel.hidden = true;
  $editorPreview.text.textContent = "";
  $mergeTarget.disabled = false;
}

function showEditorPreview(text, action) {
  pendingEditorPreview = action;
  $editorPreview.text.textContent = text;
  $editorPreview.panel.hidden = false;
  $mergeTarget.disabled = true;
  $editorPreview.confirm.focus();
}

function editorConflictError() {
  const error = new Error("Entry changed in another window");
  error.code = "STORAGE_CONFLICT";
  return error;
}

function previewDuration(seconds) {
  return formatElapsed(Math.max(0, Number(seconds) || 0));
}

function mergePreviewText(target, source, preview) {
  const gap = preview.compactedGapSeconds
    ? ` The ${previewDuration(preview.compactedGapSeconds)} gap is compacted.`
    : " Any gap is compacted.";
  return `Merge ${entryTitle(target)} with ${entryTitle(source)}. Actual duration ${previewDuration(preview.actualSeconds)} (${previewDuration(preview.targetActualSeconds)} + ${previewDuration(preview.sourceActualSeconds)}); effective duration ${previewDuration(preview.effectiveSeconds)}. Result: ${preview.startAt} to ${preview.endAt}.${gap} Target multiplier ${preview.targetMultiply || "none"} and status ${preview.targetStatus} are retained; the source becomes a tombstone.`;
}

function renderMergeTargets(entry, entries, session) {
  const candidates = entries.filter((candidate) => canMergeEntries(entry, candidate));
  session.mergeTargetRevisions = new Map(candidates.map((candidate) => [candidate.id, Number(candidate.revision || 0)]));
  const options = candidates.map((candidate) => {
    const option = document.createElement("option");
    option.value = candidate.id;
    option.textContent = `${shortDateTime(candidate.start_at)} · ${formatElapsed(candidate.duration_seconds || durationSeconds(candidate.start_at, candidate.end_at))}`;
    return option;
  });
  $mergeTarget.replaceChildren(...options);
  $mergeEdit.disabled = !candidates.length;
  setEntryEditorMergeAvailability($mergeTools, candidates.length > 0);
}

async function saveEdit() {
  const session = editorSession;
  if (!session) return;
  try {
    const before = await getEntry(session.id);
    if (!before || Number(before.revision || 0) !== session.revision) throw editorConflictError();
    const updated = await updateEntry(
      session.id,
      readEntryForm(editFields(), { multiplyValue: session.multiplyValue }),
      { expectedRevision: session.revision }
    );
    lastEntryUndo = { kind: "update", ...entryUpdateUndoToken(before, updated) };
    $undoDeleteButton.textContent = "Undo change";
    $undoDeleteButton.hidden = false;
    if (editorSession === session) hideEdit(session);
    queueSync();
  } catch (error) {
    if (error.code === "STORAGE_CONFLICT" && editorSession === session) hideEdit(session);
    throw error;
  }
}

function saveEditOnEnter(event) {
  if (event.key !== "Enter" || event.isComposing || event.repeat) return;
  event.preventDefault();
  const session = editorSession;
  runPopupAction(`save-entry:${session?.id || "none"}:${session?.token || 0}`, saveEdit, { expectedRevision: session?.revision });
}

async function deleteEdit() {
  const session = editorSession;
  if (!session) return;
  if (!confirm("Delete this time log entry?")) return;
  try {
    const deleted = await softDeleteEntry(session.id, { expectedRevision: session.revision });
    lastEntryUndo = { kind: "deletion", ...deletionUndoToken(deleted) };
    $undoDeleteButton.textContent = "Undo deletion";
    $undoDeleteButton.hidden = false;
    if (editorSession === session) hideEdit(session);
    queueSync();
  } catch (error) {
    if (error.code === "STORAGE_CONFLICT" && editorSession === session) hideEdit(session);
    throw error;
  }
}

async function undoDeletion() {
  const undo = lastEntryUndo;
  if (!undo) return;
  lastEntryUndo = null;
  $undoDeleteButton.hidden = true;
  if (undo.kind === "deletion") {
    await undoDeletedEntry(undo.id, undo);
    setSyncStatus("synced", "Deletion undone");
  } else {
    await undoEntryUpdate(undo);
    setSyncStatus("synced", "Change undone");
  }
  queueSync();
}

async function mergeEdit() {
  const session = editorSession;
  if (!session) return;
  const sourceId = $mergeTarget.value;
  if (!sourceId) return;
  const target = await getEntry(session.id);
  const source = await getEntry(sourceId);
  if (!target || !source || target.revision !== session.revision
    || source.revision !== session.mergeTargetRevisions.get(sourceId)) throw editorConflictError();
  const preview = mergeEntryPreview(target, source);
  showEditorPreview(mergePreviewText(target, source, preview), {
    kind: "merge",
    sessionToken: session.token,
    targetId: session.id,
    sourceId,
    expectedTargetRevision: session.revision,
    expectedSourceRevision: source.revision
  });
}

async function confirmEditorPreview() {
  const pending = pendingEditorPreview;
  const session = editorSession;
  if (!pending || !session || pending.sessionToken !== session.token) {
    clearEditorPreview();
    throw editorConflictError();
  }
  if (pending.kind === "merge") {
    await mergeEntries(pending.targetId, pending.sourceId, {
      expectedRevisions: {
        [pending.targetId]: pending.expectedTargetRevision,
        [pending.sourceId]: pending.expectedSourceRevision
      }
    });
    hideEdit(session);
    setSyncStatus("synced", "Entries merged");
    queueSync();
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
  $("#stopButton").addEventListener("click", (event) => {
    const latest = activeEntries[0];
    const target = latest
      ? Object.freeze({ id: latest.id, expectedRevision: latest.revision })
      : null;
    return runPopupAction(`stop-timer:${target?.id || "none"}`, () => stopTimer(target), {
      button: event.currentTarget,
      expectedRevision: target?.expectedRevision
    });
  });
  $activeWarning.addEventListener("click", (event) => {
    const edit = event.target.closest("[data-warning-edit-id]");
    if (edit) {
      showEdit(edit.dataset.warningEditId).catch((error) => setSyncStatus("error", formatError(error)));
      return;
    }
    const stop = event.target.closest("[data-warning-stop-id]");
    if (!stop) return;
    const target = activeEntries.find((entry) => entry.id === stop.dataset.warningStopId);
    if (!target) return;
    runPopupAction(`stop-timer:${target.id}`, () => stopTimer({ id: target.id, expectedRevision: target.revision }), {
      button: stop,
      expectedRevision: target.revision
    });
  });
  $activePanel.addEventListener("click", editActiveTimer);
  $activePanel.addEventListener("keydown", editActiveTimerFromKeyboard);
  $("#headerSyncButton").addEventListener("click", (event) => runPopupAction("sync", syncAndCheckForUpdate, { button: event.currentTarget }));
  $undoDeleteButton.addEventListener("click", (event) => runPopupAction(`undo-entry:${lastEntryUndo?.id || "none"}`, undoDeletion, { button: event.currentTarget }));
  $installUpdate.addEventListener("click", () => void installUpdate());
  $loadMoreRecent.addEventListener("click", () => {
    recentWeekCount += 1;
    render().catch((error) => {
      setSyncStatus("error", formatError(error));
    });
  });
  const rerenderRecent = () => {
    render().catch((error) => setSyncStatus("error", formatError(error)));
  };
  [$recentTextFilter, $recentProjectFilter, $recentTaskFilter, $recentReviewFilter].forEach((control) => {
    control.addEventListener(control === $recentReviewFilter ? "change" : "input", rerenderRecent);
  });
  $jumpRecentDate.addEventListener("click", () => {
    const date = new Date(`${$recentDate.value}T12:00:00`);
    if (!$recentDate.value || Number.isNaN(date.getTime())) {
      setSyncStatus("error", "Choose a valid date to show its week.");
      return;
    }
    recentAnchorWeek = startOfLocalWeek(date);
    recentWeekCount = 1;
    expandedRecentGroups.clear();
    rerenderRecent();
  });
  $currentRecentWeek.addEventListener("click", () => {
    recentAnchorWeek = null;
    recentWeekCount = 1;
    $recentDate.value = "";
    expandedRecentGroups.clear();
    rerenderRecent();
  });
  $toggleRecentControls.addEventListener("click", () => {
    const expanded = $recentControls.hidden;
    $recentControls.hidden = !expanded;
    $toggleRecentControls.setAttribute("aria-expanded", String(expanded));
    $toggleRecentControls.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} history filters`);
    $toggleRecentControls.title = `${expanded ? "Hide" : "Show"} history filters`;
    if (expanded) $recentTextFilter.focus();
  });
  $("#openAnalytics").addEventListener("click", () => platform.openExtensionPage("analytics/analytics.html").catch((error) => setSyncStatus("error", formatError(error))));
  $("#openCalendar").addEventListener("click", () => platform.openExtensionPage("calendar/calendar.html").catch((error) => setSyncStatus("error", formatError(error))));
  $windowSizePresets.addEventListener("click", (event) => {
    const button = event.target.closest("[data-window-width]");
    if (!button) return;
    runPopupAction(`resize-window:${button.dataset.windowWidth}x${button.dataset.windowHeight}:${button.dataset.windowMode}`, () => (
      windowSizeController.resize({
        width: Number(button.dataset.windowWidth),
        height: Number(button.dataset.windowHeight),
        isWindow: button.dataset.windowMode === "true"
      })
    ), { button });
  });
  $("#editWindowSizes").addEventListener("click", () => windowSizeController.setOpen(!windowSizeController.isOpen));
  $("#addWindowSize").addEventListener("click", () => {
    windowSizeController.add();
  });
  $windowSizeFields.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-window-size]");
    if (!remove) return;
    windowSizeController.remove(remove.dataset.removeWindowSize);
  });
  $("#saveWindowSizes").addEventListener("click", (event) => runPopupAction("save-window-sizes", () => windowSizeController.save(), { button: event.currentTarget }));
  $("#cancelWindowSizes").addEventListener("click", () => windowSizeController.setOpen(false));
  $chatGptUsageValues.addEventListener("click", (event) => {
    if (event.target.closest(".chatgpt-usage-value")) {
      platform.openExtensionPage("options/options.html#chatgpt-usage").catch((error) => setSyncStatus("error", formatError(error)));
    }
  });
  $("#openOptions").addEventListener("click", () => platform.openExtensionPage("options/options.html").catch((error) => setSyncStatus("error", formatError(error))));
  entryEditor.actions.save.addEventListener("click", (event) => runPopupAction(`save-entry:${editorSession?.id || "none"}:${editorSession?.token || 0}`, saveEdit, {
    button: event.currentTarget,
    expectedRevision: editorSession?.revision
  }));
  entryEditor.merge.button.addEventListener("click", (event) => runPopupAction(`merge-entry:${editorSession?.id || "none"}:${editorSession?.token || 0}`, mergeEdit, {
    button: event.currentTarget,
    expectedRevision: editorSession?.revision
  }));
  entryEditor.preview.confirm.addEventListener("click", (event) => runPopupAction(`confirm-entry-preview:${editorSession?.id || "none"}:${editorSession?.token || 0}`, confirmEditorPreview, {
    button: event.currentTarget,
    expectedRevision: editorSession?.revision
  }));
  entryEditor.preview.cancel.addEventListener("click", clearEditorPreview);
  entryEditor.actions.cancel.addEventListener("click", () => hideEdit());
  entryEditor.actions.delete.addEventListener("click", (event) => runPopupAction(`delete-entry:${editorSession?.id || "none"}:${editorSession?.token || 0}`, deleteEdit, {
    button: event.currentTarget,
    expectedRevision: editorSession?.revision
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
      showEdit(row.dataset.editId).catch((error) => setSyncStatus("error", formatError(error)));
    }
  });
  $recentEntries.addEventListener("keydown", (event) => {
    if (event.target.closest("button")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest(".entry-row[data-edit-id]");
    if (!row) return;
    event.preventDefault();
    showEdit(row.dataset.editId).catch((error) => setSyncStatus("error", formatError(error)));
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
          setSyncStatus("error", formatError(error));
        }
      });
    });
  }
  await render();
  usageCountdownTimer = setInterval(() => {
    void renderChatGptUsageSummary(() => true);
  }, 30_000);
  void runPageTask({
    page: "popup",
    phase: "chatgpt-usage-refresh",
    task: async () => {
      await refreshChatGptUsageOnOpen();
      await render();
    }
  });
  // Periodic syncing belongs to the background alarm; its notifyEntriesChanged
  // broadcast re-renders this popup, so no local poller is needed.
  await runSync({ force: false });
  await render();
}

window.addEventListener("pagehide", () => {
  stopElapsedTicker();
  if (usageCountdownTimer) clearInterval(usageCountdownTimer);
  usageCountdownTimer = null;
  if (unsubscribeEntryEvents) unsubscribeEntryEvents();
});

startPage({ page: "popup", title: "Time Logger", init });

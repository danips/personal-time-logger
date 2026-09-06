import { getActiveEntries, getDirtyEntryCount, getEntriesIntersecting, getEntry, getSetting, getVisibleEntries, setSetting } from "../src/db.js";
import { runAction } from "../src/action-runner.js";
import {
  CHATGPT_HOST_PERMISSION,
  CHATGPT_SESSION_TOKEN_CONSENT_KEY,
  getChatGptUsageState,
  refreshChatGptUsage
} from "../src/chatgpt-usage-service.js";
import { canMergeEntries, hasMultiplier, mergeEntries, replaceActiveTimer, softDeleteEntry, stopEntry, updateEntry } from "../src/entries.js";
import { readEntryForm, writeEntryForm } from "../src/entry-form.js";
import { mountEntryEditor, setEntryEditorMergeAvailability } from "../src/entry-editor.js";
import { activeTimerState, elapsedTimerState } from "../src/popup-active-state.js";
import { onEntriesChanged } from "../src/events.js";
import {
  requestBackgroundSync,
  UPDATE_CHECK_MESSAGE,
  UPDATE_INSTALL_MESSAGE
} from "../src/sync-request.js";
import { groupRecentEntries } from "../src/popup-recent-groups.js";
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
let renderGeneration = 0;

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
const $dirtyBadge = $("#dirtyBadge");
const $syncStatus = $("#syncStatus");
const $brandRow = $(".brand-row");
const $statusRow = $(".status-row");
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
  $elapsed.textContent = elapsedTimerState(
    latest,
    latest ? formatElapsed(durationSeconds(latest.start_at)) : "00:00:00"
  ).elapsed;
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
  if (activeEntries[0]) {
    startElapsedTicker();
  } else {
    stopElapsedTicker();
  }

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

async function loadWindowSizes() {
  await windowSizeController.load();
}

async function renderChatGptUsageSummary(isCurrent) {
  const { snapshot } = await getChatGptUsageState();
  if (!isCurrent()) return false;

  const windows = [
    { label: "5h", window: snapshot?.primary_window },
    { label: "Week", window: snapshot?.secondary_window }
  ].filter(({ window }) => compactPercent(window?.remaining_percent));
  $chatGptUsageSummary.classList.toggle("hidden", windows.length === 0);
  if (!windows.length) return true;

  const values = windows.map(({ label, window }) => {
    const remaining = compactPercent(window.remaining_percent);
    const nextRefresh = shortDateTime(window.reset_at) || "not provided";
    const lastUpdate = shortDateTime(snapshot.collected_at) || "not available";
    const detail = `${label} limit: ${remaining} remaining\nResets: ${nextRefresh}\nLast update: ${lastUpdate}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chatgpt-usage-value";
    button.textContent = `${label} ${remaining}`;
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
  showEdit(latest.id).catch((error) => setSyncStatus("error", formatError(error)));
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
  setEntryEditorMergeAvailability($mergeTools, false);
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
  setEntryEditorMergeAvailability($mergeTools, candidates.length > 0);
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
  $activePanel.addEventListener("click", editActiveTimer);
  $activePanel.addEventListener("keydown", editActiveTimerFromKeyboard);
  $("#headerSyncButton").addEventListener("click", (event) => runPopupAction("sync", syncAndCheckForUpdate, { button: event.currentTarget }));
  $installUpdate.addEventListener("click", () => void installUpdate());
  $loadMoreRecent.addEventListener("click", () => {
    recentWeekCount += 1;
    render().catch((error) => {
      setSyncStatus("error", formatError(error));
    });
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
  if (unsubscribeEntryEvents) unsubscribeEntryEvents();
});

startPage({ page: "popup", title: "Time Logger", init });

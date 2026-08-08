import { getActiveEntries, getDirtyEntries, getVisibleEntries } from "../src/db.js";
import { getChatGptAccounts } from "../src/chatgpt-containers.js";
import { canMergeEntries, createEntry, hasMultiplier, mergeEntries, softDeleteEntry, stopEntry, updateEntry } from "../src/entries.js";
import { readEntryForm, writeEntryForm } from "../src/entry-form.js";
import { onEntriesChanged } from "../src/events.js";
import { syncNow } from "../src/sync.js";
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
import { setActiveIcon } from "../src/icon.js";

let activeEntries = [];
let editingId = "";
let editingMultiplyValue = "";
let ticker = null;
let unsubscribeEntryEvents = null;
const expandedRecentGroups = new Set();
let recentWeekCount = 1;

const $activePanel = $(".active-panel");
const $activeDot = $("#activeProjectDot");
const $activeTitle = $("#activeTitle");
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
const $newTimerToggle = $("#newTimerToggle");
const $newTimerPanel = $("#newTimerPanel");
const $newTimerIcon = $(".new-timer-icon");
const $newTimerSection = $("#newTimerSection");
const $newTimerDivider = $("#newTimerDivider");
const $chatGptUsageSummary = $("#chatGptUsageSummary");
const $chatGptUsageValues = $("#chatGptUsageValues");

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

function groupRecentEntries(entries) {
  const weeks = [];
  const weekMap = new Map();
  const weekTotals = new Map();
  const dayTotals = new Map();

  for (const entry of entries) {
    const seconds = entryDuration(entry);
    const weekKey = weekInfo(entry.start_at).key;
    const dayKey = localDayKey(entry.start_at);
    weekTotals.set(weekKey, (weekTotals.get(weekKey) || 0) + seconds);
    dayTotals.set(dayKey, (dayTotals.get(dayKey) || 0) + seconds);
  }

  for (const entry of entries) {
    const weekSeed = weekInfo(entry.start_at);
    if (!weekMap.has(weekSeed.key)) {
      weekSeed.totalSeconds = weekTotals.get(weekSeed.key) || 0;
      weekMap.set(weekSeed.key, weekSeed);
      weeks.push(weekSeed);
    }

    const week = weekMap.get(weekSeed.key);

    const dayKey = localDayKey(entry.start_at);
    if (!week.dayMap.has(dayKey)) {
      const day = {
        key: dayKey,
        label: localDayLabel(entry.start_at),
        totalSeconds: dayTotals.get(dayKey) || 0,
        groups: [],
        groupMap: new Map()
      };
      week.dayMap.set(dayKey, day);
      week.days.push(day);
    }

    const day = week.dayMap.get(dayKey);

    const groupKey = recentGroupKey(entry);
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
    group.entries.push(entry);
    group.totalSeconds += entryDuration(entry);
  }

  for (const week of weeks) {
    delete week.dayMap;
    for (const day of week.days) {
      delete day.groupMap;
    }
  }

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
  $activeTitle.textContent = latest ? entryTitle(latest) : "No active timer";
  $elapsed.textContent = latest ? formatElapsed(durationSeconds(latest.start_at)) : "00:00:00";
  $stopButton.classList.toggle("hidden", !latest);
  $activePanel.classList.toggle("is-running", hasActive);
  $activePanel.tabIndex = 0;
  $activePanel.setAttribute("role", "button");
  $activePanel.setAttribute("aria-label", latest ? `Edit active timer ${entryTitle(latest)}` : "Start a new timer");
  $activeDot.classList.toggle("hidden", !latest);
  if (latest) $activeDot.style.setProperty("--project-color", projectColor(latest));
  if (hasActive) setNewTimerOpen(false);
  setActiveIcon(hasActive);
}

function setNewTimerOpen(open) {
  $newTimerSection.classList.toggle("hidden", !open);
  $newTimerDivider.classList.toggle("hidden", !open);
  $newTimerToggle.setAttribute("aria-expanded", open ? "true" : "false");
  $newTimerPanel.classList.toggle("hidden", !open);
  $newTimerIcon.textContent = open ? "-" : "+";
}

function toggleNewTimer() {
  setNewTimerOpen($newTimerToggle.getAttribute("aria-expanded") !== "true");
}

async function renderActive() {
  activeEntries = await getActiveEntries();
  updateElapsed();

  if (activeEntries.length > 1) {
    $activeWarning.textContent = `Warning: ${activeEntries.length} active timers exist. Older active entries are marked needs_review on sync.`;
    $activeWarning.classList.remove("hidden");
  } else {
    $activeWarning.classList.add("hidden");
  }
}

function weeksBefore(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 0;
  const entryWeek = startOfLocalWeek(date);
  const currentWeek = startOfLocalWeek(new Date());
  const weeks = (currentWeek.getTime() - entryWeek.getTime()) / (7 * 24 * 60 * 60 * 1000);
  return Math.max(0, Math.round(weeks));
}

async function renderRecent() {
  const allEntries = await getVisibleEntries();
  const newest = allEntries.find((entry) => entry.start_at);
  if (newest) {
    // Entries are sorted newest first, so expand the window far enough back to
    // always show something when the current week is empty.
    recentWeekCount = Math.max(recentWeekCount, weeksBefore(newest.start_at) + 1);
  }
  const cutoff = addDays(startOfLocalWeek(new Date()), -7 * (recentWeekCount - 1));
  const cutoffStr = cutoff.toISOString();
  const entries = allEntries.filter((e) => e.start_at && e.start_at >= cutoffStr);
  // Undated entries can never come into view by widening the window, so they
  // must not keep the load-more button alive.
  const hiddenCount = allEntries.filter((e) => e.start_at && e.start_at < cutoffStr).length;

  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "entry-meta";
    empty.textContent = "No entries yet.";
    $recentEntries.replaceChildren(empty);
    $loadMoreRecent.classList.toggle("hidden", hiddenCount === 0);
    $loadMoreRecent.textContent = hiddenCount > 0 ? "Load more (previous week)" : "";
    return;
  }

  const weekElements = groupRecentEntries(entries).map((week) => {
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

  $loadMoreRecent.classList.toggle("hidden", hiddenCount === 0);
  $loadMoreRecent.textContent = hiddenCount > 0 ? "Load more (previous week)" : "";
}

async function renderDirtyBadge() {
  if (!$dirtyBadge) return;
  const count = (await getDirtyEntries()).length;
  const label = count > 99 ? "99+ pending" : `${count} pending`;
  $dirtyBadge.textContent = label;
  $dirtyBadge.title = `${count} unsynced local ${count === 1 ? "change" : "changes"}`;
  $dirtyBadge.classList.toggle("hidden", count === 0);
}

function compactPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) return null;
  return `${Math.round(numeric * 10) / 10}%`;
}

async function renderChatGptUsageSummary() {
  const summaries = (await getChatGptAccounts())
    .map((account) => ({
      label: account.email || account.label || "ChatGPT account",
      remaining: compactPercent(account.snapshot?.primary_window?.remaining_percent),
      resetAt: account.snapshot?.primary_window?.reset_at || "",
      collectedAt: account.snapshot?.collected_at || account.last_success_at || ""
    }))
    .filter((account) => account.remaining);

  $chatGptUsageSummary.classList.toggle("hidden", summaries.length === 0);
  if (!summaries.length) return;

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
}

async function render() {
  await renderActive();
  await renderChatGptUsageSummary();
  await renderDirtyBadge();
  await renderRecent();
}

async function runSync({ force = false } = {}) {
  setStatus($syncStatus, "pending");
  try {
    const result = await syncNow({ interactiveAuth: false, force });
    setStatus($syncStatus, result.status, result.warning);
  } catch (error) {
    setStatus($syncStatus, statusFromError(error), formatError(error));
  }
  await render();
}

async function stopRunningTimers() {
  // Starting a timer replaces the running one instead of leaving two active
  // entries for sync to flag as needing review.
  for (const entry of await getActiveEntries()) {
    await stopEntry(entry.id);
  }
}

async function startTimer() {
  await stopRunningTimers();
  await createEntry(formFields());
  setNewTimerOpen(false);
  await runSync({ force: false });
}

async function restartFromEntry(id) {
  const entry = (await getVisibleEntries()).find((item) => item.id === id);
  if (!entry) return;
  await stopRunningTimers();
  await createEntry({
    project: entry.project || "",
    task: entry.task || "",
    description: entry.description || "",
    multiply: entry.multiply ? true : false
  });
  hideEdit();
  await runSync({ force: false });
}

async function stopTimer() {
  const active = await getActiveEntries();
  if (!active.length) return;
  await stopEntry(active[0].id);
  await runSync({ force: false });
}

async function showEdit(id) {
  const entries = await getVisibleEntries();
  const entry = entries.find((item) => item.id === id);
  if (!entry) return;
  editingId = id;
  editingMultiplyValue = entry.multiply || "";
  $editProjectDot.classList.toggle("hidden", !entry.project);
  $editProjectDot.style.setProperty("--project-color", projectColor(entry));
  writeEntryForm(editFields(), entry);
  renderMergeTargets(entry, entries);
  setNewTimerOpen(false);
  $editPanel.classList.remove("hidden");
  $editProject.focus();
}

function editActiveTimer(event) {
  if (event && event.target.closest("#stopButton")) return;
  const latest = activeEntries[0];
  if (!latest) {
    setNewTimerOpen(true);
    $("#project").focus();
    return;
  }
  showEdit(latest.id);
}

function editActiveTimerFromKeyboard(event) {
  if (event.target !== event.currentTarget) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  editActiveTimer(event);
}

function hideEdit() {
  editingId = "";
  editingMultiplyValue = "";
  $mergeTarget.replaceChildren();
  $mergeEdit.disabled = true;
  $editProjectDot.classList.add("hidden");
  $editPanel.classList.add("hidden");
}

function renderMergeTargets(entry, entries) {
  const candidates = entries.filter((candidate) => canMergeEntries(entry, candidate));
  const options = candidates.map((candidate) => {
    const option = document.createElement("option");
    option.value = candidate.id;
    option.textContent = `${shortDateTime(candidate.start_at)} · ${formatElapsed(candidate.duration_seconds || durationSeconds(candidate.start_at, candidate.end_at))}`;
    return option;
  });
  if (!options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No matching completed entries";
    options.push(option);
  }
  $mergeTarget.replaceChildren(...options);
  $mergeEdit.disabled = !candidates.length;
}

async function saveEdit() {
  if (!editingId) return;
  await updateEntry(editingId, readEntryForm(editFields(), { multiplyValue: editingMultiplyValue }));
  hideEdit();
  await runSync({ force: false });
}

function saveEditOnEnter(event) {
  if (event.key !== "Enter" || event.isComposing || event.repeat) return;
  event.preventDefault();
  saveEdit();
}

async function deleteEdit() {
  if (!editingId) return;
  if (!confirm("Delete this time log entry?")) return;
  await softDeleteEntry(editingId);
  hideEdit();
  await runSync({ force: false });
}

async function mergeEdit() {
  if (!editingId) return;
  const sourceId = $mergeTarget.value;
  if (!sourceId) return;
  try {
    await mergeEntries(editingId, sourceId);
    hideEdit();
    await runSync({ force: false });
  } catch (error) {
    setStatus($syncStatus, "error", formatError(error));
  }
}

function bindEvents() {
  bindMinuteRollover($editStart);
  bindMinuteRollover($editEnd);
  $editStart.addEventListener("keydown", saveEditOnEnter);
  $editEnd.addEventListener("keydown", saveEditOnEnter);
  $newTimerToggle.addEventListener("click", toggleNewTimer);
  $("#startButton").addEventListener("click", startTimer);
  $("#stopButton").addEventListener("click", stopTimer);
  $activePanel.addEventListener("click", editActiveTimer);
  $activePanel.addEventListener("keydown", editActiveTimerFromKeyboard);
  $("#headerSyncButton").addEventListener("click", () => runSync({ force: true }));
  $loadMoreRecent.addEventListener("click", () => {
    recentWeekCount += 1;
    renderRecent().catch((error) => {
      setStatus($syncStatus, "error", formatError(error));
    });
  });
  $("#openCalendar").addEventListener("click", () => platform.openExtensionPage("calendar/calendar.html"));
  $("#openReconcile").addEventListener("click", () => platform.openExtensionPage("reconcile/reconcile.html"));
  $("#openCodexUsage").addEventListener("click", () => platform.openExtensionPage("usage/usage.html"));
  $chatGptUsageValues.addEventListener("click", (event) => {
    if (event.target.closest(".chatgpt-usage-value")) platform.openExtensionPage("usage/usage.html");
  });
  $("#openOptions").addEventListener("click", () => platform.openOptionsPage());
  $("#saveEdit").addEventListener("click", saveEdit);
  $("#mergeEdit").addEventListener("click", mergeEdit);
  $("#cancelEdit").addEventListener("click", hideEdit);
  $("#deleteEdit").addEventListener("click", deleteEdit);
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
      restartFromEntry(restartButton.dataset.restartId);
      return;
    }

    const row = event.target.closest(".entry-row[data-edit-id]");
    if (row) {
      showEdit(row.dataset.editId);
    }
  });
  $recentEntries.addEventListener("keydown", (event) => {
    if (event.target.closest("button")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest(".entry-row[data-edit-id]");
    if (!row) return;
    event.preventDefault();
    showEdit(row.dataset.editId);
  });
}

async function init() {
  bindEvents();
  unsubscribeEntryEvents = onEntriesChanged(() => {
    render().catch((error) => {
      setStatus($syncStatus, "error", formatError(error));
    });
  });
  await render();
  // Periodic syncing belongs to the background alarm; its notifyEntriesChanged
  // broadcast re-renders this popup, so no local poller is needed.
  await runSync({ force: false });
  ticker = setInterval(updateElapsed, 1000);
}

window.addEventListener("pagehide", () => {
  if (ticker) clearInterval(ticker);
  if (unsubscribeEntryEvents) unsubscribeEntryEvents();
});

init();

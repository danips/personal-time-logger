import { getActiveEntries, getAllEntries, getDirtyEntries, getSetting, getVisibleEntries } from "../src/db.js";
import { canMergeEntries, createEntry, hasMultiplier, mergeEntries, softDeleteEntry, stopEntry, updateEntry } from "../src/entries.js";
import { downloadCsv } from "../src/csv.js";
import { onEntriesChanged } from "../src/events.js";
import { syncNow } from "../src/sync.js";
import {
  addDays,
  bindMinuteRollover,
  durationSeconds,
  formatElapsed,
  fromLocalInputValue,
  localTime,
  shortDateTime,
  startOfLocalDay,
  startOfLocalWeek,
  toLocalInputValue
} from "../src/time.js";
import {
  $,
  entryTitle,
  escapeHtml,
  formatError,
  projectColor,
  setStatus,
  statusFromError
} from "../src/ui-helpers.js";
import { platform } from "../src/platform.js";

let activeEntries = [];
let editingId = "";
let editingMultiplyValue = "";
let ticker = null;
let poller = null;
let unsubscribeEntryEvents = null;
const expandedRecentGroups = new Set();
const RECENT_PAGE_SIZE = 10;
let recentLimit = RECENT_PAGE_SIZE;

function formFields() {
  return {
    client: "",
    project: $("#project").value.trim(),
    task: $("#task").value.trim(),
    description: $("#description").value.trim(),
    billable: $("#billable").checked,
    multiply: $("#multiply").checked,
    tags: ""
  };
}

function entryDetails(entry) {
  return [entry.task, entry.description].filter(Boolean).join(" - ") || "No task or description";
}

function entryDuration(entry) {
  return Number(entry.duration_seconds) || durationSeconds(entry.start_at, entry.end_at || undefined);
}

function projectDot(entry) {
  return `<span class="project-dot" style="--project-color: ${projectColor(entry)}" aria-hidden="true"></span>`;
}

function entryChips(entry, { includeMultiply = true } = {}) {
  const chips = [];
  if (entry.billable) chips.push("Billable");
  if (includeMultiply && hasMultiplier(entry)) chips.push(`x${entry.multiply}`);
  if (entry.status === "needs_review") chips.push("Review");
  if (entry.dirty) chips.push("Pending");
  return chips;
}

function renderChips(chips) {
  if (!chips.length) return "";
  return `<div class="entry-chips">${chips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join("")}</div>`;
}

function groupChips(group) {
  const chips = new Set();
  for (const entry of group.entries) {
    for (const chip of entryChips(entry)) chips.add(chip);
  }
  return [...chips];
}

function localDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function localDayKey(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return localDateKey(date);
}

function localDayLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown day";
  return date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function shortMonthDay(date) {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
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
  let label = `${shortMonthDay(start)} - ${shortMonthDay(end)}`;
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
    entry.billable ? "1" : "0",
    entry.multiply || ""
  ].map((part) => encodeURIComponent(part)).join("|");
}

function groupRecentEntries(entries, totalEntries = entries) {
  const weeks = [];
  const weekMap = new Map();
  const weekTotals = new Map();
  const dayTotals = new Map();

  for (const entry of totalEntries) {
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
  const details = entryDetails(entry);
  const multiplier = hasMultiplier(entry) ? `x${entry.multiply}` : "";
  return `
    <article class="entry-row ${child ? "entry-row-child" : ""} ${entry.status === "needs_review" ? "needs-review" : ""}" data-edit-id="${escapeHtml(entry.id)}" role="button" tabindex="0" aria-label="Edit ${escapeHtml(entryTitle(entry))}">
      <div class="entry-main">
        <div class="entry-title">${projectDot(entry)}<span>${escapeHtml(entry.project || "Untitled project")}</span></div>
        <div class="entry-meta" title="${escapeHtml(details)}">${escapeHtml(details)}</div>
        <div class="entry-time-row">
          <span class="entry-meta">
            ${escapeHtml(localTime(entry.start_at))}
            ${entry.end_at ? ` - ${escapeHtml(localTime(entry.end_at))}` : " - active"}
          </span>
          <span class="entry-duration-col entry-time-duration">${escapeHtml(duration)}</span>
          ${multiplier ? `<span class="entry-multiplier">${escapeHtml(multiplier)}</span>` : ""}
        </div>
        ${renderChips(entryChips(entry, { includeMultiply: false }))}
      </div>
      <div class="entry-actions">
        <button class="play-button" type="button" data-restart-id="${escapeHtml(entry.id)}" title="Start from this entry" aria-label="Start from ${escapeHtml(entryTitle(entry))}">▶</button>
      </div>
    </article>
  `;
}

function renderRecentTimerGroup(group) {
  const [entry] = group.entries;
  if (group.entries.length === 1) return renderEntryRow(entry);

  const expanded = expandedRecentGroups.has(group.key);
  return `
    <section class="timer-group">
      <article class="entry-row timer-group-row ${entry.status === "needs_review" ? "needs-review" : ""}">
        <div class="entry-main">
          <div class="entry-title">${projectDot(entry)}<span>${escapeHtml(entry.project || "Untitled project")}</span></div>
          <div class="entry-meta">${escapeHtml(entryDetails(entry))}</div>
          ${renderChips(groupChips(group))}
        </div>
        <div class="entry-actions">
          <span class="entry-duration-col">${escapeHtml(formatElapsed(group.totalSeconds))}</span>
          <button class="count-button" type="button" data-toggle-group="${escapeHtml(group.key)}" aria-expanded="${expanded ? "true" : "false"}">
            ${group.entries.length}
          </button>
          <button class="play-button" type="button" data-restart-id="${escapeHtml(entry.id)}" title="Start from this group" aria-label="Start from ${escapeHtml(entryTitle(entry))}">▶</button>
        </div>
      </article>
      <div class="timer-instances ${expanded ? "" : "hidden"}">
        ${group.entries.map((item) => renderEntryRow(item, { child: true })).join("")}
      </div>
    </section>
  `;
}

function updateElapsed() {
  const latest = activeEntries[0];
  const activePanel = $(".active-panel");
  const dot = $("#activeProjectDot");
  $("#activeTitle").textContent = latest ? entryTitle(latest) : "No active timer";
  $("#elapsed").textContent = latest ? formatElapsed(durationSeconds(latest.start_at)) : "00:00:00";
  $("#stopButton").classList.toggle("hidden", !latest);
  activePanel.classList.toggle("is-running", Boolean(latest));
  dot.classList.toggle("hidden", !latest);
  if (latest) dot.style.setProperty("--project-color", projectColor(latest));
}

function setNewTimerOpen(open) {
  $("#newTimerToggle").setAttribute("aria-expanded", open ? "true" : "false");
  $("#newTimerPanel").classList.toggle("hidden", !open);
  $(".new-timer-icon").textContent = open ? "-" : "+";
}

function toggleNewTimer() {
  setNewTimerOpen($("#newTimerToggle").getAttribute("aria-expanded") !== "true");
}

async function renderActive() {
  activeEntries = await getActiveEntries();
  updateElapsed();

  const warning = $("#activeWarning");
  if (activeEntries.length > 1) {
    warning.textContent = `Warning: ${activeEntries.length} active timers exist. Older active entries are marked needs_review on sync.`;
    warning.classList.remove("hidden");
  } else {
    warning.classList.add("hidden");
  }
}

async function renderRecent() {
  const allEntries = await getVisibleEntries();
  const entries = allEntries.slice(0, recentLimit);
  const container = $("#recentEntries");
  const loadMore = $("#loadMoreRecent");

  if (!entries.length) {
    container.innerHTML = '<p class="entry-meta">No entries yet.</p>';
    loadMore.classList.add("hidden");
    return;
  }

  container.innerHTML = groupRecentEntries(entries, allEntries).map((week) => `
    <section class="week-group">
      <header class="week-group-header">
        <strong>${escapeHtml(week.label)}</strong>
        <span>${escapeHtml(formatElapsed(week.totalSeconds))}</span>
      </header>
      <div class="week-group-days">
        ${week.days.map((day) => `
          <section class="day-group">
            <header class="day-group-header">
              <strong>${escapeHtml(day.label)}</strong>
              <span>${escapeHtml(formatElapsed(day.totalSeconds))}</span>
            </header>
            <div class="day-group-entries">
              ${day.groups.map(renderRecentTimerGroup).join("")}
            </div>
          </section>
        `).join("")}
      </div>
    </section>
  `).join("");

  loadMore.classList.toggle("hidden", allEntries.length <= recentLimit);
  loadMore.textContent = `Load more (${Math.max(0, allEntries.length - recentLimit)} left)`;
}

async function renderDirtyBadge() {
  const badge = $("#dirtyBadge");
  if (!badge) return;

  const count = (await getDirtyEntries()).length;
  const label = count > 99 ? "99+ pending" : `${count} pending`;
  badge.textContent = label;
  badge.title = `${count} unsynced local ${count === 1 ? "change" : "changes"}`;
  badge.classList.toggle("hidden", count === 0);
}

async function render() {
  await renderActive();
  await renderDirtyBadge();
  await renderRecent();
}

async function runSync({ force = false } = {}) {
  const status = $("#syncStatus");
  setStatus(status, "pending");
  try {
    const result = await syncNow({ interactiveAuth: false, force });
    setStatus(status, result.status, result.warning);
  } catch (error) {
    setStatus(status, statusFromError(error), formatError(error));
  }
  await render();
}

async function startTimer() {
  await createEntry(formFields());
  setNewTimerOpen(false);
  await render();
  await runSync({ force: false });
}

async function restartFromEntry(id) {
  const entry = (await getVisibleEntries()).find((item) => item.id === id);
  if (!entry) return;
  await createEntry({
    client: "",
    project: entry.project || "",
    task: entry.task || "",
    description: entry.description || "",
    billable: Boolean(entry.billable),
    multiply: entry.multiply || false,
    tags: ""
  });
  hideEdit();
  await render();
  await runSync({ force: false });
}

async function stopTimer() {
  const active = await getActiveEntries();
  if (!active.length) return;
  await stopEntry(active[0].id);
  await render();
  await runSync({ force: false });
}

async function showEdit(id) {
  const entries = await getVisibleEntries();
  const entry = entries.find((item) => item.id === id);
  if (!entry) return;
  editingId = id;
  editingMultiplyValue = entry.multiply || "";
  const editDot = $("#editProjectDot");
  editDot.classList.toggle("hidden", !entry.project);
  editDot.style.setProperty("--project-color", projectColor(entry));
  $("#editProject").value = entry.project || "";
  $("#editTask").value = entry.task || "";
  $("#editDescription").value = entry.description || "";
  $("#editBillable").checked = Boolean(entry.billable);
  $("#editMultiply").checked = hasMultiplier(entry);
  $("#editStart").value = toLocalInputValue(entry.start_at);
  $("#editEnd").value = toLocalInputValue(entry.end_at);
  $("#editStatus").value = entry.status || "ok";
  renderMergeTargets(entry, entries);
  $("#editPanel").classList.remove("hidden");
}

function hideEdit() {
  editingId = "";
  editingMultiplyValue = "";
  $("#mergeTarget").innerHTML = "";
  $("#mergeEdit").disabled = true;
  $("#editProjectDot").classList.add("hidden");
  $("#editPanel").classList.add("hidden");
}

function renderMergeTargets(entry, entries) {
  const candidates = entries.filter((candidate) => canMergeEntries(entry, candidate));
  const select = $("#mergeTarget");
  select.innerHTML = candidates.length
    ? candidates.map((candidate) => `
      <option value="${escapeHtml(candidate.id)}">
        ${escapeHtml(shortDateTime(candidate.start_at))} · ${escapeHtml(formatElapsed(candidate.duration_seconds || durationSeconds(candidate.start_at, candidate.end_at)))}
      </option>
    `).join("")
    : '<option value="">No matching completed entries</option>';
  $("#mergeEdit").disabled = !candidates.length;
}

async function saveEdit() {
  if (!editingId) return;
  await updateEntry(editingId, {
    client: "",
    project: $("#editProject").value.trim(),
    task: $("#editTask").value.trim(),
    description: $("#editDescription").value.trim(),
    billable: $("#editBillable").checked,
    multiply: $("#editMultiply").checked ? (editingMultiplyValue || true) : false,
    tags: "",
    start_at: fromLocalInputValue($("#editStart").value),
    end_at: fromLocalInputValue($("#editEnd").value),
    status: $("#editStatus").value
  });
  hideEdit();
  await render();
  await runSync({ force: false });
}

function saveEditOnEnter(event) {
  if (event.key !== "Enter" || event.isComposing || event.repeat) return;
  event.preventDefault();
  saveEdit();
}

async function deleteEdit() {
  if (!editingId) return;
  await softDeleteEntry(editingId);
  hideEdit();
  await render();
  await runSync({ force: false });
}

async function mergeEdit() {
  if (!editingId) return;
  const sourceId = $("#mergeTarget").value;
  if (!sourceId) return;
  try {
    await mergeEntries(editingId, sourceId);
    hideEdit();
    await render();
    await runSync({ force: false });
  } catch (error) {
    setStatus($("#syncStatus"), "error", formatError(error));
  }
}

async function exportCsv() {
  downloadCsv(await getAllEntries());
}

async function startPolling() {
  const configured = Number(await getSetting("sync_interval_seconds", 60)) || 60;
  const interval = Math.max(30, configured) * 1000;
  poller = setInterval(() => runSync({ force: false }), interval);
}

function bindEvents() {
  bindMinuteRollover($("#editStart"));
  bindMinuteRollover($("#editEnd"));
  $("#editStart").addEventListener("keydown", saveEditOnEnter);
  $("#editEnd").addEventListener("keydown", saveEditOnEnter);
  $("#newTimerToggle").addEventListener("click", toggleNewTimer);
  $("#startButton").addEventListener("click", startTimer);
  $("#stopButton").addEventListener("click", stopTimer);
  $("#headerSyncButton").addEventListener("click", () => runSync({ force: true }));
  $("#exportButton").addEventListener("click", exportCsv);
  $("#loadMoreRecent").addEventListener("click", () => {
    recentLimit += RECENT_PAGE_SIZE;
    renderRecent().catch((error) => {
      setStatus($("#syncStatus"), "error", formatError(error));
    });
  });
  $("#openCalendar").addEventListener("click", () => platform.openExtensionPage("calendar/calendar.html"));
  $("#openOptions").addEventListener("click", () => platform.openOptionsPage());
  $("#saveEdit").addEventListener("click", saveEdit);
  $("#mergeEdit").addEventListener("click", mergeEdit);
  $("#cancelEdit").addEventListener("click", hideEdit);
  $("#deleteEdit").addEventListener("click", deleteEdit);
  $("#recentEntries").addEventListener("click", (event) => {
    const groupButton = event.target.closest("[data-toggle-group]");
    if (groupButton) {
      const key = groupButton.dataset.toggleGroup;
      if (expandedRecentGroups.has(key)) {
        expandedRecentGroups.delete(key);
      } else {
        expandedRecentGroups.add(key);
      }
      renderRecent().catch((error) => {
        setStatus($("#syncStatus"), "error", formatError(error));
      });
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
  $("#recentEntries").addEventListener("keydown", (event) => {
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
      setStatus($("#syncStatus"), "error", formatError(error));
    });
  });
  await render();
  await runSync({ force: false });
  await startPolling();
  ticker = setInterval(updateElapsed, 1000);
}

window.addEventListener("pagehide", () => {
  if (ticker) clearInterval(ticker);
  if (poller) clearInterval(poller);
  if (unsubscribeEntryEvents) unsubscribeEntryEvents();
});

init();

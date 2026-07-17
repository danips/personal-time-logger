import { getVisibleEntries } from "../src/db.js";
import { canMergeEntries, duplicateEntry, hasMultiplier, mergeEntries, updateEntry } from "../src/entries.js";
import { onEntriesChanged } from "../src/events.js";
import { syncNow } from "../src/sync.js";
import {
  addDays,
  bindMinuteRollover,
  durationSeconds,
  formatElapsed,
  fromLocalInputValue,
  localTime,
  startOfLocalDay as startOfDay,
  startOfLocalWeek as startOfWeek,
  toLocalInputValue
} from "../src/time.js";
import { $, entryTitle, formatError, projectColor, statusFromError } from "../src/ui-helpers.js";

const DAY_COUNT = 7;
const MINUTES_PER_DAY = 24 * 60;
const SNAP_MINUTES = 15;
const SLOT_HEIGHT = 12;
const PX_PER_MINUTE = SLOT_HEIGHT / SNAP_MINUTES;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DRAG_THRESHOLD_PX = 5;
const DEFAULT_VISIBLE_HOUR = 7;

let weekStart = startOfWeek(new Date());
let renderedEntries = [];
let dragState = null;
let preview = null;
let initialScrollDone = false;
let refreshTimer = null;
let selectedEntryId = "";
let editingEntryId = "";
let editingMultiplyValue = "";
let unsubscribeEntryEvents = null;

function setStatus(message) {
  $("#statusLine").textContent = message;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

function minutesSinceStartOfDay(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function maxDate(a, b) {
  return a.getTime() > b.getTime() ? a : b;
}

function minDate(a, b) {
  return a.getTime() < b.getTime() ? a : b;
}

function shortDay(date) {
  return date.toLocaleDateString([], { weekday: "short" });
}

function calendarHeaderDate(date) {
  return date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function formatTotalHours(seconds) {
  return formatElapsed(Math.round(Math.max(0, Number(seconds) || 0)));
}

function isoWeekValue(date) {
  const monday = startOfWeek(date);
  const thursday = addDays(monday, 3);
  const weekYear = thursday.getFullYear();
  const firstWeek = startOfWeek(new Date(weekYear, 0, 4));
  const week = Math.round((monday.getTime() - firstWeek.getTime()) / (7 * DAY_MS)) + 1;
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

function weekStartFromInput(value) {
  const match = String(value || "").match(/^(\d{4})-W(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (!year || week < 1 || week > 53) return null;
  const firstWeek = startOfWeek(new Date(year, 0, 4));
  return addDays(firstWeek, (week - 1) * 7);
}

function isSameLocalDate(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function intersectsWeek(entry, start, end) {
  const entryStart = new Date(entry.start_at);
  if (Number.isNaN(entryStart.getTime())) return false;
  const entryEnd = entry.end_at ? new Date(entry.end_at) : new Date();
  const displayEnd = entryEnd > entryStart ? entryEnd : addMinutes(entryStart, SNAP_MINUTES);
  return entryStart < end && displayEnd > start;
}

function durationMsForDrag(entry) {
  const start = new Date(entry.start_at);
  const end = entry.end_at ? new Date(entry.end_at) : new Date();
  const duration = end.getTime() - start.getTime();
  return Math.max(SNAP_MINUTES * MINUTE_MS, duration);
}

function actualDurationSeconds(rawStart, rawEnd) {
  return Math.max(0, (rawEnd.getTime() - rawStart.getTime()) / 1000);
}

function effectiveDurationSeconds(entry, rawStart, rawEnd) {
  const actualSeconds = Math.max(0, (rawEnd.getTime() - rawStart.getTime()) / 1000);
  if (!actualSeconds) return 0;
  const stored = Number(entry.duration_seconds) || 0;
  return entry.end_at && stored ? stored : actualSeconds;
}

function effectiveEnd(entry, rawStart, rawEnd) {
  const actualSeconds = actualDurationSeconds(rawStart, rawEnd);
  const effectiveSeconds = effectiveDurationSeconds(entry, rawStart, rawEnd);
  return addMinutes(rawStart, Math.max(actualSeconds, effectiveSeconds) / 60);
}

function buildSegments(entries) {
  const weekEnd = addDays(weekStart, DAY_COUNT);
  const days = Array.from({ length: DAY_COUNT }, () => []);

  for (const entry of entries) {
    const entryStart = new Date(entry.start_at);
    if (Number.isNaN(entryStart.getTime())) continue;

    const rawEnd = entry.end_at ? new Date(entry.end_at) : new Date();
    const actualEnd = rawEnd > entryStart ? rawEnd : addMinutes(entryStart, SNAP_MINUTES);
    const displayEnd = effectiveEnd(entry, entryStart, actualEnd);
    const effectiveSeconds = effectiveDurationSeconds(entry, entryStart, actualEnd);
    const actualSeconds = actualDurationSeconds(entryStart, actualEnd);
    const displaySeconds = actualDurationSeconds(entryStart, displayEnd);
    if (entryStart >= weekEnd || displayEnd <= weekStart) continue;

    for (let index = 0; index < DAY_COUNT; index += 1) {
      const dayStart = addDays(weekStart, index);
      const dayEnd = addDays(dayStart, 1);
      const visibleStart = maxDate(entryStart, dayStart);
      const visibleEnd = minDate(displayEnd, dayEnd);
      if (visibleEnd <= visibleStart) continue;

      days[index].push({
        entry,
        dayIndex: index,
        visibleStart,
        visibleEnd,
        actualEnd,
        displayEnd,
        effectiveSeconds,
        actualSeconds,
        displaySeconds,
        totalSeconds: displaySeconds ? effectiveSeconds * actualDurationSeconds(visibleStart, visibleEnd) / displaySeconds : 0,
        startMinute: minutesSinceStartOfDay(visibleStart),
        endMinute: minutesSinceStartOfDay(visibleEnd)
      });
    }
  }

  return days;
}

function layoutGroup(group) {
  const lanes = [];
  for (const segment of group) {
    let lane = lanes.findIndex((endMinute) => endMinute <= segment.startMinute);
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(0);
    }
    lanes[lane] = segment.endMinute;
    segment.lane = lane;
  }
  for (const segment of group) {
    segment.laneCount = Math.max(1, lanes.length);
  }
}

function layoutSegments(segments) {
  const sorted = [...segments].sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
  let group = [];
  let groupEnd = -1;

  for (const segment of sorted) {
    if (!group.length || segment.startMinute < groupEnd) {
      group.push(segment);
      groupEnd = Math.max(groupEnd, segment.endMinute);
      continue;
    }

    layoutGroup(group);
    group = [segment];
    groupEnd = segment.endMinute;
  }

  if (group.length) layoutGroup(group);
  return sorted;
}

function dailyTotalsFromSegments(segmentsByDay) {
  return segmentsByDay.map((segments) => segments.reduce((total, segment) => total + segment.totalSeconds, 0));
}

function renderHeader(dailyTotals = []) {
  const header = $("#dayHeader");
  const today = startOfDay(new Date());
  header.innerHTML = "";

  const corner = document.createElement("div");
  corner.className = "corner-header";
  corner.textContent = "Time";
  header.append(corner);

  for (let index = 0; index < DAY_COUNT; index += 1) {
    const date = addDays(weekStart, index);
    const element = document.createElement("div");
    element.className = `day-heading${isSameLocalDate(date, today) ? " today" : ""}`;
    element.innerHTML = `
      <strong>${calendarHeaderDate(date)}</strong>
      <em>${formatTotalHours(dailyTotals[index] || 0)}</em>
    `;
    header.append(element);
  }
}

function renderTimeAxis(grid) {
  const axis = document.createElement("div");
  axis.className = "time-axis";

  for (let hour = 0; hour < 24; hour += 1) {
    const label = document.createElement("div");
    label.className = "time-label";
    label.style.top = `${hour * 60 * PX_PER_MINUTE}px`;
    label.textContent = `${String(hour).padStart(2, "0")}:00`;
    axis.append(label);
  }

  grid.append(axis);
}

function renderEntryBlock(column, segment) {
  const entry = segment.entry;
  const laneCount = segment.laneCount || 1;
  const laneWidth = 100 / laneCount;
  const top = segment.startMinute * PX_PER_MINUTE + 2;
  const height = Math.max(22, (segment.endMinute - segment.startMinute) * PX_PER_MINUTE - 4);
  const actualSegmentSeconds = actualDurationSeconds(segment.visibleStart, minDate(segment.visibleEnd, segment.actualEnd));
  const effectiveSegmentSeconds = actualDurationSeconds(segment.visibleStart, segment.visibleEnd);
  const multipliedSeconds = Math.max(0, effectiveSegmentSeconds - actualSegmentSeconds);
  const actualPercent = effectiveSegmentSeconds
    ? clamp((actualSegmentSeconds / effectiveSegmentSeconds) * 100, 0, 100)
    : 100;
  const isMultiplied = hasMultiplier(entry) && multipliedSeconds > 0;

  const block = document.createElement("article");
  block.className = [
    "entry-block",
    entry.end_at ? "" : "active-entry",
    entry.status === "needs_review" ? "needs-review" : "",
    isMultiplied ? "multiplied-entry" : "",
    entry.id === selectedEntryId ? "selected-entry" : ""
  ].filter(Boolean).join(" ");
  block.dataset.entryId = entry.id;
  block.style.top = `${top}px`;
  block.style.height = `${height}px`;
  block.style.left = `calc(${segment.lane * laneWidth}% + 3px)`;
  block.style.width = `calc(${laneWidth}% - 6px)`;
  block.style.setProperty("--project-color", projectColor(entry));
  block.tabIndex = 0;
  const projectLabel = entry.project || "Untitled project";
  const detailsLabel = [entry.task, entry.description].filter(Boolean).join(" - ") || "No task or description";
  const durationLabel = formatElapsed(Math.round(segment.totalSeconds || 0));
  block.title = [
    projectLabel,
    detailsLabel,
    durationLabel
  ].filter(Boolean).join("\n");
  if (isMultiplied) {
    block.style.setProperty("--actual-percent", `${actualPercent}%`);
  }
  block.innerHTML = `
    <div class="entry-fill" aria-hidden="true"></div>
    <div class="entry-content">
      <div class="entry-project"><span class="calendar-project-dot" aria-hidden="true"></span><span class="entry-project-text"></span></div>
      <div class="entry-details"></div>
      <div class="entry-duration"></div>
    </div>
  `;
  $(".entry-project-text", block).textContent = projectLabel;
  $(".entry-details", block).textContent = detailsLabel;
  $(".entry-duration", block).textContent = durationLabel;
  block.addEventListener("pointerdown", beginDrag);
  block.addEventListener("click", selectEntryFromBlock);
  column.append(block);
}

function renderCalendar(segmentsByDay) {
  const grid = $("#calendarGrid");
  const today = startOfDay(new Date());
  grid.innerHTML = "";
  renderTimeAxis(grid);

  for (let index = 0; index < DAY_COUNT; index += 1) {
    const column = document.createElement("div");
    column.className = `day-column${isSameLocalDate(addDays(weekStart, index), today) ? " today" : ""}`;
    column.dataset.dayIndex = String(index);
    grid.append(column);

    const segments = layoutSegments(segmentsByDay[index]);
    for (const segment of segments) {
      renderEntryBlock(column, segment);
    }
  }

}

function syncScrollbarGutter() {
  const shell = $(".calendar-shell");
  const scroll = $("#calendarScroll");
  if (!shell || !scroll) return;

  const gutter = Math.max(0, scroll.offsetWidth - scroll.clientWidth);
  shell.style.setProperty("--scrollbar-gutter", `${gutter}px`);
}

async function render() {
  if (dragState) return;
  const weekEnd = addDays(weekStart, DAY_COUNT);
  renderedEntries = (await getVisibleEntries()).filter((entry) => intersectsWeek(entry, weekStart, weekEnd));
  const segmentsByDay = buildSegments(renderedEntries);
  $("#weekPicker").value = isoWeekValue(weekStart);
  renderHeader(dailyTotalsFromSegments(segmentsByDay));
  renderCalendar(segmentsByDay);
  syncScrollbarGutter();
  renderSelectionPanel();
  scrollToWorkingHours();
}

function renderSelectionPanel() {
  const panel = $("#mergePanel");
  const selected = getEntryById(selectedEntryId);
  if (!selected) {
    selectedEntryId = "";
    closeEditor();
    panel.hidden = true;
    return;
  }

  const candidates = renderedEntries.filter((entry) => canMergeEntries(selected, entry));
  $("#selectedEntryTitle").textContent = entryTitle(selected);
  $("#selectedEntryMeta").textContent = [
    `${localTime(new Date(selected.start_at))} - ${selected.end_at ? localTime(new Date(selected.end_at)) : "active"}`,
    formatElapsed(selected.duration_seconds || durationSeconds(selected.start_at, selected.end_at || undefined))
  ].join(" · ");
  $("#calendarMergeTarget").innerHTML = candidates.length
    ? candidates.map((entry) => `
      <option value="${entry.id}">
        ${shortDay(new Date(entry.start_at))} ${localTime(new Date(entry.start_at))} · ${formatElapsed(entry.duration_seconds || durationSeconds(entry.start_at, entry.end_at))}
      </option>
    `).join("")
    : '<option value="">No matching completed entries this week</option>';
  $("#calendarMergeButton").disabled = !candidates.length;
  $("#duplicateEntryButton").disabled = !selected.end_at;
  $("#duplicateEntryButton").title = selected.end_at
    ? "Create a copy at the same date and time"
    : "Stop this entry before duplicating it";
  panel.hidden = false;
}

async function selectEntryFromBlock(event) {
  const block = event.currentTarget;
  if (block.dataset.skipClick === "true") {
    block.dataset.skipClick = "";
    return;
  }
  const nextId = block.dataset.entryId || "";
  if (nextId === selectedEntryId) {
    await clearSelection();
    return;
  }

  closeEditor();
  selectedEntryId = nextId;
  await render();
  openSelectedEntryEditor();
}

function scrollToWorkingHours() {
  if (initialScrollDone) return;
  initialScrollDone = true;
  const scroll = $("#calendarScroll");
  scroll.scrollTop = DEFAULT_VISIBLE_HOUR * 60 * PX_PER_MINUTE;
}

function getEntryById(id) {
  return renderedEntries.find((entry) => entry.id === id);
}

function ensurePreview() {
  if (preview) return preview;
  preview = document.createElement("div");
  preview.className = "drag-preview";
  preview.textContent = "Move";
  return preview;
}

function dragTargetFromPointer(clientX, clientY) {
  const columns = [...document.querySelectorAll(".day-column")];
  if (!columns.length) return null;

  let best = null;
  let bestDistance = Infinity;
  for (const column of columns) {
    const rect = column.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    const distance = clientX >= rect.left && clientX <= rect.right ? 0 : Math.abs(clientX - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { column, rect };
    }
  }

  if (!best) return null;

  const rawTop = clientY - best.rect.top - dragState.offsetY;
  const snappedMinutes = Math.round((rawTop / PX_PER_MINUTE) / SNAP_MINUTES) * SNAP_MINUTES;
  const minute = clamp(snappedMinutes, 0, MINUTES_PER_DAY - SNAP_MINUTES);
  const dayIndex = Number(best.column.dataset.dayIndex || 0);
  return { column: best.column, dayIndex, minute };
}

function updatePreview(target) {
  if (!target) return;
  const element = ensurePreview();
  const durationMinutes = Math.max(SNAP_MINUTES, Math.round(dragState.durationMs / MINUTE_MS));
  const visibleMinutes = Math.min(durationMinutes, MINUTES_PER_DAY - target.minute);
  element.style.top = `${target.minute * PX_PER_MINUTE + 2}px`;
  element.style.left = "3px";
  element.style.width = "calc(100% - 6px)";
  element.style.height = `${Math.max(22, visibleMinutes * PX_PER_MINUTE - 4)}px`;
  element.textContent = `${entryTitle(dragState.entry)} · ${minutesToLabel(target.minute)}`;
  target.column.append(element);
}

function minutesToLabel(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function beginDrag(event) {
  if (event.button !== 0) return;
  const block = event.currentTarget;
  const entry = getEntryById(block.dataset.entryId);
  if (!entry) return;

  event.preventDefault();
  const rect = block.getBoundingClientRect();
  dragState = {
    entry,
    block,
    startX: event.clientX,
    startY: event.clientY,
    offsetY: event.clientY - rect.top,
    durationMs: durationMsForDrag(entry),
    active: false,
    target: null
  };
  block.setPointerCapture(event.pointerId);
  window.addEventListener("pointermove", moveDrag);
  window.addEventListener("pointerup", endDrag, { once: true });
  window.addEventListener("pointercancel", endDrag, { once: true });
}

function moveDrag(event) {
  if (!dragState) return;
  if (!dragState.active) {
    const distance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
    if (distance < DRAG_THRESHOLD_PX) return;
    dragState.active = true;
    dragState.block.classList.add("drag-source");
  }

  const target = dragTargetFromPointer(event.clientX, event.clientY);
  dragState.target = target;
  updatePreview(target);
  if (target) setStatus(`Drop at ${shortDay(addDays(weekStart, target.dayIndex))} ${minutesToLabel(target.minute)}`);
}

async function endDrag() {
  if (!dragState) return;
  const state = dragState;
  dragState = null;
  window.removeEventListener("pointermove", moveDrag);
  window.removeEventListener("pointerup", endDrag);
  window.removeEventListener("pointercancel", endDrag);
  state.block.classList.remove("drag-source");
  if (preview) {
    preview.remove();
    preview = null;
  }

  if (!state.active || !state.target) {
    await render();
    setStatus("Ready");
    return;
  }

  state.block.dataset.skipClick = "true";
  setTimeout(() => {
    state.block.dataset.skipClick = "";
  }, 0);

  const newStart = addMinutes(addDays(weekStart, state.target.dayIndex), state.target.minute);
  const changes = { start_at: newStart.toISOString() };
  if (state.entry.end_at) {
    changes.end_at = new Date(newStart.getTime() + state.durationMs).toISOString();
  }

  try {
    if (editingEntryId === state.entry.id) closeEditor();
    await updateEntry(state.entry.id, changes);
    setStatus("Entry moved");
    await render();
    await runSync({ force: false });
  } catch (error) {
    setStatus(formatError(error));
    await render();
  }
}

async function runSync({ force = false } = {}) {
  setStatus("Syncing...");
  try {
    const result = await syncNow({ interactiveAuth: false, force });
    setStatus(result.warning || result.status);
  } catch (error) {
    setStatus(`${statusFromError(error)}: ${formatError(error)}`);
  }
  await render();
}

async function mergeSelectedEntry() {
  const sourceId = $("#calendarMergeTarget").value;
  if (!selectedEntryId || !sourceId) return;

  try {
    await mergeEntries(selectedEntryId, sourceId);
    closeEditor();
    setStatus("Entries merged");
    await render();
    await runSync({ force: false });
  } catch (error) {
    setStatus(formatError(error));
  }
}

async function duplicateSelectedEntry() {
  if (!selectedEntryId) return;

  try {
    const duplicate = await duplicateEntry(selectedEntryId);
    closeEditor();
    selectedEntryId = duplicate.id;
    setStatus("Entry duplicated");
    await render();
    await runSync({ force: false });
  } catch (error) {
    setStatus(formatError(error));
  }
}

function closeEditor() {
  editingEntryId = "";
  editingMultiplyValue = "";
  $("#calendarEditForm").reset();
  $("#calendarEditPanel").hidden = true;
}

function openSelectedEntryEditor() {
  const entry = getEntryById(selectedEntryId);
  if (!entry) return;

  editingEntryId = entry.id;
  editingMultiplyValue = entry.multiply || "";
  $("#calendarEditProject").value = entry.project || "";
  $("#calendarEditTask").value = entry.task || "";
  $("#calendarEditDescription").value = entry.description || "";
  $("#calendarEditBillable").checked = Boolean(entry.billable);
  $("#calendarEditMultiply").checked = hasMultiplier(entry);
  $("#calendarEditStart").value = toLocalInputValue(entry.start_at);
  $("#calendarEditEnd").value = toLocalInputValue(entry.end_at);
  $("#calendarEditStatus").value = entry.status || "ok";
  $("#calendarEditDuration").textContent = entry.end_at
    ? formatElapsed(entry.duration_seconds || durationSeconds(entry.start_at, entry.end_at))
    : "Active time log";
  $("#calendarEditPanel").hidden = false;
  $("#calendarEditProject").focus();
}

async function saveCalendarEdit(event) {
  event.preventDefault();
  if (!editingEntryId) return;

  const startAt = fromLocalInputValue($("#calendarEditStart").value);
  const endAt = fromLocalInputValue($("#calendarEditEnd").value);
  if (!startAt) {
    setStatus("A valid start time is required");
    return;
  }
  if (endAt && new Date(endAt) < new Date(startAt)) {
    setStatus("End time cannot be before the start time");
    return;
  }

  try {
    await updateEntry(editingEntryId, {
      project: $("#calendarEditProject").value.trim(),
      task: $("#calendarEditTask").value.trim(),
      description: $("#calendarEditDescription").value.trim(),
      billable: $("#calendarEditBillable").checked,
      multiply: $("#calendarEditMultiply").checked ? (editingMultiplyValue || true) : false,
      start_at: startAt,
      end_at: endAt,
      status: $("#calendarEditStatus").value
    });
    closeEditor();
    setStatus("Entry updated");
    await render();
    await runSync({ force: false });
  } catch (error) {
    setStatus(formatError(error));
  }
}

async function clearSelection() {
  closeEditor();
  selectedEntryId = "";
  await render();
  setStatus("Ready");
}

async function changeWeek(nextStart) {
  closeEditor();
  weekStart = startOfWeek(nextStart);
  initialScrollDone = false;
  await render();
  setStatus("Ready");
}

function bindEvents() {
  bindMinuteRollover($("#calendarEditStart"));
  bindMinuteRollover($("#calendarEditEnd"));
  $("#prevWeek").addEventListener("click", () => changeWeek(addDays(weekStart, -DAY_COUNT)));
  $("#nextWeek").addEventListener("click", () => changeWeek(addDays(weekStart, DAY_COUNT)));
  $("#todayButton").addEventListener("click", () => changeWeek(new Date()));
  $("#syncButton").addEventListener("click", () => runSync({ force: true }));
  $("#duplicateEntryButton").addEventListener("click", duplicateSelectedEntry);
  $("#calendarMergeButton").addEventListener("click", mergeSelectedEntry);
  $("#calendarEditForm").addEventListener("submit", saveCalendarEdit);
  $("#cancelCalendarEditButton").addEventListener("click", clearSelection);
  $("#weekPicker").addEventListener("change", async (event) => {
    const parsed = weekStartFromInput(event.target.value);
    if (parsed) await changeWeek(parsed);
  });
  window.addEventListener("resize", syncScrollbarGutter);
}

async function init() {
  bindEvents();
  unsubscribeEntryEvents = onEntriesChanged(() => {
    render().catch((error) => {
      setStatus(formatError(error));
    });
  });
  await render();
  setStatus("Ready");
  runSync({ force: false });
  refreshTimer = setInterval(render, 60000);
}

window.addEventListener("pagehide", () => {
  if (refreshTimer) clearInterval(refreshTimer);
  if (unsubscribeEntryEvents) unsubscribeEntryEvents();
  window.removeEventListener("resize", syncScrollbarGutter);
});

init();

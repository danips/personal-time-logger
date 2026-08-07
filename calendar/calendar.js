import { getVisibleEntries } from "../src/db.js";
import { canMergeEntries, duplicateEntry, hasMultiplier, mergeEntries, softDeleteEntry, updateEntry } from "../src/entries.js";
import { readEntryForm, writeEntryForm } from "../src/entry-form.js";
import { downloadCsv } from "../src/csv.js";
import { onEntriesChanged } from "../src/events.js";
import { syncNow } from "../src/sync.js";
import {
  addDays,
  bindMinuteRollover,
  durationSeconds,
  formatElapsed,
  fromLocalInputValue,
  localDateKey,
  localTime,
  startOfLocalDay as startOfDay,
  startOfLocalWeek as startOfWeek,
  weekdayDayMonth
} from "../src/time.js";
import { $, entryTitle, formatError, projectColor, statusFromError } from "../src/ui-helpers.js";
import {
  DAY_COUNT,
  MINUTES_PER_DAY,
  MINUTE_MS,
  PX_PER_MINUTE,
  RESIZE_SNAP_MINUTES,
  SNAP_MINUTES,
  actualDurationSeconds,
  addMinutes,
  buildSegments,
  clamp,
  dailyTotalsFromSegments,
  dayIndexInWeek,
  durationMsForDrag,
  intersectsWeek,
  isSameLocalDate,
  isoWeekValue,
  layoutSegments,
  minDate,
  minutesSinceStartOfDay,
  snapDateToGrid,
  weekStartFromInput
} from "../src/calendar-layout.js";
import { bindPopupDrag } from "./popup-drag.js";

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
let lastResizeUndo = null;

function setStatus(message) {
  $("#statusLine").textContent = message;
}

function setResizeUndo(action) {
  lastResizeUndo = action;
  $("#undoResizeButton").hidden = !action;
}

function shortDay(date) {
  return date.toLocaleDateString([], { weekday: "short" });
}

function calendarHeaderDate(date) {
  return weekdayDayMonth(date);
}

function formatTotalHours(seconds) {
  return formatElapsed(Math.round(Math.max(0, Number(seconds) || 0)));
}

function renderHeader(dailyTotals = []) {
  const header = $("#dayHeader");
  const today = startOfDay(new Date());
  header.replaceChildren();

  const corner = document.createElement("div");
  corner.className = "corner-header";
  const cornerLabel = document.createElement("span");
  cornerLabel.textContent = "Time";
  const weekTotal = document.createElement("em");
  weekTotal.textContent = formatTotalHours(dailyTotals.reduce((sum, seconds) => sum + (Number(seconds) || 0), 0));
  weekTotal.title = "Total logged for the displayed week";
  corner.append(cornerLabel, weekTotal);
  header.append(corner);

  for (let index = 0; index < DAY_COUNT; index += 1) {
    const date = addDays(weekStart, index);
    const element = document.createElement("div");
    element.className = `day-heading${isSameLocalDate(date, today) ? " today" : ""}`;
    const dateLabel = document.createElement("strong");
    dateLabel.textContent = calendarHeaderDate(date);
    const total = document.createElement("em");
    total.textContent = formatTotalHours(dailyTotals[index] || 0);
    element.append(dateLabel, total);
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
  block.setAttribute("role", "button");
  block.setAttribute("aria-label", `Edit ${entryTitle(entry)}`);
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
  const fill = document.createElement("div");
  fill.className = "entry-fill";
  fill.setAttribute("aria-hidden", "true");
  const content = document.createElement("div");
  content.className = "entry-content";
  const project = document.createElement("div");
  project.className = "entry-project";
  const dot = document.createElement("span");
  dot.className = "calendar-project-dot";
  dot.title = projectLabel;
  dot.setAttribute("aria-hidden", "true");
  const taskText = document.createElement("span");
  taskText.className = "entry-project-text";
  taskText.textContent = entry.task || "No task";
  project.append(dot, taskText);
  const details = document.createElement("div");
  details.className = "entry-details";
  details.textContent = entry.description || "";
  const duration = document.createElement("div");
  duration.className = "entry-duration";
  duration.textContent = durationLabel;
  content.append(project, details, duration);
  block.append(fill, content);
  if (entry.end_at && entry.id === selectedEntryId && segment.startsEntry) {
    block.append(createResizeHandle("top", entry));
  }
  if (entry.end_at && entry.id === selectedEntryId && segment.endsEntry) {
    block.append(createResizeHandle("bottom", entry));
  }
  block.addEventListener("pointerdown", beginDrag);
  block.addEventListener("click", selectEntryFromBlock);
  block.addEventListener("keydown", selectEntryFromKeyboard);
  column.append(block);
}

function createResizeHandle(edge, entry) {
  const handle = document.createElement("div");
  handle.className = `resize-handle resize-handle-${edge}`;
  handle.dataset.resizeEdge = edge;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "horizontal");
  handle.setAttribute("aria-label", `${edge === "top" ? "Change start" : "Change end"} of ${entryTitle(entry)}`);
  handle.title = edge === "top" ? "Drag to change start time" : "Drag to change end time";
  handle.addEventListener("pointerdown", beginResize);
  return handle;
}

function renderCalendar(segmentsByDay) {
  const grid = $("#calendarGrid");
  const today = startOfDay(new Date());
  grid.replaceChildren();
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
  const segmentsByDay = buildSegments(renderedEntries, weekStart);
  $("#weekPicker").value = isoWeekValue(weekStart);
  renderHeader(dailyTotalsFromSegments(segmentsByDay));
  renderCalendar(segmentsByDay);
  syncScrollbarGutter();
  scrollToWorkingHours();
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

// Blocks are focusable, so Enter and Space must open the editor the same way a
// click does. Dragging and resizing stay pointer-only; the editor form covers
// changing start and end times from the keyboard.
function selectEntryFromKeyboard(event) {
  if (event.target !== event.currentTarget) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  selectEntryFromBlock(event);
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

/**
 * Places the popup beside its entry, kept inside the viewport.
 *
 * Measures the popup rather than assuming a size, so the caller must make it
 * visible first. Measuring it while hidden reports zero height, which used to fall
 * back to a guess and left the bottom of a low entry's popup off-screen with its
 * buttons unreachable.
 */
function positionPopupForEntry(entryId) {
  const block = document.querySelector(`[data-entry-id="${entryId}"]`);
  if (!block) return;

  const popup = $(".edit-popup");
  const blockRect = block.getBoundingClientRect();
  const popupRect = popup.getBoundingClientRect();
  const popupWidth = popupRect.width || 380;
  const popupHeight = popupRect.height || 400;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = 12;

  let left = blockRect.right + pad;
  if (left + popupWidth > vw - pad) left = blockRect.left - popupWidth - pad;
  if (left < pad) left = Math.max(pad, (vw - popupWidth) / 2);

  // Anything taller than the viewport sits at the top edge and scrolls inside
  // itself, which the popup's max-height and overflow allow for.
  const top = Math.max(pad, Math.min(blockRect.top, vh - popupHeight - pad));

  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

function editFields() {
  return {
    project: $("#calendarEditProject"),
    task: $("#calendarEditTask"),
    description: $("#calendarEditDescription"),
    multiply: $("#calendarEditMultiply"),
    start: $("#calendarEditStart"),
    end: $("#calendarEditEnd"),
    status: $("#calendarEditStatus")
  };
}

function loadEditor(entry) {
  editingEntryId = entry.id;
  editingMultiplyValue = entry.multiply || "";
  writeEntryForm(editFields(), entry);
}

function refreshSelectedEntryEditor() {
  const entry = getEntryById(selectedEntryId);
  if (!entry || !editingEntryId) return;
  loadEditor(entry);
  positionPopupForEntry(entry.id);
}

function ensurePreview() {
  if (preview) return preview;
  preview = document.createElement("div");
  preview.className = "drag-preview";
  preview.textContent = "Move";
  return preview;
}

// Nearest day column to a pointer position, so dragging outside the grid still
// resolves to the closest day instead of cancelling.
function columnFromPointer(clientX) {
  let best = null;
  let bestDistance = Infinity;
  for (const column of document.querySelectorAll(".day-column")) {
    const rect = column.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    const distance = clientX >= rect.left && clientX <= rect.right ? 0 : Math.abs(clientX - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { column, rect };
    }
  }
  return best;
}

function dragTargetFromPointer(clientX, clientY) {
  const best = columnFromPointer(clientX);
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
  if (event.target.closest(".resize-handle")) return;
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

function resizeTargetFromPointer(clientX, clientY) {
  const best = columnFromPointer(clientX);
  if (!best) return null;

  const rawMinute = (clientY - best.rect.top) / PX_PER_MINUTE;
  const minute = clamp(
    Math.round(rawMinute / RESIZE_SNAP_MINUTES) * RESIZE_SNAP_MINUTES,
    0,
    MINUTES_PER_DAY
  );
  const dayIndex = Number(best.column.dataset.dayIndex || 0);
  const date = addMinutes(addDays(weekStart, dayIndex), minute);
  return { column: best.column, dayIndex, minute, date };
}

function showResizeGuide(target) {
  if (!target) return;
  if (!preview) {
    preview = document.createElement("div");
    preview.className = "resize-guide";
  }
  preview.style.top = `${clamp(target.minute * PX_PER_MINUTE - 1, 0, MINUTES_PER_DAY * PX_PER_MINUTE - 3)}px`;
  target.column.append(preview);
}

function beginResize(event) {
  if (event.button !== 0) return;
  const handle = event.currentTarget;
  const block = handle.closest(".entry-block");
  const entry = block && getEntryById(block.dataset.entryId);
  if (!entry || !entry.end_at || entry.id !== selectedEntryId) return;

  event.preventDefault();
  event.stopPropagation();
  dragState = {
    type: "resize",
    edge: handle.dataset.resizeEdge,
    entry,
    block,
    handle,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    target: null
  };
  handle.setPointerCapture(event.pointerId);
  window.addEventListener("pointermove", moveResize);
  window.addEventListener("pointerup", endResize, { once: true });
  window.addEventListener("pointercancel", endResize, { once: true });
}

function moveResize(event) {
  if (!dragState || dragState.type !== "resize") return;
  if (!dragState.active) {
    const distance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
    if (distance < DRAG_THRESHOLD_PX) return;
    dragState.active = true;
    dragState.block.classList.add("resize-source");
  }

  const target = resizeTargetFromPointer(event.clientX, event.clientY);
  if (!target) return;
  const start = new Date(dragState.entry.start_at);
  const end = new Date(dragState.entry.end_at);
  const earliestEnd = addMinutes(start, RESIZE_SNAP_MINUTES);
  const latestStart = addMinutes(end, -RESIZE_SNAP_MINUTES);
  if (dragState.edge === "top" && target.date > latestStart) {
    target.date = snapDateToGrid(latestStart, "down");
  }
  if (dragState.edge === "bottom" && target.date < earliestEnd) {
    target.date = snapDateToGrid(earliestEnd, "up");
  }

  const targetDay = dayIndexInWeek(weekStart, target.date);
  if (targetDay >= 0 && targetDay < DAY_COUNT) {
    target.dayIndex = targetDay;
    target.column = document.querySelector(`.day-column[data-day-index="${targetDay}"]`);
    target.minute = minutesSinceStartOfDay(target.date);
  }
  dragState.target = target;
  showResizeGuide(target);

  const nextStart = dragState.edge === "top" ? target.date : start;
  const nextEnd = dragState.edge === "bottom" ? target.date : end;
  setStatus(`${dragState.edge === "top" ? "Start" : "End"}: ${shortDay(target.date)} ${localTime(target.date)} · ${formatElapsed(Math.round(actualDurationSeconds(nextStart, nextEnd)))}`);
}

async function endResize() {
  if (!dragState || dragState.type !== "resize") return;
  const state = dragState;
  dragState = null;
  window.removeEventListener("pointermove", moveResize);
  window.removeEventListener("pointerup", endResize);
  window.removeEventListener("pointercancel", endResize);
  state.block.classList.remove("resize-source");
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

  const changes = state.edge === "top"
    ? { start_at: state.target.date.toISOString() }
    : { end_at: state.target.date.toISOString() };
  const undo = {
    id: state.entry.id,
    start_at: state.entry.start_at,
    end_at: state.entry.end_at
  };

  try {
    await updateEntry(state.entry.id, changes);
    setResizeUndo(undo);
    setStatus("Entry resized");
    await render();
    if (editingEntryId === state.entry.id) refreshSelectedEntryEditor();
    await runSync({ force: false });
  } catch (error) {
    setStatus(formatError(error));
    await render();
  }
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
    setResizeUndo(null);
    await updateEntry(state.entry.id, changes);
    setStatus("Entry moved");
    await render();
    if (editingEntryId === state.entry.id) refreshSelectedEntryEditor();
    await runSync({ force: false });
  } catch (error) {
    setStatus(formatError(error));
    await render();
  }
}

async function undoResize() {
  if (!lastResizeUndo) return;
  const undo = lastResizeUndo;
  setResizeUndo(null);

  try {
    await updateEntry(undo.id, {
      start_at: undo.start_at,
      end_at: undo.end_at
    });
    setStatus("Resize undone");
    await render();
    if (editingEntryId === undo.id) refreshSelectedEntryEditor();
    await runSync({ force: false });
  } catch (error) {
    setResizeUndo(undo);
    setStatus(formatError(error));
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
    setResizeUndo(null);
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
    setResizeUndo(null);
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
  $("#calendarEditOverlay").hidden = true;
}

function openSelectedEntryEditor() {
  const entry = getEntryById(selectedEntryId);
  if (!entry) return;

  loadEditor(entry);

  const candidates = renderedEntries.filter((e) => canMergeEntries(entry, e));
  const mergeOptions = candidates.map((e) => {
    const option = document.createElement("option");
    option.value = e.id;
    option.textContent = `${shortDay(new Date(e.start_at))} ${localTime(new Date(e.start_at))} · ${formatElapsed(e.duration_seconds || durationSeconds(e.start_at, e.end_at))}`;
    return option;
  });
  if (!mergeOptions.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No matching completed entries this week";
    mergeOptions.push(option);
  }
  $("#calendarMergeTarget").replaceChildren(...mergeOptions);
  $("#calendarMergeButton").disabled = !candidates.length;
  $("#duplicateEntryButton").disabled = !entry.end_at;
  $("#duplicateEntryButton").title = entry.end_at
    ? "Create a copy at the same date and time"
    : "Stop this entry before duplicating it";

  // Unhidden first so the popup can be measured; positioning it while hidden
  // reports no height.
  $("#calendarEditOverlay").hidden = false;
  positionPopupForEntry(entry.id);
  $("#calendarEditProject").focus();
}

async function deleteCalendarEntry() {
  if (!editingEntryId) return;
  if (!confirm("Delete this time log entry?")) return;
  try {
    setResizeUndo(null);
    await softDeleteEntry(editingEntryId);
    closeEditor();
    selectedEntryId = "";
    setStatus("Entry deleted");
    await render();
    await runSync({ force: false });
  } catch (error) {
    setStatus(formatError(error));
  }
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
    setResizeUndo(null);
    await updateEntry(editingEntryId, readEntryForm(editFields(), { multiplyValue: editingMultiplyValue }));
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

/**
 * Dismisses the selection when the pointer goes down anywhere outside the
 * selected entry and its popup.
 *
 * Bound to pointerdown rather than click because dragging the popup releases the
 * pointer over the grid, and the resulting click is dispatched on the common
 * ancestor of press and release (the page body). On click that would read as an
 * outside click and close the popup mid-drag.
 */
function handleOutsidePointerDown(event) {
  if (!selectedEntryId || event.button !== 0) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target && target.closest(".entry-block, .edit-overlay")) return;
  clearSelection().catch((error) => setStatus(formatError(error)));
}

async function changeWeek(nextStart) {
  closeEditor();
  setResizeUndo(null);
  weekStart = startOfWeek(nextStart);
  initialScrollDone = false;
  await render();
  setStatus("Ready");
}

function exportDisplayedWeek() {
  const weekEnd = addDays(weekStart, DAY_COUNT - 1);
  downloadCsv(renderedEntries, `time-entries-${localDateKey(weekStart)}-to-${localDateKey(weekEnd)}.csv`);
}

function bindEvents() {
  bindMinuteRollover($("#calendarEditStart"));
  bindMinuteRollover($("#calendarEditEnd"));
  $("#prevWeek").addEventListener("click", () => changeWeek(addDays(weekStart, -DAY_COUNT)));
  $("#nextWeek").addEventListener("click", () => changeWeek(addDays(weekStart, DAY_COUNT)));
  $("#todayButton").addEventListener("click", () => changeWeek(new Date()));
  $("#exportButton").addEventListener("click", exportDisplayedWeek);
  $("#syncButton").addEventListener("click", () => runSync({ force: true }));
  $("#undoResizeButton").addEventListener("click", undoResize);
  $("#duplicateEntryButton").addEventListener("click", duplicateSelectedEntry);
  $("#calendarMergeButton").addEventListener("click", mergeSelectedEntry);
  $("#calendarEditForm").addEventListener("submit", saveCalendarEdit);
  $("#cancelCalendarEditButton").addEventListener("click", clearSelection);

  $("#deleteCalendarEntry").addEventListener("click", deleteCalendarEntry);
  bindPopupDrag($(".edit-popup"));
  $("#weekPicker").addEventListener("change", async (event) => {
    const parsed = weekStartFromInput(event.target.value);
    if (parsed) await changeWeek(parsed);
  });
  document.addEventListener("pointerdown", handleOutsidePointerDown);
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
  document.removeEventListener("pointerdown", handleOutsidePointerDown);
  window.removeEventListener("resize", syncScrollbarGutter);
});

init();

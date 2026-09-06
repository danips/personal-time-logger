import { getEntriesIntersecting, getSetting, mutateSetting } from "../src/db.js";
import { isActionRunning, runAction } from "../src/action-runner.js";
import { canMergeEntries, duplicateEntry, hasMultiplier, mergeEntries, softDeleteEntry, updateEntry } from "../src/entries.js";
import { readEntryForm, writeEntryForm } from "../src/entry-form.js";
import { mountEntryEditor, setEntryEditorMergeAvailability } from "../src/entry-editor.js";
import { moveEntryChanges, ownsGesturePointer, resizeEntryChanges } from "../src/calendar-gesture-state.js";
import { tempoDaySelectionState, weekDayKeys } from "../src/tempo-day-selection.js";
import { onEntriesChanged } from "../src/events.js";
import { requestBackgroundSync } from "../src/sync-request.js";
import {
  addDays,
  bindMinuteRollover,
  durationSeconds,
  formatElapsed,
  localTime,
  startOfLocalDay as startOfDay,
  startOfLocalWeek as startOfWeek,
  weekdayDayMonth
} from "../src/time.js";
import { $, entryTitle, formatError, projectColor, statusFromError } from "../src/ui-helpers.js";
import { runPageTask, startPage } from "../src/page-runtime.js";
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
  isSameLocalDate,
  isoWeekValue,
  layoutSegments,
  localDateAtMinute,
  minDate,
  minutesSinceStartOfDay,
  snapDateToGrid,
  scrollTopForStartHour,
  weekStartFromInput
} from "../src/calendar-layout.js";
import { bindPopupDrag } from "./popup-drag.js";
import { createTempoController } from "./tempo-controller.js";
import { SETTING_KEY } from "../src/setting-keys.js";
import { platform } from "../src/platform.js";
import { DEFAULT_WORKDAY_START_HOUR, normalizeWorkdayStartHour } from "../src/options-settings.js";

const entryEditor = mountEntryEditor(document.getElementById("calendarEntryEditor"), {
  variant: "calendar",
  showDuplicate: true,
  saveType: "submit"
});
const $editForm = entryEditor.form;
const $editProject = entryEditor.fields.project;
const $editStart = entryEditor.fields.start;
const $editEnd = entryEditor.fields.end;
const $mergeTarget = entryEditor.merge.target;
const $mergeButton = entryEditor.merge.button;
const $mergeControl = entryEditor.merge.control;
const $duplicateButton = entryEditor.actions.duplicate;

const DRAG_THRESHOLD_PX = 5;
const NO_DAYS_SELECTED_MESSAGE = "Check at least one day to send to Tempo";

let weekStart = startOfWeek(new Date());
// Which days the next Tempo send covers. Deliberately per-send state rather than
// a stored setting, so every week opens with its whole range selected.
let selectedDayKeys = new Set(weekDayKeys(weekStart, DAY_COUNT));
let tempoDaySelectionActive = false;
let renderedEntries = [];
let gesture = null;
let initialScrollDone = false;
let refreshTimer = null;
let selectedEntryId = "";
let editingEntryId = "";
let editingEntryRevision = null;
let editingMultiplyValue = "";
let unsubscribeEntryEvents = null;
let eventsBound = false;
// The latest completed calendar time change stays undoable until it is used or
// another calendar edit replaces it. There is deliberately no expiry timer.
let lastCalendarUndo = null;
let renderGeneration = 0;
let renderInFlight = null;
let renderPending = false;
let clampEditorToViewport = () => {};

function setStatus(message, state = message) {
  const status = $("#statusLine");
  status.textContent = message;
  status.dataset.status = state;
}

function runCalendarAction(key, action, { button = null, expectedRevision, afterRender } = {}) {
  return runAction(key, action, {
    expectedRevision,
    setBusy(next) {
      if (button) button.disabled = next;
    },
    onError(error) {
      setStatus(formatError(error));
    },
    async onFinally() {
      try {
        await render();
        afterRender?.();
      } catch (error) {
        setStatus(formatError(error));
      }
    }
  });
}

function setCalendarUndo(action) {
  lastCalendarUndo = action;
  const button = $("#undoCalendarButton");
  button.hidden = !action;
  button.textContent = action ? `Undo ${action.kind}` : "Undo";
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

function formatCompactElapsed(seconds) {
  const numeric = Number(seconds);
  const total = Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function renderHeader(dailyTotals = []) {
  const header = $("#dayHeader");
  const today = startOfDay(new Date());
  const needsBuild = header.children.length !== DAY_COUNT + 1;
  if (needsBuild) header.replaceChildren();

  const corner = needsBuild ? document.createElement("div") : header.firstElementChild;
  if (needsBuild) {
    corner.className = "corner-header";
    const cornerLabel = document.createElement("span");
    cornerLabel.textContent = "Time";
    const weekTotal = document.createElement("em");
    corner.append(cornerLabel, weekTotal);
    header.append(corner);
  }
  const weekTotal = corner.querySelector("em");
  weekTotal.textContent = formatTotalHours(dailyTotals.reduce((sum, seconds) => sum + (Number(seconds) || 0), 0));
  weekTotal.title = "Total logged for the displayed week";

  const dayKeys = weekDayKeys(weekStart, DAY_COUNT);
  for (let index = 0; index < DAY_COUNT; index += 1) {
    const date = addDays(weekStart, index);
    const element = needsBuild ? document.createElement("div") : header.children[index + 1];
    if (needsBuild) {
      const sendToggle = document.createElement("input");
      const dateLabel = document.createElement("strong");
      const total = document.createElement("em");
      sendToggle.type = "checkbox";
      sendToggle.className = "day-send-toggle";
      // The toggle shares the totals line, so the date keeps the full column
      // width and the control sits beside the hours it would send.
      element.append(dateLabel, sendToggle, total);
      header.append(element);
    }
    // Header cells are reused across renders, so the checkbox is re-pointed at
    // the day it now shows instead of being rebuilt with the week.
    const label = calendarHeaderDate(date);
    const sendToggle = element.querySelector(".day-send-toggle");
    const toggleLabel = `Include ${label} in the next Tempo send`;
    sendToggle.dataset.dayKey = dayKeys[index];
    sendToggle.checked = selectedDayKeys.has(dayKeys[index]);
    sendToggle.hidden = !tempoDaySelectionActive;
    sendToggle.title = toggleLabel;
    sendToggle.setAttribute("aria-label", toggleLabel);
    element.className = `day-heading${isSameLocalDate(date, today) ? " today" : ""}`;
    element.querySelector("strong").textContent = label;
    element.querySelector("em").textContent = formatTotalHours(dailyTotals[index] || 0);
  }
  applyTempoSendState();
}

function currentDaySelection() {
  return tempoDaySelectionState(selectedDayKeys, weekDayKeys(weekStart, DAY_COUNT));
}

function applyTempoSendState() {
  const selection = currentDaySelection();
  const button = $("#sendTempoButton");
  button.disabled = tempoDaySelectionActive && selection.noneSelected;
  button.textContent = tempoDaySelectionActive
    ? (selection.noneSelected
      ? "Select days to send"
      : `Send ${selection.selectedCount} day${selection.selectedCount === 1 ? "" : "s"} to Tempo`)
    : "Send week to Tempo";
  button.title = tempoDaySelectionActive && selection.noneSelected
    ? NO_DAYS_SELECTED_MESSAGE
    : `Send ${selection.scopeLabel} to Tempo`;
}

function setTempoSendMenuOpen(open) {
  const menu = $("#tempoSendMenu");
  const button = $("#tempoSendMenuButton");
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}

function setTempoDaySelectionActive(active) {
  tempoDaySelectionActive = Boolean(active);
  selectedDayKeys = new Set(tempoDaySelectionActive ? [] : weekDayKeys(weekStart, DAY_COUNT));
  document.querySelectorAll(".day-send-toggle").forEach((toggle) => {
    toggle.checked = selectedDayKeys.has(toggle.dataset.dayKey);
    toggle.hidden = !tempoDaySelectionActive;
  });
  setTempoSendMenuOpen(false);
  applyTempoSendState();
}

function toggleSendDay(dayKey, included) {
  if (!dayKey) return;
  if (included) selectedDayKeys.add(dayKey);
  else selectedDayKeys.delete(dayKey);
  applyTempoSendState();
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

function renderEntryBlock(column, segment, existingBlock = null) {
  const entry = segment.entry;
  const laneCount = segment.laneCount || 1;
  const laneWidth = 100 / laneCount;
  const top = segment.startMinute * PX_PER_MINUTE + 2;
  // Keep the block inside its real interval. A fixed minimum height makes a
  // short entry extend into the next same-lane entry and hide its borders.
  // Two pixels are enough to retain the top and bottom borders for very short
  // entries; compact entries receive a separate one-line label treatment.
  const height = Math.max(2, (segment.endMinute - segment.startMinute) * PX_PER_MINUTE - 4);
  const actualSegmentSeconds = actualDurationSeconds(segment.visibleStart, minDate(segment.visibleEnd, segment.actualEnd));
  const effectiveSegmentSeconds = actualDurationSeconds(segment.visibleStart, segment.visibleEnd);
  const multipliedSeconds = Math.max(0, effectiveSegmentSeconds - actualSegmentSeconds);
  const actualPercent = effectiveSegmentSeconds
    ? clamp((actualSegmentSeconds / effectiveSegmentSeconds) * 100, 0, 100)
    : 100;
  const isMultiplied = hasMultiplier(entry) && multipliedSeconds > 0;

  const block = existingBlock || document.createElement("article");
  const isCompact = height < 22;
  block.className = [
    "entry-block",
    entry.end_at ? "" : "active-entry",
    entry.status === "needs_review" ? "needs-review" : "",
    isMultiplied ? "multiplied-entry" : "",
    isCompact ? "compact-entry" : "",
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
  const detailsLabel = [entry.description, entry.task].filter(Boolean).join(" - ") || "No task or description";
  const durationLabel = isCompact
    ? formatCompactElapsed(segment.totalSeconds || 0)
    : formatElapsed(Math.round(segment.totalSeconds || 0));
  block.title = [
    projectLabel,
    detailsLabel,
    durationLabel
  ].filter(Boolean).join("\n");
  if (isMultiplied) block.style.setProperty("--actual-percent", `${actualPercent}%`);
  let fill = block.querySelector(".entry-fill");
  let content = block.querySelector(".entry-content");
  if (!fill || !content) {
    fill = document.createElement("div");
    fill.className = "entry-fill";
    fill.setAttribute("aria-hidden", "true");
    content = document.createElement("div");
    content.className = "entry-content";
    const project = document.createElement("div");
    project.className = "entry-project";
    const dot = document.createElement("span");
    dot.className = "calendar-project-dot";
    dot.setAttribute("aria-hidden", "true");
    const taskText = document.createElement("span");
    taskText.className = "entry-project-text";
    project.append(dot, taskText);
    const details = document.createElement("div");
    details.className = "entry-details";
    const duration = document.createElement("div");
    duration.className = "entry-duration";
    content.append(details, project, duration);
    block.append(fill, content);
  }
  fill.setAttribute("aria-hidden", "true");
  const project = content.querySelector(".entry-project");
  const dot = project.querySelector(".calendar-project-dot");
  dot.title = projectLabel;
  content.querySelector(".entry-project-text").textContent = entry.task || "No task";
  content.querySelector(".entry-details").textContent = entry.description || "";
  content.querySelector(".entry-duration").textContent = durationLabel;

  const resizeEdges = new Set();
  if (entry.end_at && entry.id === selectedEntryId && segment.startsEntry) resizeEdges.add("top");
  if (entry.end_at && entry.id === selectedEntryId && segment.endsEntry) resizeEdges.add("bottom");
  for (const handle of block.querySelectorAll(".resize-handle")) {
    if (!resizeEdges.has(handle.dataset.resizeEdge)) handle.remove();
  }
  for (const edge of resizeEdges) {
    const handle = block.querySelector(`.resize-handle-${edge}`) || createResizeHandle(edge, entry);
    handle.setAttribute("aria-label", `${edge === "top" ? "Change start" : "Change end"} of ${entryTitle(entry)}`);
    handle.title = edge === "top" ? "Drag to change start time" : "Drag to change end time";
    if (!handle.parentElement) block.append(handle);
  }
  if (!existingBlock) {
    block.addEventListener("pointerdown", beginDrag);
    block.addEventListener("click", selectEntryFromBlock);
    block.addEventListener("keydown", selectEntryFromKeyboard);
  }
  // The caller reconciles the column order after all blocks are updated. Do
  // not append reused blocks here: moving every block on every refresh creates
  // unnecessary DOM mutations even when the layout has not changed.
  return block;
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
  if (!grid.querySelector(".time-axis")) renderTimeAxis(grid);

  for (let index = 0; index < DAY_COUNT; index += 1) {
    let column = grid.querySelector(`.day-column[data-day-index="${index}"]`);
    if (!column) {
      column = document.createElement("div");
      column.dataset.dayIndex = String(index);
      grid.append(column);
    }
    column.className = `day-column${isSameLocalDate(addDays(weekStart, index), today) ? " today" : ""}`;

    let clockChangeArea = column.querySelector(".clock-change-area");
    if (!clockChangeArea) {
      clockChangeArea = document.createElement("section");
      clockChangeArea.className = "clock-change-area";
      const heading = document.createElement("strong");
      heading.textContent = "Clock-change entries";
      clockChangeArea.append(heading);
      column.append(clockChangeArea);
    }
    clockChangeArea.replaceChildren(clockChangeArea.firstElementChild || (() => {
      const heading = document.createElement("strong");
      heading.textContent = "Clock-change entries";
      return heading;
    })());
    for (const special of (segmentsByDay.clockChangeEntries || []).filter((item) => item.dayIndex === index)) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "clock-change-entry";
      item.dataset.entryId = special.entry.id;
      item.textContent = `${entryTitle(special.entry)} · ${localTime(special.start)} ${special.startOffset} → ${localTime(special.end)} ${special.endOffset} · ${formatElapsed(special.elapsedSeconds)}`;
      item.title = "Clock-change entry. Edit non-time fields or delete it; move and resize are disabled.";
      item.addEventListener("click", selectEntryFromBlock);
      clockChangeArea.append(item);
    }
    clockChangeArea.hidden = !clockChangeArea.children.length || clockChangeArea.children.length === 1;

    const segments = layoutSegments(segmentsByDay[index]);
    const existingBlocks = new Map([...column.querySelectorAll(".entry-block")]
      .map((block) => [block.dataset.entryId, block]));
    const usedBlocks = new Set();
    const nextBlocks = [];
    for (const segment of segments) {
      const block = renderEntryBlock(column, segment, existingBlocks.get(segment.entry.id));
      usedBlocks.add(block);
      nextBlocks.push(block);
    }
    const desired = [clockChangeArea, ...nextBlocks];
    for (let position = 0; position < desired.length; position += 1) {
      const node = desired[position];
      if (column.children[position] !== node) {
        column.insertBefore(node, column.children[position] || null);
      }
    }
    for (const block of existingBlocks.values()) {
      if (!usedBlocks.has(block)) block.remove();
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

function handleViewportResize() {
  syncScrollbarGutter();
  if (!$("#calendarEditOverlay").hidden) clampEditorToViewport();
}

async function performRender(generation, requestedWeekStart) {
  const weekEnd = addDays(requestedWeekStart, DAY_COUNT);
  const [nextEntries, configuredStart] = await Promise.all([
    getEntriesIntersecting(requestedWeekStart, weekEnd),
    getSetting(SETTING_KEY.WORKDAY_START_HOUR, DEFAULT_WORKDAY_START_HOUR)
  ]);
  if (
    generation !== renderGeneration
    || gesture
    || weekStart.getTime() !== requestedWeekStart.getTime()
  ) {
    if (gesture) renderPending = true;
    return;
  }
  renderedEntries = nextEntries;
  const startHour = normalizeWorkdayStartHour(configuredStart);
  const segmentsByDay = buildSegments(nextEntries, requestedWeekStart);
  $("#weekPicker").value = isoWeekValue(weekStart);
  renderHeader(dailyTotalsFromSegments(segmentsByDay));
  renderCalendar(segmentsByDay);
  syncScrollbarGutter();
  scrollToWorkingHours(startHour.valid ? startHour.start : DEFAULT_WORKDAY_START_HOUR);
}

function render() {
  renderGeneration += 1;
  renderPending = true;
  if (gesture || renderInFlight) return renderInFlight || Promise.resolve();

  const run = async () => {
    while (renderPending && !gesture) {
      renderPending = false;
      const generation = renderGeneration;
      const requestedWeekStart = new Date(weekStart);
      await performRender(generation, requestedWeekStart);
    }
  };
  renderInFlight = run().finally(() => {
    renderInFlight = null;
    if (renderPending && !gesture) void render();
  });
  return renderInFlight;
}

function refreshActiveTimers() {
  if (gesture || !renderedEntries.some((entry) => !entry.end_at && !entry.deleted_at)) return;
  const segmentsByDay = buildSegments(renderedEntries, weekStart);
  renderHeader(dailyTotalsFromSegments(segmentsByDay));
  renderCalendar(segmentsByDay);
  syncScrollbarGutter();
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

function scrollToWorkingHours(startHour) {
  if (initialScrollDone) return;
  initialScrollDone = true;
  const scroll = $("#calendarScroll");
  scroll.scrollTop = scrollTopForStartHour(startHour, scroll.clientHeight, scroll.scrollHeight);
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
  return entryEditor.fields;
}

function loadEditor(entry) {
  editingEntryId = entry.id;
  editingEntryRevision = Number(entry.revision || 0);
  editingMultiplyValue = entry.multiply || "";
  writeEntryForm(editFields(), entry);
}

function refreshSelectedEntryEditor() {
  const entry = getEntryById(selectedEntryId);
  if (!entry || !editingEntryId) return;
  loadEditor(entry);
  positionPopupForEntry(entry.id);
}

function ensurePreview(state) {
  if (state.preview) return state.preview;
  const element = document.createElement("div");
  element.className = "drag-preview";
  element.textContent = "Move";
  state.preview = element;
  return element;
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

function dragTargetFromPointer(clientX, clientY, state) {
  const best = columnFromPointer(clientX);
  if (!best) return null;

  const rawTop = clientY - best.rect.top - state.offsetY;
  const snappedMinutes = Math.round((rawTop / PX_PER_MINUTE) / SNAP_MINUTES) * SNAP_MINUTES;
  const minute = clamp(snappedMinutes, 0, MINUTES_PER_DAY - SNAP_MINUTES);
  const dayIndex = Number(best.column.dataset.dayIndex || 0);
  const date = localDateAtMinute(addDays(weekStart, dayIndex), minute);
  return date ? { column: best.column, dayIndex, minute, date } : null;
}

function updatePreview(target, state) {
  if (!target) return;
  const element = ensurePreview(state);
  const durationMinutes = Math.max(SNAP_MINUTES, Math.round(state.durationMs / MINUTE_MS));
  const visibleMinutes = Math.min(durationMinutes, MINUTES_PER_DAY - target.minute);
  element.style.top = `${target.minute * PX_PER_MINUTE + 2}px`;
  element.style.left = "3px";
  element.style.width = "calc(100% - 6px)";
  element.style.height = `${Math.max(22, visibleMinutes * PX_PER_MINUTE - 4)}px`;
  element.textContent = `${entryTitle(state.entry)} · ${minutesToLabel(target.minute)}`;
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
  if (gesture) return;
  const block = event.currentTarget;
  const entry = getEntryById(block.dataset.entryId);
  // A running timer has no settled duration and must stay anchored to its
  // original start time while it is active.
  if (!entry || !entry.end_at || isActionRunning(`drag-entry:${entry.id}`)) return;

  event.preventDefault();
  const rect = block.getBoundingClientRect();
  gesture = {
    kind: "move",
    pointerId: event.pointerId,
    entry,
    block,
    startX: event.clientX,
    startY: event.clientY,
    offsetY: event.clientY - rect.top,
    durationMs: durationMsForDrag(entry),
    active: false,
    target: null
  };
  gesture.finish = (finishEvent) => {
    if (!ownsGesturePointer(gesture, finishEvent.pointerId, "move")) return;
    return runCalendarAction(`drag-entry:${entry.id}`, endDrag, {
      expectedRevision: entry.revision,
      afterRender: refreshSelectedEntryEditor
    });
  };
  gesture.cancel = (cancelEvent) => {
    if (!ownsGesturePointer(gesture, cancelEvent.pointerId, "move")) return;
    cancelGesture(gesture);
  };
  block.setPointerCapture(event.pointerId);
  window.addEventListener("pointermove", moveDrag);
  window.addEventListener("pointerup", gesture.finish);
  window.addEventListener("pointercancel", gesture.cancel);
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
  const date = localDateAtMinute(addDays(weekStart, dayIndex), minute);
  if (!date) return null;
  return { column: best.column, dayIndex, minute, date };
}

function showResizeGuide(target, state) {
  if (!target) return;
  if (!state.preview) {
    state.preview = document.createElement("div");
    state.preview.className = "resize-guide";
  }
  state.preview.style.top = `${clamp(target.minute * PX_PER_MINUTE - 1, 0, MINUTES_PER_DAY * PX_PER_MINUTE - 3)}px`;
  target.column.append(state.preview);
}

function clearGesture(state, moveHandler, sourceClass) {
  if (gesture !== state) return false;
  gesture = null;
  window.removeEventListener("pointermove", moveHandler);
  window.removeEventListener("pointerup", state.finish);
  window.removeEventListener("pointercancel", state.cancel || state.finish);
  state.block.classList.remove(sourceClass);
  state.preview?.remove();
  if (renderPending) void render();
  return true;
}

function cancelGesture(state) {
  if (!state || gesture !== state) return;
  clearGesture(state, state.kind === "move" ? moveDrag : moveResize,
    state.kind === "move" ? "drag-source" : "resize-source");
  setStatus("Gesture cancelled", "ready");
}

function beginResize(event) {
  if (event.button !== 0) return;
  if (gesture) return;
  const handle = event.currentTarget;
  const block = handle.closest(".entry-block");
  const entry = block && getEntryById(block.dataset.entryId);
  if (!entry || !entry.end_at || entry.id !== selectedEntryId || isActionRunning(`resize-entry:${entry.id}`)) return;

  event.preventDefault();
  event.stopPropagation();
  gesture = {
    kind: "resize",
    pointerId: event.pointerId,
    edge: handle.dataset.resizeEdge,
    entry,
    block,
    handle,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    target: null
  };
  gesture.finish = (finishEvent) => {
    if (!ownsGesturePointer(gesture, finishEvent.pointerId, "resize")) return;
    return runCalendarAction(`resize-entry:${entry.id}`, endResize, {
      expectedRevision: entry.revision,
      afterRender: refreshSelectedEntryEditor
    });
  };
  gesture.cancel = (cancelEvent) => {
    if (!ownsGesturePointer(gesture, cancelEvent.pointerId, "resize")) return;
    cancelGesture(gesture);
  };
  handle.setPointerCapture(event.pointerId);
  window.addEventListener("pointermove", moveResize);
  window.addEventListener("pointerup", gesture.finish);
  window.addEventListener("pointercancel", gesture.cancel);
}

function moveResize(event) {
  if (!ownsGesturePointer(gesture, event.pointerId, "resize")) return;
  if (!gesture.active) {
    const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
    if (distance < DRAG_THRESHOLD_PX) return;
    gesture.active = true;
    gesture.block.classList.add("resize-source");
  }

  const target = resizeTargetFromPointer(event.clientX, event.clientY);
  if (!target) return;
  const start = new Date(gesture.entry.start_at);
  const end = new Date(gesture.entry.end_at);
  const earliestEnd = addMinutes(start, RESIZE_SNAP_MINUTES);
  const latestStart = addMinutes(end, -RESIZE_SNAP_MINUTES);
  if (gesture.edge === "top" && target.date > latestStart) {
    target.date = snapDateToGrid(latestStart, "down");
  }
  if (gesture.edge === "bottom" && target.date < earliestEnd) {
    target.date = snapDateToGrid(earliestEnd, "up");
  }
  if (!target.date) return;

  const targetDay = dayIndexInWeek(weekStart, target.date);
  if (targetDay >= 0 && targetDay < DAY_COUNT) {
    target.dayIndex = targetDay;
    target.column = document.querySelector(`.day-column[data-day-index="${targetDay}"]`);
    target.minute = minutesSinceStartOfDay(target.date);
  }
  gesture.target = target;
  showResizeGuide(target, gesture);

  const nextStart = gesture.edge === "top" ? target.date : start;
  const nextEnd = gesture.edge === "bottom" ? target.date : end;
  setStatus(`${gesture.edge === "top" ? "Start" : "End"}: ${shortDay(target.date)} ${localTime(target.date)} · ${formatElapsed(Math.round(actualDurationSeconds(nextStart, nextEnd)))}`);
}

async function endResize() {
  if (!gesture || gesture.kind !== "resize") return;
  const state = gesture;
  clearGesture(state, moveResize, "resize-source");

  if (!state.active || !state.target) {
    setStatus("Ready", "synced");
    return;
  }

  state.block.dataset.skipClick = "true";
  setTimeout(() => {
    state.block.dataset.skipClick = "";
  }, 0);

  const changes = resizeEntryChanges(state.edge, state.target.date);
  const undo = {
    id: state.entry.id,
    kind: "resize",
    start_at: state.entry.start_at,
    end_at: state.entry.end_at,
    revision: null
  };

  const updated = await updateEntry(state.entry.id, changes, { expectedRevision: state.entry.revision });
  undo.revision = updated.revision;
  setCalendarUndo(undo);
  setStatus("Entry resized");
  queueSync();
}

function moveDrag(event) {
  if (!ownsGesturePointer(gesture, event.pointerId, "move")) return;
  if (!gesture.active) {
    const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
    if (distance < DRAG_THRESHOLD_PX) return;
    gesture.active = true;
    gesture.block.classList.add("drag-source");
  }

  const target = dragTargetFromPointer(event.clientX, event.clientY, gesture);
  gesture.target = target;
  updatePreview(target, gesture);
  if (target) setStatus(`Drop at ${shortDay(addDays(weekStart, target.dayIndex))} ${minutesToLabel(target.minute)}`);
}

async function endDrag() {
  if (!gesture || gesture.kind !== "move") return;
  const state = gesture;
  clearGesture(state, moveDrag, "drag-source");

  if (!state.active || !state.target) {
    setStatus("Ready", "synced");
    return;
  }

  state.block.dataset.skipClick = "true";
  setTimeout(() => {
    state.block.dataset.skipClick = "";
  }, 0);

  const newStart = state.target.date;
  const changes = moveEntryChanges(state.entry, { start_at: newStart.toISOString() }, state.durationMs);

  const undo = {
    id: state.entry.id,
    kind: "move",
    start_at: state.entry.start_at,
    end_at: state.entry.end_at,
    revision: null
  };
  const updated = await updateEntry(state.entry.id, changes, { expectedRevision: state.entry.revision });
  undo.revision = updated.revision;
  setCalendarUndo(undo);
  setStatus("Entry moved");
  queueSync();
}

async function undoCalendarChange() {
  if (!lastCalendarUndo) return;
  const undo = lastCalendarUndo;
  setCalendarUndo(null);

  try {
    await updateEntry(undo.id, {
      start_at: undo.start_at,
      end_at: undo.end_at
    }, { expectedRevision: undo.revision });
    setStatus(`${undo.kind[0].toUpperCase()}${undo.kind.slice(1)} undone`);
    queueSync();
  } catch (error) {
    setCalendarUndo(undo);
    throw error;
  }
}

async function runSync({ force = false } = {}) {
  setStatus("Syncing...", "pending");
  try {
    const result = await requestBackgroundSync({ force });
    setStatus(result.warning || result.status);
  } catch (error) {
    setStatus(`${statusFromError(error)}: ${formatError(error)}`);
  }
}

function queueSync() {
  // Rendering belongs to the local transaction; remote sync continues in the
  // background even if this page is navigated away from.
  void runSync({ force: false });
}

async function mergeSelectedEntry() {
  const sourceId = $mergeTarget.value;
  if (!selectedEntryId || !sourceId) return;

  setCalendarUndo(null);
  const target = getEntryById(selectedEntryId);
  const source = getEntryById(sourceId);
  if (!target || !source) throw new Error("Entry changed in another window; refreshed");
  await mergeEntries(selectedEntryId, sourceId, {
    expectedRevisions: {
      [selectedEntryId]: target.revision,
      [sourceId]: source.revision
    }
  });
  closeEditor();
  setStatus("Entries merged");
  queueSync();
}

async function duplicateSelectedEntry() {
  if (!selectedEntryId) return;

  setCalendarUndo(null);
  const entry = getEntryById(selectedEntryId);
  if (!entry) throw new Error("Entry changed in another window; refreshed");
  const duplicate = await duplicateEntry(selectedEntryId, { expectedRevision: entry.revision });
  closeEditor();
  selectedEntryId = duplicate.id;
  setStatus("Entry duplicated");
  queueSync();
}

function closeEditor() {
  editingEntryId = "";
  editingEntryRevision = null;
  editingMultiplyValue = "";
  $editForm.reset();
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
  $mergeTarget.replaceChildren(...mergeOptions);
  $mergeButton.disabled = !candidates.length;
  setEntryEditorMergeAvailability($mergeControl, candidates.length > 0);
  $duplicateButton.disabled = !entry.end_at;
  $duplicateButton.title = entry.end_at
    ? "Create a copy at the same date and time"
    : "Stop this entry before duplicating it";

  // Unhidden first so the popup can be measured; positioning it while hidden
  // reports no height.
  $("#calendarEditOverlay").hidden = false;
  positionPopupForEntry(entry.id);
  clampEditorToViewport();
  $editProject.focus();
}

async function deleteCalendarEntry() {
  if (!editingEntryId) return;
  if (!confirm("Delete this time log entry?")) return;
  setCalendarUndo(null);
  await softDeleteEntry(editingEntryId, { expectedRevision: editingEntryRevision });
  closeEditor();
  selectedEntryId = "";
  setStatus("Entry deleted");
  queueSync();
}

async function saveCalendarEdit(event) {
  event.preventDefault();
  if (!editingEntryId) return;

  setCalendarUndo(null);
  await updateEntry(
    editingEntryId,
    readEntryForm(editFields(), { multiplyValue: editingMultiplyValue }),
    { expectedRevision: editingEntryRevision }
  );
  closeEditor();
  setStatus("Entry updated");
  queueSync();
}

async function clearSelection() {
  closeEditor();
  selectedEntryId = "";
  await render();
  setStatus("Ready", "synced");
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
  setCalendarUndo(null);
  weekStart = startOfWeek(nextStart);
  selectedDayKeys = new Set(weekDayKeys(weekStart, DAY_COUNT));
  tempoDaySelectionActive = false;
  setTempoSendMenuOpen(false);
  initialScrollDone = false;
  setStatus("Ready", "synced");
}

async function sendDisplayedWeekToTempo() {
  return tempoController.send();
}

const tempoController = createTempoController({
  getSnapshot: () => ({
    weekStart: new Date(weekStart),
    weekEnd: addDays(weekStart, DAY_COUNT),
    entries: renderedEntries.map((entry) => ({ ...entry }))
  }),
  currentSelection: () => currentDaySelection(),
  getSetting,
  mutateSetting,
  platform,
  setStatus,
  setSelectionActive: setTempoDaySelectionActive
});

function sendWholeWeekToTempo(button) {
  setTempoDaySelectionActive(false);
  return runCalendarAction("send-tempo", sendDisplayedWeekToTempo, { button });
}

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;
  bindMinuteRollover($editStart);
  bindMinuteRollover($editEnd);
  $("#prevWeek").addEventListener("click", (event) => runCalendarAction("change-week", () => changeWeek(addDays(weekStart, -DAY_COUNT)), { button: event.currentTarget }));
  $("#nextWeek").addEventListener("click", (event) => runCalendarAction("change-week", () => changeWeek(addDays(weekStart, DAY_COUNT)), { button: event.currentTarget }));
  $("#todayButton").addEventListener("click", (event) => runCalendarAction("change-week", () => changeWeek(new Date()), { button: event.currentTarget }));
  $("#sendTempoButton").addEventListener("click", (event) => {
    setTempoSendMenuOpen(false);
    runCalendarAction("send-tempo", sendDisplayedWeekToTempo, { button: event.currentTarget });
  });
  $("#tempoSendMenuButton").addEventListener("click", () => {
    setTempoSendMenuOpen($("#tempoSendMenu").hidden);
  });
  $("#sendTempoWeekOption").addEventListener("click", (event) => {
    sendWholeWeekToTempo(event.currentTarget);
  });
  $("#chooseTempoDaysOption").addEventListener("click", () => {
    setTempoDaySelectionActive(true);
    $(".day-send-toggle")?.focus();
  });
  // Delegated so the toggles survive the header rebuild that follows a week change.
  $("#dayHeader").addEventListener("change", (event) => {
    const toggle = event.target;
    if (!toggle?.classList?.contains("day-send-toggle")) return;
    toggleSendDay(toggle.dataset.dayKey, toggle.checked);
  });
  $("#undoCalendarButton").addEventListener("click", (event) => runCalendarAction(`undo-calendar:${lastCalendarUndo?.id || ""}`, undoCalendarChange, {
    button: event.currentTarget,
    expectedRevision: lastCalendarUndo?.revision,
    afterRender: refreshSelectedEntryEditor
  }));
  $duplicateButton.addEventListener("click", (event) => runCalendarAction(`duplicate-entry:${selectedEntryId}`, duplicateSelectedEntry, { button: event.currentTarget }));
  $mergeButton.addEventListener("click", (event) => runCalendarAction(`merge-entry:${selectedEntryId}`, mergeSelectedEntry, { button: event.currentTarget }));
  $editForm.addEventListener("submit", (event) => runCalendarAction(`save-entry:${editingEntryId}`, () => saveCalendarEdit(event), { expectedRevision: editingEntryRevision }));
  entryEditor.actions.cancel.addEventListener("click", () => clearSelection().catch((error) => setStatus(formatError(error))));

  entryEditor.actions.delete.addEventListener("click", (event) => runCalendarAction(`delete-entry:${editingEntryId}`, deleteCalendarEntry, {
    button: event.currentTarget,
    expectedRevision: editingEntryRevision
  }));
  clampEditorToViewport = bindPopupDrag($(".edit-popup"));
  $("#weekPicker").addEventListener("change", (event) => {
    const parsed = weekStartFromInput(event.target.value);
    if (parsed) runCalendarAction("change-week", () => changeWeek(parsed), { button: event.currentTarget });
  });
  document.addEventListener("pointerdown", handleOutsidePointerDown);
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest?.(".tempo-send-control")) setTempoSendMenuOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setTempoSendMenuOpen(false);
  });
  window.addEventListener("resize", handleViewportResize);
}

async function init() {
  bindEvents();
  if (!unsubscribeEntryEvents) {
    unsubscribeEntryEvents = onEntriesChanged(() => {
      void runPageTask({
        page: "calendar",
        phase: "entries-changed",
        task: render,
        onError(error) {
          setStatus(formatError(error));
        }
      });
    });
  }
  await render();
  setStatus("Ready", "synced");
  runCalendarAction("initial-sync", () => runSync({ force: false }));
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      if (!renderedEntries.some((entry) => !entry.end_at && !entry.deleted_at)) return;
      void runPageTask({
        page: "calendar",
        phase: "active-timer-refresh",
        task: refreshActiveTimers,
        onError(error) {
          setStatus(formatError(error));
        }
      });
    }, 60000);
  }
}

window.addEventListener("pagehide", () => {
  if (refreshTimer) clearInterval(refreshTimer);
  if (unsubscribeEntryEvents) unsubscribeEntryEvents();
  document.removeEventListener("pointerdown", handleOutsidePointerDown);
  window.removeEventListener("resize", handleViewportResize);
});

startPage({ page: "calendar", title: "Calendar", init });

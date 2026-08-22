const POPUP_MARGIN_PX = 8;
const POPUP_RECOVERY_HANDLE_PX = 48;

function finiteNonNegative(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function clampAxis(position, size, viewportSize) {
  const safeSize = finiteNonNegative(size);
  const safeViewportSize = finiteNonNegative(viewportSize);
  const recoverySize = Math.min(safeSize, POPUP_RECOVERY_HANDLE_PX);
  const minimum = Math.min(POPUP_MARGIN_PX, Math.max(0, safeViewportSize - recoverySize));
  const maximum = Math.max(minimum, safeViewportSize - recoverySize);

  return clamp(Number.isFinite(position) ? position : minimum, minimum, maximum);
}

/**
 * Keeps a draggable popup's recovery handle within the viewport.
 *
 * Keeping a small corner visible is deliberate: a popup may be larger than a
 * narrow or short viewport, but its handle must still be reachable so it can
 * be dragged back without closing and reopening the editor.
 */
export function clampPopupPosition({ left, top, width, height, viewportWidth, viewportHeight }) {
  return {
    left: clampAxis(left, width, viewportWidth),
    top: clampAxis(top, height, viewportHeight)
  };
}

function setPopupPosition(popup, position) {
  popup.style.left = `${position.left}px`;
  popup.style.top = `${position.top}px`;
}

/**
 * Makes the edit popup draggable by its handle or background.
 *
 * The only shared state is the element's own position, so the listeners and
 * their state live here rather than alongside the calendar's entry dragging.
 */
export function bindPopupDrag(popup) {
  if (!popup) return () => {};
  let state = null;

  function clampToViewport() {
    const rect = popup.getBoundingClientRect();
    setPopupPosition(popup, clampPopupPosition({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    }));
  }

  function move(event) {
    if (!state) return;
    setPopupPosition(popup, clampPopupPosition({
      left: state.originLeft + event.clientX - state.startX,
      top: state.originTop + event.clientY - state.startY,
      width: state.width,
      height: state.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    }));
  }

  function end() {
    clampToViewport();
    state = null;
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", end);
    document.removeEventListener("pointercancel", end);
  }

  popup.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    // Dragging must not steal pointer events from the form itself.
    if (event.target.closest("input, button, select, textarea")) return;

    event.preventDefault();
    const rect = popup.getBoundingClientRect();
    state = {
      startX: event.clientX,
      startY: event.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      width: rect.width,
      height: rect.height
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end, { once: true });
    document.addEventListener("pointercancel", end, { once: true });
  });

  return clampToViewport;
}

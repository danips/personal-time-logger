/**
 * Makes the edit popup draggable by its background.
 *
 * Self-contained: the only shared state is the element's own position, so the
 * listeners and their state live here rather than alongside the calendar's own
 * drag handling, which they have nothing to do with.
 */
export function bindPopupDrag(popup) {
  if (!popup) return;
  let state = null;

  function move(event) {
    if (!state) return;
    popup.style.left = `${state.originLeft + event.clientX - state.startX}px`;
    popup.style.top = `${state.originTop + event.clientY - state.startY}px`;
  }

  function end() {
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
      originTop: rect.top
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end, { once: true });
    document.addEventListener("pointercancel", end, { once: true });
  });
}

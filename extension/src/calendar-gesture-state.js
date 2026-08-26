/**
 * Pure state and change calculations shared by the calendar pointer handlers.
 * Keeping pointer ownership here makes the gesture contract testable without
 * requiring a browser DOM in unit tests.
 */
export function ownsGesturePointer(gesture, pointerId, kind) {
  return Boolean(gesture && gesture.kind === kind && gesture.pointerId === pointerId);
}

export function moveEntryChanges(entry, target, durationMs) {
  const newStart = new Date(target.start_at);
  const changes = { start_at: newStart.toISOString() };
  if (entry.end_at) changes.end_at = new Date(newStart.getTime() + durationMs).toISOString();
  return changes;
}

export function resizeEntryChanges(edge, targetDate) {
  return edge === "top"
    ? { start_at: new Date(targetDate).toISOString() }
    : { end_at: new Date(targetDate).toISOString() };
}

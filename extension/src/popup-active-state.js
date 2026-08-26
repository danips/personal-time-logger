export function activeTimerState(entry, {
  elapsed = "00:00:00",
  newTimerOpen = false,
  label = entry?.task || entry?.project || "timer"
} = {}) {
  const active = Boolean(entry);
  return {
    title: entry?.task || "No task",
    description: entry?.description || "",
    elapsed,
    stopVisible: active,
    running: active,
    ariaLabel: active
      ? `Edit active timer ${label}`
      : newTimerOpen ? "Hide new timer" : "Start a new timer",
    iconActive: active
  };
}

export function elapsedTimerState(entry, elapsed = "00:00:00") {
  return { elapsed: entry ? elapsed : "00:00:00" };
}

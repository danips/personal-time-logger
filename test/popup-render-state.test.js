import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { activeTimerState, activeTimerWarningState } from "../extension/src/popup-active-state.js";

describe("popup active render state", () => {
  it("renders the complete active state and toolbar state together", () => {
    assert.deepEqual(activeTimerState({ task: "Focus", description: "Deep work" }, { elapsed: "00:12:34" }), {
      title: "Focus",
      description: "Deep work",
      elapsed: "00:12:34",
      stopVisible: true,
      running: true,
      ariaLabel: "Edit active timer Focus"
    });
  });

  it("keeps inactive accessibility state available for the new-timer control", () => {
    assert.deepEqual(activeTimerState(null, { elapsed: "00:00:00", newTimerOpen: true }), {
      title: "No task",
      description: "",
      elapsed: "00:00:00",
      stopVisible: false,
      running: false,
      ariaLabel: "Hide new timer"
    });
  });

  it("flags an overnight timer using the analytics threshold without changing it", () => {
    const timer = {
      id: "overnight",
      task: "Night shift",
      start_at: "2026-09-11T08:00:00.000Z",
      end_at: "",
      revision: 4,
      device_id: "laptop"
    };
    const [warning] = activeTimerWarningState([timer], { now: new Date("2026-09-12T17:00:00.000Z") });
    assert.equal(warning.stale, true);
    assert.equal(warning.elapsedSeconds, 118800);
    assert.equal(timer.end_at, "");
    assert.equal(timer.revision, 4);
  });

  it("keeps every competing active timer independently actionable", () => {
    const warnings = activeTimerWarningState([
      { id: "first", start_at: "2026-09-12T08:00:00.000Z", end_at: "", revision: 2, device_id: "desktop" },
      { id: "second", start_at: "2026-09-12T09:00:00.000Z", end_at: "", revision: 7, device_id: "laptop" }
    ], { now: new Date("2026-09-12T10:00:00.000Z") });
    assert.deepEqual(warnings.map(({ entry, stale }) => [entry.id, entry.device_id, stale]), [
      ["first", "desktop", false],
      ["second", "laptop", false]
    ]);
  });
});

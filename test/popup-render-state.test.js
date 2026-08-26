import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { activeTimerState, elapsedTimerState } from "../extension/src/popup-active-state.js";

describe("popup active render state", () => {
  it("renders the complete active state and toolbar state together", () => {
    assert.deepEqual(activeTimerState({ task: "Focus", description: "Deep work" }, { elapsed: "00:12:34" }), {
      title: "Focus",
      description: "Deep work",
      elapsed: "00:12:34",
      stopVisible: true,
      running: true,
      ariaLabel: "Edit active timer Focus",
      iconActive: true
    });
  });

  it("lets elapsed ticks update only elapsed output", () => {
    assert.deepEqual(elapsedTimerState({ task: "Focus" }, "00:12:35"), { elapsed: "00:12:35" });
    assert.deepEqual(activeTimerState(null, { elapsed: "00:00:00", newTimerOpen: true }), {
      title: "No task",
      description: "",
      elapsed: "00:00:00",
      stopVisible: false,
      running: false,
      ariaLabel: "Hide new timer",
      iconActive: false
    });
  });
});

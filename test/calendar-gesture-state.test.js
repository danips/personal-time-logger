import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  moveEntryChanges,
  ownsGesturePointer,
  resizeEntryChanges
} from "../extension/src/calendar-gesture-state.js";

const entry = {
  id: "entry-1",
  start_at: "2026-08-10T09:00:00.000Z",
  end_at: "2026-08-10T10:00:00.000Z"
};

describe("calendar gesture behavior", () => {
  it("keeps move ownership with the initiating pointer and computes the moved interval", () => {
    const gesture = { kind: "move", pointerId: 11 };
    assert.equal(ownsGesturePointer(gesture, 12, "move"), false);
    assert.equal(ownsGesturePointer(gesture, 11, "move"), true);
    assert.deepEqual(moveEntryChanges(entry, { start_at: "2026-08-10T13:15:00.000Z" }, 3600000), {
      start_at: "2026-08-10T13:15:00.000Z",
      end_at: "2026-08-10T14:15:00.000Z"
    });
  });

  it("keeps resize ownership fenced and releases it when the gesture finishes", () => {
    const gesture = { kind: "resize", pointerId: 7 };
    assert.equal(ownsGesturePointer(gesture, 8, "resize"), false);
    assert.equal(ownsGesturePointer(gesture, 7, "resize"), true);
    assert.equal(ownsGesturePointer(null, 7, "resize"), false);
    assert.deepEqual(resizeEntryChanges("top", "2026-08-10T08:30:00.000Z"), {
      start_at: "2026-08-10T08:30:00.000Z"
    });
    assert.deepEqual(resizeEntryChanges("bottom", "2026-08-10T10:30:00.000Z"), {
      end_at: "2026-08-10T10:30:00.000Z"
    });
  });
});

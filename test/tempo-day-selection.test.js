import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tempoDaySelectionState, weekDayKeys } from "../extension/src/tempo-day-selection.js";

// Local Date constructors keep these assertions timezone independent: both the
// input and the expected keys are local civil dates.
const MONDAY = new Date(2026, 6, 27);

describe("calendar week day keys", () => {
  it("lists the week in display order across a month boundary", () => {
    assert.deepEqual(weekDayKeys(new Date(2026, 6, 27), 7), [
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02"
    ]);
  });

  // A week containing a DST transition is shorter or longer than 7 * 24 hours,
  // so the keys have to come from calendar arithmetic rather than added hours.
  it("keeps one key per civil day through a daylight saving change", () => {
    assert.deepEqual(weekDayKeys(new Date(2026, 2, 23), 7), [
      "2026-03-23",
      "2026-03-24",
      "2026-03-25",
      "2026-03-26",
      "2026-03-27",
      "2026-03-28",
      "2026-03-29"
    ]);
  });

  it("returns no keys for an unusable week start or day count", () => {
    for (const [start, count] of [
      [new Date("nonsense"), 7],
      [MONDAY, 0],
      [MONDAY, -1],
      [MONDAY, 1.5],
      [MONDAY, "seven"]
    ]) {
      assert.deepEqual(weekDayKeys(start, count), []);
    }
  });
});

describe("Tempo day selection state", () => {
  const days = weekDayKeys(MONDAY, 7);

  it("describes a full week as the displayed week", () => {
    const state = tempoDaySelectionState(days, days);

    assert.deepEqual(state, {
      includedDays: new Set(days),
      selectedCount: 7,
      noneSelected: false,
      scopeLabel: "the displayed week",
      repeatScopeLabel: "week"
    });
  });

  it("counts and names a partial selection", () => {
    const state = tempoDaySelectionState([days[1], days[3]], days);

    assert.deepEqual(state.includedDays, new Set(["2026-07-28", "2026-07-30"]));
    assert.equal(state.selectedCount, 2);
    assert.equal(state.noneSelected, false);
    assert.equal(state.scopeLabel, "2 selected days");
    assert.equal(state.repeatScopeLabel, "days");
  });

  it("keeps a single day singular in both labels", () => {
    const state = tempoDaySelectionState([days[4]], days);

    assert.equal(state.scopeLabel, "1 selected day");
    assert.equal(state.repeatScopeLabel, "day");
  });

  it("reports an empty selection so the send can be blocked", () => {
    const state = tempoDaySelectionState([], days);

    assert.equal(state.noneSelected, true);
    assert.equal(state.selectedCount, 0);
    assert.deepEqual(state.includedDays, new Set());
  });

  // Selected keys outlive nothing: the calendar resets them per week. Restricting
  // to the offered days anyway keeps a stale key from ever widening a send.
  it("ignores selected days outside the displayed week", () => {
    const state = tempoDaySelectionState([days[0], "2026-01-01"], days);

    assert.deepEqual(state.includedDays, new Set([days[0]]));
    assert.equal(state.selectedCount, 1);
  });

  it("accepts sets and arrays alike and tolerates unusable input", () => {
    assert.deepEqual(tempoDaySelectionState(new Set(days), days).includedDays, new Set(days));
    assert.equal(tempoDaySelectionState(null, days).noneSelected, true);
    assert.equal(tempoDaySelectionState(days, null).noneSelected, true);
    assert.equal(tempoDaySelectionState(days, []).scopeLabel, "0 selected days");
  });
});

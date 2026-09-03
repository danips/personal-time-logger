import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addDays,
  durationSeconds,
  formatElapsed,
  fromLocalInputValue,
  localDateKey,
  startOfLocalDay,
  startOfLocalWeek,
  toLocalInputValue
} from "../extension/src/time.js";

describe("durationSeconds", () => {
  it("measures the gap between two timestamps", () => {
    assert.equal(durationSeconds("2026-07-20T09:00:00.000Z", "2026-07-20T10:30:00.000Z"), 5400);
  });

  it("returns 0 when the end precedes the start", () => {
    assert.equal(durationSeconds("2026-07-20T10:00:00.000Z", "2026-07-20T09:00:00.000Z"), 0);
  });

  it("returns 0 for missing or unparseable input", () => {
    assert.equal(durationSeconds("", "2026-07-20T10:00:00.000Z"), 0);
    assert.equal(durationSeconds("2026-07-20T09:00:00.000Z", ""), 0);
    assert.equal(durationSeconds("nonsense", "2026-07-20T10:00:00.000Z"), 0);
  });
});

describe("startOfLocalWeek", () => {
  it("treats Monday as the first day", () => {
    // 2026-07-27 is a Monday.
    for (let offset = 0; offset < 7; offset += 1) {
      const day = addDays(new Date(2026, 6, 27, 13, 45), offset);
      assert.equal(localDateKey(startOfLocalWeek(day)), "2026-07-27");
    }
  });

  it("puts Sunday in the week that began the previous Monday", () => {
    assert.equal(localDateKey(startOfLocalWeek(new Date(2026, 6, 26))), "2026-07-20");
  });

  it("returns a midnight boundary", () => {
    const start = startOfLocalWeek(new Date(2026, 6, 29, 23, 59, 59));
    assert.equal(start.getHours(), 0);
    assert.equal(start.getMinutes(), 0);
    assert.equal(start.getSeconds(), 0);
  });
});

describe("addDays", () => {
  it("crosses month and year boundaries", () => {
    assert.equal(localDateKey(addDays(new Date(2026, 11, 31), 1)), "2027-01-01");
    assert.equal(localDateKey(addDays(new Date(2026, 0, 1), -1)), "2025-12-31");
  });

  it("does not mutate its argument", () => {
    const original = new Date(2026, 6, 27);
    addDays(original, 5);
    assert.equal(localDateKey(original), "2026-07-27");
  });
});

describe("startOfLocalDay", () => {
  it("keeps the calendar date and zeroes the time", () => {
    const start = startOfLocalDay(new Date(2026, 6, 27, 18, 30));
    assert.equal(localDateKey(start), "2026-07-27");
    assert.equal(start.getHours(), 0);
  });
});

describe("formatElapsed", () => {
  it("pads hours, minutes and seconds", () => {
    assert.equal(formatElapsed(0), "00:00:00");
    assert.equal(formatElapsed(59), "00:00:59");
    assert.equal(formatElapsed(3600), "01:00:00");
    assert.equal(formatElapsed(45296), "12:34:56");
  });

  it("does not roll hours over at 24", () => {
    assert.equal(formatElapsed(90000), "25:00:00");
  });

  it("clamps negative and unusable values to zero", () => {
    assert.equal(formatElapsed(-10), "00:00:00");
    assert.equal(formatElapsed(undefined), "00:00:00");
    assert.equal(formatElapsed(Infinity), "00:00:00");
  });

  it("floors fractional elapsed seconds", () => {
    assert.equal(formatElapsed(59.999), "00:00:59");
    assert.equal(formatElapsed(3600.75), "01:00:00");
  });
});

describe("local input values", () => {
  it("round-trips a local datetime through the input format", () => {
    const iso = new Date(2026, 6, 27, 9, 5, 30).toISOString();
    const inputValue = toLocalInputValue(iso);
    assert.match(inputValue, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    assert.deepEqual(fromLocalInputValue(inputValue), { kind: "instant", iso });
  });

  it("accepts single-digit local date and time components", () => {
    const iso = new Date(2026, 6, 7, 9, 5, 4).toISOString();
    assert.deepEqual(fromLocalInputValue("2026-7-7T9:5:4"), { kind: "instant", iso });
    assert.deepEqual(fromLocalInputValue("2026-7-7T9:5"), {
      kind: "instant",
      iso: new Date(2026, 6, 7, 9, 5).toISOString()
    });
  });

  it("tags empty and unparseable values separately", () => {
    assert.equal(toLocalInputValue(""), "");
    assert.equal(toLocalInputValue("nonsense"), "");
    assert.deepEqual(fromLocalInputValue(""), { kind: "empty" });
    assert.deepEqual(fromLocalInputValue("nonsense"), { kind: "invalid", reason: "format" });
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ANALYTICS_PERIOD_PRESET as PRESET,
  resolveAnalyticsPeriod
} from "../extension/src/analytics-period.js";

process.env.TZ = "Europe/Lisbon";

function local(year, month, day, hour = 0, minute = 0) {
  return new Date(year, month - 1, day, hour, minute);
}

function parts(date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];
}

describe("analytics period resolution", () => {
  it("compares this week to the same elapsed point last week", () => {
    const period = resolveAnalyticsPeriod(PRESET.THIS_WEEK, { now: local(2026, 9, 3, 14, 30) });
    assert.deepEqual(parts(period.primary.start), [2026, 8, 31, 0, 0]);
    assert.deepEqual(parts(period.primary.end), [2026, 9, 3, 14, 30]);
    assert.deepEqual(parts(period.comparison.start), [2026, 8, 24, 0, 0]);
    assert.deepEqual(parts(period.comparison.end), [2026, 8, 27, 14, 30]);
  });

  it("resolves two complete prior calendar weeks", () => {
    const period = resolveAnalyticsPeriod(PRESET.LAST_WEEK, { now: local(2026, 9, 3, 14) });
    assert.deepEqual(parts(period.primary.start), [2026, 8, 24, 0, 0]);
    assert.deepEqual(parts(period.primary.end), [2026, 8, 31, 0, 0]);
    assert.deepEqual(parts(period.comparison.start), [2026, 8, 17, 0, 0]);
    assert.deepEqual(parts(period.comparison.end), [2026, 8, 24, 0, 0]);
  });

  it("resolves month-to-date and clamps a shorter previous month", () => {
    const ordinary = resolveAnalyticsPeriod(PRESET.THIS_MONTH, { now: local(2026, 9, 18, 9, 15) });
    assert.deepEqual(parts(ordinary.comparison.end), [2026, 8, 18, 9, 15]);

    const clamped = resolveAnalyticsPeriod(PRESET.THIS_MONTH, { now: local(2027, 3, 31, 9, 15) });
    assert.deepEqual(parts(clamped.comparison.start), [2027, 2, 1, 0, 0]);
    assert.deepEqual(parts(clamped.comparison.end), [2027, 2, 28, 9, 15]);
  });

  it("resolves last month and the month before it", () => {
    const period = resolveAnalyticsPeriod(PRESET.LAST_MONTH, { now: local(2026, 9, 3) });
    assert.deepEqual(parts(period.primary.start), [2026, 8, 1, 0, 0]);
    assert.deepEqual(parts(period.primary.end), [2026, 9, 1, 0, 0]);
    assert.deepEqual(parts(period.comparison.start), [2026, 7, 1, 0, 0]);
  });

  it("uses two adjacent 30-civil-day ranges across DST", () => {
    const period = resolveAnalyticsPeriod(PRESET.LAST_30_DAYS, { now: local(2026, 4, 10, 12) });
    assert.deepEqual(parts(period.primary.start), [2026, 3, 11, 12, 0]);
    assert.deepEqual(parts(period.comparison.start), [2026, 2, 9, 12, 0]);
    assert.notEqual(period.primary.end - period.primary.start, 30 * 86_400_000);
  });

  it("compares year-to-date and clamps leap day", () => {
    const period = resolveAnalyticsPeriod(PRESET.THIS_YEAR, { now: local(2024, 2, 29, 16, 45) });
    assert.deepEqual(parts(period.primary.start), [2024, 1, 1, 0, 0]);
    assert.deepEqual(parts(period.comparison.start), [2023, 1, 1, 0, 0]);
    assert.deepEqual(parts(period.comparison.end), [2023, 2, 28, 16, 45]);
  });

  it("makes custom end dates inclusive and compares equal civil-day counts", () => {
    const period = resolveAnalyticsPeriod(PRESET.CUSTOM, {
      customStart: "2026-03-28",
      customEnd: "2026-03-30"
    });
    assert.deepEqual(parts(period.primary.start), [2026, 3, 28, 0, 0]);
    assert.deepEqual(parts(period.primary.end), [2026, 3, 31, 0, 0]);
    assert.deepEqual(parts(period.comparison.start), [2026, 3, 25, 0, 0]);
    assert.notEqual(period.primary.end - period.primary.start, 3 * 86_400_000);
  });

  it("supports a one-day custom period", () => {
    const period = resolveAnalyticsPeriod(PRESET.CUSTOM, {
      customStart: "2026-09-04",
      customEnd: "2026-09-04"
    });
    assert.deepEqual(parts(period.primary.end), [2026, 9, 5, 0, 0]);
    assert.deepEqual(parts(period.comparison.start), [2026, 9, 3, 0, 0]);
  });

  it("rejects malformed, impossible, and reversed custom ranges", () => {
    assert.throws(() => resolveAnalyticsPeriod(PRESET.CUSTOM, { customStart: "", customEnd: "2026-09-04" }), /valid local date/);
    assert.throws(() => resolveAnalyticsPeriod(PRESET.CUSTOM, { customStart: "2026-02-30", customEnd: "2026-03-01" }), /valid local date/);
    assert.throws(() => resolveAnalyticsPeriod(PRESET.CUSTOM, { customStart: "2026-09-05", customEnd: "2026-09-04" }), /on or after/);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeEntry } from "../src/entries.js";
import { addDays, startOfLocalWeek } from "../src/time.js";
import {
  DAY_COUNT,
  buildSegments,
  clamp,
  dailyTotalsFromSegments,
  dayIndexInWeek,
  durationMsForDrag,
  intersectsWeek,
  isoWeekValue,
  layoutSegments,
  minutesSinceStartOfDay,
  snapDateToGrid,
  weekStartFromInput
} from "../src/calendar-layout.js";

// 2026-07-27 is a Monday, so this is a clean week boundary to work from.
const weekStart = startOfLocalWeek(new Date(2026, 6, 27));
const at = (dayOffset, hour, minute = 0) => new Date(2026, 6, 27 + dayOffset, hour, minute);

const entry = (start, end, over = {}) => normalizeEntry({
  id: `entry-${start.getTime()}`,
  project: "Project",
  start_at: start.toISOString(),
  end_at: end ? end.toISOString() : "",
  duration_seconds: end ? Math.round((end - start) / 1000) : 0,
  ...over
});

describe("buildSegments", () => {
  it("returns one bucket per day of the week", () => {
    assert.equal(buildSegments([], weekStart).length, DAY_COUNT);
  });

  it("places an entry in its own day with minute offsets", () => {
    const segments = buildSegments([entry(at(1, 9), at(1, 10, 30))], weekStart);

    assert.equal(segments[1].length, 1);
    assert.equal(segments.flat().length, 1);

    const [segment] = segments[1];
    assert.equal(segment.startMinute, 540);
    assert.equal(segment.endMinute, 630);
    assert.equal(segment.totalSeconds, 5400);
    assert.equal(segment.startsEntry, true);
    assert.equal(segment.endsEntry, true);
  });

  it("splits an entry crossing midnight and divides its duration", () => {
    const segments = buildSegments([entry(at(0, 23), at(1, 1))], weekStart);

    assert.equal(segments[0].length, 1);
    assert.equal(segments[1].length, 1);
    assert.equal(segments[0][0].startsEntry, true);
    assert.equal(segments[0][0].endsEntry, false);
    assert.equal(segments[0][0].startMinute, 23 * 60);
    assert.equal(segments[0][0].endMinute, 24 * 60);
    assert.equal(segments[1][0].startsEntry, false);
    assert.equal(segments[1][0].endsEntry, true);

    const total = segments.flat().reduce((sum, segment) => sum + segment.totalSeconds, 0);
    assert.equal(total, 2 * 3600);
  });

  it("ignores entries outside the week and unparseable starts", () => {
    const before = entry(at(-3, 9), at(-3, 10));
    const after = entry(at(9, 9), at(9, 10));
    const broken = normalizeEntry({ id: "broken", start_at: "nonsense", end_at: "" });

    assert.equal(buildSegments([before, after, broken], weekStart).flat().length, 0);
  });

  it("clips an entry that starts before the week to the week boundary", () => {
    const segments = buildSegments([entry(at(-1, 22), at(0, 2))], weekStart);
    assert.equal(segments.flat().length, 1);
    assert.equal(segments[0][0].startMinute, 0);
    assert.equal(segments[0][0].startsEntry, false);
  });

  it("keeps multiplier geometry on the actual interval", () => {
    const multiplied = entry(at(1, 9), at(1, 10), { duration_seconds: 5400, multiply: "1.5" });
    const [segment] = buildSegments([multiplied], weekStart)[1];

    assert.equal(segment.actualSeconds, 3600);
    assert.equal(segment.effectiveSeconds, 5400);
    assert.equal(segment.totalSeconds, 5400);
    // A multiplier changes totals, not the chronology on the calendar.
    assert.equal(segment.endMinute - segment.startMinute, 60);
  });

  it("allocates multiplied time proportionally across midnight", () => {
    const multiplied = entry(at(0, 23, 30), at(1, 0, 30), {
      duration_seconds: 7200,
      multiply: "2"
    });
    const segments = buildSegments([multiplied], weekStart);

    assert.equal(segments[0][0].totalSeconds, 3600);
    assert.equal(segments[1][0].totalSeconds, 3600);
    assert.equal(segments[0][0].endMinute - segments[0][0].startMinute, 30);
    assert.equal(segments[1][0].endMinute - segments[1][0].startMinute, 30);
  });
});

describe("layoutSegments", () => {
  const laid = (...ranges) => layoutSegments(ranges.map(([startMinute, endMinute]) => ({ startMinute, endMinute })));

  it("keeps sequential segments in a single full-width lane", () => {
    const segments = laid([540, 600], [600, 660]);
    assert.deepEqual(segments.map((segment) => segment.lane), [0, 0]);
    assert.deepEqual(segments.map((segment) => segment.laneCount), [1, 1]);
  });

  it("puts overlapping segments side by side", () => {
    const segments = laid([540, 660], [600, 720]);
    assert.deepEqual(segments.map((segment) => segment.lane), [0, 1]);
    assert.deepEqual(segments.map((segment) => segment.laneCount), [2, 2]);
  });

  it("reuses a lane once its segment has ended", () => {
    const segments = laid([540, 600], [540, 660], [600, 630]);
    assert.deepEqual(segments.map((segment) => segment.lane), [0, 1, 0]);
  });

  it("scopes the lane count to the overlapping cluster", () => {
    // Two overlapping in the morning, one alone in the afternoon.
    const segments = laid([540, 660], [600, 720], [900, 960]);
    assert.deepEqual(segments.map((segment) => segment.laneCount), [2, 2, 1]);
  });

  it("orders by start then end", () => {
    const segments = laid([600, 660], [540, 700], [540, 560]);
    assert.deepEqual(segments.map((segment) => [segment.startMinute, segment.endMinute]), [
      [540, 560],
      [540, 700],
      [600, 660]
    ]);
  });
});

describe("dailyTotalsFromSegments", () => {
  it("sums each day independently", () => {
    const segments = buildSegments(
      [entry(at(0, 9), at(0, 10)), entry(at(0, 11), at(0, 12)), entry(at(3, 9), at(3, 9, 30))],
      weekStart
    );
    const totals = dailyTotalsFromSegments(segments);

    assert.equal(totals.length, DAY_COUNT);
    assert.equal(totals[0], 7200);
    assert.equal(totals[3], 1800);
    assert.equal(totals[1], 0);
  });
});

describe("intersectsWeek", () => {
  const weekEnd = addDays(weekStart, DAY_COUNT);

  it("accepts an entry inside the week", () => {
    assert.equal(intersectsWeek(entry(at(2, 9), at(2, 10)), weekStart, weekEnd), true);
  });

  it("accepts an entry overlapping either boundary", () => {
    assert.equal(intersectsWeek(entry(at(-1, 22), at(0, 2)), weekStart, weekEnd), true);
    assert.equal(intersectsWeek(entry(at(6, 22), at(7, 2)), weekStart, weekEnd), true);
  });

  it("rejects entries entirely outside and unparseable starts", () => {
    assert.equal(intersectsWeek(entry(at(-5, 9), at(-5, 10)), weekStart, weekEnd), false);
    assert.equal(intersectsWeek(entry(at(20, 9), at(20, 10)), weekStart, weekEnd), false);
    assert.equal(intersectsWeek({ start_at: "nonsense" }, weekStart, weekEnd), false);
  });
});

describe("dayIndexInWeek", () => {
  it("numbers the days from the week start", () => {
    assert.equal(dayIndexInWeek(weekStart, at(0, 12)), 0);
    assert.equal(dayIndexInWeek(weekStart, at(6, 12)), 6);
  });

  it("returns -1 outside the week", () => {
    assert.equal(dayIndexInWeek(weekStart, at(7, 12)), -1);
    assert.equal(dayIndexInWeek(weekStart, at(-1, 12)), -1);
  });
});

describe("week picker values", () => {
  it("round-trips a week through the input value", () => {
    const value = isoWeekValue(at(2, 15));
    assert.match(value, /^\d{4}-W\d{2}$/);
    assert.equal(weekStartFromInput(value).getTime(), weekStart.getTime());
  });

  it("rejects malformed or out-of-range values", () => {
    assert.equal(weekStartFromInput(""), null);
    assert.equal(weekStartFromInput("2026-W"), null);
    assert.equal(weekStartFromInput("2026-W00"), null);
    assert.equal(weekStartFromInput("2026-W54"), null);
    assert.equal(weekStartFromInput("2025-W53"), null);
  });
});

describe("snapDateToGrid", () => {
  it("rounds down or up to the resize interval", () => {
    assert.equal(minutesSinceStartOfDay(snapDateToGrid(at(0, 9, 30), "down")), 570);
    assert.equal(minutesSinceStartOfDay(snapDateToGrid(at(0, 9, 30), "up")), 570);
  });
});

describe("durationMsForDrag", () => {
  it("preserves a completed entry's duration", () => {
    assert.equal(durationMsForDrag(entry(at(0, 9), at(0, 10, 30))), 90 * 60 * 1000);
  });

  it("never returns less than one grid slot", () => {
    assert.equal(durationMsForDrag(entry(at(0, 9), at(0, 9, 5))), 15 * 60 * 1000);
  });
});

describe("clamp", () => {
  it("bounds a value both ways", () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-5, 0, 10), 0);
    assert.equal(clamp(50, 0, 10), 10);
  });
});

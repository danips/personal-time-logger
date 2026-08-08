import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { allocateEntry, entryInterval } from "../src/time-allocation.js";

const entry = {
  id: "crosses-week",
  start_at: "2026-07-26T23:00:00.000Z",
  end_at: "2026-07-27T01:00:00.000Z",
  duration_seconds: 10_800,
  multiply: "1.5"
};

describe("time allocation", () => {
  it("proportionally allocates effective duration to clipped periods", () => {
    const allocation = allocateEntry(entry, "2026-07-27T00:00:00.000Z", "2026-08-03T00:00:00.000Z");

    assert.equal(allocation.start.toISOString(), "2026-07-27T00:00:00.000Z");
    assert.equal(allocation.end.toISOString(), "2026-07-27T01:00:00.000Z");
    assert.equal(allocation.actualSeconds, 3600);
    assert.equal(allocation.effectiveSeconds, 5400);
  });

  it("uses elapsed time for a running entry", () => {
    const interval = entryInterval({ start_at: "2026-07-27T09:00:00.000Z", end_at: "" }, {
      now: new Date("2026-07-27T09:30:00.000Z")
    });
    assert.equal(interval.actualSeconds, 1800);
    assert.equal(interval.effectiveSeconds, 1800);
  });
});

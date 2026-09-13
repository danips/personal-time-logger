import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatUsageCountdown,
  usageSnapshotIsStale,
  usageWindowLabel
} from "../extension/src/usage-presentation.js";

const NOW = Date.parse("2026-09-12T10:00:00.000Z");

describe("usage presentation", () => {
  it("uses the same window names and local reset countdown", () => {
    assert.equal(usageWindowLabel({ window_seconds: 3_600 }, "Primary limit"), "Primary limit");
    assert.equal(usageWindowLabel({ window_seconds: 5 * 60 * 60 }, "Primary limit"), "5-hour limit");
    assert.equal(usageWindowLabel({ window_seconds: 7 * 24 * 60 * 60 }, "Secondary limit"), "Weekly limit");
    assert.equal(formatUsageCountdown("2026-09-12T11:31:00.000Z", NOW), "in 1h 31m");
    assert.equal(formatUsageCountdown("2026-09-12T09:59:00.000Z", NOW), "reset time has passed; refresh to confirm the new allowance");
  });

  it("marks old snapshots stale without changing the stored snapshot", () => {
    const snapshot = { collected_at: "2026-09-12T09:40:00.000Z" };
    assert.equal(usageSnapshotIsStale(snapshot, NOW, 15 * 60 * 1000), true);
    assert.equal(usageSnapshotIsStale({ collected_at: "2026-09-12T09:50:00.000Z" }, NOW, 15 * 60 * 1000), false);
  });
});

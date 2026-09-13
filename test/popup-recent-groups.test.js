import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareRecentEntries,
  filterRecentEntries,
  groupRecentEntries,
  recentFieldValues,
  recentGroupKey,
  recentTotalSeconds
} from "../extension/src/popup-recent-groups.js";

const entry = (id, start, over = {}) => ({
  id,
  project: "Project",
  task: "Task",
  description: "Description",
  start_at: start,
  end_at: "2026-08-30T10:00:00.000Z",
  duration_seconds: 3600,
  multiply: "",
  ...over
});

describe("popup recent grouping", () => {
  it("keeps same-day groups distinct when only the encoded identity changes", () => {
    const first = entry("recent-a", "2026-08-30T09:00:00.000Z");
    const second = entry("recent-b", "2026-08-30T09:30:00.000Z", { description: "Other" });
    assert.notEqual(recentGroupKey(first), recentGroupKey(second));
    const weeks = groupRecentEntries([first, second], {
      start: new Date("2026-08-01T00:00:00.000Z"),
      end: new Date("2026-09-01T00:00:00.000Z")
    });
    assert.equal(weeks[0].days[0].groups.length, 2);
  });

  it("sorts repeated entries newest first deterministically", () => {
    assert.equal(compareRecentEntries(
      entry("older", "2026-08-30T09:00:00.000Z"),
      entry("newer", "2026-08-30T09:30:00.000Z")
    ) > 0, true);
    assert.equal(compareRecentEntries(
      entry("b", "2026-08-30T09:00:00.000Z"),
      entry("a", "2026-08-30T09:00:00.000Z")
    ) < 0, true);
  });

  it("filters the loaded entries without implying an all-history search", () => {
    const entries = [
      entry("match", "2026-08-30T09:00:00.000Z", { project: "Alpha", task: "Review", status: "needs_review" }),
      entry("other", "2026-08-30T09:30:00.000Z", { project: "Beta", task: "Build" })
    ];
    assert.deepEqual(filterRecentEntries(entries, { text: "review", status: "needs_review" }).map(({ id }) => id), ["match"]);
    assert.deepEqual(filterRecentEntries(entries, { project: "alp", task: "rev" }).map(({ id }) => id), ["match"]);
    assert.deepEqual(filterRecentEntries(entries, { text: "missing" }), []);
  });

  it("provides loaded-field suggestions and distinct period totals", () => {
    const entries = [
      entry("first", "2026-08-30T09:00:00.000Z", { project: "Beta", task: "Build", duration_seconds: 1800 }),
      entry("second", "2026-08-30T09:30:00.000Z", { project: "Alpha", task: "Review", duration_seconds: 3600 })
    ];
    const range = { start: new Date("2026-08-30T00:00:00.000Z"), end: new Date("2026-08-31T00:00:00.000Z") };
    assert.deepEqual(recentFieldValues(entries, "project"), ["Alpha", "Beta"]);
    assert.equal(recentTotalSeconds(entries, range), 5400);
    assert.equal(recentTotalSeconds([entries[0]], range), 1800);
  });
});

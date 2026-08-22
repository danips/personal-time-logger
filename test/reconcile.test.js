import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeEntry } from "../extension/src/entries.js";
import { compareEntries, fieldDifferences } from "../extension/src/reconcile.js";

const fixture = (over = {}) => normalizeEntry({
  id: "entry-1",
  project: "Project",
  task: "Task",
  start_at: "2026-07-27T09:00:00.000Z",
  end_at: "2026-07-27T10:00:00.000Z",
  duration_seconds: 3600,
  created_at: "2026-07-27T09:00:00.000Z",
  updated_at: "2026-07-27T10:00:00.000Z",
  revision: 1,
  ...over
});

describe("fieldDifferences", () => {
  it("ignores local sync bookkeeping", () => {
    const local = fixture({ dirty: true, last_sync_at: "2026-07-28T00:00:00.000Z", sync_error: "boom" });
    assert.deepEqual(fieldDifferences(local, fixture()), []);
  });

  it("reports each differing field with both values", () => {
    const local = fixture({ task: "Changed", status: "needs_review" });
    const differences = fieldDifferences(local, fixture());
    const byField = new Map(differences.map((difference) => [difference.field, difference]));

    assert.deepEqual([...byField.keys()].sort(), ["status", "task"]);
    assert.deepEqual(byField.get("task"), { field: "task", local: "Changed", remote: "Task" });
    assert.deepEqual(byField.get("status"), { field: "status", local: "needs_review", remote: "ok" });
  });

  it("never reports the id, which is the join key", () => {
    const differences = fieldDifferences(fixture(), fixture({ project: "Other" }));
    assert.equal(differences.some((difference) => difference.field === "id"), false);
  });
});

describe("compareEntries", () => {
  it("counts identical entries as in sync", () => {
    const report = compareEntries([fixture()], [fixture()]);
    assert.equal(report.inSync, 1);
    assert.equal(report.different.length, 0);
    assert.equal(report.localOnly.length, 0);
    assert.equal(report.remoteOnly.length, 0);
  });

  it("sorts entries into the right buckets", () => {
    const report = compareEntries(
      [fixture(), fixture({ id: "only-local" })],
      [fixture({ task: "Changed", updated_at: "2026-07-27T08:00:00.000Z" }), fixture({ id: "only-remote" })]
    );

    assert.equal(report.inSync, 0);
    assert.deepEqual(report.different.map((item) => item.id), ["entry-1"]);
    assert.deepEqual(report.localOnly.map((item) => item.id), ["only-local"]);
    assert.deepEqual(report.remoteOnly.map((item) => item.id), ["only-remote"]);
  });

  it("names the newer side by update timestamp", () => {
    const newerLocal = compareEntries(
      [fixture({ task: "local", updated_at: "2026-07-28T00:00:00.000Z" })],
      [fixture({ task: "remote", updated_at: "2026-07-27T00:00:00.000Z" })]
    );
    assert.equal(newerLocal.different[0].newer, "local");

    const newerRemote = compareEntries(
      [fixture({ task: "local", updated_at: "2026-07-26T00:00:00.000Z" })],
      [fixture({ task: "remote", updated_at: "2026-07-27T00:00:00.000Z" })]
    );
    assert.equal(newerRemote.different[0].newer, "remote");

    const sameTimestamp = compareEntries([fixture({ task: "local" })], [fixture({ task: "remote" })]);
    assert.equal(sameTimestamp.different[0].newer, "conflict");
  });

  it("separates row totals from distinct entries when rows are duplicated", () => {
    const duplicates = [
      { id: "entry-1", entry: fixture(), keepRowIndex: 2, extraRowIndexes: [7, 9] }
    ];
    const report = compareEntries([fixture()], [fixture()], duplicates);

    assert.equal(report.remoteCount, 1);
    assert.equal(report.duplicateRowCount, 2);
    assert.equal(report.remoteRowCount, 3);
    assert.equal(report.duplicates.length, 1);
  });

  it("defaults to no duplicates when none are supplied", () => {
    const report = compareEntries([fixture()], [fixture()]);
    assert.deepEqual(report.duplicates, []);
    assert.equal(report.duplicateRowCount, 0);
    assert.equal(report.remoteRowCount, report.remoteCount);
  });

  it("handles empty sides", () => {
    const empty = compareEntries([], []);
    assert.equal(empty.localCount, 0);
    assert.equal(empty.remoteCount, 0);
    assert.equal(empty.inSync, 0);
  });
});

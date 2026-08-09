import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SHEET_HEADERS, entryToRow, normalizeEntry } from "../src/entries.js";
import { rowsToEntries } from "../src/sheets.js";

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

const sheet = (entries) => [SHEET_HEADERS, ...entries.map((entry) => entryToRow(entry))];

describe("rowsToEntries", () => {
  it("rejects a sheet whose header does not match", () => {
    assert.throws(() => rowsToEntries([["id", "nope"]]), (error) => error.code === "SHEET_MISSING");
    assert.throws(() => rowsToEntries([]), (error) => error.code === "SHEET_MISSING");
  });

  it("maps each entry to its 1-based sheet row, allowing for the header", () => {
    const { entries, rowMap } = rowsToEntries(sheet([fixture(), fixture({ id: "entry-2" })]));
    assert.deepEqual(entries.map((entry) => entry.id), ["entry-1", "entry-2"]);
    assert.equal(rowMap.get("entry-1"), 2);
    assert.equal(rowMap.get("entry-2"), 3);
  });

  it("skips rows with no id", () => {
    const rows = sheet([fixture()]);
    rows.splice(1, 0, []);
    const { entries } = rowsToEntries(rows);
    assert.equal(entries.length, 1);
  });

  it("coerces cells the spreadsheet returned as numbers", () => {
    const rows = sheet([fixture()]);
    const durationIndex = SHEET_HEADERS.indexOf("duration_seconds");
    rows[1][durationIndex] = 3600;
    const { entries } = rowsToEntries(rows);
    assert.equal(entries[0].duration_seconds, 3600);
  });

  it("keeps the most recently updated of duplicated rows, whatever their order", () => {
    const stale = fixture({ task: "stale", updated_at: "2026-07-27T08:00:00.000Z" });
    const fresh = fixture({ task: "fresh", updated_at: "2026-07-27T12:00:00.000Z" });

    // Fresh first, stale below: the naive "last row wins" collapse would lose data.
    const freshFirst = rowsToEntries(sheet([fresh, stale]));
    assert.equal(freshFirst.entries.length, 1);
    assert.equal(freshFirst.entries[0].task, "fresh");
    assert.equal(freshFirst.rowMap.get("entry-1"), 2);
    assert.deepEqual(freshFirst.duplicates[0].extraRowIndexes, [3]);

    const staleFirst = rowsToEntries(sheet([stale, fresh]));
    assert.equal(staleFirst.entries[0].task, "fresh");
    assert.equal(staleFirst.rowMap.get("entry-1"), 3);
    assert.deepEqual(staleFirst.duplicates[0].extraRowIndexes, [2]);
  });

  it("reports every surplus row when an id repeats more than twice", () => {
    const rows = sheet([fixture(), fixture(), fixture(), fixture({ id: "entry-2" })]);
    const { entries, duplicates } = rowsToEntries(rows);

    assert.deepEqual(entries.map((entry) => entry.id), ["entry-1", "entry-2"]);
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0].id, "entry-1");
    assert.equal(duplicates[0].extraRowIndexes.length, 2);
    assert.equal(duplicates[0].extraRowIndexes.includes(duplicates[0].keepRowIndex), false);
  });

  it("reports no duplicates for a clean sheet", () => {
    const { duplicates } = rowsToEntries(sheet([fixture(), fixture({ id: "entry-2" })]));
    assert.deepEqual(duplicates, []);
  });

  it("quarantines malformed rows instead of assigning fresh timestamps", () => {
    const rows = sheet([fixture({ id: "valid" }), fixture({ id: "broken" })]);
    rows[2][SHEET_HEADERS.indexOf("updated_at")] = "not-a-date";
    const { entries, quarantined } = rowsToEntries(rows);
    assert.deepEqual(entries.map((entry) => entry.id), ["valid"]);
    assert.deepEqual(quarantined.map((item) => item.id), ["broken"]);
  });

  it("retains a valid duplicate when a newer duplicate is malformed", () => {
    const valid = fixture({ id: "mixed-duplicate", task: "valid", updated_at: "2026-07-27T08:00:00.000Z" });
    const malformed = fixture({ id: valid.id, task: "broken" });
    const rows = sheet([valid, malformed]);
    rows[2][SHEET_HEADERS.indexOf("updated_at")] = "not-a-date";
    const { entries, quarantined } = rowsToEntries(rows);

    assert.deepEqual(entries.map((entry) => entry.task), ["valid"]);
    assert.deepEqual(quarantined.map((item) => item.id), [valid.id]);
  });
});

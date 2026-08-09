import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SHEET_HEADERS,
  canMergeEntries,
  decodeEntryEdit,
  decodePersistedEntry,
  entryToRow,
  hasEqualTimestampConflict,
  hasMultiplier,
  isRemoteNewer,
  normalizeEntry,
  normalizeMultiplierText,
  rowToEntry
} from "../src/entries.js";

const fixture = (over = {}) => normalizeEntry({
  id: "entry-1",
  project: "Project",
  task: "Task",
  description: "Notes",
  start_at: "2026-07-27T09:00:00.000Z",
  end_at: "2026-07-27T10:00:00.000Z",
  duration_seconds: 3600,
  created_at: "2026-07-27T09:00:00.000Z",
  updated_at: "2026-07-27T10:00:00.000Z",
  revision: 1,
  ...over
});

describe("sheet schema", () => {
  it("identifies different records with an equal timestamp as a conflict", () => {
    const first = fixture();
    assert.equal(hasEqualTimestampConflict(first, { ...first, task: "Other task" }), true);
    assert.equal(hasEqualTimestampConflict(first, { ...first }), false);
  });

  it("no longer carries the unused client, billable and tags columns", () => {
    for (const dropped of ["client", "billable", "tags"]) {
      assert.equal(SHEET_HEADERS.includes(dropped), false, `${dropped} is gone`);
    }
    assert.equal(SHEET_HEADERS.length, 14);
  });

  it("starts with the id, which joins local entries to sheet rows", () => {
    assert.equal(SHEET_HEADERS[0], "id");
  });
});

describe("normalizeEntry", () => {
  it("fills defaults and coerces types", () => {
    const entry = normalizeEntry({ id: "x", start_at: "2026-07-27T09:00:00.000Z" });
    assert.equal(entry.project, "");
    assert.equal(entry.status, "ok");
    assert.equal(entry.revision, 1);
    assert.equal(entry.dirty, false);
  });

  it("drops fields that are no longer part of the schema", () => {
    const entry = normalizeEntry({ id: "x", client: "Acme", tags: "a,b", billable: true });
    assert.equal("client" in entry, false);
    assert.equal("tags" in entry, false);
    assert.equal("billable" in entry, false);
  });

  it("derives duration from the interval when none is stored", () => {
    const entry = normalizeEntry({
      start_at: "2026-07-27T09:00:00.000Z",
      end_at: "2026-07-27T09:30:00.000Z"
    });
    assert.equal(entry.duration_seconds, 1800);
  });

  it("keeps a stored duration that differs from the interval, as a multiplier does", () => {
    const entry = normalizeEntry({
      start_at: "2026-07-27T09:00:00.000Z",
      end_at: "2026-07-27T09:30:00.000Z",
      duration_seconds: 2700
    });
    assert.equal(entry.duration_seconds, 2700);
  });

  it("only keeps a positive numeric multiplier", () => {
    assert.equal(normalizeEntry({ multiply: "1.5" }).multiply, "1.500");
    assert.equal(normalizeEntry({ multiply: "1,5" }).multiply, "1.500");
    assert.equal(normalizeEntry({ multiply: "0" }).multiply, "");
    assert.equal(normalizeEntry({ multiply: "-2" }).multiply, "");
    assert.equal(normalizeEntry({ multiply: "abc" }).multiply, "");
    // Checkbox booleans are resolved before storage, never persisted as-is.
    assert.equal(normalizeEntry({ multiply: true }).multiply, "");
    assert.equal(normalizeEntry({ multiply: "true" }).multiply, "");
  });
});

describe("normalizeMultiplierText", () => {
  it("normalizes a comma decimal separator", () => {
    assert.equal(normalizeMultiplierText("1,25"), "1.250");
  });

  it("rejects values that are not positive numbers", () => {
    assert.equal(normalizeMultiplierText("0"), "");
    assert.equal(normalizeMultiplierText("-1"), "");
    assert.equal(normalizeMultiplierText(""), "");
    assert.equal(normalizeMultiplierText("x"), "");
    assert.equal(normalizeMultiplierText("0.999"), "");
    assert.equal(normalizeMultiplierText("5.002"), "");
    assert.equal(normalizeMultiplierText("1.0001"), "");
  });
});

describe("hasMultiplier", () => {
  it("is true only for a stored numeric factor", () => {
    assert.equal(hasMultiplier({ multiply: "2" }), true);
    assert.equal(hasMultiplier({ multiply: "" }), false);
    assert.equal(hasMultiplier({}), false);
    assert.equal(hasMultiplier(null), false);
  });
});

describe("row serialization", () => {
  it("round-trips an entry through the sheet row", () => {
    const entry = fixture({ multiply: "1.5", device_id: "device-a", status: "needs_review" });
    const restored = rowToEntry(entryToRow(entry));

    for (const field of SHEET_HEADERS) {
      assert.deepEqual(restored[field], entry[field], `field ${field} survived`);
    }
  });

  it("produces one cell per header", () => {
    assert.equal(entryToRow(fixture()).length, SHEET_HEADERS.length);
  });

  it("marks a row read from the sheet as clean", () => {
    const restored = rowToEntry(entryToRow(fixture({ dirty: true })));
    assert.equal(restored.dirty, false);
    assert.equal(restored.sync_error, "");
  });

  it("rejects incomplete or invalid records at the persistence boundary", () => {
    assert.throws(() => decodePersistedEntry({ id: "incomplete" }), { code: "ENTRY_INVALID" });
    assert.throws(() => rowToEntry(["entry-only"]), { code: "ENTRY_INVALID" });
    assert.throws(() => decodePersistedEntry({ ...fixture(), revision: 0 }), { code: "ENTRY_INVALID" });
  });
});

describe("entry edit decoder", () => {
  it("keeps identity and sync bookkeeping out of edit payloads", () => {
    assert.throws(() => decodeEntryEdit({ id: "replace-me" }), { code: "ENTRY_INVALID" });
    assert.throws(() => decodeEntryEdit({ dirty: false }), { code: "ENTRY_INVALID" });
  });

  it("rejects invalid dates and accepts the editable field whitelist", () => {
    assert.throws(() => decodeEntryEdit({ start_at: "not a timestamp" }), { code: "ENTRY_INVALID" });
    assert.deepEqual(decodeEntryEdit({ task: " Updated ", end_at: "", status: "needs_review" }), {
      task: "Updated",
      end_at: "",
      status: "needs_review"
    });
  });
});

describe("canMergeEntries", () => {
  it("accepts two completed entries with matching project, task and description", () => {
    assert.equal(canMergeEntries(fixture(), fixture({ id: "entry-2" })), true);
  });

  it("rejects an entry paired with itself", () => {
    const entry = fixture();
    assert.equal(canMergeEntries(entry, entry), false);
  });

  it("rejects running or deleted entries", () => {
    assert.equal(canMergeEntries(fixture(), fixture({ id: "entry-2", end_at: "" })), false);
    assert.equal(
      canMergeEntries(fixture(), fixture({ id: "entry-2", deleted_at: "2026-07-27T11:00:00.000Z" })),
      false
    );
  });

  it("rejects entries describing different work", () => {
    assert.equal(canMergeEntries(fixture(), fixture({ id: "entry-2", task: "Other" })), false);
    assert.equal(canMergeEntries(fixture(), fixture({ id: "entry-2", project: "Other" })), false);
  });

  it("rejects missing operands", () => {
    assert.equal(canMergeEntries(fixture(), null), false);
    assert.equal(canMergeEntries(null, fixture()), false);
  });
});

describe("isRemoteNewer", () => {
  it("compares update timestamps", () => {
    const local = fixture({ updated_at: "2026-07-27T10:00:00.000Z" });
    assert.equal(isRemoteNewer(fixture({ updated_at: "2026-07-27T11:00:00.000Z" }), local), true);
    assert.equal(isRemoteNewer(fixture({ updated_at: "2026-07-27T09:00:00.000Z" }), local), false);
  });

  it("treats an equal timestamp as not newer, so local edits win ties", () => {
    assert.equal(isRemoteNewer(fixture(), fixture()), false);
  });

  it("treats anything as newer than a missing local entry", () => {
    assert.equal(isRemoteNewer(fixture(), undefined), true);
  });
});

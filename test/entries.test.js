import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  canMergeEntries,
  createCompletedEntry,
  decodeEntryEdit,
  decodePersistedEntry,
  duplicateEntryPreview,
  hasEqualTimestampConflict,
  hasMultiplier,
  isRemoteNewer,
  mergeEntryPreview,
  normalizeEntry,
  normalizeMultiplierText,
} from "../extension/src/entries.js";
import { ENTRY_FIELDS } from "../extension/src/entry-contract.js";
import { persistedEntryFixture } from "./support/persisted-entry-fixture.js";
import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { seedEntry } from "./support/db-fixtures.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;
const db = await import("../extension/src/db.js");

const contract = JSON.parse(readFileSync(new URL("./fixtures/entry-contract.json", import.meta.url), "utf8"));

function contractEntry(testCase) {
  const entry = { ...contract.base, ...(testCase.overrides || {}) };
  for (const [key, value] of Object.entries(entry)) {
    if (value && typeof value === "object" && "repeat" in value) entry[key] = String(value.repeat).repeat(Number(value.count));
  }
  for (const key of testCase.omit || []) delete entry[key];
  return { ...entry, ...(testCase.add || {}) };
}

const fixture = (over = {}) => persistedEntryFixture({ description: "Notes", ...over });

describe("entry schema", () => {
  it("identifies different records with an equal timestamp as a conflict", () => {
    const first = fixture();
    assert.equal(hasEqualTimestampConflict(first, { ...first, task: "Other task" }), true);
    assert.equal(hasEqualTimestampConflict(first, { ...first }), false);
  });

  it("no longer carries the unused client, billable and tags columns", () => {
    for (const dropped of ["client", "billable", "tags"]) {
      assert.equal(ENTRY_FIELDS.includes(dropped), false, `${dropped} is gone`);
    }
    assert.equal(ENTRY_FIELDS.length, 14);
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

describe("persistence boundary", () => {
  it("rejects incomplete or invalid records at the persistence boundary", () => {
    assert.throws(() => decodePersistedEntry({ id: "incomplete" }), { code: "ENTRY_INVALID" });
    assert.throws(() => decodePersistedEntry({ ...fixture(), revision: 0 }), { code: "ENTRY_INVALID" });
  });

  it("enforces the shared remote entry contract", () => {
    assert.equal(decodePersistedEntry(contract.base).start_at, "2026-08-24T09:00:00.000Z");
    for (const testCase of contract.validCases) {
      assert.equal(decodePersistedEntry(contractEntry(testCase)).id, contract.base.id, testCase.name);
    }
    for (const testCase of contract.invalidCases.filter(({ targets }) => !targets || targets.includes("extension"))) {
      assert.throws(() => decodePersistedEntry(contractEntry(testCase)), { code: "ENTRY_INVALID" }, testCase.name);
    }
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

describe("completed entry creation", () => {
  it("creates a dirty completed entry with a multiplier without touching an active timer", async () => {
    const active = normalizeEntry({
      id: "still-active",
      task: "Keep running",
      start_at: "2026-07-27T08:00:00.000Z",
      end_at: "",
      duration_seconds: 0,
      device_id: "other-device",
      revision: 3
    });
    await seedEntry(db, active);
    await db.setSetting("duration_multiplier", "1.5");
    const created = await createCompletedEntry({
      project: "Project",
      task: "Backfill",
      description: "Offline work",
      start_at: "2026-07-27T09:00:00.000Z",
      end_at: "2026-07-27T10:00:00.000Z",
      multiply: true
    });

    assert.equal(created.end_at, "2026-07-27T10:00:00.000Z");
    assert.equal(created.duration_seconds, 5400);
    assert.equal(created.dirty, true);
    assert.equal(created.revision, 1);
    assert.equal(created.device_id, await db.getSetting("device_id"));
    assert.deepEqual(await db.getEntry(active.id), active);
    assert.deepEqual((await db.getActiveEntries()).map(({ id }) => id), [active.id]);
  });

  it("accepts a zero-duration completed entry and rejects missing or reversed times", async () => {
    const created = await createCompletedEntry({
      start_at: "2026-07-27T10:00:00.000Z",
      end_at: "2026-07-27T10:00:00.000Z"
    });
    assert.equal(created.duration_seconds, 0);
    await assert.rejects(() => createCompletedEntry({ start_at: "2026-07-27T10:00:00.000Z", end_at: "" }), { code: "ENTRY_INVALID" });
    await assert.rejects(() => createCompletedEntry({ start_at: "2026-07-27T11:00:00.000Z", end_at: "2026-07-27T10:00:00.000Z" }), { code: "ENTRY_INVALID" });
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

describe("merge and duplicate previews", () => {
  it("shows merge compaction and retained target policy without mutating entries", () => {
    const target = fixture({ multiply: "2", status: "needs_review" });
    const source = fixture({
      id: "preview-source",
      start_at: "2026-08-08T12:00:00.000Z",
      end_at: "2026-08-08T13:00:00.000Z",
      duration_seconds: 3600,
      multiply: "3",
      status: "ok"
    });
    const preview = mergeEntryPreview(target, source);

    assert.deepEqual({
      targetActualSeconds: preview.targetActualSeconds,
      sourceActualSeconds: preview.sourceActualSeconds,
      actualSeconds: preview.actualSeconds,
      effectiveSeconds: preview.effectiveSeconds,
      compactedGapSeconds: preview.compactedGapSeconds,
      targetMultiply: preview.targetMultiply,
      targetStatus: preview.targetStatus
    }, {
      targetActualSeconds: 3600,
      sourceActualSeconds: 3600,
      actualSeconds: 7200,
      effectiveSeconds: 14400,
      compactedGapSeconds: 7200,
      targetMultiply: "2.000",
      targetStatus: "needs_review"
    });
    assert.equal(target.deleted_at, "");
    assert.equal(source.deleted_at, "");
  });

  it("shows duplicate overlap, effective duration, multiplier, and status", () => {
    const preview = duplicateEntryPreview(fixture({ multiply: "1.5", status: "needs_review", duration_seconds: 5400 }));
    assert.deepEqual({
      actualSeconds: preview.actualSeconds,
      effectiveSeconds: preview.effectiveSeconds,
      overlapSeconds: preview.overlapSeconds,
      multiply: preview.multiply,
      status: preview.status
    }, {
      actualSeconds: 3600,
      effectiveSeconds: 5400,
      overlapSeconds: 3600,
      multiply: "1.500",
      status: "needs_review"
    });
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

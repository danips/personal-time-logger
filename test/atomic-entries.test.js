import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;

const db = await import("../src/db.js");
const entries = await import("../src/entries.js");

const fixture = (over = {}) => ({
  id: "entry-1",
  project: "Project",
  task: "Task",
  description: "Description",
  start_at: "2026-08-08T09:00:00.000Z",
  end_at: "2026-08-08T10:00:00.000Z",
  duration_seconds: 3600,
  created_at: "2026-08-08T09:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
  revision: 1,
  dirty: false,
  ...over
});

describe("atomic entry mutations", () => {
  it("creates one shared device id when contexts ask at the same time", async () => {
    const [first, second] = await Promise.all([entries.getDeviceId(), entries.getDeviceId()]);
    assert.equal(first, second);
    assert.equal(await db.getSetting("device_id"), first);
  });

  it("rejects a stale edit without overwriting the current revision", async () => {
    await db.putEntry(fixture());
    const updated = await entries.updateEntry("entry-1", { task: "Fresh edit" }, { expectedRevision: 1 });

    assert.equal(updated.revision, 2);
    await assert.rejects(
      () => entries.updateEntry("entry-1", { description: "Stale edit" }, { expectedRevision: 1 }),
      (error) => error.code === "STORAGE_CONFLICT" && error.reason === "revision_mismatch"
    );
    const stored = await db.getEntry("entry-1");
    assert.equal(stored.task, "Fresh edit");
    assert.equal(stored.description, "Description");
  });

  it("merges the target and source in one committed mutation", async () => {
    await db.putEntries([
      fixture({ id: "merge-target", revision: 3 }),
      fixture({
        id: "merge-source",
        start_at: "2026-08-08T10:00:00.000Z",
        end_at: "2026-08-08T10:30:00.000Z",
        duration_seconds: 1800,
        revision: 7
      })
    ]);

    const { merged, deleted } = await entries.mergeEntries("merge-target", "merge-source", {
      expectedRevisions: { "merge-target": 3, "merge-source": 7 }
    });

    assert.equal(merged.duration_seconds, 5400);
    assert.equal(merged.revision, 4);
    assert.equal(deleted.revision, 8);
    assert.ok(deleted.deleted_at);
    assert.equal((await db.getEntry("merge-source")).deleted_at, deleted.deleted_at);
  });
});

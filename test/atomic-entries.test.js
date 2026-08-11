import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { seedEntry, seedEntries } from "./support/db-fixtures.js";

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
  deleted_at: "",
  revision: 1,
  dirty: false,
  ...over
});

describe("atomic entry mutations", () => {
  it("creates one shared device id when contexts ask at the same time", async () => {
    const [first, second] = await Promise.all([entries.getDeviceId(), entries.getDeviceId()]);
    assert.equal(first, second);
    assert.equal(await db.getSetting("device_id"), first);

    indexedDB._resetWriteLog();
    assert.equal(await entries.getDeviceId(), first);
    assert.deepEqual(indexedDB._getWriteLog(), []);
  });

  it("rejects a stale edit without overwriting the current revision", async () => {
    await seedEntry(db, fixture());
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

  it("rejects protected edit fields before opening a local write", async () => {
    const original = fixture({ id: "protected-edit" });
    await seedEntry(db, original);

    await assert.rejects(
      () => entries.updateEntry(original.id, { id: "replacement-id" }, { expectedRevision: original.revision }),
      { code: "ENTRY_INVALID" }
    );
    assert.deepEqual(await db.getEntry(original.id), original);
  });

  it("merges the target and source in one committed mutation", async () => {
    await seedEntries(db, [
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

  it("appends actual time to the selected target and retains its multiplier", async () => {
    await seedEntries(db, [
      fixture({
        id: "multiplied-target",
        start_at: "2026-08-08T12:00:00.000Z",
        end_at: "2026-08-08T13:00:00.000Z",
        duration_seconds: 7200,
        multiply: "2",
        status: "ok"
      }),
      fixture({
        id: "earlier-source",
        start_at: "2026-08-08T09:00:00.000Z",
        end_at: "2026-08-08T09:30:00.000Z",
        duration_seconds: 5400,
        multiply: "3",
        status: "needs_review"
      })
    ]);

    const { merged } = await entries.mergeEntries("multiplied-target", "earlier-source");

    assert.equal(merged.start_at, "2026-08-08T12:00:00.000Z");
    assert.equal(merged.end_at, "2026-08-08T13:30:00.000Z");
    assert.equal(merged.multiply, "2.000");
    assert.equal(merged.duration_seconds, 10_800);
    assert.equal(merged.status, "ok");
  });

  it("rolls back a merge when a later write in its transaction fails", async () => {
    await seedEntries(db, [
      fixture({ id: "rollback-target", revision: 1 }),
      fixture({
        id: "rollback-source",
        start_at: "2026-08-08T10:00:00.000Z",
        end_at: "2026-08-08T10:30:00.000Z",
        duration_seconds: 1800,
        revision: 1
      })
    ]);
    indexedDB._failOnWrite(2);

    await assert.rejects(() => entries.mergeEntries("rollback-target", "rollback-source"), /Injected IndexedDB write failure/);

    assert.equal((await db.getEntry("rollback-target")).duration_seconds, 3600);
    assert.equal((await db.getEntry("rollback-target")).revision, 1);
    assert.equal((await db.getEntry("rollback-source")).deleted_at || "", "");
    assert.equal((await db.getEntry("rollback-source")).revision, 1);
  });

  it("replaces every active timer atomically and makes retries idempotent", async () => {
    await seedEntries(db, [
      fixture({ id: "active-first", end_at: "", duration_seconds: 0, revision: 2 }),
      fixture({ id: "active-second", end_at: "", duration_seconds: 0, revision: 5 })
    ]);

    const replacement = await entries.replaceActiveTimer({ project: "Replacement" }, { operationId: "start-1" });
    indexedDB._resetWriteLog();
    const retry = await entries.replaceActiveTimer({ project: "Ignored retry" }, { operationId: "start-1" });
    const active = await db.getActiveEntries();

    assert.equal(retry.id, replacement.id);
    assert.deepEqual(active.map((entry) => entry.id), [replacement.id]);
    assert.equal((await db.getEntry("active-first")).revision, 3);
    assert.equal((await db.getEntry("active-second")).revision, 6);
    assert.equal((await db.getEntry(replacement.id)).project, "Replacement");
    assert.deepEqual(indexedDB._getWriteLog(), []);
  });

  it("does not rewrite completed history when replacing the active timer", async () => {
    await seedEntries(db, [
      fixture({ id: "unrelated-completed-history", revision: 4 }),
      fixture({ id: "scoped-active-timer", end_at: "", duration_seconds: 0, revision: 2 })
    ]);
    indexedDB._resetWriteLog();

    await entries.replaceActiveTimer({ project: "Scoped replacement" }, { operationId: "scoped-start" });

    const entryWrites = indexedDB._getWriteLog().filter((operation) => operation.store === "time_entries");
    assert.equal(entryWrites.some((operation) => operation.key === "unrelated-completed-history"), false);
    assert.equal((await db.getEntry("unrelated-completed-history")).revision, 4);
  });
});

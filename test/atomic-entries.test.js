import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { seedEntry, seedEntries } from "./support/db-fixtures.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;

const db = await import("../extension/src/db.js");
const entries = await import("../extension/src/entries.js");

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

  it("undoes one deletion with its exact tombstone and rejects a second undo", async () => {
    const original = fixture({ id: "undo-once", dirty: true });
    await seedEntry(db, original);
    const deleted = await entries.softDeleteEntry(original.id, { expectedRevision: original.revision });
    const restored = await entries.undoDeletedEntry(original.id, entries.deletionUndoToken(deleted));

    assert.equal(restored.deleted_at, "");
    assert.equal(restored.revision, deleted.revision + 1);
    assert.equal(restored.dirty, true);
    await assert.rejects(
      () => entries.undoDeletedEntry(original.id, entries.deletionUndoToken(deleted)),
      { code: "UNDO_UNAVAILABLE" }
    );
  });

  it("does not resurrect a newer tombstone or a purged row", async () => {
    const newer = fixture({ id: "undo-newer-tombstone" });
    await seedEntry(db, newer);
    const deleted = await entries.softDeleteEntry(newer.id, { expectedRevision: newer.revision });
    const replacement = await entries.updateEntry(newer.id, {
      deleted_at: "2026-08-08T12:00:00.000Z"
    }, { expectedRevision: deleted.revision });
    assert.notEqual(replacement.deleted_at, deleted.deleted_at);
    await assert.rejects(
      () => entries.undoDeletedEntry(newer.id, entries.deletionUndoToken(deleted)),
      { code: "UNDO_UNAVAILABLE" }
    );

    const purged = fixture({ id: "undo-purged" });
    await seedEntry(db, purged);
    const purgedToken = entries.deletionUndoToken(await entries.softDeleteEntry(purged.id));
    await db.mutateEntries([purged.id], (stored) => stored.delete(purged.id));
    await assert.rejects(() => entries.undoDeletedEntry(purged.id, purgedToken), { code: "UNDO_UNAVAILABLE" });
  });

  it("undoes one completed edit and refuses after another change", async () => {
    const original = fixture({ id: "undo-edit" });
    await seedEntry(db, original);
    const edited = await entries.updateEntry(original.id, {
      task: "Corrected task",
      description: "Corrected description"
    }, { expectedRevision: original.revision });
    const token = entries.entryUpdateUndoToken(original, edited);
    const restored = await entries.undoEntryUpdate(token);

    assert.equal(restored.task, original.task);
    assert.equal(restored.description, original.description);
    assert.equal(restored.revision, edited.revision + 1);
    assert.equal(restored.dirty, true);

    const nextEdit = await entries.updateEntry(original.id, { task: "Another correction" }, {
      expectedRevision: restored.revision
    });
    assert.equal(nextEdit.task, "Another correction");
    await assert.rejects(() => entries.undoEntryUpdate(token), { code: "UNDO_UNAVAILABLE" });
  });

  it("can undo a deletion after its remote acknowledgement", async () => {
    const original = fixture({ id: "undo-acknowledged" });
    await seedEntry(db, original);
    const deleted = await entries.softDeleteEntry(original.id);
    await db.mutateEntries([original.id], (stored) => {
      stored.set(original.id, { ...stored.get(original.id), dirty: false, last_sync_at: deleted.updated_at, sync_error: "" });
    });

    const restored = await entries.undoDeletedEntry(original.id, entries.deletionUndoToken({
      ...deleted,
      dirty: false,
      last_sync_at: deleted.updated_at,
      sync_error: ""
    }));
    assert.equal(restored.deleted_at, "");
    assert.equal(restored.dirty, true);
    assert.equal(restored.revision, deleted.revision + 1);
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

  it("rejects a stale merge confirmation without changing either entry", async () => {
    const target = fixture({ id: "preview-target" });
    const source = fixture({ id: "preview-source", start_at: "2026-08-08T11:00:00.000Z", end_at: "2026-08-08T12:00:00.000Z" });
    await seedEntries(db, [target, source]);
    const preview = entries.mergeEntryPreview(target, source);
    await entries.updateEntry(target.id, { description: "Changed before confirmation" }, { expectedRevision: target.revision });

    await assert.rejects(
      () => entries.mergeEntries(target.id, source.id, {
        expectedRevisions: {
          [target.id]: target.revision,
          [source.id]: source.revision
        }
      }),
      (error) => error.code === "STORAGE_CONFLICT" && error.reason === "revision_mismatch"
    );
    assert.equal((await db.getEntry(target.id)).description, "Changed before confirmation");
    assert.equal((await db.getEntry(source.id)).deleted_at, "");
    assert.equal(preview.sourceId, source.id);
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

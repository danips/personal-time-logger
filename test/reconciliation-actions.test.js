import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeEntry } from "../extension/src/entries.js";
import { SETTING_KEY } from "../extension/src/setting-keys.js";
import { seedEntry, seedEntries } from "./support/db-fixtures.js";
import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;

let db;
let reconcile;
let provider;

const fixture = (over = {}) => normalizeEntry({
  id: "reconciliation-entry",
  project: "Project",
  task: "Task",
  start_at: "2026-08-08T09:00:00.000Z",
  end_at: "2026-08-08T10:00:00.000Z",
  duration_seconds: 3600,
  created_at: "2026-08-08T09:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
  device_id: "device",
  revision: 1,
  ...over
});

const remoteSnapshot = (entries) => ({
  entries,
  entryRefs: new Map(entries.map((entry) => [entry.id, { kind: "mysql-entry", version: 1 }])),
  quarantined: [],
  config: {},
  configRefs: new Map(),
  changeToken: "v1"
});

const setSnapshot = (entries) => { provider.snapshot = remoteSnapshot(entries); };

const setup = async () => {
  db = await import("../extension/src/db.js");
  reconcile = await import("../extension/src/reconcile.js");
  provider = {
    id: "mysql",
    label: "MySQL 8.4",
    snapshot: remoteSnapshot([]),
    async readSnapshot() { return this.snapshot; },
    async deleteEntries() {}
  };
};

await setup();

describe("reconciliation actions", () => {
  it("does not overwrite a local edit made after the reconciliation scan", async () => {
    const remote = fixture({ id: "stale-local", task: "Remote task" });
    const editedLocal = fixture({ id: remote.id, task: "New local task", revision: 2 });
    await seedEntry(db, editedLocal);
    setSnapshot([remote]);

    await assert.rejects(
      () => reconcile.keepRemote(remote, { expectedLocalRevision: 1, provider }),
      (error) => error.code === "STORAGE_CONFLICT" && error.reason === "revision_mismatch"
    );

    assert.deepEqual(await db.getEntry(remote.id), editedLocal);
  });

  it("does not overwrite local data after the remote record was edited", async () => {
    const remote = fixture({ id: "stale-remote", task: "Scanned remote task" });
    const local = fixture({ id: remote.id, task: "Local task" });
    const changedRemote = fixture({ id: remote.id, task: "Edited remote task", updated_at: "2026-08-08T11:00:00.000Z" });
    await seedEntry(db, local);
    setSnapshot([changedRemote]);

    await assert.rejects(
      () => reconcile.keepRemote(remote, { expectedLocalRevision: local.revision, provider }),
      (error) => error.code === "STORAGE_CONFLICT" && error.reason === "remote_fingerprint_mismatch"
    );

    assert.deepEqual(await db.getEntry(remote.id), local);
  });

  it("does not tombstone a local record that appeared after a remote-only scan", async () => {
    const remote = fixture({ id: "new-local-after-scan" });
    const local = fixture({ id: remote.id, task: "New local record", revision: 3 });
    await seedEntry(db, local);
    setSnapshot([remote]);

    await assert.rejects(
      () => reconcile.deleteEverywhere(remote.id, remote, { provider }),
      (error) => error.code === "STORAGE_CONFLICT" && error.reason === "revision_mismatch"
    );

    assert.deepEqual(await db.getEntry(remote.id), local);
  });

  it("prevalidates every remote row before changing any selected local entry", async () => {
    const firstLocal = fixture({ id: "batch-first", task: "First local", dirty: false });
    const secondLocal = fixture({ id: "batch-second", task: "Second local", dirty: false });
    const firstRemote = fixture({ id: firstLocal.id, task: "First remote" });
    const scannedSecondRemote = fixture({ id: secondLocal.id, task: "Second remote" });
    const changedSecondRemote = fixture({
      id: secondLocal.id,
      task: "Second remote changed",
      updated_at: "2026-08-08T11:00:00.000Z"
    });
    await seedEntries(db, [firstLocal, secondLocal]);
    setSnapshot([firstRemote, changedSecondRemote]);

    await assert.rejects(
      () => reconcile.resolveReconciliationBatch([
        { action: "keepLocal", id: firstLocal.id, remoteEntry: firstRemote, expectedRevision: firstLocal.revision },
        { action: "keepLocal", id: secondLocal.id, remoteEntry: scannedSecondRemote, expectedRevision: secondLocal.revision }
      ], { provider }),
      (error) => error.code === "STORAGE_CONFLICT" && error.reason === "remote_fingerprint_mismatch"
    );
    assert.equal((await db.getEntry(firstLocal.id)).dirty, false);
    assert.equal((await db.getEntry(secondLocal.id)).dirty, false);
  });

  it("applies compatible bulk choices in one snapshot and returns each result", async () => {
    const firstLocal = fixture({ id: "batch-apply-first", task: "First local", dirty: false });
    const secondLocal = fixture({ id: "batch-apply-second", task: "Second local", dirty: false });
    const firstRemote = fixture({ id: firstLocal.id, task: "First remote" });
    const secondRemote = fixture({ id: secondLocal.id, task: "Second remote" });
    await seedEntries(db, [firstLocal, secondLocal]);
    setSnapshot([firstRemote, secondRemote]);

    const outcome = await reconcile.resolveReconciliationBatch([
      { action: "keepLocal", id: firstLocal.id, remoteEntry: firstRemote, expectedRevision: firstLocal.revision },
      { action: "keepLocal", id: secondLocal.id, remoteEntry: secondRemote, expectedRevision: secondLocal.revision }
    ], { provider });

    assert.deepEqual(outcome.results.map(({ id, action, status }) => ({ id, action, status })), [
      { id: firstLocal.id, action: "keepLocal", status: "applied" },
      { id: secondLocal.id, action: "keepLocal", status: "applied" }
    ]);
    assert.equal((await db.getEntry(firstLocal.id)).dirty, true);
    assert.equal((await db.getEntry(secondLocal.id)).dirty, true);
  });

  it("updates only the selected local entry", async () => {
    const selected = fixture({ id: "scoped-reconcile-selected", dirty: false });
    const unrelated = fixture({ id: "scoped-reconcile-unrelated", task: "Leave untouched", revision: 6 });
    await seedEntries(db, [selected, unrelated]);
    indexedDB._resetWriteLog();

    await reconcile.keepLocal(selected.id, null, { expectedRevision: selected.revision });

    const entryWrites = indexedDB._getWriteLog().filter((operation) => operation.store === "time_entries");
    assert.deepEqual(entryWrites, [{ store: "time_entries", operation: "put", key: selected.id }]);
    assert.deepEqual(await db.getEntry(unrelated.id), unrelated);
  });

  it("requires an explicit local choice before re-creating a missing synced ID", async () => {
    const stale = fixture({
      id: "missing-synced-entry",
      dirty: true,
      last_sync_at: "2026-08-08T10:00:00.000Z",
      sync_error: "Remote recovery requires review before upload."
    });
    await seedEntry(db, stale);
    await db.setSetting(SETTING_KEY.SYNC_RECOVERY_PENDING, [stale.id]);

    const chosen = await reconcile.keepLocal(stale.id, null, { expectedRevision: stale.revision });

    assert.equal(chosen.dirty, true);
    assert.equal(chosen.last_sync_at, "");
    assert.equal(chosen.sync_error, "");
    assert.deepEqual(await db.getSetting(SETTING_KEY.SYNC_RECOVERY_PENDING), []);
  });
});

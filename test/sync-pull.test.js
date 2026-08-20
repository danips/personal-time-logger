import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { seedEntry } from "./support/db-fixtures.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;

const db = await import("../src/db.js");
const { pullRemoteEntries } = await import("../src/sync.js");

const entry = (over = {}) => ({
  id: "entry-1",
  project: "Project",
  task: "Task",
  description: "",
  start_at: "2026-08-08T09:00:00.000Z",
  end_at: "2026-08-08T10:00:00.000Z",
  duration_seconds: 3600,
  status: "ok",
  created_at: "2026-08-08T09:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
  deleted_at: "",
  device_id: "device",
  revision: 1,
  multiply: "",
  dirty: false,
  last_sync_at: "",
  sync_error: "",
  ...over
});

describe("sync pull CAS", () => {
  it("does not overwrite an edit committed after the sync snapshot", async () => {
    const observed = entry();
    await seedEntry(db, observed);
    const local = new Map([[observed.id, observed]]);
    const localEdit = entry({ task: "Local edit", revision: 2, dirty: true, updated_at: "2026-08-08T12:00:00.000Z" });
    const remote = entry({ task: "Remote value", revision: 1, updated_at: "2026-08-08T11:00:00.000Z" });
    await seedEntry(db, localEdit);

    const pulled = await pullRemoteEntries(local, [remote]);

    assert.equal(pulled, 0);
    assert.deepEqual(await db.getEntry("entry-1"), localEdit);
  });

  it("does not import over an id created locally after the snapshot", async () => {
    const remote = entry({ id: "appeared-locally", task: "Remote value", updated_at: "2026-08-08T11:00:00.000Z" });
    const local = new Map();
    const created = entry({ id: "appeared-locally", task: "Local create", revision: 1, dirty: true });
    await seedEntry(db, created);

    assert.equal(await pullRemoteEntries(local, [remote]), 0);
    assert.deepEqual(await db.getEntry(created.id), created);
  });

  it("imports a genuinely remote-only entry", async () => {
    const remote = entry({ id: "remote-only", task: "Remote value", updated_at: "2026-08-08T11:00:00.000Z" });
    const local = new Map();

    assert.equal(await pullRemoteEntries(local, [remote]), 1);
    assert.equal((await db.getEntry(remote.id)).task, "Remote value");
    assert.equal((await db.getEntry(remote.id)).dirty, false);
  });

  it("does not open a write transaction or rewrite unchanged snapshot rows", async () => {
    const unchanged = entry({ id: "unchanged-snapshot" });
    await seedEntry(db, unchanged);
    const local = new Map([[unchanged.id, unchanged]]);
    indexedDB._resetWriteLog();
    indexedDB._resetTransactionLog();

    assert.equal(await pullRemoteEntries(local, [unchanged]), 0);
    assert.deepEqual(indexedDB._getWriteLog().filter((operation) => operation.store === "time_entries"), []);
    assert.deepEqual(indexedDB._getTransactionLog().filter((transaction) =>
      transaction.mode === "readwrite" && transaction.storeNames.includes("time_entries")
    ), []);
  });

  it("persists remote-only rows in one bounded transaction", async () => {
    const remoteEntries = [
      entry({ id: "batched-remote-1", task: "Remote 1", updated_at: "2026-08-08T11:00:00.000Z" }),
      entry({ id: "batched-remote-2", task: "Remote 2", updated_at: "2026-08-08T11:00:00.000Z" }),
      entry({ id: "batched-remote-3", task: "Remote 3", updated_at: "2026-08-08T11:00:00.000Z" })
    ];
    const local = new Map();
    indexedDB._resetWriteLog();
    indexedDB._resetTransactionLog();

    assert.equal(await pullRemoteEntries(local, remoteEntries), remoteEntries.length);
    assert.deepEqual(
      indexedDB._getWriteLog().filter((operation) => operation.store === "time_entries").map((operation) => operation.key).sort(),
      remoteEntries.map((remote) => remote.id).sort()
    );
    assert.equal(indexedDB._getTransactionLog().filter((transaction) =>
      transaction.mode === "readwrite" && transaction.storeNames.includes("time_entries")
    ).length, 1);
  });

  it("splits an import at the bounded transaction cap", async () => {
    const remoteEntries = Array.from({ length: 251 }, (_, index) => entry({
      id: `batch-cap-${index}`,
      updated_at: "2026-08-08T11:00:00.000Z"
    }));
    const local = new Map();
    indexedDB._resetWriteLog();
    indexedDB._resetTransactionLog();

    assert.equal(await pullRemoteEntries(local, remoteEntries), remoteEntries.length);
    assert.equal(indexedDB._getWriteLog().filter((operation) => operation.store === "time_entries").length, remoteEntries.length);
    assert.equal(indexedDB._getTransactionLog().filter((transaction) =>
      transaction.mode === "readwrite" && transaction.storeNames.includes("time_entries")
    ).length, 2);
  });

  it("applies unrelated rows when a concurrent local edit rejects one batch member", async () => {
    const observed = entry({ id: "concurrent-batch", updated_at: "2026-08-08T10:00:00.000Z" });
    const localEdit = entry({
      id: observed.id,
      task: "Local edit",
      revision: 2,
      dirty: true,
      updated_at: "2026-08-08T12:00:00.000Z"
    });
    const remoteChanged = entry({
      id: observed.id,
      task: "Remote value",
      updated_at: "2026-08-08T11:00:00.000Z"
    });
    const remoteOnly = entry({ id: "concurrent-batch-remote-only", task: "Remote only", updated_at: "2026-08-08T11:00:00.000Z" });
    await seedEntry(db, localEdit);
    const local = new Map([[observed.id, observed]]);

    assert.equal(await pullRemoteEntries(local, [remoteChanged, remoteOnly]), 1);
    assert.deepEqual(await db.getEntry(observed.id), localEdit);
    assert.equal((await db.getEntry(remoteOnly.id)).task, "Remote only");
  });
});

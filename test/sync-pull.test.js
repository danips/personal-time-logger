import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

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
    await db.putEntry(observed);
    const local = {
      entries: [observed],
      all() { return this.entries; },
      apply(changed) { this.entries.push(...changed); }
    };
    const localEdit = entry({ task: "Local edit", revision: 2, dirty: true, updated_at: "2026-08-08T12:00:00.000Z" });
    const remote = entry({ task: "Remote value", revision: 1, updated_at: "2026-08-08T11:00:00.000Z" });
    await db.putEntry(localEdit);

    const pulled = await pullRemoteEntries(local, [remote]);

    assert.equal(pulled, 0);
    assert.deepEqual(await db.getEntry("entry-1"), localEdit);
  });

  it("does not import over an id created locally after the snapshot", async () => {
    const remote = entry({ id: "appeared-locally", task: "Remote value", updated_at: "2026-08-08T11:00:00.000Z" });
    const local = {
      entries: [],
      all() { return this.entries; },
      apply(changed) { this.entries.push(...changed); }
    };
    const created = entry({ id: "appeared-locally", task: "Local create", revision: 1, dirty: true });
    await db.putEntry(created);

    assert.equal(await pullRemoteEntries(local, [remote]), 0);
    assert.deepEqual(await db.getEntry(created.id), created);
  });

  it("imports a genuinely remote-only entry", async () => {
    const remote = entry({ id: "remote-only", task: "Remote value", updated_at: "2026-08-08T11:00:00.000Z" });
    const local = {
      entries: [],
      all() { return this.entries; },
      apply(changed) { this.entries.push(...changed); }
    };

    assert.equal(await pullRemoteEntries(local, [remote]), 1);
    assert.equal((await db.getEntry(remote.id)).task, "Remote value");
    assert.equal((await db.getEntry(remote.id)).dirty, false);
  });
});

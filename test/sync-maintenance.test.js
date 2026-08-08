import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;

const db = await import("../src/db.js");
const { markMultipleActiveTimers, purgeDeletedEntries, reseedForNewSpreadsheet } = await import("../src/sync.js");

const entry = (over = {}) => ({
  id: "maintenance-entry",
  project: "Project",
  task: "Task",
  description: "",
  start_at: "2026-08-08T09:00:00.000Z",
  end_at: "",
  duration_seconds: 0,
  status: "ok",
  created_at: "2026-08-08T09:00:00.000Z",
  updated_at: "2026-08-08T09:00:00.000Z",
  deleted_at: "",
  device_id: "device",
  revision: 1,
  multiply: "",
  dirty: false,
  last_sync_at: "",
  sync_error: "",
  ...over
});

function localState(entries) {
  return {
    entries: [...entries],
    all() { return this.entries; },
    apply(changed) {
      for (const entry of changed) {
        const index = this.entries.findIndex((candidate) => candidate.id === entry.id);
        if (index >= 0) this.entries[index] = entry;
        else this.entries.push(entry);
      }
      return changed;
    },
    forget(id) {
      this.entries = this.entries.filter((candidate) => candidate.id !== id);
    }
  };
}

describe("sync maintenance transactions", () => {
  it("does not purge a tombstone restored after the sync snapshot", async () => {
    const snapshot = entry({ id: "restored-tombstone", deleted_at: "2020-01-01T00:00:00.000Z" });
    const restored = entry({ id: snapshot.id, task: "Restored", revision: 2, dirty: true });
    await db.putEntry(restored);
    const local = localState([snapshot]);

    assert.equal(await purgeDeletedEntries(local, [], new Map()), 0);
    assert.deepEqual(await db.getEntry(snapshot.id), restored);
  });

  it("does not overwrite an older active timer edited after classification", async () => {
    const newest = entry({ id: "newest", start_at: "2026-08-08T10:00:00.000Z" });
    const observedOlder = entry({ id: "older", start_at: "2026-08-08T09:00:00.000Z" });
    const localEdit = entry({ id: "older", task: "Edited", revision: 2, dirty: true });
    await db.putEntries([newest, localEdit]);
    const local = localState([newest, observedOlder]);

    assert.deepEqual(await markMultipleActiveTimers(local), []);
    assert.deepEqual(await db.getEntry("older"), localEdit);
  });

  it("preserves an edit made while a replacement spreadsheet is being seeded", async () => {
    const snapshot = entry({ id: "reseeded" });
    const localEdit = entry({ id: snapshot.id, task: "Edited", revision: 2, dirty: true, sync_error: "" });
    await db.putEntry(localEdit);
    const local = localState([snapshot]);

    assert.equal(await reseedForNewSpreadsheet(local), 0);
    assert.deepEqual(await db.getEntry(snapshot.id), localEdit);
  });
});

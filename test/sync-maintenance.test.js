import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { seedEntry, seedEntries } from "./support/db-fixtures.js";
import { persistedEntryFixture } from "./support/persisted-entry-fixture.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;

const db = await import("../extension/src/db.js");
const { markMultipleActiveTimers, pushDirtyEntries } = await import("../extension/src/sync.js");

const entry = (over = {}) => persistedEntryFixture({
  id: "maintenance-entry",
  description: "",
  start_at: "2026-08-08T09:00:00.000Z",
  end_at: "",
  duration_seconds: 0,
  created_at: "2026-08-08T09:00:00.000Z",
  updated_at: "2026-08-08T09:00:00.000Z",
  dirty: false,
  last_sync_at: "",
  sync_error: "",
  ...over
});

function localState(entries) {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

describe("sync maintenance transactions", () => {
  it("does not push a dirty entry whose remote record is quarantined", async () => {
    const dirty = entry({ id: "quarantined-dirty", dirty: true });
    await seedEntry(db, dirty);
    let writes = 0;
    const provider = {
      async updateEntries() { writes += 1; },
      async appendEntries() { writes += 1; return []; }
    };

    const pushed = await pushDirtyEntries(localState([dirty]), [], new Map(), {
      blockedIds: new Set([dirty.id]),
      provider
    });

    assert.equal(writes, 0);
    assert.equal(pushed.size, 0);
    assert.equal((await db.getEntry(dirty.id)).dirty, true);
  });

  it("does not overwrite an older active timer edited after classification", async () => {
    const newest = entry({ id: "newest", start_at: "2026-08-08T10:00:00.000Z" });
    const observedOlder = entry({ id: "older", start_at: "2026-08-08T09:00:00.000Z" });
    const localEdit = entry({ id: "older", task: "Edited", revision: 2, dirty: true });
    await seedEntries(db, [newest, localEdit]);
    const local = localState([newest, observedOlder]);

    assert.deepEqual(await markMultipleActiveTimers(local), []);
    assert.deepEqual(await db.getEntry("older"), localEdit);
  });

});

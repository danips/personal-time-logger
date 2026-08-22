import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { seedEntry, seedEntries } from "./support/db-fixtures.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;

const db = await import("../extension/src/db.js");
const { markMultipleActiveTimers, purgeDeletedEntries, reseedForNewSpreadsheet } = await import("../extension/src/sync.js");
const { RECONCILIATION_INTENTS_KEY } = await import("../extension/src/reconcile.js");

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
  return new Map(entries.map((entry) => [entry.id, entry]));
}

describe("sync maintenance transactions", () => {
  it("does not purge a tombstone restored after the sync snapshot", async () => {
    const snapshot = entry({ id: "restored-tombstone", deleted_at: "2020-01-01T00:00:00.000Z" });
    const restored = entry({ id: snapshot.id, task: "Restored", revision: 2, dirty: true });
    await seedEntry(db, restored);
    const local = localState([snapshot]);

    assert.equal(await purgeDeletedEntries(local, [], new Map()), 0);
    assert.deepEqual(await db.getEntry(snapshot.id), restored);
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

  it("preserves an edit made while a replacement spreadsheet is being seeded", async () => {
    const snapshot = entry({ id: "reseeded" });
    const localEdit = entry({ id: snapshot.id, task: "Edited", revision: 2, dirty: true, sync_error: "" });
    await seedEntry(db, localEdit);
    const local = localState([snapshot]);

    assert.equal(await reseedForNewSpreadsheet(local), 0);
    assert.deepEqual(await db.getEntry(snapshot.id), localEdit);
  });

  it("clears remote-specific reconciliation intents while replacing a spreadsheet", async () => {
    const snapshot = entry({ id: "reseed-clears-intent" });
    await seedEntry(db, snapshot);
    await db.setSetting(RECONCILIATION_INTENTS_KEY, [{
      entry_id: snapshot.id,
      resolution_id: "old-sheet-resolution",
      state: "pending_remote_push"
    }]);
    await db.setSetting("remote_modified_time", "2026-08-08T12:00:00.000Z");

    await reseedForNewSpreadsheet(localState([snapshot]));

    assert.deepEqual(await db.getSetting(RECONCILIATION_INTENTS_KEY), []);
    assert.equal(await db.getSetting("remote_modified_time"), "");
  });

  it("marks the pending spreadsheet ready in the reseed transaction", async () => {
    const snapshot = entry({ id: "reseed-binding" });
    await seedEntry(db, snapshot);
    await db.setSetting("spreadsheet_id", { state: "pending", spreadsheetId: "new-sheet" });
    const local = localState([snapshot]);

    await reseedForNewSpreadsheet(local, { spreadsheetId: "new-sheet" });

    assert.deepEqual(await db.getSetting("spreadsheet_id"), { state: "ready", spreadsheetId: "new-sheet" });
    assert.equal((await db.getEntry(snapshot.id)).dirty, true);
  });
});

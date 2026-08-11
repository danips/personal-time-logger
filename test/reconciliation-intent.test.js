import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { seedEntry } from "./support/db-fixtures.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;

const db = await import("../src/db.js");
const reconcile = await import("../src/reconcile.js");

const local = {
  id: "conflict-entry",
  project: "Project",
  task: "Local choice",
  description: "",
  start_at: "2026-08-08T09:00:00.000Z",
  end_at: "2026-08-08T10:00:00.000Z",
  duration_seconds: 3600,
  status: "ok",
  created_at: "2026-08-08T09:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
  deleted_at: "",
  device_id: "device",
  revision: 2,
  multiply: "",
  dirty: false,
  last_sync_at: "",
  sync_error: ""
};

describe("reconciliation intent", () => {
  it("records the exact local revision and remote value selected by the user", async () => {
    const remote = { ...local, task: "Spreadsheet choice", updated_at: "2026-08-08T11:00:00.000Z", revision: 4 };
    await seedEntry(db, local);

    const chosen = await reconcile.keepLocal(local.id, remote, { expectedRevision: 2 });
    const intents = await db.getSetting(reconcile.RECONCILIATION_INTENTS_KEY);

    assert.equal(chosen.dirty, true);
    assert.equal(intents.length, 1);
    assert.deepEqual({
      entry_id: intents[0].entry_id,
      chosen_side: intents[0].chosen_side,
      state: intents[0].state,
      local_revision: intents[0].local_revision,
      remote_fingerprint: intents[0].remote_fingerprint
    }, {
      entry_id: local.id,
      chosen_side: "local",
      state: reconcile.RECONCILIATION_INTENT_PENDING,
      local_revision: 2,
      remote_fingerprint: reconcile.entryFingerprint(remote)
    });
    assert.match(intents[0].resolution_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(reconcile.isPendingReconciliationIntent(intents[0]), true);
  });

  it("assigns a fresh operation id when the same choice is recorded again", async () => {
    const entry = { ...local, id: "reselected-entry" };
    const remote = { ...entry, task: "Spreadsheet choice", updated_at: "2026-08-08T11:00:00.000Z", revision: 4 };
    await seedEntry(db, entry);

    await reconcile.keepLocal(entry.id, remote, { expectedRevision: entry.revision });
    const firstId = (await db.getSetting(reconcile.RECONCILIATION_INTENTS_KEY))
      .find((intent) => intent.entry_id === entry.id).resolution_id;
    await reconcile.keepLocal(entry.id, remote, { expectedRevision: entry.revision });
    const intents = (await db.getSetting(reconcile.RECONCILIATION_INTENTS_KEY))
      .filter((intent) => intent.entry_id === entry.id);

    assert.equal(intents.length, 1);
    assert.notEqual(intents[0].resolution_id, firstId);
  });

  it("refuses to record a choice made from a stale reconciliation screen", async () => {
    await seedEntry(db, { ...local, id: "stale-entry", revision: 3 });
    await assert.rejects(
      () => reconcile.keepLocal("stale-entry", { ...local, id: "stale-entry" }, { expectedRevision: 2 }),
      (error) => error.code === "STORAGE_CONFLICT" && error.reason === "revision_mismatch"
    );
  });

  it("moves expired and legacy intents into a bounded stale diagnostic record", async () => {
    await db.setSetting(reconcile.RECONCILIATION_INTENTS_KEY, [
      { entry_id: "expired", resolution_id: "expired-1", chosen_side: "local", state: reconcile.RECONCILIATION_INTENT_PENDING, expires_at: 1 },
      { entry_id: "legacy", resolution_id: "legacy-1", chosen_side: "local" }
    ]);

    const stale = await reconcile.pruneExpiredReconciliationIntents({ now: 2 });

    assert.deepEqual(stale.map((intent) => intent.entry_id), ["expired", "legacy"]);
    assert.deepEqual(await db.getSetting(reconcile.RECONCILIATION_INTENTS_KEY), []);
    assert.deepEqual((await db.getSetting(reconcile.STALE_RECONCILIATION_INTENTS_KEY)).map((intent) => intent.entry_id), ["expired", "legacy"]);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

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
    await db.putEntry(local);

    const chosen = await reconcile.keepLocal(local.id, remote, { expectedRevision: 2 });
    const intents = await db.getSetting(reconcile.RECONCILIATION_INTENTS_KEY);

    assert.equal(chosen.dirty, true);
    assert.deepEqual(intents, [{
      entry_id: local.id,
      chosen_side: "local",
      local_revision: 2,
      remote_fingerprint: reconcile.entryFingerprint(remote),
      resolution_id: `${local.id}:2:${remote.updated_at}`
    }]);
  });

  it("refuses to record a choice made from a stale reconciliation screen", async () => {
    await db.putEntry({ ...local, id: "stale-entry", revision: 3 });
    await assert.rejects(
      () => reconcile.keepLocal("stale-entry", { ...local, id: "stale-entry" }, { expectedRevision: 2 }),
      (error) => error.code === "STORAGE_CONFLICT" && error.reason === "revision_mismatch"
    );
  });
});

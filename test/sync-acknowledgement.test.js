import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;

const db = await import("../src/db.js");
const { markSynced } = await import("../src/sync.js");

const entry = (over = {}) => ({
  id: "ack-entry",
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
  dirty: true,
  last_sync_at: "",
  sync_error: "retry later",
  ...over
});

describe("sync acknowledgements", () => {
  it("does not clear a same-revision local edit whose fingerprint changed", async () => {
    const pushed = entry();
    const localEdit = entry({ task: "Edited after push", sync_error: "keep this error" });
    await db.putEntry(localEdit);

    const acknowledgement = await markSynced(pushed);

    assert.equal(acknowledgement.applied, false);
    assert.deepEqual(await db.getEntry(pushed.id), localEdit);
  });

  it("does not resurrect an entry deleted while its remote write was pending", async () => {
    const pushed = entry({ id: "ack-deleted" });
    await db.putEntry(pushed);
    await db.deleteEntry(pushed.id);

    const acknowledgement = await markSynced(pushed);

    assert.equal(acknowledgement.applied, false);
    assert.equal(acknowledgement.entry, null);
    assert.equal(await db.getEntry(pushed.id), undefined);
  });
});

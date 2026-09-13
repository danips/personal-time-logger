import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeEntry } from "../extension/src/entries.js";
import { seedEntry } from "./support/db-fixtures.js";
import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;
globalThis.browser = {
  runtime: { getURL: (path) => path },
  storage: { sync: { async get() { return {}; }, async set() {} } }
};

const db = await import("../extension/src/db.js");
const { syncNow } = await import("../extension/src/sync.js");

const entry = normalizeEntry({
  id: "lease-fence-entry",
  project: "Project",
  task: "Task",
  start_at: "2026-08-08T09:00:00.000Z",
  end_at: "2026-08-08T10:00:00.000Z",
  duration_seconds: 3600,
  created_at: "2026-08-08T09:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
  device_id: "device",
  revision: 1,
  dirty: true
});

describe("sync lease fencing", () => {
  it("does not acknowledge an append or release a newer lease after losing ownership", async () => {
    await seedEntry(db, entry);
    let releaseAppend;
    const appendGate = new Promise((resolve) => { releaseAppend = resolve; });
    const provider = {
      id: "mysql",
      label: "MySQL 8.4",
      async ensureReady() {},
      async getChangeToken() { return "v1"; },
      async readSnapshot() {
        return { entries: [], entryRefs: new Map(), quarantined: [], config: {}, configRefs: new Map(), changeToken: "v1" };
      },
      async updateEntries() {},
      async appendEntries() {
        await appendGate;
        return [{ id: entry.id, ref: { kind: "mysql-entry", version: 1 } }];
      },
      async updateConfig() {}
    };

    const sync = syncNow({ force: true, provider });
    while ((await db.getSetting("sync_lock", null))?.state !== "held") await new Promise((resolve) => setTimeout(resolve, 0));
    while (!(await db.getSetting("sync_lock", null))?.holder) await new Promise((resolve) => setTimeout(resolve, 0));
    const replacementLock = {
      state: "held",
      holder: "new-owner",
      generation: 999,
      token: "replacement-token",
      expires_at: Date.now() + 120_000,
      ttl_ms: 120_000
    };
    await db.setSetting("sync_lock", replacementLock);
    releaseAppend();

    await assert.rejects(sync, (error) => error.code === "SYNC_BUSY");
    assert.equal((await db.getEntry(entry.id)).dirty, true);
    assert.deepEqual(await db.getSetting("sync_lock"), replacementLock);
  });
});

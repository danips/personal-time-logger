import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { persistedEntryFixture } from "./support/persisted-entry-fixture.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;
globalThis.browser = {
  runtime: { getURL: (path) => path },
  storage: { sync: { async get() { return {}; }, async set() {} } }
};

const db = await import("../extension/src/db.js");
const { syncNow } = await import("../extension/src/sync.js");

async function releaseSyncDrain() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createProvider() {
  const calls = [];
  const provider = {
    id: "mysql",
    label: "Injected provider",
    calls,
    async ensureReady() { calls.push("health"); },
    async getChangeToken() { calls.push("change-token"); return "v1"; },
    async readSnapshot() {
      calls.push("read-snapshot");
      return { entries: [], entryRefs: new Map(), quarantined: [], config: {}, configRefs: new Map(), changeToken: "v1" };
    },
    async updateEntries(entries) {
      if (entries.length) calls.push("write-entry");
    },
    async appendEntries(entries) {
      if (entries.length) calls.push("write-entry");
      return entries.map((entry) => ({ id: entry.id, ref: { kind: "injected", version: 1 } }));
    },
  };
  return provider;
}

describe("injected provider sync request counts", () => {
  it("measures idle, dirty, and forced cycles at the sync boundary", async () => {
    const provider = createProvider();
    await db.setSetting("sync_interval_seconds", 60);

    // The first cycle establishes the change marker; the following idle cycle
    // exercises the health plus change-token gate used by API providers.
    await syncNow({ provider });
    await releaseSyncDrain();
    provider.calls.length = 0;
    await syncNow({ provider });
    await releaseSyncDrain();
    assert.deepEqual(provider.calls, ["health", "change-token"]);

    await db.mutateEntries(["counted-dirty"], (entries) => {
      entries.set("counted-dirty", persistedEntryFixture({ id: "counted-dirty", dirty: true }));
    });
    provider.calls.length = 0;
    await syncNow({ provider });
    await releaseSyncDrain();
    assert.deepEqual(provider.calls, ["health", "read-snapshot", "write-entry", "change-token"]);

    provider.calls.length = 0;
    await syncNow({ provider, force: true });
    await releaseSyncDrain();
    assert.deepEqual(provider.calls, ["health", "read-snapshot"]);
  });
});

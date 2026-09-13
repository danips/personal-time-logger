import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;
globalThis.browser = {
  runtime: { getURL: (path) => path },
  storage: { sync: { async get() { return {}; }, async set() {} } }
};

const db = await import("../extension/src/db.js");
const { syncNow } = await import("../extension/src/sync.js");

function barrier() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createProvider() {
  const calls = [];
  const gates = [barrier(), barrier()];
  return {
    id: "mysql",
    label: "MySQL 8.4",
    calls,
    async ensureReady() { calls.push("health"); },
    async getChangeToken() { calls.push("change-token"); return "v1"; },
    async readSnapshot() {
      const index = calls.filter((call) => call === "read-snapshot").length;
      calls.push("read-snapshot");
      await gates[index].promise;
      throw Object.assign(new Error("API unavailable"), { code: "API_ERROR" });
    },
    async updateEntries() {},
    async appendEntries() { return []; },
    async updateConfig() {},
    gates
  };
}

describe("same-context sync coalescing", () => {
  it("keeps a queued stronger cycle registered while it runs", async () => {
    const provider = createProvider();
    const first = syncNow({ provider });
    while (!provider.calls.includes("read-snapshot")) await new Promise((resolve) => setTimeout(resolve, 0));
    const second = syncNow({ force: true, provider });
    provider.gates[0].resolve();
    while (provider.calls.filter((call) => call === "read-snapshot").length < 2) await new Promise((resolve) => setTimeout(resolve, 0));

    const third = syncNow({ provider });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(provider.calls.filter((call) => call === "read-snapshot").length, 2);

    provider.gates[1].resolve();

    await assert.rejects(first, (error) => error.code === "API_ERROR");
    await assert.rejects(second, (error) => error.code === "API_ERROR");
    await assert.rejects(third, (error) => error.code === "API_ERROR");
    const lock = await db.getSetting("sync_lock", null);
    assert.equal(lock.state, "free");
  });
});

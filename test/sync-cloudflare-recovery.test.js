import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeEntry } from "../extension/src/entries.js";
import { pushDirtyEntries } from "../extension/src/sync.js";
import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { seedEntries } from "./support/db-fixtures.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;

const db = await import("../extension/src/db.js");

function fixture(index, over = {}) {
  return normalizeEntry({
    id: `cloudflare-recovery-${index}`,
    project: "Project",
    task: "Task",
    description: `Local ${index}`,
    start_at: "2026-08-30T09:00:00.000Z",
    end_at: "2026-08-30T10:00:00.000Z",
    duration_seconds: 3600,
    status: "ok",
    created_at: "2026-08-30T09:00:00.000Z",
    updated_at: "2026-08-30T10:00:00.000Z",
    deleted_at: "",
    device_id: "recovery-device",
    revision: 1,
    multiply: "",
    dirty: true,
    ...over
  });
}

function remoteVersion(entry, version) {
  return { entry: { ...entry, dirty: false, last_sync_at: "", sync_error: "" }, version };
}

describe("Cloudflare D1 chunk recovery", () => {
  it("leaves every local update dirty after chunk two fails, then reconciles committed matches", async () => {
    const entries = Array.from({ length: 16 }, (_, index) => fixture(index));
    const oldRemote = entries.map((entry) => ({
      ...entry, description: `Remote old ${entry.id}`, updated_at: "2026-08-30T08:00:00.000Z"
    }));
    const remote = new Map(oldRemote.map((entry) => [entry.id, remoteVersion(entry, 1)]));
    let readCount = 0;
    let updateCall = 0;
    const provider = {
      async appendEntries() { return []; },
      async updateEntries(updates) {
        for (let offset = 0; offset < updates.length; offset += 15) {
          updateCall += 1;
          const chunk = updates.slice(offset, offset + 15);
          if (updateCall === 2) throw new Error("synthetic second chunk failure");
          for (const { entry, expectedRef } of chunk) {
            assert.equal(expectedRef.version, remote.get(entry.id).version);
            remote.set(entry.id, remoteVersion(entry, expectedRef.version + 1));
          }
        }
      },
      async readSnapshot() {
        readCount += 1;
        const entries = [...remote.values()].map(({ entry }) => entry);
        return {
          entries,
          entryRefs: new Map([...remote].map(([id, value]) => [id, { kind: "cloudflare-d1-row", version: value.version }])),
          config: [],
          configRefs: new Map(),
          changeToken: String(readCount)
        };
      }
    };
    await seedEntries(db, entries);
    const local = new Map(entries.map((entry) => [entry.id, entry]));
    const refs = new Map([...remote].map(([id, value]) => [id, { kind: "cloudflare-d1-row", version: value.version }]));

    await assert.rejects(
      () => pushDirtyEntries(local, oldRemote, refs, { provider }),
      /synthetic second chunk failure/
    );
    assert.equal(updateCall, 2);
    assert.equal(readCount, 0);
    for (const entry of entries) assert.equal((await db.getEntry(entry.id)).dirty, true);

    const snapshot = await provider.readSnapshot();
    const pushed = await pushDirtyEntries(local, snapshot.entries, snapshot.entryRefs, { provider });

    assert.equal(readCount, 1);
    assert.equal(pushed.size, entries.length);
    assert.equal(updateCall, 3);
    assert.deepEqual(
      [...remote.values()].map(({ entry }) => entry.description),
      entries.map((entry) => entry.description)
    );
    for (const entry of entries) assert.equal((await db.getEntry(entry.id)).dirty, false);
  });
});

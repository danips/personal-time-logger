import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeEntry } from "../extension/src/entries.js";
import { seedEntry, seedEntries } from "./support/db-fixtures.js";
import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;

const db = await import("../extension/src/db.js");
const { pushDirtyEntries } = await import("../extension/src/sync.js");

const fixture = (over = {}) => normalizeEntry({
  id: "append-entry",
  project: "Project",
  task: "Task",
  start_at: "2026-08-08T09:00:00.000Z",
  end_at: "2026-08-08T10:00:00.000Z",
  duration_seconds: 3600,
  created_at: "2026-08-08T09:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
  device_id: "device",
  revision: 1,
  dirty: true,
  ...over
});

const localState = (entries) => new Map(entries.map((entry) => [entry.id, entry]));

function snapshot(entries) {
  return {
    entries,
    entryRefs: new Map(entries.map((entry) => [entry.id, { kind: "mysql-entry", version: 1 }])),
    duplicates: [],
    quarantined: [],
    config: {},
    configRefs: new Map(),
    changeToken: "v1"
  };
}

function createProvider({ append, reads = [] } = {}) {
  const readQueue = [...reads];
  const provider = {
    id: "mysql",
    label: "MySQL 8.4",
    async updateEntries() {},
    async appendEntries(entries) {
      return append ? append(entries, provider) : entries.map((entry) => ({ id: entry.id, ref: { kind: "mysql-entry", version: 1 } }));
    },
    async readSnapshot() {
      const next = readQueue.shift();
      return typeof next === "function" ? next() : next || snapshot([]);
    }
  };
  return provider;
}

describe("append idempotency", () => {
  it("keeps an append dirty until read-back confirms a response without a mapping", async () => {
    const entry = fixture({ id: "append-missing-mapping" });
    await seedEntry(db, entry);
    let resolveRead;
    let markReadStarted;
    const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
    const readGate = new Promise((resolve) => { resolveRead = resolve; });
    const provider = createProvider({
      append: async () => [],
      reads: [async () => {
        markReadStarted();
        return readGate;
      }]
    });
    const pushedPromise = pushDirtyEntries(localState([entry]), [], new Map(), { provider });
    await readStarted;
    assert.equal((await db.getEntry(entry.id)).dirty, true);
    resolveRead(snapshot([entry]));
    const pushed = await pushedPromise;
    assert.equal(pushed.has(entry.id), true);
    assert.equal((await db.getEntry(entry.id)).dirty, false);
  });

  it("does not append again after a committed append loses its response", async () => {
    const entry = fixture({ id: "append-timeout" });
    const local = localState([entry]);
    await seedEntry(db, entry);
    let appendCalls = 0;
    const provider = createProvider({
      append: async () => {
        appendCalls += 1;
        throw Object.assign(new Error("connection lost after the server committed the append"), { committed: true });
      },
      reads: [snapshot([entry])]
    });

    await assert.rejects(() => pushDirtyEntries(local, [], new Map(), { provider }), /connection lost/);
    assert.equal((await db.getEntry(entry.id)).dirty, false);
    await pushDirtyEntries(local, [], new Map(), { provider });
    assert.equal(appendCalls, 1);
  });

  it("acknowledges only the confirmed prefix of a partial append response", async () => {
    const first = fixture({ id: "append-prefix-first" });
    const second = fixture({ id: "append-prefix-second" });
    await seedEntries(db, [first, second]);
    const provider = createProvider({
      append: async () => [{ id: first.id, ref: { kind: "mysql-entry", version: 1 } }]
    });

    const pushed = await pushDirtyEntries(localState([first, second]), [], new Map(), { provider });
    assert.equal(pushed.has(first.id), true);
    assert.equal(pushed.has(second.id), false);
    assert.equal((await db.getEntry(first.id)).dirty, false);
    assert.equal((await db.getEntry(second.id)).dirty, true);
  });

  it("treats a same-id record with different contents as an append conflict", async () => {
    const entry = fixture({ id: "append-conflict" });
    const remote = fixture({ id: entry.id, task: "Manual API edit", dirty: false });
    await seedEntry(db, entry);
    const provider = createProvider({ append: async () => [], reads: [snapshot([remote])] });

    await assert.rejects(
      () => pushDirtyEntries(localState([entry]), [], new Map(), { provider }),
      (error) => error.code === "REMOTE_APPEND_CONFLICT"
    );
    assert.equal((await db.getEntry(entry.id)).dirty, true);
  });
});

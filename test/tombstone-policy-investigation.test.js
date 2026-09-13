import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { seedEntry } from "./support/db-fixtures.js";
import { persistedEntryFixture } from "./support/persisted-entry-fixture.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;

const db = await import("../extension/src/db.js");
const backup = await import("../extension/src/backup.js");
const { protectDeletionRecovery, pullRemoteEntries, purgeDeletedEntries, pushDirtyEntries } = await import("../extension/src/sync.js");
const { SETTING_KEY } = await import("../extension/src/setting-keys.js");

const PROVIDERS = [
  { id: "google-sheets", refKind: "google-sheet-row" },
  { id: "mysql", refKind: "mysql-row" },
  { id: "cloudflare-d1", refKind: "cloudflare-d1-row" }
];

function entry(id, overrides = {}) {
  return persistedEntryFixture({
    id,
    project: "Project",
    task: "Task",
    description: "Description",
    start_at: "2026-08-08T09:00:00.000Z",
    end_at: "2026-08-08T10:00:00.000Z",
    duration_seconds: 3600,
    status: "ok",
    created_at: "2026-08-08T09:00:00.000Z",
    updated_at: "2026-08-08T10:00:00.000Z",
    deleted_at: "",
    device_id: "device-a",
    revision: 1,
    multiply: "",
    dirty: false,
    last_sync_at: "2026-08-08T10:00:00.000Z",
    sync_error: "",
    ...overrides
  });
}

function localState(entries) {
  return new Map(entries.map((value) => [value.id, value]));
}

function providerDouble(providerDefinition, remoteEntries) {
  const remote = new Map(remoteEntries.map((value) => [value.id, value]));
  return {
    id: providerDefinition.id,
    async updateEntries() {},
    async deleteEntries(preconditions) {
      for (const { id } of preconditions) remote.delete(id);
    },
    async appendEntries(entries) {
      return entries.map((value) => {
        remote.set(value.id, value);
        return { id: value.id, ref: { kind: providerDefinition.refKind, version: 1 } };
      });
    },
    remote
  };
}

describe("tombstone retention investigation", () => {
  it("reproduces post-purge outcomes for every registered provider", async () => {
    const report = [];

    for (const providerDefinition of PROVIDERS) {
      const prefix = `tombstone-${providerDefinition.id}`;
      const id = (suffix) => `${prefix}-${suffix}`;
      const tombstone = entry(id("deleted"), {
        deleted_at: "2000-01-01T00:00:00.000Z",
        updated_at: "2026-08-09T10:00:00.000Z",
        device_id: "device-a"
      });
      const provider = providerDouble(providerDefinition, [tombstone]);
      const profileA = localState([tombstone]);
      await seedEntry(db, tombstone);

      const purgedA = await purgeDeletedEntries(
        profileA,
        [tombstone],
        new Map([[tombstone.id, { kind: providerDefinition.refKind, version: 1 }]]),
        [],
        { provider }
      );
      assert.equal(purgedA, 0, `${providerDefinition.id}: expired tombstone should be retained`);
      assert.equal(provider.remote.has(tombstone.id), true, `${providerDefinition.id}: remote tombstone should be retained`);
      assert.equal(profileA.has(tombstone.id), true, `${providerDefinition.id}: profile A should retain its tombstone`);

      const cleanOldCopy = entry(tombstone.id, { device_id: "device-b" });
      const profileBClean = localState([cleanOldCopy]);
      await seedEntry(db, cleanOldCopy);
      await pullRemoteEntries(profileBClean, [tombstone], new Set());
      assert.equal(profileBClean.get(tombstone.id).deleted_at, tombstone.deleted_at, `${providerDefinition.id}: retained tombstone should replace a clean old copy`);

      const dirtyOldCopy = entry(tombstone.id, {
        description: "Edited while offline",
        device_id: "device-b",
        dirty: true,
        revision: 2,
        updated_at: "2026-08-10T10:00:00.000Z"
      });
      const profileBDirty = localState([dirtyOldCopy]);
      await seedEntry(db, dirtyOldCopy);
      const tombstoneBlocked = await protectDeletionRecovery(profileBDirty, [tombstone], new Set(), new Set());
      assert.equal(tombstoneBlocked.has(tombstone.id), true, `${providerDefinition.id}: dirty edit against tombstone should require review`);
      const pushedOldCopy = await pushDirtyEntries(
        profileBDirty,
        [tombstone],
        new Map([[tombstone.id, { kind: providerDefinition.refKind, version: 1 }]]),
        { provider, blockedIds: tombstoneBlocked }
      );
      assert.deepEqual([...pushedOldCopy], [], `${providerDefinition.id}: dirty edit against tombstone must not push automatically`);
      assert.equal(provider.remote.get(tombstone.id).deleted_at, tombstone.deleted_at, `${providerDefinition.id}: tombstone must not be resurrected`);

      const missingOldCopy = entry(id("missing"), {
        description: "Edited while deletion evidence was absent",
        device_id: "device-b",
        dirty: true,
        revision: 2
      });
      const profileBMissing = localState([missingOldCopy]);
      await seedEntry(db, missingOldCopy);
      const missingBlocked = await protectDeletionRecovery(profileBMissing, [], new Set(), new Set());
      assert.equal(missingBlocked.has(missingOldCopy.id), true, `${providerDefinition.id}: previously synced missing ID should require review`);
      const pushedMissing = await pushDirtyEntries(profileBMissing, [], new Map(), { provider, blockedIds: missingBlocked });
      assert.deepEqual([...pushedMissing], [], `${providerDefinition.id}: missing previously synced ID must not append`);
      assert.equal(provider.remote.has(missingOldCopy.id), false, `${providerDefinition.id}: missing previously synced ID must remain absent`);

      const newUnsent = entry(id("new"), {
        device_id: "device-b",
        dirty: true,
        last_sync_at: "",
        revision: 1
      });
      await seedEntry(db, newUnsent);
      const newBlocked = await protectDeletionRecovery(localState([newUnsent]), [], new Set(), new Set());
      const pushedNew = await pushDirtyEntries(localState([newUnsent]), [], new Map(), { provider, blockedIds: newBlocked });
      assert.deepEqual([...pushedNew], [newUnsent.id], `${providerDefinition.id}: new unsent ID remains appendable`);

      const backupSource = entry(id("backup"), { device_id: "device-a" });
      const parsedBackup = backup.parseBackup(backup.serializeBackup({ entries: [backupSource], settings: {} }));
      const restored = await backup.restoreBackup(parsedBackup);
      assert.equal(restored.added, 1, `${providerDefinition.id}: old backup should restore a missing entry`);
      const restoredEntry = await db.getEntry(backupSource.id);
      assert.equal(restoredEntry.dirty, true, `${providerDefinition.id}: restored entry should be pending local work`);
      const pendingBackupIds = new Set(await db.getSetting(SETTING_KEY.SYNC_RECOVERY_PENDING, []));
      assert.equal(pendingBackupIds.has(backupSource.id), true, `${providerDefinition.id}: restored entry should retain unproven provenance`);
      const backupBlocked = await protectDeletionRecovery(localState([restoredEntry]), [], pendingBackupIds, new Set());
      const pushedBackup = await pushDirtyEntries(localState([restoredEntry]), [], new Map(), { provider, blockedIds: backupBlocked });
      assert.deepEqual([...pushedBackup], [], `${providerDefinition.id}: restored old copy must not append without review`);
      assert.equal(provider.remote.has(backupSource.id), false, `${providerDefinition.id}: restored old copy must remain absent`);

      report.push(`${providerDefinition.id}: A retained tombstone; B imported deletion; dirty tombstone edit blocked; missing synced ID blocked; new unsent appended; old backup blocked`);
    }

    console.log(`Tombstone investigation: ${report.join(" | ")}`);
  });
});

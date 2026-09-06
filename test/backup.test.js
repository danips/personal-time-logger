import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { seedEntry } from "./support/db-fixtures.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;
const db = await import("../extension/src/db.js");
const backup = await import("../extension/src/backup.js");

const entry = (id, over = {}) => ({
  id,
  project: "Project",
  task: "Task",
  description: "Description",
  start_at: "2026-08-30T09:00:00.000Z",
  end_at: "2026-08-30T10:00:00.000Z",
  duration_seconds: 3600,
  status: "ok",
  created_at: "2026-08-30T09:00:00.000Z",
  updated_at: "2026-08-30T10:00:00.000Z",
  deleted_at: "",
  device_id: "device",
  revision: 1,
  multiply: "",
  dirty: false,
  last_sync_at: "2026-08-30T10:00:00.000Z",
  sync_error: "",
  ...over
});

describe("manual backup service", () => {
  before(async () => {
    await db.setSetting("duration_multiplier", "1.000");
    await db.setSetting("sync_interval_seconds", 60);
    await seedEntry(db, entry("backup-clean"));
  });

  it("round-trips a coherent clean snapshot and excludes unsynced entries", async () => {
    const snapshot = await backup.readPortableBackupSnapshot();
    const parsed = backup.parseBackup(backup.serializeBackup(snapshot));
    assert.equal(parsed.entries[0].id, "backup-clean");
    assert.equal(Object.hasOwn(parsed.settings, "mysql_api_token"), false);

    await seedEntry(db, entry("backup-dirty", { dirty: true }));
    await assert.rejects(() => backup.readPortableBackupSnapshot(), { code: "BACKUP_NOT_SYNCED" });
  });

  it("commits new entries, preserves conflicts, and is idempotent", async () => {
    const incoming = backup.parseBackup(backup.serializeBackup({
      entries: [entry("backup-clean", { project: "Changed" }), entry("backup-new")],
      settings: { sync_interval_seconds: 90 }
    }));
    const first = await backup.restoreBackup(incoming);
    assert.deepEqual(first.conflicts, ["backup-clean"]);
    assert.equal(first.added, 1);
    assert.equal((await db.getEntry("backup-clean")).project, "Project");
    assert.equal((await db.getEntry("backup-new")).dirty, true);
    const second = await backup.restoreBackup(incoming);
    assert.deepEqual(second.conflicts, ["backup-clean"]);
    assert.equal(second.added, 0);
  });
});

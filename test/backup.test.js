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

  it("round-trips active, tombstone, and dirty entries without mutating live state", async () => {
    const dirty = entry("backup-dirty", {
      dirty: true,
      last_sync_at: "2026-08-29T10:00:00.000Z",
      sync_error: "unsent edit"
    });
    const tombstone = entry("backup-tombstone", {
      deleted_at: "2026-08-29T11:00:00.000Z",
      dirty: true
    });
    await seedEntry(db, dirty);
    await seedEntry(db, tombstone);

    const snapshot = await backup.readPortableBackupSnapshot();
    const exportedDirty = snapshot.entries.find(({ id }) => id === dirty.id);
    const exportedTombstone = snapshot.entries.find(({ id }) => id === tombstone.id);
    assert.equal(exportedDirty.dirty, false);
    assert.equal(exportedDirty.last_sync_at, "");
    assert.equal(exportedDirty.sync_error, "");
    assert.equal(exportedTombstone.deleted_at, tombstone.deleted_at);
    assert.equal((await db.getEntry(dirty.id)).dirty, true);
    assert.equal((await db.getEntry(dirty.id)).sync_error, dirty.sync_error);

    const parsed = backup.parseBackup(backup.serializeBackup(snapshot));
    assert.equal(parsed.entries[0].id, "backup-clean");
    assert.equal(parsed.entries.find(({ id }) => id === dirty.id).dirty, false);
    assert.equal(Object.hasOwn(parsed.settings, "mysql_api_token"), false);
  });

  it("previews additions, identical entries, conflicts, and setting changes", async () => {
    const preview = await backup.previewBackup(backup.parseBackup(backup.serializeBackup({
      entries: [
        entry("backup-clean"),
        entry("backup-preview-new", { task: "New task" }),
        entry("backup-tombstone")
      ],
      settings: { sync_interval_seconds: 90 }
    })));
    assert.deepEqual(preview.additions.map(({ id }) => id), ["backup-preview-new"]);
    assert.deepEqual(preview.identical.map(({ id }) => id), ["backup-clean"]);
    assert.deepEqual(preview.conflicts.map(({ id }) => id), ["backup-tombstone"]);
    assert.ok(preview.conflicts[0].differences.some(({ field }) => field === "deleted_at"));
    assert.deepEqual(preview.settingsChanges.map(({ key }) => key), ["sync_interval_seconds"]);
  });

  it("commits new entries, preserves conflicts, and is idempotent", async () => {
    const incoming = backup.parseBackup(backup.serializeBackup({
      entries: [entry("backup-clean", { project: "Changed" }), entry("backup-new")],
      settings: { sync_interval_seconds: 90 }
    }));
    const first = await backup.restoreBackup(incoming);
    assert.deepEqual(first.conflicts, ["backup-clean"]);
    assert.equal(first.added, 1);
    assert.equal(first.identical, 0);
    assert.deepEqual(first.settingsChanges, [{ key: "sync_interval_seconds", current: 60, backup: 90 }]);
    assert.equal((await db.getEntry("backup-clean")).project, "Project");
    assert.equal((await db.getEntry("backup-new")).dirty, true);
    const second = await backup.restoreBackup(incoming);
    assert.deepEqual(second.conflicts, ["backup-clean"]);
    assert.equal(second.identical, 1);
    assert.equal(second.added, 0);

    await backup.restoreBackup(backup.parseBackup(backup.serializeBackup({
      entries: [],
      settings: { sync_interval_seconds: 45 }
    })), { restoreSettings: false });
    assert.equal(await db.getSetting("sync_interval_seconds"), 90);
  });

  it("rechecks a preview after a newer local edit", async () => {
    const incoming = backup.parseBackup(backup.serializeBackup({
      entries: [entry("backup-clean", { project: "Preview copy" })],
      settings: {}
    }));
    const preview = await backup.previewBackup(incoming);
    assert.deepEqual(preview.conflicts.map(({ id }) => id), ["backup-clean"]);
    await seedEntry(db, entry("backup-clean", { project: "Newer local edit", dirty: true, revision: 4 }));

    const summary = await backup.restoreBackup(incoming);
    assert.deepEqual(summary.conflicts, ["backup-clean"]);
    assert.equal((await db.getEntry("backup-clean")).project, "Newer local edit");
  });

  it("keeps v1 validation strict for duplicate, malformed, and oversized backups", () => {
    const valid = backup.serializeBackup({ entries: [entry("backup-valid")], settings: {} });
    const duplicate = JSON.parse(valid);
    duplicate.entries.push(duplicate.entries[0]);
    assert.throws(() => backup.parseBackup(JSON.stringify(duplicate)), { code: "BACKUP_INVALID" });

    const invalid = JSON.parse(valid);
    delete invalid.entries[0].task;
    assert.throws(() => backup.parseBackup(JSON.stringify(invalid)), { code: "BACKUP_INVALID" });
    assert.throws(() => backup.parseBackup("not-json"), { code: "BACKUP_INVALID" });
    assert.throws(() => backup.assertBackupSize(backup.MAX_BACKUP_BYTES + 1), { code: "BACKUP_INVALID" });
  });
});

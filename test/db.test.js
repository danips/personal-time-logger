import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { seedEntry, seedEntries } from "./support/db-fixtures.js";

installFakeIndexedDB();

let db;

before(async () => {
  db = await import("../extension/src/db.js");
});

describe("IndexedDB repository", () => {
  it("creates the version-5 stores and round-trips entries and settings", async () => {
    const entry = { id: "entry-1", project: "Project", revision: 1, dirty: true };

    await db.setSetting("profile", { name: "Test user" });
    await seedEntry(db, entry);

    assert.deepEqual(await db.getSetting("profile"), { name: "Test user" });
    assert.deepEqual(await db.getEntry("entry-1"), entry);
    assert.deepEqual(await db.getDirtyEntries(), [entry]);
  });

  it("keeps multi-record writes in one transaction", async () => {
    const entries = [
      { id: "entry-2", revision: 1 },
      { id: "entry-3", revision: 1 }
    ];

    await seedEntries(db, entries);

    assert.deepEqual(await db.getAllEntries(), [
      { id: "entry-1", project: "Project", revision: 1, dirty: true },
      { id: "entry-2", revision: 1 },
      { id: "entry-3", revision: 1 }
    ]);
  });

  it("shares committed data across independent database connections", async () => {
    const first = indexedDB.open("timelogger_db", 5);
    const second = indexedDB.open("timelogger_db", 5);
    const [firstConnection, secondConnection] = await Promise.all([
      new Promise((resolve, reject) => {
        first.onsuccess = () => resolve(first.result);
        first.onerror = () => reject(first.error);
      }),
      new Promise((resolve, reject) => {
        second.onsuccess = () => resolve(second.result);
        second.onerror = () => reject(second.error);
      })
    ]);

    const transaction = firstConnection.transaction("settings", "readwrite");
    transaction.objectStore("settings").put({ key: "shared", value: "visible" });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    const read = secondConnection.transaction("settings", "readonly").objectStore("settings").get("shared");
    const result = await new Promise((resolve, reject) => {
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
    });
    assert.deepEqual(result, { key: "shared", value: "visible" });
  });

  it("compare-and-swaps an entry revision and reports a typed conflict", async () => {
    await seedEntry(db, { id: "entry-cas", revision: 4, task: "before" });

    const updated = await db.mutateEntry("entry-cas", 4, (entry) => ({
      ...entry,
      task: "after",
      revision: entry.revision + 1
    }));
    assert.equal(updated.revision, 5);
    assert.equal((await db.getEntry("entry-cas")).task, "after");

    await assert.rejects(
      () => db.mutateEntry("entry-cas", 4, (entry) => ({ ...entry, task: "stale" })),
      (error) => error.code === "STORAGE_CONFLICT" && error.reason === "revision_mismatch"
    );
    assert.equal((await db.getEntry("entry-cas")).task, "after");
  });

  it("commits multi-entry and multi-setting mutations together", async () => {
    await seedEntries(db, [
      { id: "entry-left", revision: 1, task: "left" },
      { id: "entry-right", revision: 2, task: "right" }
    ]);
    await db.mutateEntries(["entry-left", "entry-right"], { "entry-left": 1, "entry-right": 2 }, (entries) => {
      for (const entry of entries.values()) entry.revision += 1;
    });
    await db.mutateSettings(["first", "second"], (settings) => {
      settings.set("first", "saved");
      settings.set("second", 2);
    });

    assert.deepEqual(
      [await db.getEntry("entry-left"), await db.getEntry("entry-right")].map((entry) => entry.revision),
      [2, 3]
    );
    assert.equal(await db.getSetting("first"), "saved");
    assert.equal(await db.getSetting("second"), 2);
  });

  it("skips writes for unchanged settings in an atomic mutation", async () => {
    await db.setSetting("unchanged-setting", { value: "same" });
    indexedDB._resetWriteLog();

    await db.mutateSettings(["unchanged-setting", "changed-setting"], (settings) => {
      settings.set("unchanged-setting", { value: "same" });
      settings.set("changed-setting", "new");
    });

    assert.deepEqual(indexedDB._getWriteLog(), [
      { store: "settings", operation: "put", key: "changed-setting" }
    ]);
  });

  it("skips writes for unchanged entries in an atomic mutation", async () => {
    const unchanged = { id: "unchanged-entry", revision: 1, task: "same" };
    await seedEntry(db, unchanged);
    indexedDB._resetWriteLog();

    await db.mutateEntries([unchanged.id], () => {});

    assert.deepEqual(indexedDB._getWriteLog(), []);
  });

  it("rolls back scoped entry and setting changes together", async () => {
    await seedEntry(db, { id: "scoped-rollback", revision: 1, task: "before" });
    await db.setSetting("scoped-rollback-setting", "before");
    indexedDB._failOnWrite(2);

    await assert.rejects(() => db.mutateEntryState({
      entryIds: ["scoped-rollback"],
      settingKeys: ["scoped-rollback-setting"]
    }, ({ entries, settings }) => {
      entries.set("scoped-rollback", { ...entries.get("scoped-rollback"), task: "after" });
      settings.set("scoped-rollback-setting", "after");
    }), /Injected IndexedDB write failure/);

    assert.equal((await db.getEntry("scoped-rollback")).task, "before");
    assert.equal(await db.getSetting("scoped-rollback-setting"), "before");
  });

  it("does not apply a multi-entry mutation when any expected revision is stale", async () => {
    await assert.rejects(
      () => db.mutateEntries(["entry-left", "entry-right"], { "entry-left": 2, "entry-right": 2 }, (entries) => {
        for (const entry of entries.values()) entry.task = "changed";
      }),
      (error) => error.code === "STORAGE_CONFLICT" && error.id === "entry-right"
    );
    assert.equal((await db.getEntry("entry-left")).task, "left");
    assert.equal((await db.getEntry("entry-right")).task, "right");
  });

  it("fences a former lock holder after a newer generation is claimed", async () => {
    const first = await db.claimLock("generation-lock", "first-holder", 0);
    const second = await db.claimLock("generation-lock", "second-holder", 120_000);

    assert.ok(second.generation > first.generation);
    assert.equal(await db.renewLock(first), false);
    await db.releaseLock(first);
    assert.equal(await db.isLockCurrent(second), true);
  });

  it("indexes dirty counts and entries alongside deleted, status, active, and interval queries", async () => {
    const entries = [
      {
        id: "index-completed", dirty: true, deleted_at: "", status: "ok",
        start_at: "2026-08-10T09:00:00.000Z", end_at: "2026-08-10T10:00:00.000Z"
      },
      {
        id: "index-active", dirty: false, deleted_at: "", status: "needs_review",
        start_at: "2026-08-10T11:00:00.000Z", end_at: ""
      },
      {
        id: "index-deleted", dirty: false, deleted_at: "2026-08-11T12:00:00.000Z", status: "ok",
        start_at: "2026-08-11T09:00:00.000Z", end_at: "2026-08-11T10:00:00.000Z"
      }
    ];
    await seedEntries(db, entries);

    assert.deepEqual((await db.getDirtyEntries()).map((entry) => entry.id), ["entry-1", "index-completed"]);
    assert.equal(await db.getDirtyEntryCount(), 2);
    await db.mutateEntry("index-completed", (entry) => ({ ...entry, dirty: false }));
    assert.equal(await db.getDirtyEntryCount(), 1);
    const allEntries = await db.getAllEntries();
    assert.deepEqual(allEntries.filter((entry) => entry.deleted_at).map((entry) => entry.id), ["index-deleted"]);
    assert.deepEqual(allEntries.filter((entry) => entry.status === "needs_review").map((entry) => entry.id), ["index-active"]);
    assert.deepEqual((await db.getActiveEntries()).map((entry) => entry.id), ["index-active"]);
    assert.deepEqual(
      (await db.getVisibleEntries({ limit: 2 })).map((entry) => entry.id),
      ["index-active", "index-completed"]
    );
    assert.deepEqual(
      (await db.getVisibleEntries({ before: "2026-08-10T11:00:00.000Z", limit: 2 })).map((entry) => entry.id),
      ["index-completed"]
    );
    assert.deepEqual(
      (await db.getEntriesIntersecting("2026-08-10T09:30:00.000Z", "2026-08-10T12:00:00.000Z"))
        .map((entry) => entry.id),
      ["index-completed", "index-active"]
    );
  });
});

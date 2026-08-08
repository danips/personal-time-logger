import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();

let db;

before(async () => {
  db = await import("../src/db.js");
});

describe("IndexedDB repository", () => {
  it("creates the version-2 stores and round-trips entries and settings", async () => {
    const entry = { id: "entry-1", project: "Project", revision: 1, dirty: true };

    await db.setSetting("profile", { name: "Test user" });
    await db.putEntry(entry);

    assert.deepEqual(await db.getSetting("profile"), { name: "Test user" });
    assert.deepEqual(await db.getEntry("entry-1"), entry);
    assert.deepEqual(await db.getDirtyEntries(), [entry]);
  });

  it("keeps multi-record writes in one transaction", async () => {
    const entries = [
      { id: "entry-2", revision: 1 },
      { id: "entry-3", revision: 1 }
    ];

    await db.putEntries(entries);

    assert.deepEqual(await db.getAllEntries(), [
      { id: "entry-1", project: "Project", revision: 1, dirty: true },
      { id: "entry-2", revision: 1 },
      { id: "entry-3", revision: 1 }
    ]);
  });

  it("shares committed data across independent database connections", async () => {
    const first = indexedDB.open("timelogger_db", 2);
    const second = indexedDB.open("timelogger_db", 2);
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
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function openLegacyV3Database() {
  const request = indexedDB.open("timelogger_db", 3);
  request.onupgradeneeded = () => {
    const entries = request.result.createObjectStore("time_entries", { keyPath: "id" });
    entries.createIndex("dirty", "dirty");
    request.result.createObjectStore("settings", { keyPath: "key" });
  };
  return requestResult(request);
}

describe("dirty-key migration", () => {
  it("upgrades version-3 entries without exposing the derived index key", async () => {
    const legacy = await openLegacyV3Database();
    const seed = legacy.transaction("time_entries", "readwrite");
    seed.objectStore("time_entries").put({ id: "legacy-clean", dirty: false, task: "Clean" });
    seed.objectStore("time_entries").put({ id: "legacy-dirty", dirty: true, task: "Pending" });
    await transactionDone(seed);
    legacy.close();

    const db = await import("../extension/src/db.js");
    assert.equal(await db.getDirtyEntryCount(), 1);
    assert.deepEqual((await db.getDirtyEntries()).map((entry) => entry.id), ["legacy-dirty"]);
    assert.deepEqual(await db.getEntry("legacy-dirty"), { id: "legacy-dirty", dirty: true, task: "Pending" });

    const current = await requestResult(indexedDB.open("timelogger_db", 4));
    const entries = current.transaction("time_entries", "readonly").objectStore("time_entries");
    const stored = await requestResult(entries.getAll());
    assert.equal(entries.indexNames.contains("dirty"), false);
    assert.equal(entries.indexNames.contains("dirty_key"), true);
    assert.equal(stored.find((entry) => entry.id === "legacy-dirty").dirty_key, 1);
    assert.equal("dirty_key" in stored.find((entry) => entry.id === "legacy-clean"), false);
  });
});

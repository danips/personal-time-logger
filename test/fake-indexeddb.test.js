import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

function openDatabase(name) {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = ({ target }) => target.result.createObjectStore("items", { keyPath: "id" });
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function waitUntil(predicate, label, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`${label} did not complete before the ${timeoutMs}ms deadline.`));
      setTimeout(check, 0);
    };
    check();
  });
}

describe("fake IndexedDB transaction scheduler", () => {
  it("runs transactions in FIFO order after completion", async () => {
    installFakeIndexedDB();
    const database = await openDatabase("fifo-success");
    const completed = [];
    const first = database.transaction("items", "readwrite");
    first.objectStore("items").put({ id: "first" });
    first.oncomplete = () => completed.push("first");
    const second = database.transaction("items", "readwrite");
    second.objectStore("items").put({ id: "second" });
    second.oncomplete = () => completed.push("second");

    await waitUntil(() => completed.length === 2, "FIFO transactions");
    assert.deepEqual(completed, ["first", "second"]);
  });

  it("keeps a paused commit from allowing the next transaction to start", async () => {
    installFakeIndexedDB();
    const database = await openDatabase("fifo-paused");
    const gate = indexedDB._pauseNextCommit();
    let secondStarted = false;
    const first = database.transaction("items", "readwrite");
    first.objectStore("items").put({ id: "first" });
    const second = database.transaction("items", "readwrite");
    second.objectStore("items").put({ id: "second" });
    second.oncomplete = () => { secondStarted = true; };

    await gate.waitForCommit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(secondStarted, false);
    gate.release();
    await waitUntil(() => secondStarted, "paused transaction release");
  });
});

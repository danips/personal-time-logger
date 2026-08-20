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

    await new Promise((resolve, reject) => {
      second.onerror = () => reject(second.error);
      const check = () => completed.length === 2 ? resolve() : setTimeout(check, 0);
      check();
    });
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
    await new Promise((resolve, reject) => {
      second.onerror = () => reject(second.error);
      const check = () => secondStarted ? resolve() : setTimeout(check, 0);
      check();
    });
  });
});

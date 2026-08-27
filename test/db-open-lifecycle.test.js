import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

function openDatabase(name, version, onUpgrade = () => {}) {
  const request = indexedDB.open(name, version);
  request.onupgradeneeded = onUpgrade;
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe("database open lifecycle", () => {
  it("shares a blocked request and resolves it after the blocker closes", async () => {
    const indexedDB = installFakeIndexedDB();
    const blocker = await openDatabase("timelogger_db", 1);
    const db = await import(`../extension/src/db.js?blocked=${Date.now()}`);

    const first = db.getSetting("blocked-first");
    const second = db.getSetting("blocked-second");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(indexedDB._getOpenCount(), 2);

    blocker.close();
    await Promise.all([first, second]);
    assert.equal(await db.getSetting("blocked-first"), null);
  });

  it("clears only a failed attempt so the next caller can retry", async () => {
    const indexedDB = installFakeIndexedDB();
    indexedDB._failNextOpen(new Error("upgrade failed"));
    const db = await import(`../extension/src/db.js?error=${Date.now()}`);

    await assert.rejects(() => db.getSetting("retry"), /upgrade failed/);
    await db.setSetting("retry", "works");
    assert.equal(await db.getSetting("retry"), "works");
  });

  it("closes the current connection when a newer version arrives", async () => {
    installFakeIndexedDB();
    const db = await import(`../extension/src/db.js?versionchange=${Date.now()}`);
    await db.setSetting("version-change", true);

    await openDatabase("timelogger_db", 6);
    await assert.rejects(() => db.getSetting("after-version-change"), /VersionError/);
  });
});

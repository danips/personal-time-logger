import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();

let actionMode = "success";
globalThis.browser = {
  runtime: { getURL: (path) => `moz-extension://test/${path}` },
  action: {
    async setIcon() {
      if (actionMode === "fail") throw new Error("icon action unavailable");
    }
  }
};

const diagnostics = await import("../extension/src/diagnostics.js");
const { createToolbarIndicatorRefresher, setActiveIcon, updateActiveIcon } = await import("../extension/src/icon.js");

describe("toolbar icon updates", () => {
  it("keeps the active asset geometry aligned with the packaged base icon", () => {
    const inactive = readFileSync(new URL("../extension/icons/icon.svg", import.meta.url), "utf8");
    const active = readFileSync(new URL("../extension/icons/icon-active.svg", import.meta.url), "utf8");
    assert.equal(active.replace("#22c55e", "#1a73e8"), inactive);
  });

  it("selects packaged inactive and active icon paths", async () => {
    const paths = [];
    const original = globalThis.browser.action.setIcon;
    globalThis.browser.action.setIcon = async ({ path }) => { paths.push(path); };
    try {
      await setActiveIcon(false);
      await setActiveIcon(true);
    } finally {
      globalThis.browser.action.setIcon = original;
    }
    assert.deepEqual(paths, ["moz-extension://test/icons/icon.svg", "moz-extension://test/icons/icon-active.svg"]);
  });

  it("rejects direct icon updates when the browser action fails", async () => {
    actionMode = "fail";
    await assert.rejects(() => setActiveIcon(true), /icon action unavailable/);
    actionMode = "success";
  });

  it("contains fire-and-forget failures and records one bounded diagnostic", async () => {
    await diagnostics.clearDiagnostics();
    await updateActiveIcon(false, { setIcon: async () => true });
    indexedDB._resetWriteLog();

    const failure = new Error("icon action unavailable");
    assert.equal(await updateActiveIcon(true, { setIcon: async () => { throw failure; } }), false);
    assert.deepEqual(indexedDB._getWriteLog(), [{ store: "settings", operation: "put", key: "diagnostic_ring" }]);

    indexedDB._resetWriteLog();
    await assert.doesNotReject(() => updateActiveIcon(true, {
      setIcon: async () => { throw failure; },
      reportDiagnostic: async () => { throw new Error("diagnostics unavailable"); }
    }));
    assert.deepEqual(indexedDB._getWriteLog(), []);

    const records = await diagnostics.getDiagnostics();
    assert.equal(records.length, 1);
    assert.equal(records[0].subsystem, "popup");
    assert.equal(records[0].phase, "icon-update");
    assert.equal(records[0].code, "ICON_UPDATE_FAILED");

    await updateActiveIcon(false, { setIcon: async () => true });
    let reportsAfterRecovery = 0;
    assert.equal(await updateActiveIcon(true, {
      setIcon: async () => { throw failure; },
      async reportDiagnostic() { reportsAfterRecovery += 1; }
    }), false);
    assert.equal(reportsAfterRecovery, 1);
  });

  it("coalesces indicator reads and discards an older result after a newer request", async () => {
    const resolvers = [];
    const updates = [];
    const refresh = createToolbarIndicatorRefresher({
      readActiveEntries: () => new Promise((resolve) => resolvers.push(resolve)),
      updateIcon: async (active) => { updates.push(active); }
    });

    const first = refresh();
    const second = refresh();
    assert.strictEqual(first, second);
    resolvers.shift()([]);
    await Promise.resolve();
    assert.deepEqual(updates, []);
    resolvers.shift()([{ id: "new-active" }]);
    await first;
    assert.deepEqual(updates, [true]);
  });

  it("keeps a read failure observable to the caller without starting an unhandled refresh", async () => {
    const failure = new Error("active-entry read unavailable");
    const refresh = createToolbarIndicatorRefresher({
      readActiveEntries: async () => { throw failure; }
    });

    await assert.rejects(refresh(), failure);
  });
});

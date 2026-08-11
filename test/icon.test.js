import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();

let fetchMode = "success";
let actionMode = "success";
globalThis.browser = {
  runtime: { getURL: (path) => `moz-extension://test/${path}` },
  action: {
    async setIcon() {
      if (actionMode === "fail") throw new Error("icon action unavailable");
    }
  }
};
globalThis.fetch = async () => {
  if (fetchMode === "fail") throw new Error("icon resource unavailable");
  return {
    ok: true,
    async text() { return '<svg fill="#1a73e8"></svg>'; }
  };
};

const diagnostics = await import("../src/diagnostics.js");
const { setActiveIcon, updateActiveIcon } = await import("../src/icon.js");

describe("toolbar icon updates", () => {
  it("rejects direct icon updates when the SVG resource or browser action fails", async () => {
    fetchMode = "fail";
    await assert.rejects(() => setActiveIcon(true), /icon resource unavailable/);

    fetchMode = "success";
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
});

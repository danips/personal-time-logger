import assert from "node:assert/strict";
import { describe, it } from "node:test";

let permissionCalls = 0;
let tabCalls = 0;
globalThis.chrome = {
  runtime: {
    getURL: (path) => `chrome-extension://test/${path}`,
    lastError: null
  },
  permissions: {
    contains(_details, callback) {
      permissionCalls += 1;
      callback(true);
      return Promise.resolve(false);
    }
  },
  tabs: {
    get(id, callback) {
      tabCalls += 1;
      callback({ id, status: "complete" });
      return Promise.resolve({ id, status: "loading" });
    }
  }
};

const { platform } = await import("../extension/src/platform.js?test=platform-chromium");

describe("Chromium platform adapter", () => {
  it("supports callback and promise API implementations without duplicate calls", async () => {
    assert.equal(await platform.hasOptionalHostPermission("https://chatgpt.com/*"), true);
    assert.deepEqual(await platform.getTab(42), { id: 42, status: "complete" });
    assert.equal(permissionCalls, 1);
    assert.equal(tabCalls, 1);
  });
});

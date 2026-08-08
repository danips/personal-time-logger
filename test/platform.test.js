import assert from "node:assert/strict";
import { describe, it } from "node:test";

const listeners = new Set();
let tabStatus = "loading";
globalThis.browser = {
  runtime: { getURL: (path) => `moz-extension://test/${path}` },
  tabs: {
    async get(id) {
      return id === 1 ? { id, status: tabStatus } : null;
    },
    async query() {
      return [{ id: 1 }];
    },
    onUpdated: {
      addListener(listener) {
        listeners.add(listener);
      },
      removeListener(listener) {
        listeners.delete(listener);
      }
    }
  }
};

const { platform } = await import("../src/platform.js?test=platform");

describe("browser platform adapter", () => {
  it("waits when completion happens immediately after listener registration", async () => {
    const waiting = platform.waitForTabComplete(1, 1000);
    tabStatus = "complete";
    for (const listener of listeners) listener(1, { status: "complete" });

    assert.deepEqual(await waiting, { id: 1, status: "complete" });
    assert.equal(listeners.size, 0);
  });

  it("does not require window or navigator in a background context", () => {
    const originalNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: undefined });
    assert.equal(platform.isOnline(), true);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
  });
});

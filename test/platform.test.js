import assert from "node:assert/strict";
import { describe, it } from "node:test";

let queriedTabs = [];
const createdTabs = [];
const updatedTabs = [];
const focusedWindows = [];
globalThis.browser = {
  runtime: { getURL: (path) => `moz-extension://test/${path}` },
  tabs: {
    async get(id) { return id === 1 ? { id, status: "complete" } : null; },
    async query(details) {
      if (details?.url) return queriedTabs;
      return [{ id: 1 }];
    },
    async create(details) {
      createdTabs.push(details);
      return { id: 3, ...details };
    },
    async update(id, details) {
      updatedTabs.push({ id, details });
      return { id, ...details };
    }
  },
  windows: {
    async update(id, details) {
      focusedWindows.push({ id, details });
      return { id, ...details };
    }
  }
};

const { platform } = await import("../extension/src/platform.js?test=platform");

describe("browser platform adapter", () => {
  it("does not require window or navigator in a background context", () => {
    const originalNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: undefined });
    assert.equal(platform.isOnline(), true);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
  });

  it("focuses an existing extension page instead of opening another tab", async () => {
    queriedTabs = [{ id: 7, windowId: 9 }];
    createdTabs.length = 0;
    updatedTabs.length = 0;
    focusedWindows.length = 0;

    await platform.openExtensionPage("calendar/calendar.html");

    assert.deepEqual(createdTabs, []);
    assert.deepEqual(updatedTabs, [{ id: 7, details: { active: true } }]);
    assert.deepEqual(focusedWindows, [{ id: 9, details: { focused: true } }]);
  });

  it("opens an extension page when no matching tab exists", async () => {
    queriedTabs = [];
    createdTabs.length = 0;

    await platform.openExtensionPage("usage/usage.html");

    assert.deepEqual(createdTabs, [{ url: "moz-extension://test/usage/usage.html" }]);
  });
});

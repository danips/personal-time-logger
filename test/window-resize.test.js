import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_WINDOW_SIZE,
  normalizeWindowSizePreset,
  resizeCurrentWindow,
  windowDimensionsForRequest,
  windowResizeRequest
} from "../extension/src/window-resize.js";

describe("window resize boundary", () => {
  it("rejects non-finite and out-of-range dimensions", () => {
    for (const [width, height] of [[0, 720], [1280.5, 720], [Infinity, 720], [1280, MAX_WINDOW_SIZE + 1]]) {
      assert.throws(
        () => windowResizeRequest(width, height, false),
        (error) => error.code === "WINDOW_SIZE_INVALID"
      );
    }
    assert.equal(normalizeWindowSizePreset({ width: "1280", height: "720", isWindow: "true" }).isWindow, true);
    assert.equal(normalizeWindowSizePreset({ width: "bad", height: 720 }), null);
  });

  it("preserves a valid viewport-to-window chrome offset", () => {
    assert.deepEqual(
      windowDimensionsForRequest(
        { width: 1200, height: 700, isWindow: false },
        { id: 7, width: 1320, height: 840 },
        { width: 1280, height: 800 }
      ),
      { windowId: 7, width: 1240, height: 740 }
    );
  });

  it("fails visibly instead of using missing or impossible browser measurements", () => {
    assert.throws(
      () => windowDimensionsForRequest({ width: 1200, height: 700, isWindow: false }, { id: 7, width: 1000, height: 800 }, { width: 1100, height: 700 }),
      (error) => error.code === "WINDOW_CHROME_INVALID"
    );
    assert.throws(
      () => windowDimensionsForRequest({ width: 1200, height: 700, isWindow: false }, { id: 7, width: 1320, height: 840 }, null),
      (error) => error.code === "VIEWPORT_UNAVAILABLE"
    );
  });

  it("validates before it invokes browser APIs", async () => {
    let calls = 0;
    await assert.rejects(
      () => resizeCurrentWindow({ width: "bad", height: 720, isWindow: false }, {
        async getCurrentWindow() { calls += 1; return { id: 7, width: 1320, height: 840 }; },
        async getCurrentTab() { calls += 1; return { width: 1280, height: 800 }; },
        async resizeWindow() { calls += 1; }
      }),
      (error) => error.code === "WINDOW_SIZE_INVALID"
    );
    assert.equal(calls, 0);
  });
});

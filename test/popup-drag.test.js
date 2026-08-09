import assert from "node:assert/strict";
import test from "node:test";

import { clampPopupPosition } from "../calendar/popup-drag.js";

test("clampPopupPosition keeps a popup recovery handle in view", () => {
  assert.deepEqual(clampPopupPosition({
    left: 1200,
    top: 900,
    width: 380,
    height: 500,
    viewportWidth: 1000,
    viewportHeight: 800
  }), { left: 952, top: 752 });
});

test("clampPopupPosition preserves a small viewport margin", () => {
  assert.deepEqual(clampPopupPosition({
    left: -100,
    top: -100,
    width: 380,
    height: 500,
    viewportWidth: 1000,
    viewportHeight: 800
  }), { left: 8, top: 8 });
});

test("clampPopupPosition handles a viewport smaller than the recovery handle", () => {
  assert.deepEqual(clampPopupPosition({
    left: -100,
    top: 100,
    width: 380,
    height: 500,
    viewportWidth: 30,
    viewportHeight: 30
  }), { left: 0, top: 0 });
});

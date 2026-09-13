import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { applyAppearancePreferences } from "../extension/src/themes.js";

const root = process.cwd();

describe("fixed Blue Archive appearance", () => {
  it("applies the fixed palette and optional high contrast", () => {
    const rootElement = { dataset: {} };
    const result = applyAppearancePreferences({ highContrast: true }, rootElement);

    assert.deepEqual(result, { highContrast: true });
    assert.deepEqual(rootElement.dataset, { contrast: "high" });
  });

  for (const page of [
    "popup/popup.html",
    "calendar/calendar.html",
    "analytics/analytics.html",
    "options/options.html",
    "usage/usage.html",
    "reconcile/reconcile.html"
  ]) {
    it(`loads the shared Blue Archive styles on ${page}`, () => {
      const html = readFileSync(join(root, "extension", page), "utf8");
      assert.match(html, /src\/themes\.css/);
      assert.match(html, /src\/themes\.js/);
      assert.doesNotMatch(html, /data-theme=/);
    });
  }
});

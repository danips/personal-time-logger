import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

describe("fixed Blue Archive palette", () => {
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
      assert.doesNotMatch(html, /data-theme=/);
      assert.doesNotMatch(html, /themes\.js/i);
    });
  }
});

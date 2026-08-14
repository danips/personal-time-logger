import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

describe("interface themes", () => {
  for (const relativePath of ["popup/popup.css", "calendar/calendar.css", "options/options.css"]) {
    it(`provides a system dark theme for ${relativePath}`, () => {
      const css = readFileSync(join(root, relativePath), "utf8");
      assert.match(css, /color-scheme:\s*light dark/);
      assert.match(css, /@media \(prefers-color-scheme: dark\)[\s\S]*--page:\s*#111620/);
      assert.match(css, /@media \(prefers-color-scheme: dark\)[\s\S]*--surface:\s*#1b2230/);
      assert.match(css, /@media \(prefers-color-scheme: dark\)[\s\S]*--text:\s*#eef2fb/);
    });
  }
});

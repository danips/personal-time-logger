import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const semanticTokens = ["--page", "--surface", "--text", "--accent"];

describe("interface themes", () => {
  for (const relativePath of ["popup/popup.css", "calendar/calendar.css", "options/options.css"]) {
    it(`provides the semantic theme contract for ${relativePath}`, () => {
      const css = readFileSync(join(root, "extension", relativePath), "utf8");
      assert.match(css, /color-scheme:\s*light dark/);
      for (const token of semanticTokens) assert.match(css, new RegExp(`${token}:`));
    });
  }

  it("provides selected themes and a visible high-contrast focus treatment", () => {
    const css = readFileSync(join(root, "extension/src/themes.css"), "utf8");
    assert.match(css, /:root\[data-theme=/);
    assert.match(css, /:root\[data-contrast=["']high["']\]/);
    assert.match(css, /--success:/);
    assert.match(css, /--warning:/);
    assert.match(css, /--danger:/);
    assert.match(css, /outline:\s*3px solid var\(--accent-strong\)/);
  });
});

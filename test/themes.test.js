import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  applyThemePreferences,
  DEFAULT_THEME,
  normalizeTheme,
  THEME_OPTIONS
} from "../src/themes.js";

const root = process.cwd();
const EXPECTED_THEMES = ["darcula", "codex", "github", "linear", "material", "notion", "vscode"];

describe("selectable dark themes", () => {
  it("provides the requested named palettes", () => {
    assert.deepEqual(THEME_OPTIONS.map(({ id }) => id), EXPECTED_THEMES);
    assert.equal(DEFAULT_THEME, "codex");
  });

  it("normalizes unknown or mixed-case values safely", () => {
    assert.equal(normalizeTheme("GitHub"), "github");
    assert.equal(normalizeTheme(" vscode "), "vscode");
    assert.equal(normalizeTheme("unknown"), DEFAULT_THEME);
  });

  it("applies theme and contrast preferences as root attributes", () => {
    const rootElement = { dataset: {} };
    const result = applyThemePreferences({ theme: "linear", highContrast: true }, rootElement);
    assert.deepEqual(result, { theme: "linear", highContrast: true });
    assert.deepEqual(rootElement.dataset, { theme: "linear", contrast: "high" });
  });

  it("defines every palette and a shared high-contrast variant", () => {
    const css = readFileSync(join(root, "src/themes.css"), "utf8");
    for (const theme of EXPECTED_THEMES) {
      assert.match(css, new RegExp(`data-theme=["']${theme}["']`));
    }
    assert.match(css, /data-contrast=["']high["']/);
    assert.match(css, /--surface-raised:/);
    assert.match(css, /outline:\s*3px solid var\(--accent-strong\)/);
  });

  for (const page of [
    "popup/popup.html",
    "calendar/calendar.html",
    "options/options.html",
    "usage/usage.html",
    "reconcile/reconcile.html"
  ]) {
    it(`loads the shared theme on ${page}`, () => {
      const html = readFileSync(join(root, page), "utf8");
      assert.match(html, /data-theme="codex"/);
      assert.match(html, /src\/themes\.css/);
      assert.match(html, /src\/themes\.js/);
    });
  }
});

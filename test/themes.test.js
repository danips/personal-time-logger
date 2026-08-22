import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  applyThemePreferences,
  DEFAULT_THEME,
  normalizeTheme,
  THEME_OPTIONS
} from "../extension/src/themes.js";

const root = process.cwd();
const extensionRoot = join(root, "extension");
const EXPECTED_THEMES = ["cinder-glow", "moss-circuit", "blue-archive", "violet-orbit", "amethyst-stack", "sienna-paper", "harbor-terminal"];

describe("selectable dark themes", () => {
  it("provides the requested named palettes", () => {
    assert.deepEqual(THEME_OPTIONS.map(({ id }) => id), EXPECTED_THEMES);
    assert.deepEqual(THEME_OPTIONS.map(({ label }) => label), [
      "Cinder Glow",
      "Moss Circuit",
      "Blue Archive",
      "Violet Orbit",
      "Amethyst Stack",
      "Sienna Paper",
      "Harbor Terminal"
    ]);
    assert.equal(DEFAULT_THEME, "moss-circuit");
  });

  it("normalizes unknown or mixed-case values safely", () => {
    assert.equal(normalizeTheme("Blue-Archive"), "blue-archive");
    assert.equal(normalizeTheme(" github "), "blue-archive");
    assert.equal(normalizeTheme(" vscode "), "harbor-terminal");
    assert.equal(normalizeTheme("unknown"), DEFAULT_THEME);
  });

  it("applies theme and contrast preferences as root attributes", () => {
    const rootElement = { dataset: {} };
    const result = applyThemePreferences({ theme: "violet-orbit", highContrast: true }, rootElement);
    assert.deepEqual(result, { theme: "violet-orbit", highContrast: true });
    assert.deepEqual(rootElement.dataset, { theme: "violet-orbit", contrast: "high" });
  });

  it("defines every palette and a shared high-contrast variant", () => {
    const css = readFileSync(join(extensionRoot, "src/themes.css"), "utf8");
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
      const html = readFileSync(join(extensionRoot, page), "utf8");
      assert.match(html, /data-theme="moss-circuit"/);
      assert.match(html, /src\/themes\.css/);
      assert.match(html, /src\/themes\.js/);
    });
  }
});

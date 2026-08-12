import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

describe("popup editor theme", () => {
  it("provides the shared editor label color in dark mode", () => {
    const css = readFileSync(join(root, "popup/popup.css"), "utf8");
    assert.match(css, /@media \(prefers-color-scheme: dark\)[\s\S]*--muted:\s*#bdc1c6/);
  });
});

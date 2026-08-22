import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

describe("shared entry editor", () => {
  it("keeps an unavailable merge control hidden despite its grid layout", () => {
    const css = readFileSync(join(root, "extension/src/entry-editor.css"), "utf8");
    assert.match(css, /\.entry-editor-merge-control\[hidden\]\s*\{\s*display:\s*none/);
  });
});

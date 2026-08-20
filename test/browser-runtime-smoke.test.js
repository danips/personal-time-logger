import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const code = readFileSync(join(process.cwd(), "scripts/browser-runtime-smoke.mjs"), "utf8");

describe("browser runtime smoke packaging", () => {
  it("packages the canonical prepared release source", () => {
    assert.match(code, /prepare-firefox-release\.mjs/);
    assert.match(code, /smokeUpdateBaseUrl/);
    assert.match(code, /\["-q", "-r", output, "\."\]/);
    assert.match(code, /cwd: sourceDirectory/);
    assert.doesNotMatch(code, /git", \["ls-files"/);
    assert.doesNotMatch(code, /const extensionDirectories/);
  });
});

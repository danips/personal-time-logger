import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const code = readFileSync(join(process.cwd(), "extension/src/sync.js"), "utf8");

describe("sync cycle local state", () => {
  it("uses the cycle Map directly instead of an array facade", () => {
    assert.match(code, /return new Map\(entries\.map/);
    assert.doesNotMatch(code, /local\.all\(\)|local\.apply\(|local\.forget\(/);
    assert.match(code, /local\.values\(\)/);
    assert.match(code, /local\.set\(/);
    assert.match(code, /local\.delete\(/);
  });
});

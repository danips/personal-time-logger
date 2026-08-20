import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const code = readFileSync(join(process.cwd(), "calendar/calendar.js"), "utf8");

describe("calendar gesture state", () => {
  it("uses one pointer-owned move/resize state with fenced handlers", () => {
    assert.doesNotMatch(code, /dragState/);
    assert.match(code, /kind: "move"/);
    assert.match(code, /kind: "resize"/);
    assert.match(code, /if \(gesture\) return;/);
    assert.match(code, /gesture\.kind !== "move" \|\| gesture\.pointerId !== event\.pointerId/);
    assert.match(code, /gesture\.kind !== "resize" \|\| gesture\.pointerId !== event\.pointerId/);
    assert.match(code, /state\.preview\?\.remove\(\)/);
  });
});

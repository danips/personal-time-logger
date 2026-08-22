import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const code = readFileSync(join(process.cwd(), "extension/popup/popup.js"), "utf8");

function functionSource(name) {
  const start = Math.max(code.indexOf(`function ${name}(`), code.indexOf(`async function ${name}(`));
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = code.indexOf("{", start);
  let depth = 0;
  for (let position = bodyStart; position < code.length; position += 1) {
    if (code[position] === "{") depth += 1;
    if (code[position] === "}") depth -= 1;
    if (depth === 0) return code.slice(start, position + 1);
  }
  throw new Error(`unterminated ${name}`);
}

describe("popup active render state", () => {
  it("keeps full state rendering separate from the elapsed-time tick", () => {
    assert.doesNotMatch(code, /renderedActiveId/);
    assert.match(functionSource("updateElapsed"), /tickElapsed\(activeEntries\[0\]\)/);
    assert.match(functionSource("renderActiveState"), /\$activeTitle\.textContent/);
    assert.match(functionSource("renderActiveState"), /\$activePanel\.setAttribute/);
    assert.match(functionSource("renderActiveState"), /updateActiveIcon\(hasActive\)/);
    assert.match(functionSource("renderActive"), /renderActiveState\(activeEntries\[0\]\)/);
  });
});

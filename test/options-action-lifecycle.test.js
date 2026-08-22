import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const code = readFileSync(join(process.cwd(), "extension/options/options.js"), "utf8");

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

describe("Options action lifecycle", () => {
  it("keeps busy, errors, and final refresh in the outer runner", () => {
    const runner = functionSource("runOptionsAction");
    assert.match(runner, /setBusy\(next\)/);
    assert.match(runner, /onError[\s\S]*formatError/);
    assert.match(runner, /onFinally[\s\S]*refresh\(\)/);
    for (const name of ["saveGoogleCredentials", "signInClicked", "signOutClicked", "reconnectSpreadsheetClicked", "connectSpreadsheetClicked", "createReplacementSpreadsheetClicked"]) {
      const body = functionSource(name);
      assert.doesNotMatch(body, /\brefresh\(/, `${name} must not refresh internally`);
      assert.doesNotMatch(body, /\.disabled\s*=/, `${name} must not manage busy state internally`);
      assert.doesNotMatch(body, /catch\s*\(/, `${name} must not convert action failures into success`);
    }
  });
});

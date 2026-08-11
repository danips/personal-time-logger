import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

function source(file) {
  return readFileSync(join(root, file), "utf8");
}

function functionSource(code, name) {
  const start = code.indexOf(`function ${name}(`);
  const asyncStart = code.indexOf(`async function ${name}(`);
  const index = Math.max(start, asyncStart);
  assert.notEqual(index, -1, `missing ${name}`);
  const bodyStart = code.indexOf(") {", index) + 2;
  let depth = 0;
  for (let position = bodyStart; position < code.length; position += 1) {
    if (code[position] === "{") depth += 1;
    if (code[position] === "}") depth -= 1;
    if (depth === 0) return code.slice(index, position + 1);
  }
  throw new Error(`unterminated ${name}`);
}

describe("page action render ownership", () => {
  const pages = [
    {
      file: "popup/popup.js",
      wrapper: "runPopupAction",
      actions: ["runSync", "startTimer", "restartFromEntry", "stopTimer", "saveEdit", "deleteEdit", "mergeEdit"]
    },
    {
      file: "calendar/calendar.js",
      wrapper: "runCalendarAction",
      actions: ["runSync", "endResize", "endDrag", "undoResize", "mergeSelectedEntry", "duplicateSelectedEntry", "deleteCalendarEntry", "saveCalendarEdit", "changeWeek"]
    },
    {
      file: "usage/usage.js",
      wrapper: "runUsageAction",
      actions: ["refreshOne"]
    }
  ];

  for (const page of pages) {
    it(`${page.file} gives its action wrapper the final render`, () => {
      const code = source(page.file);
      assert.match(functionSource(code, page.wrapper), /onFinally[\s\S]*\brender\(/);
      for (const action of page.actions) {
        assert.doesNotMatch(functionSource(code, action), /\b(?:await )?render\(/, `${action} must not render directly`);
      }
    });
  }
});

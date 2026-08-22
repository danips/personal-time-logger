import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeSpreadsheetBinding, readySpreadsheetBinding } from "../extension/src/sheets.js";

describe("spreadsheet binding state", () => {
  it("decodes legacy values conservatively", () => {
    assert.deepEqual(decodeSpreadsheetBinding("sheet-a"), { state: "ready", spreadsheetId: "sheet-a" });
    assert.deepEqual(decodeSpreadsheetBinding("sheet-a", "sheet-b"), { state: "pending", spreadsheetId: "sheet-b" });
    assert.deepEqual(decodeSpreadsheetBinding("", ""), { state: "unbound" });
  });

  it("only marks the matching pending destination ready", () => {
    const pending = { state: "pending", spreadsheetId: "sheet-a" };
    assert.deepEqual(readySpreadsheetBinding(pending, "sheet-a"), { state: "ready", spreadsheetId: "sheet-a" });
    assert.deepEqual(readySpreadsheetBinding(pending, "sheet-b"), pending);
  });
});

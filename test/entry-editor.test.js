import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setEntryEditorMergeAvailability } from "../extension/src/entry-editor.js";

describe("shared entry editor", () => {
  it("hides the merge control when no valid target exists", () => {
    const control = { hidden: false };
    assert.equal(setEntryEditorMergeAvailability(control, false), false);
    assert.equal(control.hidden, true);
  });

  it("exposes the merge control only when a valid target exists", () => {
    const control = { hidden: true };
    assert.equal(setEntryEditorMergeAvailability(control, true), true);
    assert.equal(control.hidden, false);
    assert.equal(setEntryEditorMergeAvailability(control, false), false);
    assert.equal(control.hidden, true);
  });
});

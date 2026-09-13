import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mountEntryEditor } from "../extension/src/entry-editor.js";

const FIELD_IDS = [
  "entry-editor-project",
  "entry-editor-task",
  "entry-editor-description",
  "entry-editor-multiply",
  "entry-editor-status",
  "entry-editor-start",
  "entry-editor-end",
  "entry-editor-time-summary",
  "entry-editor-merge-control",
  "entry-editor-merge-target",
  "entry-editor-merge-button",
  "entry-editor-preview",
  "entry-editor-preview-text",
  "entry-editor-preview-confirm",
  "entry-editor-preview-cancel",
  "entry-editor-save",
  "entry-editor-cancel",
  "entry-editor-delete",
  "entry-editor-duplicate"
];

class FakeElement {
  constructor(id) {
    this.id = id;
    this.hidden = false;
    this.type = "button";
    this.className = "";
    this.removed = false;
  }

  querySelector(selector) {
    const id = selector.slice(1);
    return this.children.find((child) => child.id === id && !child.removed) || null;
  }

  remove() {
    this.removed = true;
  }
}

class FakeTemplate {
  constructor() {
    this.content = {
      firstElementChild: new FakeElement("entry-editor-form")
    };
    this.content.firstElementChild.children = FIELD_IDS.map((id) => new FakeElement(id));
  }

  set innerHTML(_value) {}
}

class FakeContainer {
  replaceChildren(form) {
    this.form = form;
  }
}

describe("entry editor mounting", () => {
  it("handles the root form directly and returns scoped controls for each variant", () => {
    const previousDocument = globalThis.document;
    globalThis.document = {
      createElement(type) {
        assert.equal(type, "template");
        return new FakeTemplate();
      }
    };

    try {
      const popup = mountEntryEditor(new FakeContainer(), { variant: "popup" });
      assert.equal(popup.form.id, "editForm");
      assert.equal(popup.fields.project.id, "editProject");
      assert.equal(popup.merge.target.id, "mergeTarget");
      assert.equal(popup.preview.confirm.id, "confirmEditPreview");
      assert.equal(popup.timeSummary.id, "editTimeSummary");
      assert.equal(popup.actions.save.id, "saveEdit");
      assert.equal(popup.actions.duplicate, null);

      const calendar = mountEntryEditor(new FakeContainer(), { variant: "calendar", showDuplicate: true, saveType: "submit" });
      assert.equal(calendar.form.id, "calendarEditForm");
      assert.equal(calendar.actions.duplicate.id, "duplicateEntryButton");
      assert.equal(calendar.preview.panel.id, "calendarPreview");
      assert.equal(calendar.timeSummary.id, "calendarEditTimeSummary");
      assert.equal(calendar.actions.save.type, "submit");
      assert.notEqual(popup.fields.project, calendar.fields.project);
    } finally {
      globalThis.document = previousDocument;
    }
  });
});

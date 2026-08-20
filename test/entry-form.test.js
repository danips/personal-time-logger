import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readEntryForm } from "../src/entry-form.js";

function fields(over = {}) {
  return {
    project: { value: "Project" },
    task: { value: "Task" },
    description: { value: "Description" },
    multiply: { checked: false },
    start: { value: "2026-07-27T09:00:00" },
    end: { value: "2026-07-27T10:00:00" },
    ...over
  };
}

describe("entry form decoder", () => {
  it("decodes valid times and preserves a blank end", () => {
    const payload = readEntryForm(fields({ end: { value: "" } }));
    assert.equal(payload.start_at, new Date(2026, 6, 27, 9).toISOString());
    assert.equal(payload.end_at, "");
  });

  it("rejects invalid required or nonblank optional times", () => {
    assert.throws(
      () => readEntryForm(fields({ start: { value: "" } })),
      (error) => error.code === "ENTRY_INVALID" && /start time is required/i.test(error.message)
    );
    assert.throws(
      () => readEntryForm(fields({ end: { value: "nonsense" } })),
      (error) => error.code === "ENTRY_INVALID" && /end time is invalid/i.test(error.message)
    );
  });

  it("rejects an end before the start", () => {
    assert.throws(
      () => readEntryForm(fields({ end: { value: "2026-07-27T08:59:59" } })),
      (error) => error.code === "ENTRY_INVALID" && /cannot be before/i.test(error.message)
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ENTRY_FIELDS } from "../extension/src/entry-contract.js";
import { SHEET_HEADERS } from "../extension/src/entries.js";
import { CANONICAL_ENTRY_FIELDS } from "../extension/src/fingerprints.js";
import { PERSISTED_ENTRY_FIELDS } from "../extension/src/remote-api-client.js";

describe("persisted entry contract", () => {
  it("owns one frozen ordered field list for every persisted projection", () => {
    assert.equal(Object.isFrozen(ENTRY_FIELDS), true);
    assert.deepEqual(SHEET_HEADERS, ENTRY_FIELDS);
    assert.deepEqual(CANONICAL_ENTRY_FIELDS, ENTRY_FIELDS);
    assert.deepEqual(PERSISTED_ENTRY_FIELDS, ENTRY_FIELDS);
    assert.deepEqual(ENTRY_FIELDS, [
      "id", "project", "task", "description", "start_at", "end_at", "duration_seconds",
      "status", "created_at", "updated_at", "deleted_at", "device_id", "revision", "multiply"
    ]);
  });

  it("keeps local-only bookkeeping outside the contract", () => {
    for (const field of ["dirty", "dirty_key", "last_sync_at", "sync_error"]) {
      assert.equal(ENTRY_FIELDS.includes(field), false, field);
    }
  });
});

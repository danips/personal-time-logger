import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { serializeQuarantinedRecords } from "../extension/src/reconcile-export.js";

describe("quarantined reconciliation export", () => {
  it("exports only locations and reasons with safe CSV text", () => {
    const csv = serializeQuarantinedRecords([
      { id: "=bad", ref: { version: 7 }, reason: "bad,\nvalue" },
      { id: "versioned", ref: { version: 4 }, reason: "invalid" }
    ], { provider: "Remote, test" });
    assert.match(csv, /Provider,"Remote, test"/);
    assert.match(csv, /'=bad,record version 7,"bad,\r?\nvalue"/);
    assert.match(csv, /versioned,record version 4,invalid/);
    assert.doesNotMatch(csv, /raw|payload|credential/i);
  });
});

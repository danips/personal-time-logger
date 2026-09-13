import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  duplicateRecordsSupported,
  bulkResolutionPreview,
  operationOutcome,
  paginateReconciliationItems,
  reconciliationActionDisabled,
  reconciliationActionEligibility
} from "../extension/src/reconcile-ui-state.js";

describe("reconciliation provider capabilities", () => {
  it("only enables duplicate-record repair for supporting providers", () => {
    assert.equal(duplicateRecordsSupported({ provider: { capabilities: { duplicateRemoteRecords: true } } }), true);
    assert.equal(duplicateRecordsSupported({ provider: { capabilities: { duplicateRemoteRecords: false } } }), false);
    assert.equal(duplicateRecordsSupported({}), false);
  });
});

describe("reconciliation action state", () => {
  it("summarizes bulk scope and keeps equal-time conflicts visible", () => {
    assert.deepEqual(bulkResolutionPreview([
      { id: "local", newer: "local" },
      { id: "conflict", newer: "conflict" },
      { id: "remote", newer: "remote" }
    ]), { affectedCount: 3, equalTimestampConflicts: 1, preconditionCount: 3 });
  });

  it("normalizes completed, pending, and failed operation counts", () => {
    assert.deepEqual(operationOutcome({ completed: 2, pending: 1, failed: 3 }), { completed: 2, pending: 1, failed: 3 });
    assert.deepEqual(operationOutcome({ completed: -1, pending: "bad" }), { completed: 0, pending: 0, failed: 0 });
  });

  it("bounds a large group to one page and clamps a stale page after rescan", () => {
    const values = Array.from({ length: 121 }, (_, index) => index);
    assert.deepEqual(paginateReconciliationItems(values, { page: 1, pageSize: 50 }), {
      items: values.slice(50, 100), page: 1, pageCount: 3, total: 121
    });
    assert.deepEqual(paginateReconciliationItems(values.slice(0, 12), { page: 9, pageSize: 50 }), {
      items: values.slice(0, 12), page: 0, pageCount: 1, total: 12
    });
  });

  it("keeps every bulk action disabled for an empty report", () => {
    const eligibility = reconciliationActionEligibility({
      duplicates: [],
      different: [],
      localOnly: [],
      remoteOnly: []
    });

    assert.deepEqual(eligibility, {
      deleteAllDuplicates: false,
      keepAllLocal: false,
      keepAllRemote: false,
      keepAllNewest: false,
      pushAllLocal: false,
      importAllRemote: false
    });
    assert.equal(Object.values(eligibility).every((eligible) => reconciliationActionDisabled(false, eligible)), true);
  });

  it("enables only the actions represented by a mixed report", () => {
    assert.deepEqual(reconciliationActionEligibility({
      duplicates: [{}],
      different: [{ newer: "local" }, { newer: "remote" }],
      localOnly: [],
      remoteOnly: [{}]
    }), {
      deleteAllDuplicates: true,
      keepAllLocal: true,
      keepAllRemote: true,
      keepAllNewest: true,
      pushAllLocal: false,
      importAllRemote: true
    });
  });

  it("keeps otherwise eligible actions disabled while an operation is in progress", () => {
    assert.equal(reconciliationActionDisabled(true, true), true);
    assert.equal(reconciliationActionDisabled(false, true), false);
    assert.equal(reconciliationActionDisabled(false, false), true);
  });
});

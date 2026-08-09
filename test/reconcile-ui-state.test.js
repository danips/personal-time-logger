import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  reconciliationActionDisabled,
  reconciliationActionEligibility
} from "../src/reconcile-ui-state.js";

describe("reconciliation action state", () => {
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
      different: [{}, {}],
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

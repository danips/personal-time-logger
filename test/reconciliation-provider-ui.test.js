import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;

const { loadReconciliation } = await import("../extension/src/reconcile.js");
const reconcileHtml = readFileSync(join(process.cwd(), "extension/reconcile/reconcile.html"), "utf8");

describe("provider-aware reconciliation UI", () => {
  it("serializes active provider metadata without exposing provider methods", async () => {
    const report = await loadReconciliation({
      provider: {
        id: "future-provider",
        label: "Future Remote",
        async readSnapshot() {
          return { entries: [], quarantined: [{ id: "bad", ref: { version: 3 }, reason: "invalid_entry" }] };
        },
        secretMethod() {}
      }
    });

    assert.deepEqual(report.provider, {
      id: "future-provider",
      label: "Future Remote",
    });
    assert.equal(Object.hasOwn(report.provider, "secretMethod"), false);
    assert.equal(report.quarantined[0].ref.version, 3);
  });

  it("declares rendered controls for filtering, outcomes, and safe quarantine export", () => {
    assert.doesNotMatch(reconcileHtml, /duplicate|rowIndex/i);
    assert.match(reconcileHtml, /id="quarantinedSection"/);
    assert.match(reconcileHtml, /id="reconcileSearch"/);
    assert.match(reconcileHtml, /id="operationOutcome"/);
    assert.match(reconcileHtml, /id="exportQuarantined"/);
  });

  it("keeps MySQL-style reports free of duplicate repair and spreadsheet controls", async () => {
    const report = await loadReconciliation({
      provider: {
        id: "mysql",
        label: "MySQL 8.4",
        async readSnapshot() {
          return { entries: [] };
        }
      }
    });

    assert.equal(report.provider.label, "MySQL 8.4");
    assert.doesNotMatch(reconcileHtml, /spreadsheet/i);
  });

  it("classifies an invalid provider snapshot before comparison", async () => {
    await assert.rejects(() => loadReconciliation({
      provider: {
        id: "mysql",
        label: "MySQL 8.4",
        async readSnapshot() { return null; }
      }
    }), { code: "REMOTE_API_INCOMPATIBLE" });
  });
});

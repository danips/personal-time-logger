import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;

const { loadReconciliation } = await import("../extension/src/reconcile.js");
const reconcileUi = readFileSync(join(process.cwd(), "extension/reconcile/reconcile.js"), "utf8");
const reconcileHtml = readFileSync(join(process.cwd(), "extension/reconcile/reconcile.html"), "utf8");

describe("provider-aware reconciliation UI", () => {
  it("serializes active provider metadata without exposing provider methods", async () => {
    const report = await loadReconciliation({
      provider: {
        id: "future-provider",
        label: "Future Remote",
        capabilities: { duplicateRemoteRecords: false },
        async readSnapshot() {
          return { entries: [], duplicates: [], quarantined: [{ id: "bad", ref: { version: 3 }, reason: "invalid_entry" }] };
        },
        secretMethod() {}
      }
    });

    assert.deepEqual(report.provider, {
      id: "future-provider",
      label: "Future Remote",
      capabilities: { duplicateRemoteRecords: false }
    });
    assert.equal(Object.hasOwn(report.provider, "secretMethod"), false);
    assert.equal(report.quarantined[0].ref.version, 3);
  });

  it("keeps generic UI copy independent of spreadsheet terminology", () => {
    for (const phrase of [
      "Nothing differs between this device and the spreadsheet",
      "Every local entry exists in the spreadsheet",
      "Every spreadsheet row exists on this device",
      "Comparing this device with the spreadsheet",
      "This device and the spreadsheet agree"
    ]) {
      assert.equal(reconcileUi.includes(phrase), false, phrase);
    }
    assert.match(reconcileUi, /duplicateRecordsSupported/);
    assert.match(reconcileUi, /Remote backend: /);
    assert.match(reconcileHtml, /id="duplicateSummaryMetric"/);
    assert.match(reconcileHtml, /id="quarantinedSection"/);
  });

  it("keeps MySQL-style reports free of duplicate repair and spreadsheet controls", async () => {
    const report = await loadReconciliation({
      provider: {
        id: "mysql",
        label: "MySQL 8.4",
        capabilities: { duplicateRemoteRecords: false },
        async readSnapshot() {
          return { entries: [], duplicates: [] };
        }
      }
    });

    assert.equal(report.provider.label, "MySQL 8.4");
    assert.deepEqual(report.duplicates, []);
    assert.match(reconcileUi, /Keep remote/);
    assert.match(reconcileUi, /Push to remote/);
    assert.match(reconcileUi, /Import from remote/);
    assert.doesNotMatch(reconcileHtml, /spreadsheet/i);
  });
});

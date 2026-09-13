import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();

const diagnostics = await import("../extension/src/diagnostics.js");

describe("diagnostic ring", () => {
  it("keeps bounded, privacy-safe recovery records", async () => {
    for (let index = 0; index < diagnostics.MAX_DIAGNOSTICS + 2; index += 1) {
      await diagnostics.recordDiagnostic({
        subsystem: "sync",
        phase: `phase-${index}`,
        code: "API_ERROR",
        entryCount: index,
        recovery: "Retry from Options. https://secret.invalid"
      });
    }

    const records = await diagnostics.getDiagnostics();
    assert.equal(records.length, diagnostics.MAX_DIAGNOSTICS);
    assert.equal(records[0].phase, "phase-2");
    assert.equal(records.at(-1).entry_count, diagnostics.MAX_DIAGNOSTICS + 1);
    assert.equal(records.at(-1).recovery.includes("https"), false);
    assert.equal(diagnostics.diagnosticsText(records).includes("https"), false);
  });

  it("coalesces repeated retry failures and clears on request", async () => {
    await diagnostics.clearDiagnostics();
    await diagnostics.recordDiagnostic({ subsystem: "sync", phase: "remote_read", code: "API_TIMEOUT" });
    await diagnostics.recordDiagnostic({ subsystem: "sync", phase: "remote_read", code: "API_TIMEOUT" });

    const records = await diagnostics.getDiagnostics();
    assert.equal(records.length, 1);
    assert.equal(records[0].occurrences, 2);
    assert.match(diagnostics.diagnosticsText(records), /occurrences=2/);
    await diagnostics.clearDiagnostics();
    assert.deepEqual(await diagnostics.getDiagnostics(), []);
  });

  it("deduplicates the same phase across reporting layers but keeps phases distinct", async () => {
    await diagnostics.clearDiagnostics();
    await diagnostics.recordDiagnostic({ subsystem: "sync", phase: "remote_read", code: "OFFLINE" });
    await diagnostics.recordDiagnostic({ subsystem: "background", phase: "remote_read", code: "OFFLINE" });
    await diagnostics.recordDiagnostic({ subsystem: "background", phase: "retry", code: "OFFLINE" });

    const records = await diagnostics.getDiagnostics();
    assert.equal(records.length, 2);
    assert.equal(records[0].occurrences, 2);
    assert.equal(records[0].phase, "remote_read");
    assert.equal(records[1].phase, "retry");
  });

  it("stores safe support context without raw URLs", async () => {
    await diagnostics.clearDiagnostics();
    await diagnostics.recordDiagnostic({
      subsystem: "sync",
      phase: "remote_read",
      code: "API_TIMEOUT",
      provider: "MySQL https://secret.invalid/token",
      freshness: "last success https://secret.invalid/at"
    });

    const [record] = await diagnostics.getDiagnostics();
    assert.equal(record.provider.includes("https"), false);
    assert.equal(record.freshness.includes("https"), false);
    assert.equal(record.extension_version, "unknown");
    assert.equal(record.occurrences, 1);
  });
});

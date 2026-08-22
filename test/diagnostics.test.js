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

    assert.equal((await diagnostics.getDiagnostics()).length, 1);
    await diagnostics.clearDiagnostics();
    assert.deepEqual(await diagnostics.getDiagnostics(), []);
  });
});

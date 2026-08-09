import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();
const diagnostics = await import("../src/diagnostics.js");
const { runPageTask } = await import("../src/page-runtime.js");

describe("page runtime recovery", () => {
  it("records failed callbacks without preventing later callbacks", async () => {
    await diagnostics.clearDiagnostics();
    const failure = new Error("calendar render failed");
    failure.code = "API_NETWORK";
    let reported = null;

    const failed = await runPageTask({
      page: "calendar",
      phase: "periodic-render",
      task: async () => { throw failure; },
      onError(error) {
        reported = error;
      }
    });

    assert.equal(failed, undefined);
    assert.equal(reported, failure);
    const records = await diagnostics.getDiagnostics();
    assert.equal(records.length, 1);
    assert.equal(records[0].subsystem, "page");
    assert.equal(records[0].phase, "calendar.periodic-render");
    assert.equal(records[0].code, "API_NETWORK");
    assert.equal(records[0].recovery, "Use Retry to restart this page or open Options diagnostics for details.");

    assert.equal(await runPageTask({
      page: "calendar",
      phase: "periodic-render",
      task: async () => "next render completed"
    }), "next render completed");
  });

  it("contains a reporter failure as well as the original callback failure", async () => {
    await diagnostics.clearDiagnostics();
    const failure = new Error("startup failed");

    await assert.doesNotReject(() => runPageTask({
      page: "options",
      phase: "startup",
      task: async () => { throw failure; },
      onError() {
        throw new Error("status rendering failed");
      }
    }));
    assert.equal((await diagnostics.getDiagnostics()).length, 1);
  });
});

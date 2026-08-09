import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isActionRunning, runAction } from "../src/action-runner.js";

describe("runAction", () => {
  it("coalesces duplicate activation, manages busy state, and refreshes once", async () => {
    let resolveAction;
    let calls = 0;
    const busy = [];
    let finalized = 0;
    const action = () => {
      calls += 1;
      return new Promise((resolve) => { resolveAction = resolve; });
    };

    const first = runAction("save-entry", action, {
      setBusy: (value) => busy.push(value),
      onFinally: () => { finalized += 1; }
    });
    const second = runAction("save-entry", action);

    assert.equal(first, second);
    assert.equal(calls, 1);
    assert.equal(isActionRunning("save-entry"), true);
    resolveAction("saved");
    assert.equal(await first, "saved");
    assert.equal(isActionRunning("save-entry"), false);
    assert.deepEqual(busy, [true, false]);
    assert.equal(finalized, 1);
  });

  it("reports an action error without leaving an unhandled rejection", async () => {
    const errors = [];
    const result = await runAction("delete-entry", async () => {
      const error = new Error("write failed");
      error.code = "STORAGE_CONFLICT";
      throw error;
    }, {
      onError: (error) => errors.push(error.code)
    });

    assert.equal(result, undefined);
    assert.deepEqual(errors, ["STORAGE_CONFLICT"]);
    assert.equal(isActionRunning("delete-entry"), false);
  });

  it("passes the displayed revision through to a guarded action", async () => {
    let received;
    await runAction("stop-entry", ({ expectedRevision }) => {
      received = expectedRevision;
    }, { expectedRevision: 7 });
    assert.equal(received, 7);
  });
});

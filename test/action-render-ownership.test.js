import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runAction } from "../extension/src/action-runner.js";

describe("page action outcomes", () => {
  it("publishes a local mutation and queues remote work without waiting for it", async () => {
    const state = { entries: [], syncStarted: false, rendered: 0 };
    let releaseSync;
    const sync = new Promise((resolve) => { releaseSync = resolve; });
    const action = runAction("start-timer-behavior", async () => {
      state.entries.push("local-entry");
      state.syncStarted = true;
      void sync;
    }, { onFinally: () => { state.rendered += 1; } });
    await action;
    assert.deepEqual(state, { entries: ["local-entry"], syncStarted: true, rendered: 1 });
    releaseSync();
  });

  it("restores the initiating control and refreshes after a failed action", async () => {
    const button = { disabled: false };
    const events = [];
    await runAction("save-error-behavior", async () => {
      throw Object.assign(new Error("conflict"), { code: "STORAGE_CONFLICT" });
    }, {
      setBusy: (busy) => { button.disabled = busy; events.push(`busy:${busy}`); },
      onError: (error) => events.push(`error:${error.code}`),
      onFinally: () => events.push("refresh")
    });
    assert.equal(button.disabled, false);
    assert.deepEqual(events, ["busy:true", "error:STORAGE_CONFLICT", "refresh", "busy:false"]);
  });
});

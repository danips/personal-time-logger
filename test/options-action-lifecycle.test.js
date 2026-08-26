import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runAction } from "../extension/src/action-runner.js";

describe("options action lifecycle", () => {
  it("runs one final refresh on success and keeps the button disabled only while busy", async () => {
    const button = { disabled: false };
    const events = [];
    const result = await runAction("options-save-behavior", async () => {
      events.push("save");
      return "saved";
    }, {
      setBusy: (busy) => { button.disabled = busy; },
      onFinally: () => events.push("refresh")
    });
    assert.equal(result, "saved");
    assert.equal(button.disabled, false);
    assert.deepEqual(events, ["save", "refresh"]);
  });

  it("reports errors while still performing the final refresh", async () => {
    const events = [];
    const result = await runAction("options-error-behavior", async () => {
      throw Object.assign(new Error("not connected"), { code: "REMOTE_NETWORK" });
    }, {
      onError: (error) => events.push(`error:${error.code}`),
      onFinally: () => events.push("refresh")
    });
    assert.equal(result, undefined);
    assert.deepEqual(events, ["error:REMOTE_NETWORK", "refresh"]);
  });
});

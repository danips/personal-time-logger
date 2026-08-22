import assert from "node:assert/strict";
import { describe, it } from "node:test";

const alarms = [];
globalThis.browser = {
  runtime: { getURL: (path) => path },
  alarms: {
    create(name, options) {
      alarms.push({ name, options });
    }
  }
};

const {
  SYNC_ALARM,
  scheduleSyncHeartbeat,
  scheduleWithFallback,
  syncAlarmMinutes
} = await import("../extension/src/background-schedule.js");

describe("background schedule helpers", () => {
  it("clamps sub-minute intervals to the browser alarm minimum", () => {
    assert.equal(syncAlarmMinutes(1), 1);
    assert.equal(syncAlarmMinutes(30), 1);
    assert.equal(syncAlarmMinutes(90), 2);
  });

  it("recreates the named heartbeat alarm with the saved interval", () => {
    alarms.length = 0;
    assert.equal(scheduleSyncHeartbeat(90), true);
    assert.deepEqual(alarms, [{
      name: SYNC_ALARM,
      options: { periodInMinutes: 2, delayInMinutes: 2 }
    }]);
  });

  it("records a scheduling failure and arms a fallback even when diagnostic storage fails", async () => {
    const attempts = [];
    const result = await scheduleWithFallback({
      async schedule() {
        attempts.push("primary");
        throw new Error("settings store unavailable");
      },
      async scheduleFallback() {
        attempts.push("fallback");
        return true;
      },
      async saveDiagnostic() {
        attempts.push("diagnostic");
        throw new Error("diagnostic store unavailable");
      }
    });

    assert.equal(result, false);
    assert.deepEqual(attempts, ["primary", "diagnostic", "fallback"]);
  });

  it("clears a previous diagnostic after a successful primary schedule", async () => {
    const diagnostics = [];
    const result = await scheduleWithFallback({
      async schedule() { return true; },
      async scheduleFallback() {
        throw new Error("fallback should not run");
      },
      async saveDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      }
    });

    assert.equal(result, true);
    assert.deepEqual(diagnostics, [null]);
  });
});

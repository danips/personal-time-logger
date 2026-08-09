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

const { SYNC_ALARM, scheduleSyncHeartbeat, syncAlarmMinutes } = await import("../src/background-schedule.js");

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
});

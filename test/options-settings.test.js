import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INVALID_MULTIPLIER_MESSAGE,
  INVALID_WORKDAY_START_HOUR_MESSAGE,
  normalizeOptionsSettings,
  normalizeWorkdayStartHour,
  planOptionsSettingsSave
} from "../extension/src/options-settings.js";

describe("Options settings save plan", () => {
  it("accepts a calendar start hour", () => {
    assert.deepEqual(normalizeWorkdayStartHour("09"), {
      valid: true,
      start: 9
    });
  });

  it("rejects empty, fractional, and out-of-range calendar start hours", () => {
    for (const hour of ["", "9.5", "-1", "24"]) {
      assert.deepEqual(normalizeWorkdayStartHour(hour), {
        valid: false,
        message: INVALID_WORKDAY_START_HOUR_MESSAGE
      });
    }
  });

  it("normalizes the accepted form domain", () => {
    assert.deepEqual(normalizeOptionsSettings({ interval: "20", multiplier: "1,25" }), {
      valid: true,
      interval: 30,
      multiplier: "1.250"
    });
  });

  it("rejects invalid multipliers instead of replacing them with one", () => {
    for (const multiplier of ["", "0.999", "5.002", "1.0001", "not-a-number"]) {
      assert.deepEqual(normalizeOptionsSettings({ interval: "60", multiplier }), {
        valid: false,
        message: INVALID_MULTIPLIER_MESSAGE
      });
    }
  });

  it("leaves an unchanged saved configuration entirely local", () => {
    assert.deepEqual(planOptionsSettingsSave({
      currentInterval: 60,
      currentMultiplier: "1.500",
      currentMultiplierUpdatedAt: "2026-08-11T10:00:00.000Z",
      interval: 60,
      multiplier: "1.500"
    }), {
      intervalChanged: false,
      multiplierChanged: false,
      multiplierSyncNeeded: false
    });
  });

  it("resets scheduling without remote configuration work for interval-only saves", () => {
    assert.deepEqual(planOptionsSettingsSave({
      currentInterval: 60,
      currentMultiplier: "1.500",
      currentMultiplierUpdatedAt: "2026-08-11T10:00:00.000Z",
      interval: 90,
      multiplier: "1.500"
    }), {
      intervalChanged: true,
      multiplierChanged: false,
      multiplierSyncNeeded: false
    });
  });

  it("starts remote configuration work for multiplier changes and first-time publication", () => {
    assert.deepEqual(planOptionsSettingsSave({
      currentInterval: 60,
      currentMultiplier: "1.500",
      currentMultiplierUpdatedAt: "2026-08-11T10:00:00.000Z",
      interval: 60,
      multiplier: "1.250"
    }), {
      intervalChanged: false,
      multiplierChanged: true,
      multiplierSyncNeeded: true
    });
    assert.deepEqual(planOptionsSettingsSave({
      currentInterval: undefined,
      currentMultiplier: undefined,
      currentMultiplierUpdatedAt: "",
      interval: 60,
      multiplier: "1.000"
    }), {
      intervalChanged: false,
      multiplierChanged: false,
      multiplierSyncNeeded: true
    });
  });
});

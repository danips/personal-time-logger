import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BACKUP_SETTING_KEYS,
  INVALID_MULTIPLIER_MESSAGE,
  INVALID_WORKDAY_START_HOUR_MESSAGE,
  normalizeBackupSettings,
  normalizeOptionsSettings,
  normalizeWorkdayStartHour,
  planOptionsSettingsSave
} from "../extension/src/options-settings.js";

describe("Options settings save plan", () => {
  it("normalizes portable backup settings and excludes credentials, endpoints, and consent", () => {
    assert.deepEqual(normalizeBackupSettings({
      duration_multiplier: "1,25",
      sync_interval_seconds: 60,
      tempo_author_account_id: " account ",
      tempo_task_issue_ids: { Task: "00123" },
      window_resize_presets: [{ width: "1280", height: 720, isWindow: "true" }],
      workday_start_hour: "9",
      mysql_api_base_url: "https://attacker.invalid",
      chatgpt_usage_session_token_consent: true
    }), {
      duration_multiplier: "1.250",
      sync_interval_seconds: 60,
      tempo_author_account_id: "account",
      tempo_task_issue_ids: { Task: "123" },
      window_resize_presets: [{ width: 1280, height: 720, isWindow: true }],
      workday_start_hour: 9
    });
    assert.equal(BACKUP_SETTING_KEYS.includes("mysql_api_base_url"), false);
    assert.equal(BACKUP_SETTING_KEYS.includes("cloudflare_d1_api_base_url"), false);
    assert.equal(BACKUP_SETTING_KEYS.includes("chatgpt_usage_session_token_consent"), false);
  });

  it("rejects malformed backup settings before import", () => {
    for (const settings of [
      { duration_multiplier: "invalid" },
      { sync_interval_seconds: "soon" },
      { tempo_task_issue_ids: { Task: "not-an-id" } },
      { window_resize_presets: [{ width: 0, height: 720, isWindow: false }] },
      { workday_start_hour: 24 }
    ]) assert.throws(() => normalizeBackupSettings(settings), TypeError);
  });

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

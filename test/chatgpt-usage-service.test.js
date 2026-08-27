import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHATGPT_SESSION_TOKEN_CONSENT_KEY,
  CHATGPT_USAGE_STATE_KEY,
  clearChatGptUsageData,
  getChatGptUsageState,
  refreshChatGptUsage,
  requestCurrentChatGptUsage
} from "../extension/src/chatgpt-usage-service.js";

const NOW = 1_800_000_000_000;

function accessToken() {
  const claims = {
    "https://api.openai.com/auth": { chatgpt_account_id: "redacted-account-id" }
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.signature`;
}

function usageResponse() {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 1,
        limit_window_seconds: 18_000,
        reset_at: 1_800_016_508
      },
      secondary_window: {
        used_percent: 7,
        limit_window_seconds: 604_800,
        reset_at: 1_800_603_308
      }
    },
    credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: "0" }
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

function harness() {
  const values = new Map([[CHATGPT_SESSION_TOKEN_CONSENT_KEY, true]]);
  const calls = [];
  const overrides = {
    now: () => NOW,
    language: "en-GB",
    platform: { async hasOptionalHostPermission() { return true; } },
    async fetch(url, options) {
      calls.push({ url, options });
      if (url.endsWith("/api/auth/session")) return jsonResponse({ accessToken: accessToken() });
      return jsonResponse(usageResponse());
    },
    async getSetting(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
    async setSetting(key, value) { values.set(key, value); return value; },
    async removeSetting(key) { values.delete(key); }
  };
  return { calls, values, overrides };
}

describe("single-session ChatGPT usage", () => {
  it("retrieves both the 5-hour and weekly limits without tabs or containers", async () => {
    const { calls, overrides } = harness();
    const snapshot = await requestCurrentChatGptUsage(overrides);

    assert.equal(snapshot.account.plan_type, "plus");
    assert.equal(snapshot.primary_window.window_seconds, 18_000);
    assert.equal(snapshot.primary_window.remaining_percent, 99);
    assert.equal(snapshot.secondary_window.window_seconds, 604_800);
    assert.equal(snapshot.secondary_window.remaining_percent, 93);
    assert.equal(snapshot.source, "extension_session");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.credentials, "include");
    assert.equal(calls[1].options.headers["chatgpt-account-id"], "redacted-account-id");
    assert.match(calls[1].options.headers.authorization, /^Bearer header\./);
    assert.equal("tabs" in overrides.platform, false);
  });

  it("stores one snapshot and observes the refresh cooldown", async () => {
    const { calls, values, overrides } = harness();
    const refreshed = await refreshChatGptUsage({ ...overrides, ignoreCooldown: true });
    assert.equal(refreshed.kind, "refreshed");
    assert.equal((await getChatGptUsageState(overrides)).snapshot.secondary_window.remaining_percent, 93);

    const skipped = await refreshChatGptUsage(overrides);
    assert.equal(skipped.kind, "skipped");
    assert.equal(calls.length, 2);
    assert.equal(values.get(CHATGPT_USAGE_STATE_KEY).last_error, null);
  });

  it("requires permission and explicit consent", async () => {
    const denied = harness();
    denied.overrides.platform.hasOptionalHostPermission = async () => false;
    await assert.rejects(() => refreshChatGptUsage(denied.overrides), { code: "permission_required" });

    const noConsent = harness();
    noConsent.values.set(CHATGPT_SESSION_TOKEN_CONSENT_KEY, false);
    await assert.rejects(() => refreshChatGptUsage(noConsent.overrides), { code: "consent_required" });
  });

  it("reports a deactivated selected workspace without retaining the raw response", async () => {
    const { overrides } = harness();
    overrides.fetch = async (url) => url.endsWith("/api/auth/session")
      ? jsonResponse({ accessToken: accessToken() })
      : jsonResponse({ detail: { code: "deactivated_workspace", private_detail: "not persisted" } }, 402);

    await assert.rejects(() => refreshChatGptUsage({ ...overrides, ignoreCooldown: true }), {
      code: "workspace_deactivated",
      http_status: 402
    });
    const state = await getChatGptUsageState(overrides);
    assert.equal(state.last_error.code, "workspace_deactivated");
    assert.equal(JSON.stringify(state).includes("private_detail"), false);
    assert.equal(JSON.stringify(state).includes("deactivated_workspace"), false);
  });

  it("clears the current snapshot and legacy multi-account settings", async () => {
    const { values, overrides } = harness();
    values.set(CHATGPT_USAGE_STATE_KEY, { snapshot: {} });
    values.set("chatgpt_usage_accounts", [{ id: "legacy" }]);
    values.set("chatgpt_usage_account_generation", 2);
    values.set("chatgpt_usage_profile_salt", "legacy-salt");

    await clearChatGptUsageData(overrides);
    for (const key of [
      CHATGPT_USAGE_STATE_KEY,
      CHATGPT_SESSION_TOKEN_CONSENT_KEY,
      "chatgpt_usage_accounts",
      "chatgpt_usage_account_generation",
      "chatgpt_usage_profile_salt"
    ]) {
      assert.equal(values.has(key), false);
    }
  });
});

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { describe, it } from "node:test";

import {
  clearChatGptUsageData,
  createAccountContainer,
  disconnectAccount,
  refreshAccount,
  verifyAccount
} from "../src/chatgpt-containers.js";

const response = (over = {}) => ({
  user_id: "user-private",
  account_id: "account-private",
  email: "member@example.invalid",
  plan_type: "team",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 4,
      window_seconds: 604800,
      reset_at: 1786773902
    }
  },
  ...over
});

function harness({ raw = response(), tabs = [], now = 1_800_000_000_000 } = {}) {
  const values = new Map();
  const calls = { createdTabs: [], removedTabs: [], permission: 0 };
  let tabId = 10;
  const fakePlatform = {
    async hasOptionalHostPermission() {
      calls.permission += 1;
      return true;
    },
    contextualIdentitiesAvailable: () => true,
    async createContextualIdentity() {
      return { cookieStoreId: "firefox-container-1" };
    },
    async getContextualIdentity() {
      return { cookieStoreId: "firefox-container-1" };
    },
    async createTab(details) {
      const tab = { id: ++tabId, status: "complete", ...details };
      calls.createdTabs.push(tab);
      return tab;
    },
    async queryChatGptTabs() {
      return tabs;
    },
    async waitForTabComplete(tab) {
      return { ...tab, status: "complete" };
    },
    async sendTabMessage() {
      return { status: 200, body: raw };
    },
    async removeTab(id) {
      calls.removedTabs.push(id);
    }
  };
  const overrides = {
    platform: fakePlatform,
    crypto: webcrypto,
    now: () => now,
    getSetting: async (key, fallback) => values.has(key) ? values.get(key) : fallback,
    setSetting: async (key, value) => values.set(key, value),
    removeSetting: async (key) => values.delete(key)
  };
  return { calls, values, overrides };
}

describe("ChatGPT container orchestration", () => {
  it("stores a pending binding before opening a visible setup tab", async () => {
    const { calls, values, overrides } = harness();
    const account = await createAccountContainer("Account 1", overrides);

    assert.equal(account.pending_setup, true);
    assert.equal(account.cookie_store_id, "firefox-container-1");
    assert.equal(calls.createdTabs.length, 1);
    assert.equal(calls.createdTabs[0].active, true);
    assert.equal(values.get("chatgpt_usage_accounts")[0].cookie_store_id, "firefox-container-1");
  });

  it("reports denied host access before creating a container", async () => {
    const { overrides } = harness();
    overrides.platform.hasOptionalHostPermission = async () => false;
    await assert.rejects(() => createAccountContainer("Account 1", overrides), { code: "permission_required" });
  });

  it("validates a signed-in account and stores only the fingerprint and normalized snapshot", async () => {
    const { values, overrides } = harness();
    await createAccountContainer("Account 1", overrides);
    const saved = await verifyAccount("firefox-container-1", overrides);

    assert.equal(saved.pending_setup, false);
    assert.equal(saved.email, "member@example.invalid");
    assert.equal(typeof saved.fingerprint, "string");
    assert.equal("user_id" in saved, false);
    assert.equal("account_id" in saved, false);
    assert.equal(JSON.stringify(saved).includes("user-private"), false);
    assert.equal(saved.snapshot.primary_window.remaining_percent, 96);
  });

  it("connects a valid usage response when optional raw identity fields are absent", async () => {
    const raw = response();
    delete raw.user_id;
    delete raw.account_id;
    const { overrides } = harness({ raw });
    await createAccountContainer("Account 1", overrides);
    const saved = await verifyAccount("firefox-container-1", overrides);

    assert.equal(saved.pending_setup, false);
    assert.equal(saved.fingerprint, "");
    assert.equal(saved.snapshot.primary_window.remaining_percent, 96);
  });

  it("uses and cleans up an inactive temporary tab for refresh", async () => {
    const { calls, values, overrides } = harness();
    await createAccountContainer("Account 1", overrides);
    const account = await verifyAccount("firefox-container-1", overrides);
    values.set("chatgpt_usage_accounts", [{ ...account, last_refresh_at: 0 }]);

    const refreshed = await refreshAccount({ ...account, last_refresh_at: 0 }, { ...overrides, ignoreCooldown: true });
    assert.equal(refreshed.snapshot.primary_window.used_percent, 4);
    assert.equal(calls.createdTabs.at(-1).active, false);
    assert.deepEqual(calls.removedTabs, [calls.createdTabs.at(-1).id]);
  });

  it("enforces the per-account refresh cooldown", async () => {
    const { overrides } = harness();
    await createAccountContainer("Account 1", overrides);
    const account = await verifyAccount("firefox-container-1", overrides);
    const result = await refreshAccount(account, overrides);
    assert.equal(result.skipped, true);
    assert.equal(result.skip_reason, "cooldown");
  });

  it("rejects connecting the same account twice", async () => {
    const { values, overrides } = harness();
    await createAccountContainer("Account 1", overrides);
    const first = await verifyAccount("firefox-container-1", overrides);
    values.set("chatgpt_usage_accounts", [
      first,
      {
        id: "second-account",
        label: "Account 2",
        cookie_store_id: "firefox-container-2",
        pending_setup: true,
        fingerprint: "",
        snapshot: null
      }
    ]);
    await assert.rejects(() => verifyAccount("firefox-container-2", overrides), { code: "duplicate_account" });
  });

  it("disconnects local data without deleting the Firefox container", async () => {
    const { calls, values, overrides } = harness();
    await createAccountContainer("Account 1", overrides);
    const account = await verifyAccount("firefox-container-1", overrides);
    await disconnectAccount(account.id, overrides);

    assert.deepEqual(values.get("chatgpt_usage_accounts"), []);
    assert.deepEqual(calls.removedTabs, []);
  });

  it("clears usage records and the profile salt without touching browser containers", async () => {
    const { calls, values, overrides } = harness();
    values.set("chatgpt_usage_accounts", [{ id: "a" }]);
    values.set("chatgpt_usage_profile_salt", "salt");
    values.set("chatgpt_usage_cache_version", 1);
    values.set("chatgpt_usage_session_token_consent", true);
    await clearChatGptUsageData(overrides);

    assert.equal(values.has("chatgpt_usage_accounts"), false);
    assert.equal(values.has("chatgpt_usage_profile_salt"), false);
    assert.equal(values.has("chatgpt_usage_cache_version"), false);
    assert.equal(values.has("chatgpt_usage_session_token_consent"), false);
    assert.deepEqual(calls.removedTabs, []);
  });
});

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();

const db = await import("../extension/src/db.js");
const {
  CHATGPT_ACCOUNTS_KEY,
  CHATGPT_PROFILE_SALT_KEY,
  clearChatGptUsageData,
  disconnectAccount,
  refreshAccount
} = await import("../extension/src/chatgpt-containers.js");

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const account = (id) => ({
  id,
  label: id,
  cookie_store_id: `container-${id}`,
  pending_setup: false,
  fingerprint: "",
  email: "",
  plan_type: "",
  snapshot: null,
  last_success_at: null,
  last_refresh_at: 0,
  last_error: null
});

function usage(email) {
  return {
    email,
    plan_type: "team",
    rate_limit: {
      allowed: true,
      primary_window: { used_percent: 10, window_seconds: 3600, reset_at: 1_800_000_000 }
    }
  };
}

describe("atomic ChatGPT account mutations", () => {
  it("retains both account snapshots when concurrent refreshes complete in either order", async () => {
    const first = account("first");
    const second = account("second");
    await db.setSetting(CHATGPT_ACCOUNTS_KEY, [first, second]);

    const firstResponse = deferred();
    const secondResponse = deferred();
    const arrived = deferred();
    let requests = 0;
    const overrides = {
      crypto: webcrypto,
      now: () => 1_800_000_000_000,
      platform: {
        async hasOptionalHostPermission() { return true; },
        async getContextualIdentity(cookieStoreId) { return { cookieStoreId }; },
        async queryChatGptTabs() { return []; },
        async createTab({ cookieStoreId }) { return { id: cookieStoreId, status: "complete" }; },
        async waitForTabComplete(id) { return { id, status: "complete" }; },
        async sendTabMessage(id) {
          requests += 1;
          if (requests === 2) arrived.resolve();
          return id === "container-first" ? firstResponse.promise : secondResponse.promise;
        },
        async removeTab() {}
      }
    };

    const refreshingFirst = refreshAccount(first.id, { ...overrides, ignoreCooldown: true });
    const refreshingSecond = refreshAccount(second.id, { ...overrides, ignoreCooldown: true });
    await arrived.promise;

    secondResponse.resolve({ status: 200, body: usage("second@example.invalid") });
    firstResponse.resolve({ status: 200, body: usage("first@example.invalid") });
    await Promise.all([refreshingFirst, refreshingSecond]);

    const stored = await db.getSetting(CHATGPT_ACCOUNTS_KEY);
    assert.deepEqual(
      stored.map((item) => [item.id, item.email]).sort(([left], [right]) => left.localeCompare(right)),
      [["first", "first@example.invalid"], ["second", "second@example.invalid"]]
    );
  });

  it("does not resurrect an account disconnected while its refresh is paused", async () => {
    const saved = account("disconnecting");
    await db.setSetting(CHATGPT_ACCOUNTS_KEY, [saved]);
    const responseBarrier = deferred();
    const requestStarted = deferred();
    const overrides = {
      crypto: webcrypto,
      now: () => 1_800_000_000_000,
      platform: {
        async hasOptionalHostPermission() { return true; },
        async getContextualIdentity(cookieStoreId) { return { cookieStoreId }; },
        async queryChatGptTabs() { return []; },
        async createTab({ cookieStoreId }) { return { id: cookieStoreId, status: "complete" }; },
        async waitForTabComplete(id) { return { id, status: "complete" }; },
        async sendTabMessage() {
          requestStarted.resolve();
          return responseBarrier.promise;
        },
        async removeTab() {}
      }
    };

    const refresh = refreshAccount(saved.id, { ...overrides, ignoreCooldown: true });
    await requestStarted.promise;
    await disconnectAccount(saved.id, overrides);
    responseBarrier.resolve({ status: 200, body: usage("disconnecting@example.invalid") });

    await assert.rejects(refresh, { code: "account_not_found" });
    assert.deepEqual(await db.getSetting(CHATGPT_ACCOUNTS_KEY), []);
  });

  it("does not recreate accounts or a profile salt after clear during refresh", async () => {
    const saved = account("clearing");
    await db.setSetting(CHATGPT_ACCOUNTS_KEY, [saved]);
    await db.setSetting(CHATGPT_PROFILE_SALT_KEY, "old-salt");
    const responseBarrier = deferred();
    const requestStarted = deferred();
    const overrides = {
      crypto: webcrypto,
      now: () => 1_800_000_000_000,
      platform: {
        async hasOptionalHostPermission() { return true; },
        async getContextualIdentity(cookieStoreId) { return { cookieStoreId }; },
        async queryChatGptTabs() { return []; },
        async createTab({ cookieStoreId }) { return { id: cookieStoreId, status: "complete" }; },
        async waitForTabComplete(id) { return { id, status: "complete" }; },
        async sendTabMessage() {
          requestStarted.resolve();
          return responseBarrier.promise;
        },
        async removeTab() {}
      }
    };

    const refresh = refreshAccount(saved.id, { ...overrides, ignoreCooldown: true });
    await requestStarted.promise;
    await clearChatGptUsageData(overrides);
    responseBarrier.resolve({
      status: 200,
      body: { ...usage("clearing@example.invalid"), user_id: "user", account_id: "account" }
    });

    await assert.rejects(refresh, { code: "account_not_found" });
    assert.equal(await db.getSetting(CHATGPT_ACCOUNTS_KEY), null);
    assert.equal(await db.getSetting(CHATGPT_PROFILE_SALT_KEY), null);
  });
});

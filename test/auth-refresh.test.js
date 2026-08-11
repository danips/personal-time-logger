import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { createGoogleApiMock } from "./support/mock-google-api.js";

installFakeIndexedDB();
globalThis.browser = {
  runtime: { getURL: (path) => path },
  storage: {
    sync: {
      async get() {
        return {
          google_oauth_client_id: "test-client",
          google_oauth_client_secret: "test-secret"
        };
      },
      async set() {}
    }
  }
};

let db;
let google;

async function authContext(label) {
  const moduleUrl = new URL("../src/auth.js", import.meta.url);
  moduleUrl.searchParams.set("test_context", label);
  return import(moduleUrl.href);
}

before(async () => {
  db = await import("../src/db.js");
  google = createGoogleApiMock().install();
});

after(() => google.restore());

describe("token refresh", () => {
  it("uses one refresh request when two extension contexts need a token", async () => {
    await db.setSetting("token_data", {
      access_token: "expired-token",
      refresh_token: "refresh-token",
      expires_at: Date.now() - 1
    });

    const refresh = google.barrier("refresh token");
    google.enqueue({ method: "POST", pathname: "/token" }, refresh);
    const [first, second] = await Promise.all([authContext("first"), authContext("second")]);
    const firstToken = first.getAccessToken();
    const secondToken = second.getAccessToken();

    const request = await refresh.waitForRequest();
    assert.match(String(request.body), /grant_type=refresh_token/);
    refresh.release(google.json({ access_token: "fresh-token", expires_in: 3600 }));

    assert.deepEqual(await Promise.all([firstToken, secondToken]), ["fresh-token", "fresh-token"]);
    assert.equal(google.calls.filter((call) => call.pathname === "/token").length, 1);
  });

  it("stores the OAuth expiry reported by Google without extending it", async () => {
    await db.setSetting("token_data", {
      access_token: "expired-token",
      refresh_token: "refresh-token",
      expires_at: Date.now() - 1
    });
    google.enqueue({ method: "POST", pathname: "/token" }, google.json({
      access_token: "short-lived-token",
      expires_in: 5
    }));

    const auth = await authContext("expiry");
    const before = Date.now();
    assert.equal(await auth.getAccessToken(), "short-lived-token");
    const tokenData = await db.getSetting("token_data");
    assert.ok(tokenData.expires_at >= before + 5_000);
    assert.ok(tokenData.expires_at < before + 6_000);
  });

  it("clears a revoked refresh token and requires a new sign-in", async () => {
    await db.setSetting("token_data", {
      access_token: "expired-token",
      refresh_token: "revoked-refresh-token",
      expires_at: Date.now() - 1
    });
    google.enqueue({ method: "POST", pathname: "/token" }, google.status(400, {
      error: "invalid_grant",
      error_description: "Token has been expired or revoked."
    }));

    const auth = await authContext("revoked");
    await assert.rejects(() => auth.getAccessToken(), (error) => error.code === "AUTH_EXPIRED");
    assert.equal(await db.getSetting("token_data"), null);
  });

  it("does not persist a malformed successful refresh response", async () => {
    const tokenData = {
      access_token: "expired-token",
      refresh_token: "refresh-token",
      expires_at: Date.now() - 1
    };
    await db.setSetting("token_data", tokenData);
    google.enqueue({ method: "POST", pathname: "/token" }, google.json({ expires_in: 3600 }));

    const auth = await authContext("malformed-token");
    await assert.rejects(() => auth.getAccessToken(), (error) => error.code === "AUTH_FAILED");
    assert.deepEqual(await db.getSetting("token_data"), tokenData);
  });

  it("aborts a stalled OAuth refresh and releases its lock", async () => {
    await db.setSetting("token_data", {
      access_token: "expired-token",
      refresh_token: "stalled-refresh-token",
      expires_at: Date.now() - 1
    });
    const auth = await authContext("timeout");
    const previousFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let aborted = false;
    let timeoutHandle;
    let cleared = false;

    globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("OAuth request aborted"));
      }, { once: true });
    });
    globalThis.setTimeout = (callback, delay, ...args) => {
      const handle = originalSetTimeout(callback, delay === 30_000 ? 0 : delay, ...args);
      if (delay === 30_000) timeoutHandle = handle;
      return handle;
    };
    globalThis.clearTimeout = (handle) => {
      if (handle === timeoutHandle) cleared = true;
      return originalClearTimeout(handle);
    };

    try {
      await assert.rejects(() => auth.getAccessToken(), (error) => error.code === "API_TIMEOUT");
      assert.equal(aborted, true);
      assert.equal(cleared, true);
      assert.equal(await db.getSetting("token_refresh_lock"), null);
    } finally {
      globalThis.fetch = previousFetch;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it("maps OAuth network failures to the shared network code", async () => {
    await db.setSetting("token_data", {
      access_token: "expired-token",
      refresh_token: "offline-refresh-token",
      expires_at: Date.now() - 1
    });
    const auth = await authContext("network-failure");
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network unavailable");
    };

    try {
      await assert.rejects(() => auth.getAccessToken(), (error) => error.code === "API_NETWORK");
      assert.equal(await db.getSetting("token_refresh_lock"), null);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("does not restore credentials when a refresh completes after sign-out", async () => {
    await db.setSetting("token_data", {
      access_token: "expired-token",
      refresh_token: "signout-refresh-token",
      expires_at: Date.now() - 1
    });
    const refresh = google.barrier("refresh after sign-out");
    google.enqueue({ method: "POST", pathname: "/token" }, refresh);
    const auth = await authContext("signout-during-refresh");
    const pending = auth.getAccessToken();
    await refresh.waitForRequest();
    await auth.signOut();
    refresh.release(google.json({ access_token: "stale-fresh-token", expires_in: 3600 }));

    await assert.rejects(pending, (error) => error.code === "AUTH_STALE");
    assert.equal(await db.getSetting("token_data"), null);
  });

  it("keeps the newer refresh response when a former lock owner finishes last", async () => {
    await db.setSetting("token_data", {
      access_token: "expired-token",
      refresh_token: "race-refresh-token",
      expires_at: Date.now() - 1
    });
    const firstRefresh = google.barrier("first refresh");
    google.enqueue({ method: "POST", pathname: "/token" }, firstRefresh);
    const first = await authContext("first-refresh-owner");
    const firstPending = first.getAccessToken();
    await firstRefresh.waitForRequest();

    await db.setSetting("token_refresh_lock", { holder: "expired-owner", generation: 999, acquired_at: 0 });
    google.enqueue({ method: "POST", pathname: "/token" }, google.json({ access_token: "newer-token", expires_in: 3600 }));
    const second = await authContext("second-refresh-owner");
    assert.equal(await second.getAccessToken(), "newer-token");

    firstRefresh.release(google.json({ access_token: "older-token", expires_in: 3600 }));
    assert.equal(await firstPending, "newer-token");
    assert.equal((await db.getSetting("token_data")).access_token, "newer-token");
  });
});

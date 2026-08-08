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
});

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
});

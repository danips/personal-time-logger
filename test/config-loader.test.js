import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();
const synced = {};
let rejectNextSyncWrite = false;
globalThis.browser = {
  runtime: { getURL: (path) => path },
  storage: {
    sync: {
      async get(keys) {
        return Object.fromEntries(keys.filter((key) => Object.hasOwn(synced, key)).map((key) => [key, synced[key]]));
      },
      async set(values) {
        if (rejectNextSyncWrite) {
          rejectNextSyncWrite = false;
          throw new Error("Firefox Sync is temporarily unavailable");
        }
        Object.assign(synced, values);
      }
    }
  }
};

const db = await import("../extension/src/db.js");
const config = await import("../extension/src/config-loader.js");

describe("OAuth credential configuration", () => {
  it("requires a complete client configuration", async () => {
    await assert.rejects(
      () => config.setOAuthClientCredentials("client-only", ""),
      (error) => error.code === "CONFIG_INVALID"
    );
    assert.equal(synced.google_oauth_client_id, undefined);
    assert.equal((await config.getConfig()).configLoaded, false);
  });

  it("atomically invalidates the local token before publishing changed credentials", async () => {
    await db.setSetting(config.TOKEN_KEY, { access_token: "old", refresh_token: "old-refresh" });
    await db.setSetting(config.AUTH_GENERATION_KEY, 4);

    const saved = await config.setOAuthClientCredentials("new-client", "new-secret");

    assert.equal(saved.changed, true);
    assert.deepEqual(synced, {
      google_oauth_client_id: "new-client",
      google_oauth_client_secret: "new-secret"
    });
    assert.equal(await db.getSetting(config.TOKEN_KEY), null);
    assert.equal(await db.getSetting(config.AUTH_GENERATION_KEY), 5);
    assert.equal((await config.getConfig()).configLoaded, true);
  });

  it("does not pair changed credentials with a token when Firefox Sync rejects the save", async () => {
    Object.assign(synced, {
      google_oauth_client_id: "old-client",
      google_oauth_client_secret: "old-secret"
    });
    await db.setSetting(config.TOKEN_KEY, { access_token: "old", refresh_token: "old-refresh" });
    await db.setSetting(config.AUTH_GENERATION_KEY, 10);
    rejectNextSyncWrite = true;

    await assert.rejects(
      () => config.setOAuthClientCredentials("new-client", "new-secret"),
      (error) => error.code === "CONFIG_SAVE_FAILED"
    );

    assert.deepEqual(synced, {
      google_oauth_client_id: "old-client",
      google_oauth_client_secret: "old-secret"
    });
    assert.equal(await db.getSetting(config.TOKEN_KEY), null);
    assert.equal(await db.getSetting(config.AUTH_GENERATION_KEY), 11);
  });

  it("treats a partial legacy configuration as incomplete instead of usable", async () => {
    delete synced.google_oauth_client_id;
    delete synced.google_oauth_client_secret;
    await db.setSetting("google_oauth_client_id", "legacy-client-only");

    const loaded = await config.getConfig();

    assert.equal(loaded.configLoaded, false);
    assert.equal(loaded.configIncomplete, true);
  });
});

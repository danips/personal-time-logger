import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { seedEntry } from "./support/db-fixtures.js";
import { persistedEntryFixture } from "./support/persisted-entry-fixture.js";

installFakeIndexedDB();
const removeCalls = [];
let fetchCalls = 0;
globalThis.browser = {
  storage: { sync: { async remove(keys) { removeCalls.push([...keys]); } } },
  runtime: { getURL: (path) => path }
};
globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error("retirement cleanup must not fetch");
};

const db = await import("../extension/src/db.js");
const { RETIRED_LOCAL_KEYS, retireGoogleState } = await import("../extension/src/provider-retirement.js");

describe("retired provider cleanup", () => {
  it("removes exact legacy state while preserving D1 state, migration, and entries", async () => {
    const localEntry = persistedEntryFixture({ id: "retirement-entry", project: "Keep local data" });
    await seedEntry(db, localEntry);
    await db.setSetting("remote_backend", "cloudflare-d1");
    await db.setSetting("remote_backend_established", true);
    await db.setSetting("mysql_api_token", "keep-me");
    await db.setSetting("mysql_remote_change_token", "token-7");
    await db.setSetting("cloudflare_d1_api_token", "keep-d1-token");
    await db.setSetting("cloudflare_d1_remote_change_token", "d1-token-9");
    await db.setSetting("storage_migration_state", { source_provider: "mysql", target_provider: "cloudflare-d1", phase: "seeding", migration_id: "supported-migration" });
    await db.setSetting("reconciliation_intents", [{ provider: "cloudflare-d1", id: "keep" }]);
    await db.setSetting("diagnostic_ring", [{ code: "API_ERROR" }]);
    for (const key of RETIRED_LOCAL_KEYS) await db.setSetting(key, `legacy-${key}`);

    await retireGoogleState();

    assert.equal(await db.getSetting("remote_backend"), "cloudflare-d1");
    assert.equal(await db.getSetting("remote_backend_established"), true);
    assert.equal(await db.getSetting("mysql_api_token"), "keep-me");
    assert.equal(await db.getSetting("mysql_remote_change_token"), "token-7");
    assert.equal(await db.getSetting("cloudflare_d1_api_token"), "keep-d1-token");
    assert.equal(await db.getSetting("cloudflare_d1_remote_change_token"), "d1-token-9");
    assert.deepEqual(await db.getSetting("storage_migration_state"), { source_provider: "mysql", target_provider: "cloudflare-d1", phase: "seeding", migration_id: "supported-migration" });
    assert.deepEqual(await db.getSetting("reconciliation_intents"), [{ provider: "cloudflare-d1", id: "keep" }]);
    assert.deepEqual(await db.getSetting("diagnostic_ring"), [{ code: "API_ERROR" }]);
    assert.deepEqual(await db.getEntry(localEntry.id), localEntry);
    for (const key of RETIRED_LOCAL_KEYS) assert.equal(await db.getSetting(key), null, key);
    assert.deepEqual(removeCalls, [["google_oauth_client_id", "google_oauth_client_secret"]]);
    assert.equal(fetchCalls, 0);
  });

  it("unconfigures missing and legacy providers and scrubs only retired migration intents", async () => {
    await db.setSetting("remote_backend", "google-sheets");
    await db.setSetting("remote_backend_established", true);
    await db.setSetting("storage_migration_state", { source_provider: "google-sheets", target_provider: "mysql", phase: "failed" });
    await db.setSetting("reconciliation_intents", [
      { provider: "google-sheets", id: "retired" },
      { provider: "mysql", id: "supported" }
    ]);
    await db.setSetting("google_oauth_client_id", "client");
    await db.setSetting("unrelated_setting", "preserve");

    await retireGoogleState();
    await retireGoogleState();

    assert.equal(await db.getSetting("remote_backend"), "");
    assert.equal(await db.getSetting("remote_backend_established"), false);
    assert.equal(await db.getSetting("storage_migration_state"), null);
    assert.deepEqual(await db.getSetting("reconciliation_intents"), [{ provider: "mysql", id: "supported" }]);
    assert.equal(await db.getSetting("unrelated_setting"), "preserve");
    assert.equal(await db.getSetting("google_oauth_client_id"), null);
    assert.deepEqual(removeCalls, [
      ["google_oauth_client_id", "google_oauth_client_secret"],
      ["google_oauth_client_id", "google_oauth_client_secret"],
      ["google_oauth_client_id", "google_oauth_client_secret"]
    ]);
    assert.equal(fetchCalls, 0);
  });

  it("keeps a profile with no backend explicitly unconfigured", async () => {
    await db.mutateSettings(["remote_backend", "remote_backend_established", "token_data"], (settings) => {
      settings.delete("remote_backend");
      settings.set("remote_backend_established", true);
      settings.set("token_data", { access_token: "retired" });
    });

    await retireGoogleState();

    assert.equal(await db.getSetting("remote_backend"), "");
    assert.equal(await db.getSetting("remote_backend_established"), false);
    assert.equal(await db.getSetting("token_data"), null);
    assert.equal(removeCalls.length, 4);
    assert.equal(fetchCalls, 0);
  });
});

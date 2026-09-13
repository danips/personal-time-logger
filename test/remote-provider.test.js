import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { persistedEntryFixture } from "./support/persisted-entry-fixture.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;
globalThis.browser = {
  runtime: { getURL: (path) => path },
  storage: {
    sync: {
      async remove() {}
    }
  }
};

const db = await import("../extension/src/db.js");
const providers = await import("../extension/src/remote-provider.js");
const mysql = await import("../extension/src/remote-mysql.js");

const fixture = (over = {}) => persistedEntryFixture({
  id: "provider-entry",
  description: "",
  ...over
});

describe("remote provider selection", () => {
  it("treats missing and blank settings as unconfigured", async () => {
    await db.setSetting("remote_backend", "");
    assert.equal(providers.decodeRemoteProviderId(undefined), "");
    assert.equal(providers.decodeRemoteProviderId("  "), "");
    await assert.rejects(() => providers.getActiveRemoteProvider(), { code: "REMOTE_BACKEND_UNSUPPORTED" });
  });

  it("treats the retired Google Sheets value as unsupported", async () => {
    await db.setSetting("remote_backend", "google-sheets");
    assert.equal(providers.decodeRemoteProviderId("google-sheets"), "google-sheets");
    assert.throws(() => providers.getRemoteProvider("google-sheets"), { code: "REMOTE_BACKEND_UNSUPPORTED" });
    await assert.rejects(() => providers.getActiveRemoteProvider(), { code: "REMOTE_BACKEND_UNSUPPORTED" });
  });

  it("rejects unknown backend IDs instead of falling back", () => {
    assert.throws(
      () => providers.getRemoteProvider("not-a-provider"),
      (error) => error.code === "REMOTE_BACKEND_UNSUPPORTED"
    );
  });

  it("registers exactly the supported provider IDs", () => {
    assert.equal(providers.REMOTE_PROVIDER_ID.MYSQL, "mysql");
    assert.equal(providers.REMOTE_PROVIDER_ID.CLOUDFLARE_D1, "cloudflare-d1");
    assert.deepEqual(providers.registeredRemoteProviderIds(), ["mysql", "cloudflare-d1"]);
    assert.equal(providers.getRemoteProvider(providers.REMOTE_PROVIDER_ID.MYSQL).id, "mysql");
    assert.equal(providers.getRemoteProvider(providers.REMOTE_PROVIDER_ID.CLOUDFLARE_D1).id, "cloudflare-d1");
  });

  it("keeps the provider contract consistent across backends", () => {
    for (const id of providers.registeredRemoteProviderIds()) {
      const provider = providers.getRemoteProvider(id);
      assert.equal(typeof provider.id, "string");
      assert.equal(typeof provider.label, "string");
      for (const method of [
        "ensureReady",
        "getChangeToken",
        "readSnapshot",
        "appendEntries",
        "updateEntries",
        "deleteEntries",
        "updateConfig"
      ]) {
        assert.equal(typeof provider[method], "function", `${id}.${method}`);
      }
    }
  });
});

describe("MySQL API client", () => {
  const platformApi = {
    isOnline: () => true,
    async hasOptionalHostPermission() { return true; },
    async requestOptionalHostPermission() { return true; }
  };

  it("normalizes the configured URL and rejects unsafe production URLs", () => {
    assert.equal(mysql.normalizeMysqlApiBaseUrl("https://time-api.cordoceo.com///"), "https://time-api.cordoceo.com");
    assert.throws(() => mysql.normalizeMysqlApiBaseUrl("http://localhost:8080"), (error) => error.code === "MYSQL_CONFIG_INVALID");
    assert.throws(() => mysql.normalizeMysqlApiBaseUrl("https://user:pass@example.invalid"), (error) => error.code === "MYSQL_CONFIG_INVALID");
  });

  it("requires a local token before making a request and sends it only as bearer auth", async () => {
    let calls = 0;
    const missing = mysql.createMysqlApiClient({
      baseUrl: "https://time-api.cordoceo.com",
      token: "",
      platformApi,
      fetchImpl: async () => { calls += 1; return null; }
    });
    await assert.rejects(() => missing.health(), (error) => error.code === "MYSQL_CONFIG_MISSING");
    assert.equal(calls, 0);

    let request;
    const client = mysql.createMysqlApiClient({
      baseUrl: "https://time-api.cordoceo.com",
      token: "test-secret-token",
      platformApi,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, service: "personal-time-logger", apiVersion: 1, schemaVersion: 1, mysql: "8.4" }); } };
      }
    });
    await client.health();
    assert.equal(request.url, "https://time-api.cordoceo.com/v1/health");
    assert.equal(request.options.headers.Authorization, "Bearer test-secret-token");
  });

  it("maps stale API responses without exposing token or server text", async () => {
    const client = mysql.createMysqlApiClient({
      baseUrl: "https://time-api.cordoceo.com",
      token: "secret-token-that-must-not-appear",
      platformApi,
      fetchImpl: async () => ({
        ok: false,
        status: 409,
        async text() { return JSON.stringify({ error: { code: "REMOTE_VERSION_STALE", message: "secret-token-that-must-not-appear" } }); }
      })
    });
    await assert.rejects(() => client.changeToken(), (error) => {
      assert.equal(error.code, "REMOTE_VERSION_STALE");
      assert.equal(error.message.includes("secret-token"), false);
      return true;
    });
  });

  it("distinguishes a server CORS rejection from a missing Firefox host permission", async () => {
    const client = mysql.createMysqlApiClient({
      baseUrl: "https://time-api.cordoceo.com",
      token: "test-secret-token",
      platformApi,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        async text() { return JSON.stringify({ error: { code: "ORIGIN_NOT_ALLOWED" } }); }
      })
    });
    await assert.rejects(() => client.changeToken(), (error) => {
      assert.equal(error.code, "REMOTE_ORIGIN_NOT_ALLOWED");
      return true;
    });
  });

  it("strips local-only entry fields before sending mutations", async () => {
    const localEntry = fixture({ dirty: true, last_sync_at: "2026-08-08T10:00:00.000Z", sync_error: "old failure" });
    let requestBody;
    await mysql.mysqlProvider.appendEntries([localEntry], {
      baseUrl: "https://time-api.cordoceo.com",
      token: "test-secret-token",
      platformApi,
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return { ok: true, status: 200, async text() { return JSON.stringify({ entries: [{ id: localEntry.id, version: 1 }] }); } };
      }
    });
    assert.equal(requestBody.entries[0].dirty, undefined);
    assert.equal(requestBody.entries[0].last_sync_at, undefined);
    assert.equal(requestBody.entries[0].sync_error, undefined);
    assert.equal(Object.keys(requestBody.entries[0]).length, 14);
  });

  it("normalizes nullable optional fields returned by the MySQL API", async () => {
    const entry = fixture({ end_at: null, deleted_at: null, multiply: null });
    const snapshot = await mysql.mysqlProvider.readSnapshot({
      baseUrl: "https://time-api.cordoceo.com",
      token: "test-secret-token",
      platformApi,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            changeToken: "1",
            entries: [{ entry, version: 1 }],
            config: []
          });
        }
      })
    });
    assert.equal(snapshot.quarantined.length, 0);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].end_at, "");
    assert.equal(snapshot.entries[0].deleted_at, "");
    assert.equal(snapshot.entries[0].multiply, "");
  });
});

describe("provider boundary", () => {
  it("keeps generic sync and reconciliation free of direct Sheets imports", () => {
    const sync = readFileSync(join(process.cwd(), "extension/src/sync.js"), "utf8");
    const reconcile = readFileSync(join(process.cwd(), "extension/src/reconcile.js"), "utf8");
    assert.doesNotMatch(sync, /from ["']\.\/sheets\.js["']/);
    assert.doesNotMatch(reconcile, /from ["']\.\/sheets\.js["']/);
    assert.match(sync, /getActiveRemoteProvider/);
    assert.match(reconcile, /getActiveRemoteProvider/);
  });

  it("exposes the safe Storage preparation UI and exact API host permission", () => {
    const options = readFileSync(join(process.cwd(), "extension/options/options.html"), "utf8");
    const optionsCode = readFileSync(join(process.cwd(), "extension/options/options.js"), "utf8");
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "extension/manifest.json"), "utf8"));
    assert.match(options, /id="storage"/);
    assert.match(options, /id="testMysqlConnection"/);
    assert.match(options, /id="activateMysqlFromLocal"/);
    assert.match(options, /id="activateMysqlFromRemote"/);
    assert.match(options, /id="firstRunSetup"/);
    assert.match(options, /id="chooseMysqlSetup"/);
    assert.match(options, /id="chooseCloudflareD1Setup"/);
    assert.match(options, /id="cloudflareD1ApiBaseUrl"/);
    assert.match(options, /id="cloudflareD1ApiToken" type="password"/);
    assert.match(options, /id="testCloudflareD1Connection"/);
    assert.match(optionsCode, /activateCloudflareD1Clicked/);
    assert.match(optionsCode, /CLOUDFLARE_D1_API_TOKEN/);
    assert.match(options, /id="settingsLayout"/);
    assert.match(optionsCode, /REMOTE_BACKEND_TARGET|remoteBackendTarget/);
    assert.match(optionsCode, /activateMysqlFromLocal/);
    assert.match(optionsCode, /activateMysqlFromRemote/);
    assert.match(optionsCode, /REMOTE_BACKEND_ESTABLISHED/);
    assert.match(options, /not switched until verified migration succeeds/i);
    assert.doesNotMatch(options, /\bgoogle\b|\bspreadsheet\b|\boauth\b/i);
    assert.doesNotMatch(optionsCode, /\bgoogle\b|\bspreadsheet\b|\boauth\b/i);
    assert.deepEqual(manifest.host_permissions, []);
    assert.ok(manifest.optional_host_permissions.includes("https://time-api.cordoceo.com/*"));
    assert.ok(manifest.optional_host_permissions.includes("https://*/*"));
    assert.ok(manifest.optional_host_permissions.includes("https://*.workers.dev/*"));
    assert.equal(mysql.mysqlHostPermission("https://self-hosted.example/api"), "https://self-hosted.example/*");
    assert.doesNotMatch(optionsCode, /CLOUDFLARE_D1_API_TOKEN[^\n]*BACKUP/);
  });
});

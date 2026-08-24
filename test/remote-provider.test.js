import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { entryToRow, normalizeEntry, SHEET_HEADERS } from "../extension/src/entries.js";
import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { createGoogleApiMock } from "./support/mock-google-api.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;
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

const db = await import("../extension/src/db.js");
const providers = await import("../extension/src/remote-provider.js");
const googleProvider = await import("../extension/src/remote-google-sheets.js");
const mysql = await import("../extension/src/remote-mysql.js");

const fixture = (over = {}) => normalizeEntry({
  id: "provider-entry",
  project: "Project",
  task: "Task",
  description: "",
  start_at: "2026-08-08T09:00:00.000Z",
  end_at: "2026-08-08T10:00:00.000Z",
  duration_seconds: 3600,
  status: "ok",
  created_at: "2026-08-08T09:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
  deleted_at: "",
  device_id: "device",
  revision: 1,
  multiply: "",
  ...over
});

describe("remote provider selection", () => {
  it("defaults missing and blank settings to Google Sheets", async () => {
    await db.setSetting("remote_backend", "");
    assert.equal(providers.decodeRemoteProviderId(undefined), "google-sheets");
    assert.equal((await providers.getActiveRemoteProvider()).id, "google-sheets");
  });

  it("rejects unknown backend IDs instead of falling back", () => {
    assert.throws(
      () => providers.getRemoteProvider("not-a-provider"),
      (error) => error.code === "REMOTE_BACKEND_UNSUPPORTED"
    );
  });

  it("registers the stable MySQL provider ID", () => {
    assert.equal(providers.REMOTE_PROVIDER_ID.MYSQL, "mysql");
    assert.deepEqual(providers.registeredRemoteProviderIds(), ["google-sheets", "mysql"]);
    assert.equal(providers.getRemoteProvider(providers.REMOTE_PROVIDER_ID.MYSQL).id, "mysql");
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
});

describe("Google provider adapter", () => {
  it("maps Google rows and config rows to opaque provider references", async () => {
    const google = createGoogleApiMock().install();
    try {
      await db.setSetting("token_data", { access_token: "test-access-token", expires_at: Date.now() + 60_000 });
      await db.setSetting("spreadsheet_id", { state: "ready", spreadsheetId: "sheet-1" });
      const entry = fixture();
      google.enqueue(
        { method: "GET", pathname: "/v4/spreadsheets/sheet-1/values:batchGet" },
        google.json({
          valueRanges: [
            { range: "time_entries!A:N", values: [SHEET_HEADERS, entryToRow(entry)] },
            { range: "config!A:C", values: [["key", "value", "updated_at"], ["duration_multiplier", "1.5", entry.updated_at]] }
          ]
        })
      );

      const snapshot = await googleProvider.googleSheetsProvider.readSnapshot();
      const entryRef = snapshot.entryRefs.get(entry.id);
      const configRef = snapshot.configRefs.get("duration_multiplier");

      assert.deepEqual(entryRef, {
        kind: "google-sheet-row",
        rowIndex: 2,
        fingerprint: entryToRow(entry).join("\u0000")
      });
      assert.deepEqual(configRef, {
        kind: "google-config-row",
        rowIndex: 2,
        fingerprint: ["duration_multiplier", "1.5", entry.updated_at].join("\u0000")
      });
      assert.equal(snapshot.rowMap, undefined);
      assert.equal(snapshot.configRows, undefined);
      assert.equal(snapshot.duplicates.length, 0);
    } finally {
      google.restore();
    }
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
    assert.match(optionsCode, /REMOTE_BACKEND_TARGET|remoteBackendTarget/);
    assert.match(options, /not switched until the verified migration/i);
    assert.ok(manifest.optional_host_permissions.includes("https://time-api.cordoceo.com/*"));
  });
});

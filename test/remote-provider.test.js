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

  it("keeps the stable MySQL ID reserved without pretending it is available", () => {
    assert.equal(providers.REMOTE_PROVIDER_ID.MYSQL, "mysql");
    assert.deepEqual(providers.registeredRemoteProviderIds(), ["google-sheets"]);
    assert.throws(
      () => providers.getRemoteProvider(providers.REMOTE_PROVIDER_ID.MYSQL),
      (error) => error.code === "REMOTE_BACKEND_UNSUPPORTED"
    );
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
});

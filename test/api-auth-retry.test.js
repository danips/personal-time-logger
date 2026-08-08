import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { SHEET_HEADERS } from "../src/entries.js";
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
let sheets;
let google;

before(async () => {
  db = await import("../src/db.js");
  sheets = await import("../src/sheets.js");
  google = createGoogleApiMock().install();
  await sheets.setSpreadsheetId("sheet-1");
});

after(() => google.restore());

describe("Google API authentication retry", () => {
  it("refreshes once and retries an idempotent Sheets read after a 401", async () => {
    await db.setSetting("token_data", {
      access_token: "stale-access-token",
      refresh_token: "refresh-token",
      expires_at: Date.now() + 60_000
    });
    const snapshotPath = "/v4/spreadsheets/sheet-1/values:batchGet";
    google.enqueue({ method: "GET", pathname: snapshotPath }, google.status(401));
    google.enqueue({ method: "POST", pathname: "/token" }, google.json({
      access_token: "fresh-access-token",
      expires_in: 3600
    }));
    google.enqueue({ method: "GET", pathname: snapshotPath }, google.json({
      valueRanges: [
        { range: "time_entries!A:N", values: [SHEET_HEADERS] },
        { range: "config!A:C", values: [["key", "value", "updated_at"]] }
      ]
    }));

    const snapshot = await sheets.readRemoteSnapshot();
    assert.deepEqual(snapshot.entries, []);
    const reads = google.calls.filter((call) => call.pathname === snapshotPath);
    assert.equal(reads.length, 2);
    assert.equal(reads[0].headers.get("authorization"), "Bearer stale-access-token");
    assert.equal(reads[1].headers.get("authorization"), "Bearer fresh-access-token");
    assert.equal(google.calls.filter((call) => call.pathname === "/token").length, 1);
  });
});

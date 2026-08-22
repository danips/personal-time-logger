import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { SHEET_HEADERS } from "../extension/src/entries.js";
import { seedEntry } from "./support/db-fixtures.js";
import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { createGoogleApiMock } from "./support/mock-google-api.js";

installFakeIndexedDB();
globalThis.browser = {
  runtime: { getURL: (path) => path },
  storage: {
    sync: {
      async get() { return { google_oauth_client_id: "test-client", google_oauth_client_secret: "test-secret" }; },
      async set() {}
    }
  }
};

let db;
let sheets;
let google;

before(async () => {
  db = await import("../extension/src/db.js");
  sheets = await import("../extension/src/sheets.js");
  google = createGoogleApiMock().install();
  await db.setSetting("token_data", { access_token: "test-token", expires_at: Date.now() + 60_000 });
  await sheets.setSpreadsheetId("sheet-1");
});

after(() => google.restore());

describe("deterministic runtime barriers", () => {
  it("holds a Sheets response body without completing the snapshot", async () => {
    const body = google.bodyBarrier("snapshot body");
    google.enqueue({ method: "GET", pathname: "/v4/spreadsheets/sheet-1/values:batchGet" }, body);

    let settled = false;
    const snapshot = sheets.readRemoteSnapshot().finally(() => { settled = true; });
    await body.waitForRequest();
    await Promise.resolve();
    assert.equal(settled, false);
    body.release(google.json({
      valueRanges: [
        { range: "time_entries!A:N", values: [SHEET_HEADERS] },
        { range: "config!A:C", values: [["key", "value", "updated_at"]] }
      ]
    }));

    assert.deepEqual((await snapshot).entries, []);
  });

  it("holds an IndexedDB commit until a test releases it", async () => {
    const gate = indexedDB._pauseNextCommit();
    const write = seedEntry(db, { id: "commit-barrier", revision: 1 });
    await gate.waitForCommit();

    let writeComplete = false;
    void write.then(() => { writeComplete = true; });
    await Promise.resolve();
    assert.equal(writeComplete, false);
    gate.release();
    await write;
    assert.deepEqual(await db.getEntry("commit-barrier"), { id: "commit-barrier", revision: 1 });
  });
});

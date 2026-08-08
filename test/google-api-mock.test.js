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
  await db.setSetting("token_data", {
    access_token: "test-access-token",
    expires_at: Date.now() + 60_000
  });
  await sheets.setSpreadsheetId("sheet-1");
});

after(() => google.restore());

describe("mock Google API", () => {
  it("pauses and releases a real Sheets snapshot request", async () => {
    const read = google.barrier("snapshot");
    google.enqueue({ method: "GET", pathname: "/v4/spreadsheets/sheet-1/values:batchGet" }, read);

    const snapshotPromise = sheets.readRemoteSnapshot();
    const request = await read.waitForRequest();
    assert.equal(request.headers.get("authorization"), "Bearer test-access-token");

    read.release(google.json({
      valueRanges: [
        { range: "time_entries!A:N", values: [SHEET_HEADERS] },
        { range: "config!A:C", values: [["key", "value", "updated_at"]] }
      ]
    }));

    const snapshot = await snapshotPromise;
    assert.deepEqual(snapshot.entries, []);
    assert.deepEqual(snapshot.config, {});
  });

  it("releases concurrent requests in a chosen order", async () => {
    const first = google.barrier("first");
    const second = google.barrier("second");
    google.enqueue("/first", first);
    google.enqueue("/second", second);

    const firstRequest = fetch("https://www.googleapis.com/first").then((response) => response.json());
    const secondRequest = fetch("https://www.googleapis.com/second").then((response) => response.json());
    await Promise.all([first.waitForRequest(), second.waitForRequest()]);

    second.release(google.json({ order: 2 }));
    assert.deepEqual(await secondRequest, { order: 2 });
    first.release(google.json({ order: 1 }));
    assert.deepEqual(await firstRequest, { order: 1 });
  });

  it("provides status, malformed-payload, and timeout responses", async () => {
    for (const status of [401, 403, 404, 429, 500]) {
      google.enqueue(`/status-${status}`, google.status(status));
      const result = await fetch(`https://www.googleapis.com/status-${status}`);
      assert.equal(result.status, status);
      assert.equal(result.ok, false);
    }

    google.enqueue("/malformed", google.malformed("not JSON"));
    const malformed = await fetch("https://www.googleapis.com/malformed");
    await assert.rejects(() => malformed.json(), SyntaxError);

    const timeout = google.timeout("slow read");
    google.enqueue("/slow", timeout);
    const slow = fetch("https://www.googleapis.com/slow");
    await timeout.waitForRequest();
    timeout.expire();
    await assert.rejects(slow, /timed out/);
  });

  it("models physical row shifts from inserts and highest-first deletes", () => {
    google.setRows("time_entries", [["header"], ["a"], ["b"], ["c"]]);
    google.insertRows("time_entries", 3, [["inserted"]]);
    google.deleteRows("time_entries", [4, 2]);

    assert.deepEqual(google.rows("time_entries"), [["header"], ["inserted"], ["c"]]);
  });
});

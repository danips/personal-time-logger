import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

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

const snapshotPath = { method: "GET", pathname: "/v4/spreadsheets/sheet-1/values:batchGet" };

let db;
let google;
let sheets;
let syncNow;

before(async () => {
  db = await import("../src/db.js");
  sheets = await import("../src/sheets.js");
  ({ syncNow } = await import("../src/sync.js"));
  google = createGoogleApiMock().install();
  await db.setSetting("token_data", { access_token: "test-access-token", expires_at: Date.now() + 60_000 });
  await sheets.setSpreadsheetId("sheet-1");
});

after(() => google.restore());

describe("same-context sync coalescing", () => {
  it("keeps a queued stronger cycle registered while it runs", async () => {
    const firstGate = google.barrier("first forced snapshot");
    const secondGate = google.barrier("queued forced snapshot");
    google.enqueue(snapshotPath, firstGate);
    google.enqueue(snapshotPath, secondGate);

    const first = syncNow({ force: true });
    await firstGate.waitForRequest();
    const second = syncNow({ force: true, interactiveAuth: true });
    firstGate.release(google.status(500));
    await secondGate.waitForRequest();

    const third = syncNow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The first failed snapshot probes Drive once while deciding whether the
    // spreadsheet disappeared. A third same-context cycle would add another
    // request while the queued second snapshot is still held.
    assert.equal(google.calls.length, 3);

    secondGate.release(google.status(500));

    await assert.rejects(first, (error) => error.code === "API_ERROR");
    await assert.rejects(second, (error) => error.code === "API_ERROR");
    await assert.rejects(third, (error) => error.code === "API_ERROR");
    assert.equal(await db.getSetting("sync_lock", null), null);
  });
});

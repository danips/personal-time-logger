import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { normalizeEntry, SHEET_HEADERS } from "../src/entries.js";
import { seedEntry } from "./support/db-fixtures.js";
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

let db;
let google;
let sheets;
let syncNow;

const entry = normalizeEntry({
  id: "lease-fence-entry",
  project: "Project",
  task: "Task",
  start_at: "2026-08-08T09:00:00.000Z",
  end_at: "2026-08-08T10:00:00.000Z",
  duration_seconds: 3600,
  created_at: "2026-08-08T09:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
  revision: 1,
  dirty: true
});

const snapshotPath = { method: "GET", pathname: "/v4/spreadsheets/sheet-1/values:batchGet" };
const appendPath = (request) => request.method === "POST"
  && request.pathname.endsWith("/values/time_entries!A%3AN:append");

before(async () => {
  db = await import("../src/db.js");
  sheets = await import("../src/sheets.js");
  ({ syncNow } = await import("../src/sync.js"));
  google = createGoogleApiMock().install();
  await db.setSetting("token_data", { access_token: "test-access-token", expires_at: Date.now() + 60_000 });
  await sheets.setSpreadsheetId("sheet-1");
});

after(() => google.restore());

describe("sync lease fencing", () => {
  it("does not acknowledge an append or release a newer lease after losing ownership", async () => {
    await seedEntry(db, entry);
    google.enqueue(snapshotPath, google.json({
      valueRanges: [
        { range: "time_entries!A:N", values: [SHEET_HEADERS] },
        { range: "config!A:C", values: [["key", "value", "updated_at"]] }
      ]
    }));
    const append = google.barrier("append");
    google.enqueue(appendPath, append);

    const sync = syncNow({ force: true });
    await append.waitForRequest();
    const replacementLock = {
      state: "held",
      holder: "new-owner",
      generation: 999,
      token: "replacement-token",
      expires_at: Date.now() + 120_000,
      ttl_ms: 120_000
    };
    await db.setSetting("sync_lock", replacementLock);
    append.release(google.json({ updates: { updatedRange: "time_entries!A2:N2" } }));

    await assert.rejects(sync, (error) => error.code === "SYNC_BUSY");
    assert.equal((await db.getEntry(entry.id)).dirty, true);
    assert.deepEqual(await db.getSetting("sync_lock"), replacementLock);
  });
});

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { entryToRow, normalizeEntry, SHEET_HEADERS } from "../extension/src/entries.js";
import { seedEntry, seedEntries } from "./support/db-fixtures.js";
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
let pushDirtyEntries;
let sheets;

const fixture = (over = {}) => normalizeEntry({
  id: "append-entry",
  project: "Project",
  task: "Task",
  start_at: "2026-08-08T09:00:00.000Z",
  end_at: "2026-08-08T10:00:00.000Z",
  duration_seconds: 3600,
  created_at: "2026-08-08T09:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
  device_id: "device",
  revision: 1,
  dirty: true,
  ...over
});

const appendPath = (request) => request.method === "POST"
  && request.pathname.endsWith("/values/time_entries!A%3AN:append");
const snapshotPath = { method: "GET", pathname: "/v4/spreadsheets/sheet-1/values:batchGet" };

function enqueueSnapshot(entries) {
  google.enqueue(snapshotPath, google.json({
    valueRanges: [
      { range: "time_entries!A:N", values: [SHEET_HEADERS, ...entries.map(entryToRow)] },
      { range: "config!A:C", values: [["key", "value", "updated_at"]] }
    ]
  }));
}

function localState(entries) {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

before(async () => {
  db = await import("../extension/src/db.js");
  ({ pushDirtyEntries } = await import("../extension/src/sync.js"));
  sheets = await import("../extension/src/sheets.js");
  google = createGoogleApiMock().install();
  await db.setSetting("token_data", { access_token: "test-access-token", expires_at: Date.now() + 60_000 });
  await sheets.setSpreadsheetId("sheet-1");
});

after(() => google.restore());

beforeEach(() => {
  google.calls.length = 0;
});

describe("append idempotency", () => {
  it("keeps an append dirty until read-back confirms a response without a range", async () => {
    const entry = fixture({ id: "append-missing-range" });
    await seedEntry(db, entry);
    google.enqueue(appendPath, google.json({ updates: {} }));
    const readBack = google.barrier("append read-back");
    google.enqueue(snapshotPath, readBack);

    const pushedPromise = pushDirtyEntries(localState([entry]), [], new Map(), { interactiveAuth: false });
    await readBack.waitForRequest();
    assert.equal((await db.getEntry(entry.id)).dirty, true);
    readBack.release(google.json({
      valueRanges: [
        { range: "time_entries!A:N", values: [SHEET_HEADERS, entryToRow(entry)] },
        { range: "config!A:C", values: [["key", "value", "updated_at"]] }
      ]
    }));
    const pushed = await pushedPromise;

    assert.equal(pushed.has(entry.id), true);
    assert.equal((await db.getEntry(entry.id)).dirty, false);
  });

  it("does not append again after a committed append loses its response", async () => {
    const entry = fixture({ id: "append-timeout" });
    const local = localState([entry]);
    await seedEntry(db, entry);
    google.enqueue(appendPath, async () => {
      enqueueSnapshot([entry]);
      throw new Error("connection lost after the server committed the append");
    });

    await assert.rejects(
      () => pushDirtyEntries(local, [], new Map(), { interactiveAuth: false }),
      /connection lost/
    );
    assert.equal((await db.getEntry(entry.id)).dirty, false);

    await pushDirtyEntries(local, [], new Map(), { interactiveAuth: false });
    assert.equal(google.calls.filter(appendPath).length, 1);
  });

  it("acknowledges only the confirmed prefix of a partial append response", async () => {
    const first = fixture({ id: "append-prefix-first" });
    const second = fixture({ id: "append-prefix-second" });
    await seedEntries(db, [first, second]);
    google.enqueue(appendPath, google.json({ updates: { updatedRange: "time_entries!A2:N2" } }));
    enqueueSnapshot([first]);

    const pushed = await pushDirtyEntries(localState([first, second]), [], new Map(), { interactiveAuth: false });

    assert.equal(pushed.has(first.id), true);
    assert.equal(pushed.has(second.id), false);
    assert.equal((await db.getEntry(first.id)).dirty, false);
    assert.equal((await db.getEntry(second.id)).dirty, true);
  });

  it("treats a same-id row with different contents as an append conflict", async () => {
    const entry = fixture({ id: "append-conflict" });
    const remote = fixture({ id: entry.id, task: "Manual spreadsheet edit", dirty: false });
    await seedEntry(db, entry);
    google.enqueue(appendPath, google.json({ updates: {} }));
    enqueueSnapshot([remote]);

    await assert.rejects(
      () => pushDirtyEntries(localState([entry]), [], new Map(), { interactiveAuth: false }),
      (error) => error.code === "REMOTE_APPEND_CONFLICT"
    );
    assert.equal((await db.getEntry(entry.id)).dirty, true);
  });
});

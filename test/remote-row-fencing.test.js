import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { entryToRow, normalizeEntry, SHEET_HEADERS } from "../src/entries.js";
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
let google;
let sheets;

const fixture = (over = {}) => normalizeEntry({
  id: "entry-1",
  project: "Project",
  task: "Task",
  start_at: "2026-07-27T09:00:00.000Z",
  end_at: "2026-07-27T10:00:00.000Z",
  duration_seconds: 3600,
  created_at: "2026-07-27T09:00:00.000Z",
  updated_at: "2026-07-27T10:00:00.000Z",
  revision: 1,
  ...over
});

const entryRowsPath = (request) => request.method === "GET"
  && request.pathname.endsWith("/values/time_entries!A%3AN");

before(async () => {
  db = await import("../src/db.js");
  sheets = await import("../src/sheets.js");
  google = createGoogleApiMock().install();
  await db.setSetting("token_data", { access_token: "test-access-token", expires_at: Date.now() + 60_000 });
  await sheets.setSpreadsheetId("sheet-1");
});

after(() => google.restore());

describe("remote row fencing", () => {
  it("rejects bare row numbers before making a destructive request", async () => {
    await assert.rejects(() => sheets.deleteRemoteRows([8]), { code: "REMOTE_ROW_PRECONDITION_REQUIRED" });
    assert.equal(google.calls.filter((call) => call.method === "POST").length, 0);
  });

  it("checks every duplicate row before deleting any of them", async () => {
    const first = fixture({ id: "duplicate-1" });
    const second = fixture({ id: "duplicate-2", task: "original" });
    const changedSecond = fixture({ id: "duplicate-2", task: "edited outside the extension" });
    google.enqueue(entryRowsPath, google.json({ values: [SHEET_HEADERS, entryToRow(first), entryToRow(changedSecond)] }));

    await assert.rejects(() => sheets.deleteRemoteRows([
      { id: first.id, rowIndex: 2, expectedFingerprint: sheets.rowFingerprint(entryToRow(first)) },
      { id: second.id, rowIndex: 3, expectedFingerprint: sheets.rowFingerprint(entryToRow(second)) }
    ]), { code: "REMOTE_ROW_STALE" });

    assert.equal(google.calls.some((call) => call.pathname.endsWith(":batchUpdate")), false);
  });

  it("rejects a same-id row whose other fields changed before an update", async () => {
    const original = fixture();
    const changed = fixture({ task: "edited outside the extension" });
    google.enqueue(entryRowsPath, google.json({ values: [SHEET_HEADERS, entryToRow(changed)] }));

    await assert.rejects(() => sheets.updateRemoteEntries([{
      rowIndex: 2,
      entry: fixture({ task: "local change", revision: 2 }),
      expectedFingerprint: sheets.rowFingerprint(entryToRow(original))
    }]), { code: "REMOTE_ROW_STALE" });

    assert.equal(google.calls.some((call) => call.pathname.endsWith("values:batchUpdate")), false);
  });

  it("detects a row that changes after preflight verification", async () => {
    const original = fixture();
    const replacement = fixture({ task: "local change", revision: 2 });
    google.enqueue(entryRowsPath, google.json({ values: [SHEET_HEADERS, entryToRow(original)] }));
    google.enqueue({ method: "POST", pathname: "/v4/spreadsheets/sheet-1/values:batchUpdate" }, google.json({}));
    google.enqueue(entryRowsPath, google.json({ values: [SHEET_HEADERS, entryToRow(original)] }));

    await assert.rejects(() => sheets.updateRemoteEntries([{
      rowIndex: 2,
      entry: replacement,
      expectedFingerprint: sheets.rowFingerprint(entryToRow(original))
    }]), { code: "REMOTE_ROW_STALE" });
  });
});

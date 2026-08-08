import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { entryToRow, normalizeEntry, SHEET_HEADERS } from "../src/entries.js";
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
let reconcile;
let sheets;

const fixture = (over = {}) => normalizeEntry({
  id: "reconciliation-entry",
  project: "Project",
  task: "Task",
  start_at: "2026-08-08T09:00:00.000Z",
  end_at: "2026-08-08T10:00:00.000Z",
  duration_seconds: 3600,
  created_at: "2026-08-08T09:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
  revision: 1,
  ...over
});

const snapshotPath = { method: "GET", pathname: "/v4/spreadsheets/sheet-1/values:batchGet" };

function enqueueSnapshot(entries) {
  google.enqueue(snapshotPath, google.json({
    valueRanges: [
      { range: "time_entries!A:N", values: [SHEET_HEADERS, ...entries.map(entryToRow)] },
      { range: "config!A:C", values: [["key", "value", "updated_at"]] }
    ]
  }));
}

before(async () => {
  db = await import("../src/db.js");
  reconcile = await import("../src/reconcile.js");
  sheets = await import("../src/sheets.js");
  google = createGoogleApiMock().install();
  await db.setSetting("token_data", { access_token: "test-access-token", expires_at: Date.now() + 60_000 });
  await sheets.setSpreadsheetId("sheet-1");
});

after(() => google.restore());

describe("reconciliation actions", () => {
  it("does not overwrite a local edit made after the reconciliation scan", async () => {
    const remote = fixture({ id: "stale-local", task: "Spreadsheet task" });
    const editedLocal = fixture({ id: remote.id, task: "New local task", revision: 2 });
    await db.putEntry(editedLocal);
    enqueueSnapshot([remote]);

    await assert.rejects(
      () => reconcile.keepRemote(remote, { expectedLocalRevision: 1 }),
      (error) => error.code === "STORAGE_CONFLICT" && error.reason === "revision_mismatch"
    );

    assert.deepEqual(await db.getEntry(remote.id), editedLocal);
  });

  it("does not overwrite local data after the spreadsheet row was edited", async () => {
    const remote = fixture({ id: "stale-remote", task: "Scanned spreadsheet task" });
    const local = fixture({ id: remote.id, task: "Local task" });
    const changedRemote = fixture({ id: remote.id, task: "Edited spreadsheet task", updated_at: "2026-08-08T11:00:00.000Z" });
    await db.putEntry(local);
    enqueueSnapshot([changedRemote]);

    await assert.rejects(
      () => reconcile.keepRemote(remote, { expectedLocalRevision: local.revision }),
      (error) => error.code === "STORAGE_CONFLICT" && error.reason === "remote_fingerprint_mismatch"
    );

    assert.deepEqual(await db.getEntry(remote.id), local);
  });

  it("does not tombstone a local record that appeared after a remote-only scan", async () => {
    const remote = fixture({ id: "new-local-after-scan" });
    const local = fixture({ id: remote.id, task: "New local record", revision: 3 });
    await db.putEntry(local);
    enqueueSnapshot([remote]);

    await assert.rejects(
      () => reconcile.deleteEverywhere(remote.id, remote),
      (error) => error.code === "STORAGE_CONFLICT" && error.reason === "revision_mismatch"
    );

    assert.deepEqual(await db.getEntry(remote.id), local);
  });
});

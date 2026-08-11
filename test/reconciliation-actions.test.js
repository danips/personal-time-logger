import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { entryToRow, normalizeEntry, SHEET_HEADERS } from "../src/entries.js";
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
    await seedEntry(db, editedLocal);
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
    await seedEntry(db, local);
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
    await seedEntry(db, local);
    enqueueSnapshot([remote]);

    await assert.rejects(
      () => reconcile.deleteEverywhere(remote.id, remote),
      (error) => error.code === "STORAGE_CONFLICT" && error.reason === "revision_mismatch"
    );

    assert.deepEqual(await db.getEntry(remote.id), local);
  });

  it("prevalidates every remote row before changing any selected local entry", async () => {
    const firstLocal = fixture({ id: "batch-first", task: "First local", dirty: false });
    const secondLocal = fixture({ id: "batch-second", task: "Second local", dirty: false });
    const firstRemote = fixture({ id: firstLocal.id, task: "First spreadsheet" });
    const scannedSecondRemote = fixture({ id: secondLocal.id, task: "Second spreadsheet" });
    const changedSecondRemote = fixture({
      id: secondLocal.id,
      task: "Second spreadsheet changed",
      updated_at: "2026-08-08T11:00:00.000Z"
    });
    await seedEntries(db, [firstLocal, secondLocal]);
    enqueueSnapshot([firstRemote, changedSecondRemote]);

    await assert.rejects(
      () => reconcile.resolveReconciliationBatch([
        { action: "keepLocal", id: firstLocal.id, remoteEntry: firstRemote, expectedRevision: firstLocal.revision },
        { action: "keepLocal", id: secondLocal.id, remoteEntry: scannedSecondRemote, expectedRevision: secondLocal.revision }
      ]),
      (error) => error.code === "STORAGE_CONFLICT" && error.reason === "remote_fingerprint_mismatch"
    );
    assert.equal((await db.getEntry(firstLocal.id)).dirty, false);
    assert.equal((await db.getEntry(secondLocal.id)).dirty, false);
  });

  it("applies compatible bulk choices in one snapshot and returns each result", async () => {
    const firstLocal = fixture({ id: "batch-apply-first", task: "First local", dirty: false });
    const secondLocal = fixture({ id: "batch-apply-second", task: "Second local", dirty: false });
    const firstRemote = fixture({ id: firstLocal.id, task: "First spreadsheet" });
    const secondRemote = fixture({ id: secondLocal.id, task: "Second spreadsheet" });
    await seedEntries(db, [firstLocal, secondLocal]);
    google.calls.length = 0;
    enqueueSnapshot([firstRemote, secondRemote]);

    const outcome = await reconcile.resolveReconciliationBatch([
      { action: "keepLocal", id: firstLocal.id, remoteEntry: firstRemote, expectedRevision: firstLocal.revision },
      { action: "keepLocal", id: secondLocal.id, remoteEntry: secondRemote, expectedRevision: secondLocal.revision }
    ]);

    assert.deepEqual(outcome.results.map(({ id, action, status }) => ({ id, action, status })), [
      { id: firstLocal.id, action: "keepLocal", status: "applied" },
      { id: secondLocal.id, action: "keepLocal", status: "applied" }
    ]);
    assert.equal((await db.getEntry(firstLocal.id)).dirty, true);
    assert.equal((await db.getEntry(secondLocal.id)).dirty, true);
    assert.equal(google.calls.filter((call) => call.pathname === snapshotPath.pathname).length, 1);
  });

  it("updates only the selected local entry", async () => {
    const selected = fixture({ id: "scoped-reconcile-selected", dirty: false });
    const unrelated = fixture({ id: "scoped-reconcile-unrelated", task: "Leave untouched", revision: 6 });
    await seedEntries(db, [selected, unrelated]);
    indexedDB._resetWriteLog();

    await reconcile.keepLocal(selected.id, null, { expectedRevision: selected.revision });

    const entryWrites = indexedDB._getWriteLog().filter((operation) => operation.store === "time_entries");
    assert.deepEqual(entryWrites, [{ store: "time_entries", operation: "put", key: selected.id }]);
    assert.deepEqual(await db.getEntry(unrelated.id), unrelated);
  });
});

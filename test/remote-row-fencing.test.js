import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { entryToRow, normalizeEntry, SHEET_HEADERS } from "../extension/src/entries.js";
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
  device_id: "device",
  revision: 1,
  ...over
});

const entryRowsPath = (request) => request.method === "GET"
  && request.pathname.endsWith("/values/time_entries!A%3AN");
const driveModifiedPath = { method: "GET", pathname: "/drive/v3/files/sheet-1" };

function enqueueStableDriveGate() {
  google.enqueue(driveModifiedPath, google.json({ modifiedTime: "2026-07-27T10:30:00.000Z" }));
  google.enqueue(driveModifiedPath, google.json({ modifiedTime: "2026-07-27T10:30:00.000Z" }));
}

before(async () => {
  db = await import("../extension/src/db.js");
  sheets = await import("../extension/src/sheets.js");
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
    google.enqueue(driveModifiedPath, google.json({ modifiedTime: "2026-07-27T10:30:00.000Z" }));
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
    google.enqueue(driveModifiedPath, google.json({ modifiedTime: "2026-07-27T10:30:00.000Z" }));
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
    enqueueStableDriveGate();
    google.enqueue(entryRowsPath, google.json({ values: [SHEET_HEADERS, entryToRow(original)] }));
    google.enqueue({ method: "POST", pathname: "/v4/spreadsheets/sheet-1/values:batchUpdate" }, google.json({}));
    google.enqueue(entryRowsPath, google.json({ values: [SHEET_HEADERS, entryToRow(original)] }));

    await assert.rejects(() => sheets.updateRemoteEntries([{
      rowIndex: 2,
      entry: replacement,
      expectedFingerprint: sheets.rowFingerprint(entryToRow(original))
    }]), { code: "REMOTE_ROW_STALE" });
  });

  it("stops when Drive reports a row shift between preflight and mutation", async () => {
    const original = fixture();
    google.calls.length = 0;
    google.enqueue(driveModifiedPath, google.json({ modifiedTime: "2026-07-27T10:30:00.000Z" }));
    google.enqueue(entryRowsPath, google.json({ values: [SHEET_HEADERS, entryToRow(original)] }));
    google.enqueue(driveModifiedPath, google.json({ modifiedTime: "2026-07-27T10:31:00.000Z" }));

    await assert.rejects(() => sheets.updateRemoteEntries([{
      rowIndex: 2,
      entry: fixture({ task: "local change", revision: 2 }),
      expectedFingerprint: sheets.rowFingerprint(entryToRow(original))
    }]), { code: "REMOTE_ROW_STALE" });

    assert.equal(google.calls.some((call) => call.method === "POST"
      && call.pathname.endsWith("/values:batchUpdate")), false);
  });

  it("uses bounded contiguous reads for a large row-verification batch", async () => {
    const originals = Array.from({ length: 300 }, (_, index) => fixture({
      id: `large-batch-${index + 1}`,
      task: `Original ${index + 1}`
    }));
    const updates = originals.map((original, index) => ({
      rowIndex: index + 2,
      entry: fixture({
        id: original.id,
        task: `Updated ${index + 1}`,
        revision: 2,
        updated_at: "2026-07-27T11:00:00.000Z"
      }),
      expectedFingerprint: sheets.rowFingerprint(entryToRow(original))
    }));
    google.calls.length = 0;
    enqueueStableDriveGate();
    google.enqueue(entryRowsPath, google.json({ values: [SHEET_HEADERS, ...originals.map(entryToRow)] }));
    google.enqueue({ method: "POST", pathname: "/v4/spreadsheets/sheet-1/values:batchUpdate" }, google.json({}));
    google.enqueue(entryRowsPath, google.json({ values: [
      SHEET_HEADERS,
      ...updates.map(({ entry }) => entryToRow(entry))
    ] }));

    await sheets.updateRemoteEntries(updates);

    const verificationReads = google.calls.filter((call) => call.method === "GET"
      && call.pathname.endsWith("/values/time_entries!A%3AN"));
    assert.equal(verificationReads.length, 2);
    assert.equal(verificationReads.every((call) => !call.search.includes("ranges=")), true);
    const mutation = google.calls.find((call) => call.method === "POST"
      && call.pathname.endsWith("/values:batchUpdate"));
    assert.equal(JSON.parse(mutation.body).data.length, 300);
  });
});

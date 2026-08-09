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

function enqueueNoCandidates() {
  google.enqueue({ method: "GET", pathname: "/drive/v3/files" }, google.json({ files: [] }));
}

before(async () => {
  db = await import("../src/db.js");
  sheets = await import("../src/sheets.js");
  google = createGoogleApiMock().install();
  await db.setSetting("token_data", {
    access_token: "test-access-token",
    expires_at: Date.now() + 60_000
  });
});

after(() => google.restore());

describe("spreadsheet provisioning", () => {
  it("resumes initialization of a created spreadsheet instead of creating another", async () => {
    await sheets.setSpreadsheetId("");
    await db.setSetting("spreadsheet_provision_pending", "");
    enqueueNoCandidates();
    google.enqueue({ method: "POST", pathname: "/v4/spreadsheets" }, google.json({ spreadsheetId: "created-sheet" }));
    google.enqueue({ method: "POST", pathname: "/v4/spreadsheets/created-sheet/values:batchUpdate" }, google.status(500));

    await assert.rejects(() => sheets.provisionSpreadsheet(), (error) => error.code === "API_ERROR");
    assert.equal(await sheets.getSpreadsheetId(), "created-sheet");
    assert.equal(await db.getSetting("spreadsheet_provision_pending"), "created-sheet");

    google.enqueue({ method: "GET", pathname: "/v4/spreadsheets/created-sheet" }, google.json({
      sheets: [
        { properties: { title: "time_entries", sheetId: 1 } },
        { properties: { title: "config", sheetId: 2 } }
      ]
    }));
    google.enqueue({ method: "GET", pathname: "/v4/spreadsheets/created-sheet/values/time_entries!A%3AZ" }, google.json({
      values: [SHEET_HEADERS]
    }));
    google.enqueue({ method: "GET", pathname: "/v4/spreadsheets/created-sheet/values/config!A%3AZ" }, google.json({
      values: [["key", "value", "updated_at"]]
    }));

    const recovered = await sheets.provisionSpreadsheet();
    assert.deepEqual(recovered, {
      spreadsheetId: "created-sheet",
      name: "Personal Time Logger",
      adopted: false,
      recovered: true
    });
    assert.equal(await db.getSetting("spreadsheet_provision_pending"), "");
    assert.equal(google.calls.filter((call) => call.method === "POST" && call.pathname === "/v4/spreadsheets").length, 1);
  });

  it("does not create a replacement when candidate validation fails", async () => {
    await sheets.setSpreadsheetId("");
    google.calls.length = 0;
    google.enqueue({ method: "GET", pathname: "/drive/v3/files" }, google.json({
      files: [{ id: "candidate-sheet", name: "Existing sheet" }]
    }));
    google.enqueue(
      { method: "GET", pathname: "/v4/spreadsheets/candidate-sheet/values/time_entries!A1%3AN1" },
      google.status(403, { error: { message: "The caller does not have permission" } })
    );

    await assert.rejects(() => sheets.provisionSpreadsheet(), (error) => error.code === "API_ERROR");
    assert.equal(google.calls.some((call) => call.method === "POST" && call.pathname === "/v4/spreadsheets"), false);
  });

  it("does not rewrite headers when the header safety read fails", async () => {
    await sheets.setSpreadsheetId("header-sheet");
    google.calls.length = 0;
    google.enqueue({ method: "GET", pathname: "/v4/spreadsheets/header-sheet/values:batchGet" }, google.json({
      valueRanges: [
        { range: "time_entries!A:N", values: [["not", "the", "header"]] },
        { range: "config!A:C", values: [["key", "value", "updated_at"]] }
      ]
    }));
    google.enqueue({ method: "GET", pathname: "/v4/spreadsheets/header-sheet" }, google.json({
      sheets: [
        { properties: { title: "time_entries", sheetId: 1 } },
        { properties: { title: "config", sheetId: 2 } }
      ]
    }));
    google.enqueue(
      { method: "GET", pathname: "/v4/spreadsheets/header-sheet/values/time_entries!A%3AZ" },
      google.status(403, { error: { message: "The caller does not have permission" } })
    );

    await assert.rejects(() => sheets.readRemoteSnapshot(), (error) => error.code === "API_ERROR");
    assert.equal(
      google.calls.some((call) => call.method === "POST" && call.pathname === "/v4/spreadsheets/header-sheet/values:batchUpdate"),
      false
    );
  });

  it("does not treat an inaccessible Drive file as deleted", async () => {
    await sheets.setSpreadsheetId("inaccessible-sheet");
    google.calls.length = 0;
    google.enqueue(
      { method: "GET", pathname: "/drive/v3/files/inaccessible-sheet" },
      google.status(404, { error: { message: "File not found" } })
    );

    assert.equal(await sheets.isSpreadsheetGone(), false);
  });

  it("only adopts a selected spreadsheet after validating its time_entries header", async () => {
    await sheets.setSpreadsheetId("former-sheet");
    google.calls.length = 0;
    google.enqueue(
      { method: "GET", pathname: "/v4/spreadsheets/recovery-sheet/values/time_entries!A1%3AN1" },
      google.json({ values: [SHEET_HEADERS] })
    );

    assert.equal(await sheets.adoptSpreadsheet(" recovery-sheet "), "recovery-sheet");
    assert.equal(await sheets.getSpreadsheetId(), "recovery-sheet");
    assert.equal(await db.getSetting("spreadsheet_provision_pending"), "recovery-sheet");
  });

  it("marks an explicitly created replacement for one-time local re-seeding", async () => {
    await sheets.setSpreadsheetId("former-sheet");
    await db.setSetting("spreadsheet_provision_pending", "");
    google.calls.length = 0;
    google.enqueue(
      { method: "POST", pathname: "/v4/spreadsheets" },
      google.json({ spreadsheetId: "replacement-sheet" })
    );
    google.enqueue(
      { method: "POST", pathname: "/v4/spreadsheets/replacement-sheet/values:batchUpdate" },
      google.json({})
    );

    assert.equal(await sheets.createReplacementSpreadsheet(), "replacement-sheet");
    assert.equal(await sheets.getSpreadsheetId(), "replacement-sheet");
    assert.equal(await db.getSetting("spreadsheet_provision_pending"), "replacement-sheet");
  });

  it("does not replace the current binding when a selected spreadsheet is incompatible", async () => {
    await sheets.setSpreadsheetId("keep-this-sheet");
    google.calls.length = 0;
    google.enqueue(
      { method: "GET", pathname: "/v4/spreadsheets/not-ours/values/time_entries!A1%3AN1" },
      google.json({ values: [["not", "our", "header"]] })
    );

    await assert.rejects(
      () => sheets.adoptSpreadsheet("not-ours"),
      (error) => error.code === "SHEET_SCHEMA_UNSUPPORTED"
    );
    assert.equal(await sheets.getSpreadsheetId(), "keep-this-sheet");
  });

  it("rejects a malformed successful Sheets response without attempting repair", async () => {
    await sheets.setSpreadsheetId("malformed-sheet");
    google.calls.length = 0;
    google.enqueue(
      { method: "GET", pathname: "/v4/spreadsheets/malformed-sheet/values:batchGet" },
      google.malformed("this is not JSON")
    );

    await assert.rejects(() => sheets.readRemoteSnapshot(), (error) => error.code === "API_ERROR");
    assert.equal(google.calls.some((call) => call.pathname === "/v4/spreadsheets/malformed-sheet"), false);
  });
});

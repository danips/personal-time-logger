import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";

import { SHEET_HEADERS } from "../src/entries.js";
import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

const fixturesDirectory = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = async (name) => JSON.parse(await readFile(join(fixturesDirectory, name), "utf8"));

installFakeIndexedDB();

let db;
let rowsToEntries;

before(async () => {
  db = await import("../src/db.js");
  ({ rowsToEntries } = await import("../src/sheets.js"));
});

describe("migration fixtures", () => {
  it("loads a version-2 IndexedDB snapshot without losing active entries or tombstones", async () => {
    const snapshot = await readFixture("indexeddb-v2.json");
    assert.equal(snapshot.database, "timelogger_db");
    assert.equal(snapshot.version, 2);

    await db.putEntries(snapshot.stores.time_entries);
    await Promise.all(snapshot.stores.settings.map(({ key, value }) => db.setSetting(key, value)));

    assert.equal((await db.getEntry("v2-active-entry")).end_at, "");
    assert.equal((await db.getEntry("v2-tombstone-entry")).deleted_at, "2026-08-04T08:00:00.000Z");
    assert.deepEqual(await db.getDirtyEntries().then((entries) => entries.map((entry) => entry.id).sort()), [
      "v2-active-entry",
      "v2-tombstone-entry"
    ]);
    assert.equal(await db.getSetting("spreadsheet_id"), "legacy-sheet-id");
  });

  it("decodes a legacy single-tab spreadsheet and preserves its entries", async () => {
    const spreadsheet = await readFixture("legacy-spreadsheet.json");
    assert.equal("config" in spreadsheet.tabs, false);

    const rows = spreadsheet.tabs.time_entries.rows;
    assert.deepEqual(rows[0], SHEET_HEADERS);
    const { entries, rowMap } = rowsToEntries(rows);

    assert.deepEqual(entries.map((entry) => entry.id), ["legacy-complete-entry", "legacy-deleted-entry"]);
    assert.equal(entries[1].deleted_at, "2026-07-03T09:00:00.000Z");
    assert.equal(entries[1].multiply, "2.000");
    assert.deepEqual([...rowMap], [
      ["legacy-complete-entry", 2],
      ["legacy-deleted-entry", 3]
    ]);
  });
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";

import { seedEntries } from "./support/db-fixtures.js";
import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

const fixturesDirectory = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = async (name) => JSON.parse(await readFile(join(fixturesDirectory, name), "utf8"));

installFakeIndexedDB();

let db;

before(async () => {
  db = await import("../extension/src/db.js");
});

describe("migration fixtures", () => {
  it("imports a version-2 IndexedDB fixture without losing active entries or tombstones", async () => {
    const snapshot = await readFixture("indexeddb-v2.json");
    assert.equal(snapshot.database, "timelogger_db");
    assert.equal(snapshot.version, 2);

    await seedEntries(db, snapshot.stores.time_entries);
    await Promise.all(snapshot.stores.settings.map(({ key, value }) => db.setSetting(key, value)));

    assert.equal((await db.getEntry("v2-active-entry")).end_at, "");
    assert.equal((await db.getEntry("v2-tombstone-entry")).deleted_at, "2026-08-04T08:00:00.000Z");
    assert.deepEqual(await db.getDirtyEntries().then((entries) => entries.map((entry) => entry.id).sort()), [
      "v2-active-entry",
      "v2-tombstone-entry"
    ]);
  });
});

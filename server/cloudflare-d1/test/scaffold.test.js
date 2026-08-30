import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const migration = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
const config = readFileSync(new URL("../wrangler.example.jsonc", import.meta.url), "utf8");

describe("Cloudflare D1 scaffold", () => {
  it("contains a placeholder-only Worker configuration and DB binding", () => {
    assert.match(config, /"main": "src\/index\.js"/);
    assert.match(config, /"binding": "DB"/);
    assert.match(config, /REPLACE_WITH_THE_ID/);
    assert.doesNotMatch(config, /Bearer|sha256|[a-f0-9]{64}/i);
  });

  it("initializes the four schema tables and one metadata row", () => {
    for (const table of ["time_entries", "config", "app_meta", "mutation_guard"]) {
      assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
    }
    assert.match(migration, /INSERT INTO app_meta\(id, schema_version, change_seq\) VALUES \(1, 1, 1\)/);
    assert.match(migration, /remote_version INTEGER NOT NULL DEFAULT 1 CHECK \(remote_version >= 1\)/);
    assert.match(migration, /value INTEGER NOT NULL CHECK \(value IS NOT NULL\)/);
  });
});

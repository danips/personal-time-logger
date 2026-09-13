import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const config = readFileSync(new globalThis.URL("../wrangler.example.jsonc", import.meta.url), "utf8");

describe("Cloudflare D1 scaffold", () => {
  it("contains a placeholder-only Worker configuration and DB binding", () => {
    assert.match(config, /"main": "src\/index\.js"/);
    assert.match(config, /"binding": "DB"/);
    assert.match(config, /REPLACE_WITH_THE_ID/);
    assert.doesNotMatch(config, /Bearer|sha256|[a-f0-9]{64}/i);
  });

});

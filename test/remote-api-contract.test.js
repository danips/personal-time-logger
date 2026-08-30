import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const contract = readFileSync("docs/remote-api-v1.md", "utf8");

describe("remote API v1 contract", () => {
  it("freezes the provider-neutral routes", () => {
    for (const route of [
      "GET | `/v1/health`", "GET | `/v1/change-token`", "GET | `/v1/snapshot`",
      "POST | `/v1/entries/append`", "POST | `/v1/entries/update`",
      "POST | `/v1/entries/delete`", "POST | `/v1/config/update`"
    ]) assert.match(contract, new RegExp(route.replace(/[|`]/g, "\\$&")));
  });

  it("freezes the canonical fields and safe error shape", () => {
    assert.match(contract, /id.*project.*task.*description.*start_at.*end_at/s);
    assert.match(contract, /REMOTE_VERSION_STALE/);
    assert.match(contract, /Authorization: Bearer/);
    assert.match(contract, /SQL errors, stack traces, URLs, tokens, and token digests/);
  });
});

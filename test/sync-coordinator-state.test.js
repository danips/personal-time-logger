import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const code = readFileSync(join(process.cwd(), "extension/src/sync.js"), "utf8");

describe("sync drain coordinator", () => {
  it("keeps active and queued state in one drain record", () => {
    assert.match(code, /let syncDrain = null;/);
    assert.doesNotMatch(code, /let inFlightSync = null|let inFlightOptions = null|let currentSync = null|let queuedSync = null|let queuedOptions = null/);
    assert.match(code, /const drain = \{ current: null, queued: null, drainPromise: null \}/);
    assert.match(code, /syncDrain\.queued\?\.deferred\.promise/);
  });
});

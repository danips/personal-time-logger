import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();
const db = await import("../src/db.js");
const session = await import("../src/auth-session-store.js");

describe("auth session store", () => {
  it("owns fenced begin, replace, clear, and invalidate transitions", async () => {
    assert.equal((await session.getAuthSessionSnapshot()).generation, 0);
    const begun = await session.beginAuthSession();
    assert.equal(begun, 1);

    const rejected = await session.replaceAuthToken({ refresh_token: "stale" }, { expectedGeneration: 0 });
    assert.equal(rejected.applied, false);

    const saved = await session.replaceAuthToken({ refresh_token: "fresh" }, { expectedGeneration: begun });
    assert.equal(saved.applied, true);
    assert.equal(saved.generation, 2);
    assert.equal((await session.getAuthSessionSnapshot()).tokenData.refresh_token, "fresh");

    assert.equal(await session.clearAuthSession({ expectedGeneration: 1 }), false);
    assert.equal(await session.clearAuthSession({ expectedGeneration: 2, expectedRefreshToken: "fresh" }), true);
    assert.equal((await session.getAuthSessionSnapshot()).tokenData, null);
    await session.invalidateAuthSession();
    assert.equal((await session.getAuthSessionSnapshot()).generation, 4);
    assert.equal(await db.getSetting(session.TOKEN_KEY), null);
  });
});

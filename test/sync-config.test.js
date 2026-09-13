import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();

const db = await import("../extension/src/db.js");
const { hasPendingConfig, syncConfig } = await import("../extension/src/sync-config.js");

const key = "duration_multiplier";
const updatedKey = "duration_multiplier_updated_at";
const syncedKey = "duration_multiplier_synced_at";
const old = "2026-08-08T10:00:00.000Z";
const newer = "2026-08-08T11:00:00.000Z";

async function local(value = "1", updatedAt = "", syncedAt = "") {
  await db.mutateSettings([key, updatedKey, syncedKey], (settings) => {
    settings.set(key, value);
    settings.set(updatedKey, updatedAt);
    settings.set(syncedKey, syncedAt);
  });
}

const lease = { assert: async () => {} };
const remote = (entry) => entry ? { [key]: entry } : {};

describe("duration multiplier sync policy", () => {
  it("has no pending config without a local timestamp", async () => {
    await local("1", "", "");
    assert.equal(await hasPendingConfig(), false);
    assert.deepEqual(await syncConfig({}, new Map(), { provider: {}, lease }), { changed: false });
  });

  it("pushes a local-only value with the snapshot reference", async () => {
    await local("1.250", old, "");
    const calls = [];
    const outcome = await syncConfig({}, new Map([[key, "config-ref"]]), {
      provider: { updateConfig: async (...args) => calls.push(args) }, lease
    });
    assert.deepEqual(outcome, { changed: true, pushed: true });
    assert.deepEqual(calls[0], [key, "1.250", old, { expectedRef: "config-ref" }]);
    assert.equal(await db.getSetting(syncedKey), old);
  });

  it("pulls a valid newer value and treats equal values as synchronized", async () => {
    await local("1", old, "");
    assert.deepEqual(await syncConfig(remote({ value: "1.500", updated_at: newer }), new Map(), { provider: {}, lease }), { changed: true, pulled: true });
    assert.equal(await db.getSetting(key), "1.500");
    assert.deepEqual(await syncConfig(remote({ value: "1.500", updated_at: newer }), new Map(), { provider: {}, lease }), { changed: false });
  });

  it("reports equal-timestamp disagreements and invalid or future remote values as conflicts", async () => {
    await local("1", old, "");
    assert.deepEqual(await syncConfig(remote({ value: "1.5", updated_at: old }), new Map(), { provider: {}, lease }), { conflict: true, changed: false });
    assert.deepEqual(await syncConfig(remote({ value: "not-a-number", updated_at: newer }), new Map(), { provider: {}, lease }), { conflict: true, changed: false });
    assert.deepEqual(await syncConfig(remote({ value: "1.5", updated_at: "2999-01-01T00:00:00.000Z" }), new Map(), { provider: {}, lease }), { conflict: true, changed: false });
  });

  it("does not overwrite a local save that races a pull", async () => {
    await local("1", old, "");
    let assertions = 0;
    const racingLease = { assert: async () => {
      assertions += 1;
      if (assertions === 1) await db.setSetting(updatedKey, "2026-08-08T12:00:00.000Z");
    } };
    assert.deepEqual(await syncConfig(remote({ value: "1.5", updated_at: newer }), new Map(), { provider: {}, lease: racingLease }), { changed: false, pulled: false });
    assert.equal(await db.getSetting(key), "1");
  });

  it("preserves stale-reference and lease-loss failures without marking config synchronized", async () => {
    await local("1.25", old, "");
    await assert.rejects(syncConfig({}, new Map([[key, "stale"]]), {
      provider: { updateConfig: async () => { throw Object.assign(new Error("stale"), { code: "REMOTE_CONFLICT" }); } }, lease
    }), { code: "REMOTE_CONFLICT" });
    assert.equal(await db.getSetting(syncedKey), "");

    let assertions = 0;
    await assert.rejects(syncConfig({}, new Map(), {
      provider: { updateConfig: async () => {} },
      lease: { assert: async () => { assertions += 1; if (assertions === 2) throw Object.assign(new Error("lost"), { code: "SYNC_BUSY" }); } }
    }), { code: "SYNC_BUSY" });
    assert.equal(await db.getSetting(syncedKey), "");
  });
});

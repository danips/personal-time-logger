import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { persistedEntryFixture } from "./support/persisted-entry-fixture.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;

const db = await import("../extension/src/db.js");
const { formatSyncContext, readSyncStatus } = await import("../extension/src/sync-status.js");
const { SETTING_KEY } = await import("../extension/src/setting-keys.js");

const provider = { id: "mysql", label: "MySQL 8.4" };

describe("sync status presentation", () => {
  it("combines provider, local safety, freshness, and retry state", async () => {
    const lastSuccessAt = "2026-09-12T09:00:00.000Z";
    const retryAt = Date.now() + 60_000;
    await db.setSetting(SETTING_KEY.REMOTE_BACKEND, "mysql");
    await db.setSetting(SETTING_KEY.SYNC_LAST_SUCCESS_AT, lastSuccessAt);
    await db.setSetting(SETTING_KEY.SYNC_LAST_STATUS, "synced");
    await db.setSetting(SETTING_KEY.SYNC_BACKOFF_UNTIL, retryAt);
    await db.mutateEntries(["pending-status", "review-status", "deleted-status"], (entries) => {
      entries.set("pending-status", persistedEntryFixture({ id: "pending-status", dirty: true }));
      entries.set("review-status", persistedEntryFixture({ id: "review-status", status: "needs_review" }));
      entries.set("deleted-status", persistedEntryFixture({ id: "deleted-status", deleted_at: lastSuccessAt, dirty: true }));
    });

    const snapshot = await readSyncStatus({ now: Date.now(), provider });
    assert.deepEqual({
      provider: snapshot.provider,
      pendingCount: snapshot.pendingCount,
      reviewCount: snapshot.reviewCount,
      lastSuccessAt: snapshot.lastSuccessAt,
      nextRetryAt: snapshot.nextRetryAt > Date.now(),
      state: snapshot.state
    }, {
      provider,
      pendingCount: 1,
      reviewCount: 1,
      lastSuccessAt,
      nextRetryAt: true,
      state: "needs-review"
    });
    const context = formatSyncContext(snapshot);
    assert.match(context, /State: needs review/);
    assert.match(context, /Provider: MySQL 8\.4/);
    assert.match(context, /Local pending: 1/);
    assert.match(context, /Last remote success:/);
    assert.match(context, /Review: 1/);
    assert.match(context, /next retry/);
  });
});

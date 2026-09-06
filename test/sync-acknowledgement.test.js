import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { seedEntry } from "./support/db-fixtures.js";
import { persistedEntryFixture } from "./support/persisted-entry-fixture.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;

const db = await import("../extension/src/db.js");
const { markSynced } = await import("../extension/src/sync.js");

const entry = (over = {}) => persistedEntryFixture({
  id: "ack-entry",
  description: "",
  dirty: true,
  last_sync_at: "",
  sync_error: "retry later",
  ...over
});

describe("sync acknowledgements", () => {
  it("does not clear a same-revision local edit whose fingerprint changed", async () => {
    const pushed = entry();
    const localEdit = entry({ task: "Edited after push", sync_error: "keep this error" });
    await seedEntry(db, localEdit);

    const acknowledgement = await markSynced(pushed);

    assert.equal(acknowledgement.applied, false);
    assert.deepEqual(await db.getEntry(pushed.id), localEdit);
  });

  it("does not resurrect an entry deleted while its remote write was pending", async () => {
    const pushed = entry({ id: "ack-deleted" });
    await seedEntry(db, pushed);
    await db.mutateEntry(pushed.id, () => undefined);

    const acknowledgement = await markSynced(pushed);

    assert.equal(acknowledgement.applied, false);
    assert.equal(acknowledgement.entry, null);
    assert.equal(await db.getEntry(pushed.id), undefined);
  });
});

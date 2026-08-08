import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import { createDbContexts } from "./support/multi-context.js";

installFakeIndexedDB();

describe("multi-context database harness", () => {
  it("loads independent repository modules against one shared database", async () => {
    const [popup, calendar] = await createDbContexts(["popup", "calendar"]);
    assert.notStrictEqual(popup, calendar);

    await popup.setSetting("writer", "popup");
    assert.equal(await calendar.getSetting("writer"), "popup");

    await Promise.all([
      popup.putEntry({ id: "popup-entry", revision: 1 }),
      calendar.putEntry({ id: "calendar-entry", revision: 1 })
    ]);

    const entries = await calendar.getAllEntries();
    assert.deepEqual(entries.map((entry) => entry.id).sort(), ["calendar-entry", "popup-entry"]);
  });

  it("gives each new context pair its own module state without losing durable data", async () => {
    const [background, reconcile] = await createDbContexts(["background", "reconcile"]);

    assert.equal(await background.getSetting("writer"), "popup");
    await reconcile.setSetting("writer", "reconcile");
    assert.equal(await background.getSetting("writer"), "reconcile");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalMigrationDataset, canonicalMigrationText, migrationDigest, migrationPreview, assertLocalCompatibleWithRemote } from "../extension/src/storage-migration.js";
import { persistedEntryFixture } from "./support/persisted-entry-fixture.js";

const entry = (id, over = {}) => persistedEntryFixture({
  id,
  ...over
});

describe("storage migration canonical dataset", () => {
  it("uses a provider-neutral compatibility check", () => {
    const snapshot = { entries: [entry("a")], config: {} };
    assert.doesNotThrow(() => assertLocalCompatibleWithRemote(snapshot, snapshot, "Cloudflare Worker + D1"));
    assert.throws(() => assertLocalCompatibleWithRemote(snapshot, { entries: [], config: {} }, "Cloudflare Worker + D1"), /Cloudflare Worker \+ D1/);
  });

  it("sorts entries/config and excludes provider marker and local bookkeeping", () => {
    const dataset = canonicalMigrationDataset({
      entries: [entry("b", { dirty: true }), entry("a")],
      config: {
        z: { value: "2", updated_at: "2026-08-08T11:00:00.000Z" },
        app: { value: "personal-time-logger", updated_at: "2026-08-08T11:00:00.000Z" },
        duration_multiplier: { value: "1.500", updated_at: "2026-08-08T11:00:00.000Z" }
      }
    });
    assert.deepEqual(dataset.entries.map(([id]) => id), ["a", "b"]);
    assert.deepEqual(dataset.config, [
      ["duration_multiplier", "1.500", "2026-08-08T11:00:00.000Z"],
      ["z", "2", "2026-08-08T11:00:00.000Z"]
    ]);
    assert.doesNotMatch(canonicalMigrationText({ entries: [entry("a")], config: {} }), /dirty|last_sync_at|sync_error/);
  });

  it("preserves the established canonical entry serialization", () => {
    const source = entry("fixed", { dirty: true, last_sync_at: "not-persisted", sync_error: "old" });
    assert.equal(
      canonicalMigrationText({ entries: [source], config: {} }),
      '{"entries":[["fixed","Project","Task","Description","2026-08-08T09:00:00.000Z","2026-08-08T10:00:00.000Z",3600,"ok","2026-08-08T09:00:00.000Z","2026-08-08T10:00:00.000Z","","device",1,""]],"config":[]}'
    );
  });

  it("produces the same digest for equivalent provider ordering", async () => {
    const first = { entries: [entry("b"), entry("a")], config: { b: { value: "2", updated_at: "2026-08-08T11:00:00.000Z" }, a: { value: "1", updated_at: "2026-08-08T11:00:00.000Z" } } };
    const second = { entries: [entry("a"), entry("b")], config: { a: first.config.a, b: first.config.b } };
    assert.equal(await migrationDigest(first), await migrationDigest(second));
  });

  it("previews source and target counts without hiding disagreements", () => {
    const source = {
      entries: [entry("same"), entry("missing")],
      config: { duration_multiplier: { value: "1", updated_at: "2026-08-08T11:00:00.000Z" } }
    };
    const target = {
      entries: [entry("same", { description: "changed" }), entry("extra")],
      config: { duration_multiplier: { value: "2", updated_at: "2026-08-08T11:00:00.000Z" } },
    };
    assert.deepEqual(migrationPreview(source, target), {
      sourceEntryCount: 2,
      targetEntryCount: 2,
      sourceConfigCount: 1,
      targetConfigCount: 1,
      sourceOnlyEntryCount: 1,
      targetOnlyEntryCount: 1,
      changedEntryCount: 1,
      configDisagreementCount: 1,
      disagreementCount: 4
    });
  });
});

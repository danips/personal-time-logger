import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalMigrationDataset, canonicalMigrationText, migrationDigest, assertLocalCompatibleWithRemote } from "../extension/src/storage-migration.js";
import { registeredRemoteProviderIds } from "../extension/src/remote-provider.js";

const entry = (id, over = {}) => ({
  id,
  project: "Project",
  task: "Task",
  description: "Description",
  start_at: "2026-08-08T09:00:00.000Z",
  end_at: "2026-08-08T10:00:00.000Z",
  duration_seconds: 3600,
  status: "ok",
  created_at: "2026-08-08T09:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
  deleted_at: "",
  device_id: "device",
  revision: 1,
  multiply: "",
  ...over
});

describe("storage migration canonical dataset", () => {
  it("recognizes every registered source and target direction", () => {
    assert.deepEqual(registeredRemoteProviderIds(), ["google-sheets", "mysql", "cloudflare-d1"]);
    assert.deepEqual(registeredRemoteProviderIds().flatMap((source) => registeredRemoteProviderIds()
      .filter((target) => target !== source).map((target) => `${source}->${target}`)), [
      "google-sheets->mysql", "google-sheets->cloudflare-d1",
      "mysql->google-sheets", "mysql->cloudflare-d1",
      "cloudflare-d1->google-sheets", "cloudflare-d1->mysql"
    ]);
  });

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

  it("produces the same digest for equivalent provider ordering", async () => {
    const first = { entries: [entry("b"), entry("a")], config: { b: { value: "2", updated_at: "2026-08-08T11:00:00.000Z" }, a: { value: "1", updated_at: "2026-08-08T11:00:00.000Z" } } };
    const second = { entries: [entry("a"), entry("b")], config: { a: first.config.a, b: first.config.b } };
    assert.equal(await migrationDigest(first), await migrationDigest(second));
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeEntry } from "../extension/src/entries.js";
import {
  CHUNK_SIZE,
  cloudflareD1HostPermission,
  cloudflareD1Provider,
  normalizeCloudflareD1ApiBaseUrl
} from "../extension/src/remote-cloudflare-d1.js";

const platformApi = {
  isOnline: () => true,
  async hasOptionalHostPermission() { return true; },
  async requestOptionalHostPermission() { return true; }
};
const fixture = (id, over = {}) => normalizeEntry({
  id, project: "Project", task: "Task", description: "Description",
  start_at: "2026-08-30T09:00:00.000Z", end_at: "2026-08-30T10:00:00.000Z", duration_seconds: 3600,
  status: "ok", created_at: "2026-08-30T09:00:00.000Z", updated_at: "2026-08-30T10:00:00.000Z",
  deleted_at: "", device_id: "device", revision: 1, multiply: "", ...over
});
const ok = (body) => ({ ok: true, status: 200, async text() { return JSON.stringify(body); } });

describe("Cloudflare Worker + D1 provider", () => {
  it("normalizes workers.dev URLs and requests only the exact origin", () => {
    assert.equal(normalizeCloudflareD1ApiBaseUrl("https://my-worker.workers.dev///"), "https://my-worker.workers.dev");
    assert.equal(cloudflareD1HostPermission("https://my-worker.workers.dev/path"), "https://my-worker.workers.dev/*");
    for (const value of ["http://my-worker.workers.dev", "https://example.com", "https://user:pass@my-worker.workers.dev", "https://my-worker.workers.dev/?secret=1"]) {
      assert.throws(() => normalizeCloudflareD1ApiBaseUrl(value), (error) => error.code === "CLOUDFLARE_D1_CONFIG_INVALID");
    }
  });

  it("validates D1 health and normalizes nullable snapshot fields", async () => {
    const clientOptions = {
      baseUrl: "https://my-worker.workers.dev", token: "synthetic-token", platformApi,
      fetchImpl: async (_url, options) => {
        assert.equal(options.headers.Authorization, "Bearer synthetic-token");
        return ok({ ok: true, service: "personal-time-logger", apiVersion: 1, schemaVersion: 1, storage: "cloudflare-d1" });
      }
    };
    assert.equal((await cloudflareD1Provider.testConnection(clientOptions)).storage, "cloudflare-d1");
    const snapshot = await cloudflareD1Provider.readSnapshot({
      ...clientOptions,
      fetchImpl: async () => ok({ changeToken: "4", entries: [{ entry: fixture("nullable", { end_at: null, deleted_at: null, multiply: null }), version: 2 }], config: [] })
    });
    assert.equal(snapshot.entries[0].end_at, "");
    assert.deepEqual(snapshot.entryRefs.get("nullable"), { kind: "cloudflare-d1-row", version: 2 });
  });

  it("chunks transport mutations at fifteen and preserves append order", async () => {
    const calls = [];
    const entries = Array.from({ length: CHUNK_SIZE + 1 }, (_, index) => fixture(`chunk-${index}`));
    const result = await cloudflareD1Provider.appendEntries(entries, {
      baseUrl: "https://my-worker.workers.dev", token: "synthetic-token", platformApi,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        calls.push(body.entries.length);
        return ok({ entries: body.entries.map((entry, index) => ({ id: entry.id, version: index + 1 })) });
      }
    });
    assert.deepEqual(calls, [15, 1]);
    assert.deepEqual(result.map(({ id }) => id), entries.map(({ id }) => id));
  });

  it("leaves later-chunk failures visible for safe retry", async () => {
    let calls = 0;
    await assert.rejects(() => cloudflareD1Provider.appendEntries(
      Array.from({ length: CHUNK_SIZE + 1 }, (_, index) => fixture(`failure-${index}`)),
      {
        baseUrl: "https://my-worker.workers.dev", token: "synthetic-token", platformApi,
        fetchImpl: async () => {
          calls += 1;
          return calls === 1 ? ok({ entries: [] }) : { ok: false, status: 500, async text() { return JSON.stringify({ error: { code: "API_ERROR", message: "secret" } }); } };
        }
      }
    ), { code: "API_ERROR" });
    assert.equal(calls, 2);
  });
});

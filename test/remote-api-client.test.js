import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chunkByEncodedBytes,
  createRemoteApiClient,
  normalizeRemoteApiBaseUrl,
  parseRemoteSnapshot,
  remoteHostPermission
} from "../extension/src/remote-api-client.js";

const platformApi = {
  isOnline: () => true,
  async hasOptionalHostPermission() { return true; },
  async requestOptionalHostPermission() { return true; }
};
const base = {
  baseUrl: "https://example.workers.dev/ptl",
  token: "synthetic-token",
  providerLabel: "Cloudflare Worker + D1",
  platformApi
};
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() { return typeof body === "string" ? body : JSON.stringify(body); }
});

describe("provider-neutral remote API client", () => {
  it("chunks exact UTF-8 wire bodies with one projection per item", () => {
    let encodeCalls = 0;
    const values = [
      { id: "a", text: "quoted \"text\"" },
      { id: "b", text: "Grüße" },
      { id: "c", text: "tail" }
    ];
    const encode = (value) => { encodeCalls += 1; return value; };
    const chunks = chunkByEncodedBytes(values, {
      maxBytes: 63,
      envelopeKey: "entries",
      encode
    });

    assert.equal(encodeCalls, values.length);
    assert.deepEqual(chunks.flat(), values);
    for (const chunk of chunks) {
      assert.equal(new TextEncoder().encode(chunk.encodedBody).byteLength <= 63, true);
      assert.deepEqual(JSON.parse(chunk.encodedBody), { entries: chunk });
    }
  });

  it("rejects one item whose encoded envelope exceeds the byte cap", () => {
    assert.throws(() => chunkByEncodedBytes([{ text: "x".repeat(100) }], {
      maxBytes: 20,
      envelopeKey: "entries"
    }), { code: "REMOTE_API_INCOMPATIBLE" });
  });

  it("enforces an item-count cap alongside the byte cap", () => {
    const chunks = chunkByEncodedBytes([1, 2, 3], {
      maxBytes: 100,
      maxItems: 2,
      envelopeKey: "values"
    });
    assert.deepEqual(chunks.map((chunk) => [...chunk]), [[1, 2], [3]]);
  });

  it("normalizes safe URLs and rejects credentials, queries, fragments, and HTTP", () => {
    assert.equal(normalizeRemoteApiBaseUrl("https://example.workers.dev///"), "https://example.workers.dev");
    for (const value of [
      "http://example.workers.dev", "https://user:pass@example.workers.dev",
      "https://example.workers.dev/?token=secret", "https://example.workers.dev/#secret"
    ]) assert.throws(() => normalizeRemoteApiBaseUrl(value), /HTTPS|cannot contain/);
    assert.equal(remoteHostPermission("https://example.workers.dev/path"), "https://example.workers.dev/*");
  });

  it("uses bearer-only authentication and validates JSON objects", async () => {
    let request;
    const client = createRemoteApiClient({
      ...base,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return response({ ok: true });
      }
    });
    await client.health();
    assert.equal(request.url, "https://example.workers.dev/ptl/v1/health");
    assert.deepEqual(request.options.headers, { Authorization: "Bearer synthetic-token" });

    for (const body of ["not-json", [], null]) {
      const malformed = createRemoteApiClient({ ...base, fetchImpl: async () => response(body) });
      await assert.rejects(() => malformed.health(), { code: "REMOTE_API_INCOMPATIBLE" });
    }
  });

  it("classifies a non-object snapshot as an incompatible API response", () => {
    assert.throws(() => parseRemoteSnapshot(null, {
      entryRefKind: "test-entry",
      configRefKind: "test-config",
      providerLabel: "Test API"
    }), { code: "REMOTE_API_INCOMPATIBLE" });
  });

  it("maps recognized server errors without exposing server text or secrets", async () => {
    const client = createRemoteApiClient({
      ...base,
      fetchImpl: async () => response({ error: { code: "REMOTE_VERSION_STALE", message: "synthetic-token" } }, 409)
    });
    await assert.rejects(() => client.health(), (error) => {
      assert.equal(error.code, "REMOTE_VERSION_STALE");
      assert.equal(error.message.includes("synthetic-token"), false);
      return true;
    });
  });

  it("supports offline, permission-request, denied-permission, and timeout outcomes", async () => {
    await assert.rejects(() => createRemoteApiClient({
      ...base, platformApi: { ...platformApi, isOnline: () => false }, fetchImpl: async () => response({})
    }).health(), { code: "OFFLINE" });

    let requested = 0;
    const requesting = createRemoteApiClient({
      ...base,
      requestPermission: true,
      platformApi: {
        ...platformApi,
        async hasOptionalHostPermission() { return false; },
        async requestOptionalHostPermission(permission) {
          requested += 1;
          assert.equal(permission, "https://example.workers.dev/*");
          return true;
        }
      },
      fetchImpl: async () => response({ ok: true })
    });
    await requesting.health();
    assert.equal(requested, 1);

    await assert.rejects(() => createRemoteApiClient({
      ...base,
      platformApi: { ...platformApi, async hasOptionalHostPermission() { return false; } },
      fetchImpl: async () => response({})
    }).health(), { code: "REMOTE_PERMISSION" });

    await assert.rejects(() => createRemoteApiClient({
      ...base,
      timeoutMs: 1,
      fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
    }).health(), { code: "API_TIMEOUT" });
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createRemoteApiClient,
  normalizeRemoteApiBaseUrl,
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

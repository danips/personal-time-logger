import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import worker from "../src/index.js";
import { constantTimeEqual, decodeHex } from "../src/auth.js";
import { extensionOrigin } from "../src/cors.js";
import { ApiError } from "../src/errors.js";
import { entry, normalizeTimestamp } from "../src/validator.js";

const contract = JSON.parse(readFileSync(new globalThis.URL("../../../test/fixtures/entry-contract.json", import.meta.url), "utf8"));

const token = "synthetic-worker-token";
async function digestHex(value) {
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new globalThis.TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function db() {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes("schema_version")) return { schema_version: 1, change_seq: 1 };
              return { change_seq: 1 };
            }
          };
        }
      };
    }
  };
}

describe("Cloudflare D1 Worker pure boundaries", () => {
  it("decodes only a 32-byte hex digest and compares in constant work", () => {
    const digest = decodeHex("a".repeat(64));
    assert.equal(digest.length, 32);
    assert.equal(decodeHex("not-a-digest"), null);
    assert.equal(constantTimeEqual(digest, new Uint8Array(digest)), true);
    assert.equal(constantTimeEqual(digest, new Uint8Array(31)), false);
  });

  it("accepts only credential-free moz-extension origins", () => {
    assert.equal(extensionOrigin("moz-extension://abc-123"), "moz-extension://abc-123");
    for (const origin of [
      "https://example.com", "moz-extension://abc/path", "moz-extension://abc/?x=1",
      "moz-extension://user:pass@abc", "moz-extension://"
    ]) assert.equal(extensionOrigin(origin), null);
  });

  it("normalizes timestamps and rejects unsafe entry values", () => {
    assert.equal(normalizeTimestamp("2026-08-30T12:00:00+01:00", "updated_at"), "2026-08-30T11:00:00.000Z");
    assert.throws(() => normalizeTimestamp("2026-02-31T12:00:00Z", "updated_at"), ApiError);
    assert.throws(() => entry({ id: "x", dirty: true }), (error) => error.code === "INVALID_REQUEST" || error.code === "ENTRY_INVALID");
  });

  it("enforces the shared remote entry contract", () => {
    assert.equal(entry(contract.base).start_at, "2026-08-24T09:00:00.000Z");
    for (const overrides of contract.invalidOverrides) {
      assert.throws(() => entry({ ...contract.base, ...overrides }), ApiError);
    }
  });

  it("authenticates health, handles CORS, and rejects unsupported methods", async () => {
    const env = { DB: db(), PTL_API_TOKEN_SHA256: await digestHex(token) };
    const auth = { Authorization: `Bearer ${token}`, Origin: "moz-extension://abc-123" };
    const good = await worker.fetch(new globalThis.Request("https://worker.example/v1/health", { headers: auth }), env);
    assert.equal(good.status, 200);
    assert.equal((await good.json()).storage, "cloudflare-d1");
    assert.equal(good.headers.get("Access-Control-Allow-Origin"), "moz-extension://abc-123");

    const missing = await worker.fetch(new globalThis.Request("https://worker.example/v1/health"), env);
    assert.equal(missing.status, 401);
    const badOrigin = await worker.fetch(new globalThis.Request("https://worker.example/v1/health", {
      headers: { ...auth, Origin: "https://example.com" }
    }), env);
    assert.equal(badOrigin.status, 403);
    const preflight = await worker.fetch(new globalThis.Request("https://worker.example/v1/entries/append", {
      method: "OPTIONS",
      headers: {
        Origin: "moz-extension://abc-123",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type"
      }
    }), env);
    assert.equal(preflight.status, 204);
    const method = await worker.fetch(new globalThis.Request("https://worker.example/v1/health", {
      method: "POST", headers: auth
    }), env);
    assert.equal(method.status, 405);
    assert.equal((await method.json()).error.code, "METHOD_NOT_ALLOWED");
  });
});

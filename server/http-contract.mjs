/* global fetch, process, console */

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export async function assertHttpContract(baseUrl, token) {
  const request = async (path, options = {}, authToken = token) => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        ...(authToken === null ? {} : { Authorization: `Bearer ${authToken}` }),
        ...options.headers
      }
    });
    const body = await response.json().catch(() => null);
    return { response, body };
  };

  const missingAuth = await request("/v1/change-token", {}, null);
  assert.equal(missingAuth.response.status, 401);
  assert.equal(missingAuth.body.error.code, "AUTH_REQUIRED");

  const invalidAuth = await request("/v1/change-token", {}, "wrong-token");
  assert.equal(invalidAuth.response.status, 401);
  assert.equal(invalidAuth.body.error.code, "AUTH_REQUIRED");

  const unknownRoute = await request("/v1/not-a-route");
  assert.equal(unknownRoute.response.status, 404);
  assert.equal(unknownRoute.body.error.code, "ROUTE_NOT_FOUND");

  const wrongMethod = await request("/v1/health", { method: "POST" });
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.body.error.code, "METHOD_NOT_ALLOWED");

  const wrongType = await request("/v1/entries/append", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ entries: [] })
  });
  assert.equal(wrongType.response.status, 400);
  assert.equal(wrongType.body.error.code, "INVALID_REQUEST");

  const malformed = await request("/v1/entries/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{"
  });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.error.code, "INVALID_REQUEST");

  const unknownField = await request("/v1/entries/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries: [], unexpected: true })
  });
  assert.equal(unknownField.response.status, 400);
  assert.equal(unknownField.body.error.code, "INVALID_REQUEST");

  const health = await request("/v1/health");
  assert.equal(health.response.status, 200);
  assert.deepEqual(
    { ok: health.body.ok, service: health.body.service, apiVersion: health.body.apiVersion, schemaVersion: health.body.schemaVersion },
    { ok: true, service: "personal-time-logger", apiVersion: 1, schemaVersion: 1 }
  );

  const id = `shared-http-contract-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const entry = {
    id,
    project: "Contract project",
    task: "Contract task",
    description: "SQL-like 'value' ✓",
    start_at: "2026-08-30T09:00:00.000Z",
    end_at: "2026-08-30T10:00:00.000Z",
    duration_seconds: 3600,
    status: "ok",
    created_at: "2026-08-30T09:00:00.000Z",
    updated_at: "2026-08-30T09:00:00.000Z",
    deleted_at: null,
    device_id: "shared-http-contract",
    revision: 1,
    multiply: null
  };
  const append = await request("/v1/entries/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries: [entry] })
  });
  assert.equal(append.response.status, 200);
  assert.deepEqual(append.body.entries, [{ id, version: 1 }]);

  const snapshot = await request("/v1/snapshot");
  const stored = snapshot.body.entries.find(({ entry: value }) => value.id === id);
  assert.ok(stored);
  assert.equal(stored.entry.project, entry.project);
  assert.equal(stored.entry.description, entry.description);
  assert.equal(stored.entry.revision, entry.revision);
  assert.equal(stored.version, 1);
  const tokenAfterAppend = (await request("/v1/change-token")).body.changeToken;

  const repeat = await request("/v1/entries/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries: [entry] })
  });
  assert.deepEqual(repeat.body.entries, [{ id, version: 1 }]);
  const afterRepeat = await request("/v1/change-token");
  assert.equal(afterRepeat.body.changeToken, tokenAfterAppend);

  const changed = { ...entry, description: "changed", updated_at: "2026-08-30T10:00:00.000Z" };
  const update = await request("/v1/entries/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates: [{ entry: changed, expectedVersion: 1 }] })
  });
  assert.deepEqual(update.body.entries, [{ id, version: 2 }]);
  const stale = await request("/v1/entries/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates: [{ entry, expectedVersion: 1 }] })
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "REMOTE_VERSION_STALE");

  const deleted = await request("/v1/entries/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preconditions: [{ id, expectedVersion: 2 }] })
  });
  assert.deepEqual(deleted.body.deleted, [id]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , baseUrl, token] = process.argv;
  if (!baseUrl || !token) throw new Error("Usage: node server/http-contract.mjs BASE_URL TOKEN");
  await assertHttpContract(baseUrl, token);
  console.log("HTTP contract checks passed.");
}

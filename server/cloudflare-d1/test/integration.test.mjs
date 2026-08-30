/* global URL, fetch, process, setTimeout */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";

const supported = Number(process.versions.node.split(".")[0]) >= 20;
const token = "synthetic-local-worker-token";
const root = resolve(new URL("..", import.meta.url).pathname);
let worker;

function digestHex(value) {
  return globalThis.crypto.subtle.digest("SHA-256", new globalThis.TextEncoder().encode(value)).then((bytes) =>
    [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
}

function unusedPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function run(command, args, options = {}) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, { cwd: root, ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk).replaceAll(token, "[redacted]"); });
    child.stderr.on("data", (chunk) => { output += String(chunk).replaceAll(token, "[redacted]"); });
    child.once("error", reject);
    child.once("close", (code) => resolveProcess({ code, output }));
  });
}

async function startWorker() {
  const directory = await mkdtemp(join(tmpdir(), "ptl-d1-integration-"));
  const configPath = join(directory, "wrangler.test.jsonc");
  const statePath = join(directory, "state");
  const port = await unusedPort();
  const digest = await digestHex(token);
  await writeFile(configPath, JSON.stringify({
    name: `ptl-local-test-${process.pid}`,
    main: resolve(root, "src/index.js"),
    compatibility_date: "2026-08-30",
    vars: { PTL_API_TOKEN_SHA256: digest },
    d1_databases: [{
      binding: "DB", database_name: `ptl-local-test-${process.pid}`,
      database_id: "00000000-0000-0000-0000-000000000001",
      migrations_dir: resolve(root, "migrations")
    }]
  }));
  const migration = await run("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--config", configPath]);
  assert.equal(migration.code, 0, migration.output);
  const child = spawn("npx", ["wrangler", "dev", "--local", "--config", configPath, "--persist-to", statePath, "--port", String(port), "--ip", "127.0.0.1"], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const capture = (chunk) => { output += String(chunk).replaceAll(token, "[redacted]"); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/v1/health`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 200) return { child, baseUrl, directory };
    } catch {
      // Wrangler is still starting; the bounded readiness probe retries.
    }
    await new Promise((resolveReady) => setTimeout(resolveReady, 100));
  }
  child.kill("SIGTERM");
  throw new Error(`Local Worker did not become ready: ${output}`);
}

async function stopWorker() {
  if (!worker) return;
  worker.child.kill("SIGTERM");
  await new Promise((resolveStop) => worker.child.once("close", resolveStop));
  await rm(worker.directory, { recursive: true, force: true });
  worker = null;
}

function makeEntry(id, over = {}) {
  return {
    id, project: "Project", task: "Task", description: "Description",
    start_at: "2026-08-30T09:00:00.000Z", end_at: "2026-08-30T10:00:00.000Z", duration_seconds: 3600,
    status: "ok", created_at: "2026-08-30T09:00:00.000Z", updated_at: "2026-08-30T10:00:00.000Z",
    deleted_at: null, device_id: "integration-device", revision: 1, multiply: null, ...over
  };
}

async function api(path, options = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...options.headers };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  return fetch(`${worker.baseUrl}${path}`, { ...options, headers });
}

describe("local Cloudflare Worker + D1 API", { skip: !supported }, () => {
  before(async () => { worker = await startWorker(); });
  after(stopWorker);

  it("supports authenticated health, atomic append/update/config, and snapshot reads", async () => {
    const headers = { Authorization: `Bearer ${token}` };
    const health = await fetch(`${worker.baseUrl}/v1/health`, { headers });
    assert.deepEqual(await health.json(), {
      ok: true, service: "personal-time-logger", apiVersion: 1, schemaVersion: 1, storage: "cloudflare-d1"
    });
    const entry = {
      id: "integration-entry", project: "Project", task: "Task", description: "Unicode ✓",
      start_at: "2026-08-30T09:00:00.000Z", end_at: null, duration_seconds: 0, status: "ok",
      created_at: "2026-08-30T09:00:00.000Z", updated_at: "2026-08-30T09:00:00.000Z",
      deleted_at: null, device_id: "integration-device", revision: 1, multiply: null
    };
    const append = await fetch(`${worker.baseUrl}/v1/entries/append`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ entries: [entry] })
    });
    assert.deepEqual(await append.json(), { entries: [{ id: entry.id, version: 1 }] });
    const snapshot = await fetch(`${worker.baseUrl}/v1/snapshot`, { headers });
    const snapshotBody = await snapshot.json();
    assert.equal(snapshotBody.entries[0].entry.end_at, null);
    assert.equal(snapshotBody.changeToken, "2");
    const changed = { ...entry, description: "changed", updated_at: "2026-08-30T10:00:00.000Z" };
    const update = await fetch(`${worker.baseUrl}/v1/entries/update`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ updates: [{ entry: changed, expectedVersion: 1 }] })
    });
    assert.deepEqual(await update.json(), { entries: [{ id: entry.id, version: 2 }] });
    const config = await fetch(`${worker.baseUrl}/v1/config/update`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ key: "duration_multiplier", value: "1.500", updated_at: "2026-08-30T10:00:00.000Z" })
    });
    assert.deepEqual(await config.json(), { key: "duration_multiplier", version: 1 });
  });

  it("enforces authentication, CORS, validation, idempotency, conflicts, and batch limits", async () => {
    const missing = await fetch(`${worker.baseUrl}/v1/change-token`);
    assert.equal(missing.status, 401);
    const badOrigin = await api("/v1/change-token", { headers: { Origin: "https://example.com" } });
    assert.equal(badOrigin.status, 403);
    const unknown = await api("/v1/not-a-route");
    assert.equal(unknown.status, 404);
    const malformed = await api("/v1/entries/append", { body: "{" });
    assert.equal(malformed.status, 400);
    const unknownField = await api("/v1/entries/append", { body: { entries: [], unexpected: true } });
    assert.equal(unknownField.status, 400);
    const sixteen = await api("/v1/entries/append", { body: { entries: Array.from({ length: 16 }, (_, index) => makeEntry(`limit-${index}`)) } });
    assert.equal(sixteen.status, 400);

    const entries = [makeEntry("contract-a"), makeEntry("contract-b")];
    const first = await api("/v1/entries/append", { method: "POST", body: { entries } });
    assert.deepEqual((await first.json()).entries.map(({ id }) => id), entries.map(({ id }) => id));
    const tokenAfterAppend = (await (await api("/v1/change-token")).json()).changeToken;
    const repeat = await api("/v1/entries/append", { method: "POST", body: { entries } });
    assert.deepEqual((await repeat.json()).entries, [{ id: "contract-a", version: 1 }, { id: "contract-b", version: 1 }]);
    assert.equal((await (await api("/v1/change-token")).json()).changeToken, tokenAfterAppend);
    const conflict = await api("/v1/entries/append", { method: "POST", body: { entries: [makeEntry("contract-a", { description: "different" })] } });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "REMOTE_APPEND_CONFLICT");

    const updated = await api("/v1/entries/update", {
      method: "POST", body: { updates: [{ entry: makeEntry("contract-a", { description: "updated" }), expectedVersion: 1 }] }
    });
    assert.deepEqual(await updated.json(), { entries: [{ id: "contract-a", version: 2 }] });
    const stale = await api("/v1/entries/update", {
      method: "POST", body: { updates: [{ entry: makeEntry("contract-a", { description: "stale" }), expectedVersion: 1 }] }
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, "REMOTE_VERSION_STALE");

    const config = await api("/v1/config/update", {
      method: "POST", body: { key: "integration", value: "one", updated_at: "2026-08-30T10:00:00Z" }
    });
    assert.deepEqual(await config.json(), { key: "integration", version: 1 });
    const noop = await api("/v1/config/update", {
      method: "POST", body: { key: "integration", value: "one", updated_at: "2026-08-30T10:00:00.000Z", expectedVersion: 1 }
    });
    assert.deepEqual(await noop.json(), { key: "integration", version: 1 });
    const configConflict = await api("/v1/config/update", {
      method: "POST", body: { key: "integration", value: "two", updated_at: "2026-08-30T10:00:00.000Z", expectedVersion: 9 }
    });
    assert.equal(configConflict.status, 409);
  });

  it("rolls back a mixed stale update and serializes same-version races", async () => {
    const entries = [makeEntry("rollback-a"), makeEntry("rollback-b"), makeEntry("race")];
    assert.equal((await (await api("/v1/entries/append", { method: "POST", body: { entries } })).json()).entries.length, 3);
    const mixed = await api("/v1/entries/update", {
      method: "POST", body: { updates: [
        { entry: makeEntry("rollback-a", { description: "must rollback" }), expectedVersion: 1 },
        { entry: makeEntry("rollback-b", { description: "stale" }), expectedVersion: 99 }
      ] }
    });
    assert.equal(mixed.status, 409);
    const after = (await (await api("/v1/snapshot")).json()).entries;
    assert.equal(after.find(({ entry }) => entry.id === "rollback-a").version, 1);
    const race = await Promise.all([1, 2].map((number) => api("/v1/entries/update", {
      method: "POST", body: { updates: [{ entry: makeEntry("race", { description: `race-${number}` }), expectedVersion: 1 }] }
    })));
    assert.deepEqual(race.map((response) => response.status).sort(), [200, 409]);
  });
});

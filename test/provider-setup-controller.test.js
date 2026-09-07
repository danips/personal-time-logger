import test from "node:test";
import assert from "node:assert/strict";
import { createProviderSetupController } from "../extension/options/provider-setup-controller.js";

const keys = {
  CONFIG_SAVE_FAILED: "CONFIG_SAVE_FAILED",
  REMOTE_PERMISSION: "REMOTE_PERMISSION",
  REMOTE_BACKEND: "remote_backend",
  REMOTE_BACKEND_ESTABLISHED: "remote_backend_established",
  GOOGLE_SHEETS: "google_sheets"
};

function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function descriptor() {
  return {
    id: "example", label: "Example", permissionLabel: "API", connectionLabel: "Example API",
    urlKey: "example_url", tokenKey: "example_token", defaultUrl: "https://default.example",
    missingCode: "TOKEN_MISSING", normalizeBaseUrl: (value) => String(value).trim().replace(/\/$/, ""),
    hostPermission: (baseUrl) => `${baseUrl}/*`, error: codedError,
    provider: { testConnection: async (options) => ({ service: "example", options }) }
  };
}

function controller({ settings = new Map(), claimLock = async () => ({ owner: "test" }), requestPermission = async () => true, permissionTimeoutMs } = {}) {
  const released = [];
  const activations = [];
  return {
    released,
    activations,
    api: createProviderSetupController({
      claimLock,
      releaseLock: async (lock) => { released.push(lock); },
      getSetting: async (key, fallback) => settings.has(key) ? settings.get(key) : fallback,
      mutateSettings: async (settingKeys, mutator) => {
        const staged = new Map(settingKeys.map((key) => [key, settings.get(key)]));
        mutator(staged);
        for (const [key, value] of staged) settings.set(key, value);
      },
      platform: { requestOptionalHostPermission: requestPermission }, keys, owner: () => "test-owner",
      activateFromLocal: async (id, options) => { activations.push(["local", id, options]); },
      activateFromRemote: async (id, options) => { activations.push(["remote", id, options]); },
      permissionTimeoutMs
    })
  };
}

test("provider setup saves normalized credentials and always releases its lock", async () => {
  const settings = new Map();
  const { api, released } = controller({ settings });
  const saved = await api.save(descriptor(), " https://api.example/ ", " token ");
  assert.deepEqual(saved, { baseUrl: "https://api.example", token: "token" });
  assert.equal(settings.get("example_url"), "https://api.example");
  assert.equal(settings.get("example_token"), "token");
  assert.equal(released.length, 1);
});

test("provider setup fences active destination changes and reports missing tokens", async () => {
  const settings = new Map([[keys.REMOTE_BACKEND, "example"], [keys.REMOTE_BACKEND_ESTABLISHED, true], ["example_url", "https://old.example"]]);
  const { api, released } = controller({ settings });
  await assert.rejects(api.save(descriptor(), "https://new.example", "token"), { code: keys.CONFIG_SAVE_FAILED });
  await assert.rejects(api.save(descriptor(), "https://old.example", ""), { code: "TOKEN_MISSING" });
  assert.equal(released.length, 1);
});

test("provider setup rejects lock contention before it changes settings", async () => {
  const settings = new Map();
  const { api, released } = controller({ settings, claimLock: async () => null });
  await assert.rejects(api.save(descriptor(), "https://api.example", "token"), { code: keys.CONFIG_SAVE_FAILED });
  assert.equal(settings.size, 0);
  assert.equal(released.length, 0);
});

test("provider setup reports permission denial, tests after grant, and selects activation source", async () => {
  const denied = controller({ requestPermission: async () => false });
  await assert.rejects(denied.api.test(descriptor(), "https://api.example", "token", { setConnectionStatus() {} }), { code: keys.REMOTE_PERMISSION });
  const granted = controller();
  const statuses = [];
  const health = await granted.api.test(descriptor(), "https://api.example", "token", { setConnectionStatus: (status) => statuses.push(status) });
  assert.equal(health.options.requestPermission, false);
  assert.equal(statuses.length, 2);
  await granted.api.activate(descriptor(), "remote", { onProgress() {} });
  assert.equal(granted.activations[0][0], "remote");
});

test("provider setup reports permission timeouts and forwards activation errors to page callbacks", async () => {
  const timedOut = controller({ requestPermission: async () => new Promise(() => {}), permissionTimeoutMs: 1 });
  await assert.rejects(timedOut.api.test(descriptor(), "https://api.example", "token", { setConnectionStatus() {} }), { code: keys.REMOTE_PERMISSION });
  const failure = Object.assign(new Error("migration failed"), { code: "MIGRATION_FAILED" });
  const errorCallbacks = [];
  const failing = createProviderSetupController({
    claimLock: async () => ({}), releaseLock: async () => {}, getSetting: async () => undefined, mutateSettings: async () => {},
    platform: {}, keys, owner: () => "owner", activateFromLocal: async () => { throw failure; }, activateFromRemote: async () => {}
  });
  await assert.rejects(failing.activate(descriptor(), "local", { onError: (error) => errorCallbacks.push(error) }), { code: "MIGRATION_FAILED" });
  assert.deepEqual(errorCallbacks, [failure]);
});

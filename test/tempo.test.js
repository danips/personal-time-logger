import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { normalizeEntry } from "../extension/src/entries.js";
import {
  normalizeTempoIssueId,
  normalizeTempoTaskIssueIds,
  prepareTempoWeek,
  sendTempoWorklogs,
  tempoXhrRequest
} from "../extension/src/tempo.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const fixture = (overrides = {}) => normalizeEntry({
  id: "tempo-entry",
  project: "Project",
  task: "Implementation",
  description: "Built the feature",
  start_at: "2026-07-27T09:00:00.000Z",
  end_at: "2026-07-27T10:00:00.000Z",
  duration_seconds: 3600,
  ...overrides
});

const week = {
  periodStart: "2026-07-27T00:00:00.000Z",
  periodEnd: "2026-08-03T00:00:00.000Z",
  authorAccountId: "account-123",
  taskIssueIds: { Implementation: "10042" }
};

describe("Tempo week preparation", () => {
  it("validates positive numeric issue IDs without losing int64 precision", () => {
    assert.equal(normalizeTempoIssueId(" 00123 "), "123");
    assert.equal(normalizeTempoIssueId("9223372036854775807"), "9223372036854775807");
    assert.equal(normalizeTempoIssueId("0"), "");
    assert.equal(normalizeTempoIssueId("ABC-12"), "");
    assert.deepEqual(normalizeTempoTaskIssueIds({ Task: "42", Invalid: "x" }), { Task: "42" });
  });

  it("uses description as the Tempo comment and groups by cached Task issue ID", () => {
    const prepared = prepareTempoWeek([fixture()], week);

    assert.equal(prepared.totalWorklogs, 1);
    assert.deepEqual(prepared.missingTasks, []);
    assert.deepEqual(prepared.groups, [{
      issueId: "10042",
      worklogs: [{
        authorAccountId: "account-123",
        description: "Built the feature",
        startDate: "2026-07-27",
        timeSpentSeconds: 3600
      }]
    }]);
  });

  it("apportions multiplied time to the displayed week", () => {
    const prepared = prepareTempoWeek([fixture({
      start_at: "2026-07-26T23:00:00.000Z",
      end_at: "2026-07-27T01:00:00.000Z",
      duration_seconds: 10_800,
      multiply: "1.5"
    })], week);

    assert.equal(prepared.groups[0].worklogs[0].timeSpentSeconds, 5400);
    assert.equal(prepared.groups[0].worklogs[0].startDate, "2026-07-27");
  });

  it("reports unknown Tasks once and skips running or deleted entries", () => {
    const prepared = prepareTempoWeek([
      fixture({ id: "one", task: "Unknown" }),
      fixture({ id: "two", task: "Unknown" }),
      fixture({ id: "running", end_at: "", duration_seconds: 0 }),
      fixture({ id: "deleted", deleted_at: "2026-07-28T00:00:00.000Z" })
    ], week);

    assert.deepEqual(prepared.missingTasks, ["Unknown"]);
    assert.equal(prepared.skippedRunning, 1);
    assert.equal(prepared.totalWorklogs, 0);
  });
});

describe("Tempo bulk upload", () => {
  it("keeps the authenticated request in the privileged background context", () => {
    const calendar = readFileSync(join(root, "extension/calendar/calendar.js"), "utf8");
    const background = readFileSync(join(root, "extension/background/background.js"), "utf8");
    const manifest = JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8"));

    assert.doesNotMatch(calendar, /sendTempoWorklogs/);
    assert.match(calendar, /sendRuntimeMessage/);
    assert.match(background, /fetchImpl:\s*tempoXhrRequest/);
    assert.equal(manifest.host_permissions.includes("https://api.tempo.io/*"), false);
    assert.equal(manifest.optional_host_permissions.includes("https://api.tempo.io/*"), true);
  });

  it("builds a privileged XMLHttpRequest suitable for the background page", async () => {
    let request;
    class FakeXmlHttpRequest {
      constructor() {
        request = this;
        this.headers = {};
        this.status = 200;
        this.responseText = "[]";
      }

      open(method, url, async) {
        Object.assign(this, { method, url, async });
      }

      setRequestHeader(name, value) {
        this.headers[name] = value;
      }

      send(body) {
        this.body = body;
        queueMicrotask(() => this.onload());
      }
    }

    const response = await tempoXhrRequest("https://api.tempo.io/4/worklogs/issue/42/bulk", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: "[]"
    }, FakeXmlHttpRequest);

    assert.equal(response.ok, true);
    assert.equal(request.method, "POST");
    assert.equal(request.headers.Authorization, "Bearer token");
    assert.equal(Object.hasOwn(request.headers, "Origin"), false);
    assert.equal(request.timeout, 20_000);
  });

  it("posts at most 50 worklogs per request with bearer authentication", async () => {
    const requests = [];
    const worklogs = Array.from({ length: 51 }, (_, index) => ({
      authorAccountId: "account-123",
      description: `Work ${index}`,
      startDate: "2026-07-27",
      timeSpentSeconds: 60
    }));
    const result = await sendTempoWorklogs([{ issueId: "10042", worklogs }], {
      token: "secret-token",
      requestIntervalMs: 0,
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
    });

    assert.deepEqual(result, { sentWorklogs: 51, requestCount: 2 });
    assert.deepEqual(requests.map((request) => JSON.parse(request.init.body).length), [50, 1]);
    assert.equal(requests[0].url, "https://api.tempo.io/4/worklogs/issue/10042/bulk");
    assert.equal(requests[0].init.headers.Authorization, "Bearer secret-token");
  });

  it("reports partial success so retrying cannot silently duplicate earlier batches", async () => {
    let call = 0;
    await assert.rejects(() => sendTempoWorklogs([
      { issueId: "10", worklogs: [{ timeSpentSeconds: 60 }] },
      { issueId: "20", worklogs: [{ timeSpentSeconds: 60 }] }
    ], {
      token: "token",
      requestIntervalMs: 0,
      fetchImpl: async () => {
        call += 1;
        return call === 1
          ? new Response("[]", { status: 200 })
          : new Response(JSON.stringify({ message: "Not allowed" }), { status: 400 });
      }
    }), (error) => {
      assert.equal(error.code, "TEMPO_PARTIAL");
      assert.match(error.message, /1 worklog was already sent; do not retry the whole week/);
      return true;
    });
  });

  it("codes blocked requests as Tempo network failures", async () => {
    await assert.rejects(() => sendTempoWorklogs([
      { issueId: "10", worklogs: [{ timeSpentSeconds: 60 }] }
    ], {
      token: "token",
      fetchImpl: async () => {
        throw new TypeError("CORS request did not succeed");
      }
    }), (error) => error.code === "TEMPO_NETWORK");
  });
});

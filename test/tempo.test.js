import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeEntry } from "../src/entries.js";
import {
  normalizeTempoIssueId,
  normalizeTempoTaskIssueIds,
  prepareTempoWeek,
  sendTempoWorklogs
} from "../src/tempo.js";

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
    }), /1 worklog was already sent; do not retry the whole week/);
  });
});

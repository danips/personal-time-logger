import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { normalizeEntry } from "../extension/src/entries.js";
import {
  normalizeTempoDayKeys,
  normalizeTempoIssueId,
  normalizeTempoProjectTaskIssueIds,
  normalizeTempoTaskIssueIds,
  prepareTempoWeek,
  tempoProjectTaskKey,
  sendTempoWorklogs,
  tempoXhrRequest
} from "../extension/src/tempo.js";
import { allocateEntryByLocalDay } from "../extension/src/time-allocation.js";
import { entryFingerprint } from "../extension/src/fingerprints.js";
import { addDays, localDateKey } from "../extension/src/time.js";

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

const dayKeyOf = (isoTimestamp) => localDateKey(new Date(isoTimestamp));
const localIso = (year, month, day, hour, minute = 0, second = 0) =>
  new Date(year, month - 1, day, hour, minute, second).toISOString();
const localMidnight = (year, month, day) => new Date(year, month - 1, day);

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
    const entry = fixture();
    const prepared = prepareTempoWeek([entry], week);

    assert.equal(prepared.totalWorklogs, 1);
    assert.deepEqual(prepared.missingTasks, []);
    assert.deepEqual(prepared.groups, [{
      issueId: "10042",
      worklogs: [{
        authorAccountId: "account-123",
        description: "Built the feature",
        startDate: "2026-07-27",
        timeSpentSeconds: 3600,
        entryFingerprint: entryFingerprint(entry)
      }]
    }]);
  });

  it("requires project-plus-task mappings when identical task labels collide", () => {
    const entries = [
      fixture({ id: "project-a", project: "Project A" }),
      fixture({ id: "project-b", project: "Project B" })
    ];
    const withoutCollisionMappings = prepareTempoWeek(entries, {
      ...week,
      taskIssueIds: { Implementation: "10042" }
    });
    assert.equal(withoutCollisionMappings.totalWorklogs, 0);
    assert.deepEqual(withoutCollisionMappings.missingTaskMappings, [
      { project: "Project A", task: "Implementation", key: tempoProjectTaskKey("Project A", "Implementation") },
      { project: "Project B", task: "Implementation", key: tempoProjectTaskKey("Project B", "Implementation") }
    ]);

    const projectMappings = normalizeTempoProjectTaskIssueIds({
      [tempoProjectTaskKey("Project A", "Implementation")]: "10042",
      [tempoProjectTaskKey("Project B", "Implementation")]: "10043"
    });
    const prepared = prepareTempoWeek(entries, { ...week, taskIssueIds: { Implementation: "10042" }, projectTaskIssueIds: projectMappings });
    assert.deepEqual(prepared.groups.map((group) => group.issueId), ["10042", "10043"]);
    assert.equal(prepared.missingTaskMappings.length, 0);
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

  it("splits a midnight crossing into daily allocations and filters after rounding", () => {
    const periodStart = localMidnight(2026, 7, 27);
    const periodEnd = addDays(periodStart, 7);
    const startAt = localIso(2026, 7, 27, 23);
    const endAt = localIso(2026, 7, 28, 1);
    const entry = fixture({ start_at: startAt, end_at: endAt, duration_seconds: 7200 });
    const full = prepareTempoWeek([entry], {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      authorAccountId: "account-123",
      taskIssueIds: { Implementation: "10042" }
    });

    assert.deepEqual(full.groups[0].worklogs.map(({ startDate, timeSpentSeconds }) => ({ startDate, timeSpentSeconds })), [
      { startDate: dayKeyOf(startAt), timeSpentSeconds: 3600 },
      { startDate: dayKeyOf(endAt), timeSpentSeconds: 3600 }
    ]);

    const selected = prepareTempoWeek([entry], {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      authorAccountId: "account-123",
      taskIssueIds: { Implementation: "10042" },
      includedDays: [dayKeyOf(endAt)]
    });
    assert.deepEqual(selected.groups[0].worklogs.map(({ startDate, timeSpentSeconds }) => ({ startDate, timeSpentSeconds })), [
      { startDate: dayKeyOf(endAt), timeSpentSeconds: 3600 }
    ]);
  });

  it("clips before splitting and keeps fractional remainder assignment deterministic", () => {
    const periodStart = localMidnight(2026, 7, 27);
    const periodEnd = addDays(periodStart, 7);
    const clipped = prepareTempoWeek([fixture({
      start_at: localIso(2026, 7, 26, 23),
      end_at: localIso(2026, 7, 27, 1),
      duration_seconds: 7200,
      multiply: "1.500"
    })], {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      authorAccountId: "account-123",
      taskIssueIds: { Implementation: "10042" }
    });
    assert.deepEqual(clipped.groups[0].worklogs.map(({ startDate, timeSpentSeconds }) => ({ startDate, timeSpentSeconds })), [
      { startDate: dayKeyOf(periodStart.toISOString()), timeSpentSeconds: 3600 }
    ]);

    const fractionalStart = localIso(2026, 7, 27, 23, 59, 59);
    const fractionalEnd = localIso(2026, 7, 28, 0, 0, 1);
    const fractional = prepareTempoWeek([fixture({
      start_at: fractionalStart,
      end_at: fractionalEnd,
      duration_seconds: 3,
      multiply: "1.500"
    })], {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      authorAccountId: "account-123",
      taskIssueIds: { Implementation: "10042" }
    });
    assert.deepEqual(fractional.groups[0].worklogs.map(({ startDate, timeSpentSeconds }) => ({ startDate, timeSpentSeconds })), [
      { startDate: dayKeyOf(fractionalStart), timeSpentSeconds: 2 },
      { startDate: dayKeyOf(fractionalEnd), timeSpentSeconds: 1 }
    ]);
    const selectedSecond = prepareTempoWeek([fixture({
      start_at: fractionalStart,
      end_at: fractionalEnd,
      duration_seconds: 3,
      multiply: "1.500"
    })], {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      authorAccountId: "account-123",
      taskIssueIds: { Implementation: "10042" },
      includedDays: [dayKeyOf(fractionalEnd)]
    });
    assert.equal(selectedSecond.groups[0].worklogs[0].timeSpentSeconds, 1);
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

  it("normalizes day keys from any iterable and drops unusable members", () => {
    assert.deepEqual(normalizeTempoDayKeys([" 2026-07-27 ", "", "2026-07-27"]), new Set(["2026-07-27"]));
    assert.deepEqual(normalizeTempoDayKeys(new Set(["2026-07-28"])), new Set(["2026-07-28"]));
    assert.deepEqual(normalizeTempoDayKeys("2026-07-27"), new Set());
    assert.deepEqual(normalizeTempoDayKeys(null), new Set());
    assert.deepEqual(normalizeTempoDayKeys(42), new Set());
  });

  it("sends only the selected days of the period", () => {
    const monday = fixture({ id: "monday" });
    const tuesday = fixture({
        id: "tuesday",
        start_at: "2026-07-28T09:00:00.000Z",
        end_at: "2026-07-28T11:00:00.000Z",
        duration_seconds: 7200
      });
    const prepared = prepareTempoWeek([monday, tuesday], { ...week, includedDays: [dayKeyOf("2026-07-28T09:00:00.000Z")] });

    assert.equal(prepared.totalWorklogs, 1);
    assert.equal(prepared.skippedExcludedDays, 1);
    assert.deepEqual(prepared.groups[0].worklogs, [{
      authorAccountId: "account-123",
      description: "Built the feature",
      startDate: dayKeyOf("2026-07-28T09:00:00.000Z"),
      timeSpentSeconds: 7200,
      entryFingerprint: entryFingerprint(tuesday)
    }]);
  });

  // The calendar prompts for every missing Task mapping, so a day nobody selected
  // must drop out first or unselecting a day still interrogates the user about it.
  it("excludes unselected days before collecting missing Task mappings", () => {
    const prepared = prepareTempoWeek([
      fixture({ id: "mapped" }),
      fixture({
        id: "unmapped",
        task: "Unknown",
        start_at: "2026-07-28T09:00:00.000Z",
        end_at: "2026-07-28T10:00:00.000Z"
      })
    ], { ...week, includedDays: [dayKeyOf("2026-07-27T09:00:00.000Z")] });

    assert.deepEqual(prepared.missingTasks, []);
    assert.equal(prepared.skippedExcludedDays, 1);
    assert.equal(prepared.totalWorklogs, 1);
  });

  it("only warns about running timers on days the send covers", () => {
    const running = fixture({
      id: "running",
      start_at: "2026-07-28T09:00:00.000Z",
      end_at: "",
      duration_seconds: 0
    });

    assert.equal(prepareTempoWeek([running], week).skippedRunning, 1);
    assert.equal(prepareTempoWeek([running], {
      ...week,
      includedDays: [dayKeyOf(running.start_at)]
    }).skippedRunning, 1);
    assert.equal(prepareTempoWeek([running], {
      ...week,
      includedDays: [dayKeyOf("2026-07-27T09:00:00.000Z")]
    }).skippedRunning, 0);
  });

  // An empty selection must never be read as "no filter", or clearing every
  // checkbox would send the whole week instead of nothing.
  it("separates an omitted selection from an empty one", () => {
    const entries = [fixture()];

    assert.equal(prepareTempoWeek(entries, week).totalWorklogs, 1);
    assert.equal(prepareTempoWeek(entries, { ...week, includedDays: undefined }).totalWorklogs, 1);
    assert.equal(prepareTempoWeek(entries, { ...week, includedDays: null }).totalWorklogs, 1);
    assert.equal(prepareTempoWeek(entries, { ...week, includedDays: [] }).totalWorklogs, 0);
    assert.equal(prepareTempoWeek(entries, { ...week, includedDays: new Set() }).skippedExcludedDays, 1);
  });
});

describe("Tempo civil-day allocation", () => {
  it("uses each zone's elapsed length for a DST civil day", () => {
    const zone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const transition = zone === "Europe/Lisbon"
      ? [2026, 3, 29, 23 * 3600]
      : zone === "Australia/Lord_Howe"
        ? [2026, 4, 5, 24.5 * 3600]
        : [2026, 3, 29];
    const [year, month, day, expectedTransitionSeconds] = transition;
    const start = localMidnight(year, month, day);
    const end = addDays(start, 1);
    const expectedSeconds = expectedTransitionSeconds || (end.getTime() - start.getTime()) / 1000;
    const allocations = allocateEntryByLocalDay(fixture({
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      duration_seconds: expectedSeconds
    }));

    assert.equal(allocations.length, 1);
    assert.equal(allocations[0].actualSeconds, expectedSeconds);
    assert.equal(allocations[0].effectiveSeconds, expectedSeconds);
  });
});

describe("Tempo bulk upload", () => {
  it("keeps the authenticated request in the privileged background context", () => {
    const calendar = readFileSync(join(root, "extension/calendar/calendar.js"), "utf8");
    const tempoController = readFileSync(join(root, "extension/calendar/tempo-controller.js"), "utf8");
    const background = readFileSync(join(root, "extension/background/background.js"), "utf8");
    const manifest = JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8"));

    assert.doesNotMatch(calendar, /sendTempoWorklogs/);
    assert.match(tempoController, /sendRuntimeMessage/);
    assert.match(background, /createTempoUploadHandler/);
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

    assert.deepEqual(result, {
      sentWorklogs: 51,
      acknowledgedWorklogs: 51,
      requestCount: 2,
      currentRequestOutcome: "acknowledged"
    });
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
      assert.equal(error.acknowledgedWorklogs, 1);
      assert.equal(error.requestCount, 2);
      assert.equal(error.currentRequestOutcome, "rejected");
      assert.match(error.message, /1 worklog was already sent; do not retry the whole week/);
      return true;
    });
  });

  it("cancels between chunks while preserving the acknowledged current request", async () => {
    const requests = [];
    let cancel = false;
    const worklogs = Array.from({ length: 51 }, (_, index) => ({
      authorAccountId: "account-123",
      description: `Work ${index}`,
      startDate: "2026-07-27",
      timeSpentSeconds: 60
    }));
    await assert.rejects(() => sendTempoWorklogs([{ issueId: "10042", worklogs }], {
      token: "secret-token",
      requestIntervalMs: 0,
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return new Response("[]", { status: 200 });
      },
      onChunkOutcome: async ({ outcome }) => {
        if (outcome === "acknowledged") cancel = true;
      },
      shouldCancel: () => cancel
    }), (error) => {
      assert.equal(error.code, "TEMPO_CANCELLED");
      assert.equal(error.acknowledgedWorklogs, 50);
      assert.equal(error.requestCount, 1);
      assert.equal(error.currentRequestOutcome, "acknowledged");
      assert.match(error.message, /no future chunks were sent/);
      return true;
    });
    assert.equal(requests.length, 1);
    assert.equal(JSON.parse(requests[0].init.body).length, 50);
  });

  it("codes blocked requests as Tempo network failures", async () => {
    await assert.rejects(() => sendTempoWorklogs([
      { issueId: "10", worklogs: [{ timeSpentSeconds: 60 }] }
    ], {
      token: "token",
      fetchImpl: async () => {
        throw new TypeError("CORS request did not succeed");
      }
    }), (error) => {
      assert.equal(error.code, "TEMPO_NETWORK");
      assert.equal(error.acknowledgedWorklogs, 0);
      assert.equal(error.requestCount, 1);
      assert.equal(error.currentRequestOutcome, "unknown");
      return true;
    });
  });
});

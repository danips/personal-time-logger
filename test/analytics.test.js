import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  LONG_SESSION_SECONDS,
  SHORT_ANOMALY_SECONDS,
  STALE_ACTIVE_SECONDS,
  aggregateDescriptions,
  aggregatePeriod,
  aggregateProjects,
  buildAnalyticsReport,
  comparisonDelta,
  detectAnomalies,
  fragmentationMetrics,
  sessionsForPeriod
} from "../extension/src/analytics.js";

process.env.TZ = "Europe/Lisbon";

const primary = { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-09-08T00:00:00Z") };
const comparison = { start: new Date("2026-08-25T00:00:00Z"), end: new Date("2026-09-01T00:00:00Z") };
const now = new Date("2026-09-07T18:00:00Z");

function entry(id, start, end, overrides = {}) {
  const actual = end ? (new Date(end) - new Date(start)) / 1000 : 0;
  return {
    id,
    project: "Alpha",
    task: "Build",
    description: "Code review",
    start_at: start,
    end_at: end,
    duration_seconds: actual,
    status: "synced",
    ...overrides
  };
}

describe("clipped analytics sessions and totals", () => {
  it("clips completed, multiplied, spanning, and running entries canonically", () => {
    const entries = [
      entry("ordinary", "2026-09-02T10:00:00Z", "2026-09-02T11:00:00Z"),
      entry("multiplied", "2026-09-03T10:00:00Z", "2026-09-03T12:00:00Z", { duration_seconds: 10_800 }),
      entry("boundary", "2026-08-31T23:00:00Z", "2026-09-01T01:00:00Z", { duration_seconds: 14_400 }),
      entry("running", "2026-09-07T17:00:00Z", "", { duration_seconds: 0 }),
      entry("invalid", "2026-09-04T10:00:00Z", "2026-09-04T10:00:00Z")
    ];
    const sessions = sessionsForPeriod(entries, primary, { now });
    assert.equal(sessions.length, 4);
    assert.equal(sessions.find(({ entry: value }) => value.id === "multiplied").actualSeconds, 7200);
    assert.equal(sessions.find(({ entry: value }) => value.id === "multiplied").effectiveSeconds, 10_800);
    assert.equal(sessions.find(({ entry: value }) => value.id === "boundary").effectiveSeconds, 7200);
    assert.equal(sessions.find(({ entry: value }) => value.id === "running").actualSeconds, 3600);
  });

  it("counts logged local days without splitting sessions", () => {
    const crossing = entry("midnight", "2026-09-02T22:00:00Z", "2026-09-03T02:00:00Z", { duration_seconds: 28_800 });
    const sessions = sessionsForPeriod([crossing], primary, { now });
    const totals = aggregatePeriod(sessions, { entries: [crossing], period: primary, now });
    assert.equal(totals.sessionCount, 1);
    assert.equal(totals.loggedDays, 2);
    assert.equal(totals.totalEffectiveSeconds, 28_800);
    assert.equal(totals.averageEffectiveSecondsPerLoggedDay, 14_400);
    assert.equal(totals.averageActualSessionSeconds, 14_400);
  });

  it("returns stable zero metrics for an empty report", () => {
    const totals = aggregatePeriod([], { entries: [], period: primary, now });
    assert.deepEqual(totals, {
      totalEffectiveSeconds: 0,
      loggedDays: 0,
      averageEffectiveSecondsPerLoggedDay: 0,
      sessionCount: 0,
      averageActualSessionSeconds: 0,
      medianActualSessionSeconds: 0,
      longestActualSessionSeconds: 0
    });
  });

  it("allocates one multiplied entry independently across comparison and primary periods", () => {
    const spanning = entry("spanning", "2026-08-31T23:00:00Z", "2026-09-01T01:00:00Z", {
      duration_seconds: 14_400
    });
    const report = buildAnalyticsReport([spanning], { primary, comparison, now });

    assert.equal(report.primary.sessionCount, 1);
    assert.equal(report.comparison.sessionCount, 1);
    assert.equal(report.primary.totalEffectiveSeconds, 7200);
    assert.equal(report.comparison.totalEffectiveSeconds, 7200);
    assert.equal(sessionsForPeriod([spanning], primary, { now })[0].actualSeconds, 3600);
    assert.equal(sessionsForPeriod([spanning], comparison, { now })[0].actualSeconds, 3600);
  });
});

describe("comparison and hierarchy", () => {
  it("uses finite zero and New deltas", () => {
    assert.deepEqual(comparisonDelta(0, 0), { kind: "percent", percent: 0 });
    assert.deepEqual(comparisonDelta(1, 0), { kind: "new", percent: null });
    assert.deepEqual(comparisonDelta(150, 100), { kind: "percent", percent: 50 });
  });

  it("keeps tasks scoped to projects and applies fallback labels", () => {
    const sessions = sessionsForPeriod([
      entry("a", "2026-09-02T09:00:00Z", "2026-09-02T10:00:00Z", { project: "Beta", task: "Shared" }),
      entry("b", "2026-09-02T10:00:00Z", "2026-09-02T11:00:00Z", { project: "Alpha", task: "Shared" }),
      entry("c", "2026-09-02T11:00:00Z", "2026-09-02T11:30:00Z", { project: " ", task: "" })
    ], primary, { now });
    const projects = aggregateProjects(sessions, [], 9000);
    assert.deepEqual(projects.map(({ label }) => label), ["Alpha", "Beta", "No project"]);
    assert.equal(projects[0].tasks[0].label, "Shared");
    assert.equal(projects[2].tasks[0].label, "No task");
    assert.equal(projects[0].delta.kind, "new");
  });

  it("retains comparison-only project and task rows with deterministic sorting", () => {
    const report = buildAnalyticsReport([
      entry("old-beta", "2026-08-26T09:00:00Z", "2026-08-26T10:00:00Z", { project: "Old Beta", task: "Previous task" }),
      entry("old-alpha", "2026-08-27T09:00:00Z", "2026-08-27T10:00:00Z", { project: "Old Alpha", task: "Previous task" })
    ], { primary, comparison, now });

    assert.deepEqual(report.projects.map(({ label }) => label), ["Old Alpha", "Old Beta"]);
    const project = report.projects[0];
    assert.equal(project.currentSeconds, 0);
    assert.equal(project.previousSeconds, 3600);
    assert.equal(project.share, 0);
    assert.deepEqual(project.delta, { kind: "percent", percent: -100 });
    assert.equal(project.tasks[0].currentSeconds, 0);
    assert.equal(project.tasks[0].previousSeconds, 3600);
    assert.deepEqual(project.tasks[0].delta, { kind: "percent", percent: -100 });
  });
});

describe("description frequency", () => {
  it("normalizes case/whitespace, preserves punctuation, and selects a representative", () => {
    const sessions = sessionsForPeriod([
      entry("a", "2026-09-02T09:00:00Z", "2026-09-02T10:00:00Z", { description: "Code review" }),
      entry("b", "2026-09-02T10:00:00Z", "2026-09-02T11:00:00Z", { description: " code   review ", duration_seconds: 7200 }),
      entry("c", "2026-09-02T11:00:00Z", "2026-09-02T12:00:00Z", { description: "CODE REVIEW" }),
      entry("d", "2026-09-02T12:00:00Z", "2026-09-02T13:00:00Z", { description: "Code review!" }),
      entry("e", "2026-09-02T13:00:00Z", "2026-09-02T14:00:00Z", { description: "   " })
    ], primary, { now });
    const rows = aggregateDescriptions(sessions, [], 18_000);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].description, "CODE REVIEW");
    assert.equal(rows[0].sessionCount, 3);
    assert.equal(rows[0].currentSeconds, 14_400);
    assert.equal(rows[0].averageSeconds, 4800);
    assert.equal(rows[1].description, "Code review!");
  });

  it("uses the strictly most frequent exact trimmed spelling as representative", () => {
    const sessions = sessionsForPeriod([
      entry("a", "2026-09-02T09:00:00Z", "2026-09-02T10:00:00Z", { description: "Code Review" }),
      entry("b", "2026-09-02T10:00:00Z", "2026-09-02T11:00:00Z", { description: "  Code Review  " }),
      entry("c", "2026-09-02T11:00:00Z", "2026-09-02T12:00:00Z", { description: "code review" }),
      entry("d", "2026-09-02T12:00:00Z", "2026-09-02T13:00:00Z", { description: " CODE   REVIEW " })
    ], primary, { now });

    const [row] = aggregateDescriptions(sessions, [], 14_400);
    assert.equal(row.description, "Code Review");
    assert.equal(row.sessionCount, 4);
  });

  it("keeps the calculated average represented in the description table", () => {
    const html = readFileSync(new URL("../extension/analytics/analytics.html", import.meta.url), "utf8");
    const javascript = readFileSync(new URL("../extension/analytics/analytics.js", import.meta.url), "utf8");
    assert.match(html, /<th scope="col">Average<\/th>/);
    assert.match(javascript, /duration\(row\.averageSeconds\)/);
  });
});

describe("fragmentation", () => {
  it("uses actual intervals, the exact gap boundary, and scoped task pairs", () => {
    const sessions = sessionsForPeriod([
      entry("a", "2026-09-02T09:00:00Z", "2026-09-02T09:10:00Z", { duration_seconds: 3600 }),
      entry("b", "2026-09-02T09:40:00Z", "2026-09-02T10:00:00Z", { task: "Test" }),
      entry("c", "2026-09-02T10:00:00Z", "2026-09-02T11:00:00Z", { project: "Beta", task: "Test" }),
      entry("d", "2026-09-02T11:30:01Z", "2026-09-02T13:00:01Z", { project: "Beta", task: "Test" })
    ], primary, { now });
    const metrics = fragmentationMetrics(sessions);
    assert.equal(metrics.switchEligibleTransitions, 2);
    assert.equal(metrics.projectSwitches, 1);
    assert.equal(metrics.taskSwitches, 2);
    assert.equal(metrics.shortSessionCount, 1);
    assert.equal(metrics.buckets.under15, 1);
    assert.equal(metrics.buckets["1to2"], 2);
  });

  it("treats overlaps as eligible and ignores multiplier tails", () => {
    const sessions = sessionsForPeriod([
      entry("a", "2026-09-02T09:00:00Z", "2026-09-02T10:00:00Z", { duration_seconds: 18_000 }),
      entry("b", "2026-09-02T09:30:00Z", "2026-09-02T10:00:00Z", { task: "Test" })
    ], primary, { now });
    const metrics = fragmentationMetrics(sessions);
    assert.equal(metrics.switchEligibleTransitions, 1);
    assert.equal(metrics.buckets["30to60"], 1);
    assert.equal(metrics.buckets["1to2"], 1);
  });

  it("counts an eligible same-project and same-task transition without a switch", () => {
    const sessions = sessionsForPeriod([
      entry("a", "2026-09-02T09:00:00Z", "2026-09-02T10:00:00Z"),
      entry("b", "2026-09-02T10:20:00Z", "2026-09-02T11:00:00Z")
    ], primary, { now });
    const metrics = fragmentationMetrics(sessions);
    assert.equal(metrics.switchEligibleTransitions, 1);
    assert.equal(metrics.projectSwitches, 0);
    assert.equal(metrics.taskSwitches, 0);
  });

  it("does not count a project or task change after a long overnight gap", () => {
    const sessions = sessionsForPeriod([
      entry("a", "2026-09-02T17:00:00Z", "2026-09-02T18:00:00Z"),
      entry("b", "2026-09-03T09:00:00Z", "2026-09-03T10:00:00Z", { project: "Beta", task: "Test" })
    ], primary, { now });
    const metrics = fragmentationMetrics(sessions);
    assert.equal(metrics.switchEligibleTransitions, 0);
    assert.equal(metrics.projectSwitches, 0);
    assert.equal(metrics.taskSwitches, 0);
  });
});

describe("deterministic anomalies", () => {
  it("detects every threshold and permits multiple records per entry", () => {
    const sessions = sessionsForPeriod([
      entry("short", "2026-09-02T09:00:00Z", "2026-09-02T09:01:00Z", { project: "", task: "", status: "needs_review" }),
      entry("not-short", "2026-09-02T10:00:00Z", "2026-09-02T10:01:01Z"),
      entry("long", "2026-09-03T09:00:00Z", "2026-09-03T15:00:00Z"),
      entry("stale", "2026-09-07T10:00:00Z", ""),
      entry("fresh", "2026-09-07T11:00:01Z", "")
    ], primary, { now });
    const anomalies = detectAnomalies(sessions, { now });
    assert.equal(SHORT_ANOMALY_SECONDS, 60);
    assert.equal(LONG_SESSION_SECONDS, 21_600);
    assert.equal(STALE_ACTIVE_SECONDS, 28_800);
    assert.equal(anomalies.filter(({ entryId }) => entryId === "short").length, 4);
    assert.ok(anomalies.some(({ type, entryId }) => type === "very_long" && entryId === "long"));
    assert.ok(anomalies.some(({ type, entryId }) => type === "stale_active" && entryId === "stale"));
    assert.ok(!anomalies.some(({ type, entryId }) => type === "very_short" && entryId === "not-short"));
    assert.ok(!anomalies.some(({ type, entryId }) => type === "stale_active" && entryId === "fresh"));
  });

  it("emits overlapping pairs once but not adjacent or effective-only tails", () => {
    const sessions = sessionsForPeriod([
      entry("a", "2026-09-02T09:00:00Z", "2026-09-02T10:00:00Z", { duration_seconds: 18_000 }),
      entry("b", "2026-09-02T09:30:00Z", "2026-09-02T10:30:00Z"),
      entry("c", "2026-09-02T10:00:00Z", "2026-09-02T11:00:00Z")
    ], primary, { now });
    const overlaps = detectAnomalies(sessions, { now }).filter(({ type }) => type === "overlap");
    assert.deepEqual(overlaps.map(({ entryId, relatedEntryId }) => [entryId, relatedEntryId]), [["b", "c"], ["a", "b"]]);
  });

  it("handles multiple stale active entries and reports their overlap once", () => {
    const activeNow = new Date("2026-09-07T18:00:00Z");
    const running = [
      entry("active-a", "2026-09-07T08:00:00Z", ""),
      entry("active-b", "2026-09-07T09:00:00Z", "")
    ];
    const report = buildAnalyticsReport(running, { primary, comparison, now: activeNow });
    const stale = report.anomalies.filter(({ type }) => type === "stale_active");
    const overlaps = report.anomalies.filter(({ type }) => type === "overlap");

    assert.equal(report.primary.sessionCount, 2);
    assert.deepEqual(stale.map(({ entryId }) => entryId), ["active-b", "active-a"]);
    assert.deepEqual(overlaps.map(({ entryId, relatedEntryId }) => [entryId, relatedEntryId]), [["active-a", "active-b"]]);
    assert.deepEqual(report.anomalies.map(({ type }) => type), ["stale_active", "stale_active", "overlap"]);
  });
});

describe("composed report", () => {
  it("builds current/comparison metrics and all report families", () => {
    const report = buildAnalyticsReport([
      entry("old", "2026-08-26T09:00:00Z", "2026-08-26T10:00:00Z"),
      entry("new", "2026-09-02T09:00:00Z", "2026-09-02T11:00:00Z", { project: "Beta", task: "Plan", description: "Planning" })
    ], { primary, comparison, now });
    assert.equal(report.primary.totalEffectiveSeconds, 7200);
    assert.equal(report.comparison.totalEffectiveSeconds, 3600);
    assert.equal(report.deltas.totalEffectiveSeconds.percent, 100);
    assert.equal(report.projects[0].label, "Beta");
    assert.equal(report.descriptions[0].description, "Planning");
    assert.equal(report.fragmentation.sessionCount, 1);
    assert.equal(report.anomalies.length, 0);
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { serializeAnalyticsReport } from "../extension/src/analytics-export.js";

function report() {
  return {
    primary: {
      totalActualSeconds: 3600,
      totalEffectiveSeconds: 5400,
      loggedDays: 1,
      sessionCount: 1,
      averageActualSessionSeconds: 3600,
      medianActualSessionSeconds: 3600,
      longestActualSessionSeconds: 3600
    },
    comparison: {
      totalActualSeconds: 1800,
      totalEffectiveSeconds: 1800,
      loggedDays: 1,
      sessionCount: 1,
      averageActualSessionSeconds: 1800,
      medianActualSessionSeconds: 1800,
      longestActualSessionSeconds: 1800
    },
    fragmentation: { projectSwitches: 0, taskSwitches: 0, shortSessionCount: 0 },
    anomalies: {
      totalCount: 1,
      omittedOverlapCount: 0,
      rows: [{
        type: "needs_review",
        start: "2026-09-02T09:00:00.000Z",
        project: "=Dangerous project",
        task: "@Dangerous task",
        message: "line 1\nline 2",
        entryId: "entry-1",
        relatedEntryId: ""
      }]
    },
    projects: [{
      label: "=Dangerous project",
      currentSeconds: 3600,
      previousSeconds: 1800,
      share: 2 / 3,
      tasks: [{ label: "quoted, task", currentSeconds: 3600, previousSeconds: 1800, share: 2 / 3 }]
    }],
    descriptions: [{
      description: "description\nwith \"quotes\"",
      sessionCount: 1,
      currentSeconds: 3600,
      averageSeconds: 3600,
      share: 2 / 3,
      previousSeconds: 1800
    }]
  };
}

describe("analytics CSV export", () => {
  it("provides print styling that removes report controls", () => {
    const css = readFileSync(new URL("../extension/analytics/analytics.css", import.meta.url), "utf8");
    assert.match(css, /@media print/);
    assert.match(css, /\.period-controls, \.report-actions, \.analytics-filters/);
  });

  it("exports the filtered report snapshot with ranges, timezone, and actual/effective labels", () => {
    const csv = serializeAnalyticsReport(report(), {
      primaryRange: "Sep 2, 2026",
      comparisonRange: "Sep 1, 2026",
      timezone: "Europe/Lisbon",
      filters: { project: "=Dangerous project", task: "@Dangerous task" }
    });
    assert.match(csv, /Timezone,Europe\/Lisbon/);
    assert.match(csv, /Current range,"Sep 2, 2026"/);
    assert.match(csv, /Total actual time \(seconds\),3600,1800,100\.0%/);
    assert.match(csv, /Total effective time \(seconds\),5400,1800,200\.0%/);
    assert.match(csv, /'=Dangerous project/);
    assert.match(csv, /'@Dangerous task/);
    assert.match(csv, /"description\r?\nwith ""quotes"""/);
  });

  it("keeps numeric columns numeric while neutralizing text formula prefixes", () => {
    const csv = serializeAnalyticsReport(report());
    assert.match(csv, /,3600,1800,100\.0%/);
    assert.doesNotMatch(csv, /Total actual time \(seconds\),'3600/);
    assert.match(csv, /"=Dangerous project"|'=Dangerous project/);
  });

  it("includes omitted overlap accounting from the same report", () => {
    const value = report();
    value.anomalies.rows = [];
    value.anomalies.totalCount = 4;
    value.anomalies.omittedOverlapCount = 4;
    const csv = serializeAnalyticsReport(value);
    assert.match(csv, /overlap pairs omitted,,,,4,,/);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { entriesToCsv } from "../src/csv.js";
import { normalizeEntry } from "../src/entries.js";

const fixture = (over = {}) => normalizeEntry({
  id: "entry-1",
  project: "Project",
  task: "Task",
  start_at: "2026-07-27T09:00:00.000Z",
  end_at: "2026-07-27T10:00:00.000Z",
  duration_seconds: 3600,
  ...over
});

const rows = (csv) => csv.split("\n");
const columns = (line) => line.split(",");

describe("entriesToCsv", () => {
  it("always emits a header row", () => {
    const [header] = rows(entriesToCsv([]));
    assert.match(header, /^Entry ID,Allocation Start \(ISO\),Allocation End \(ISO\),Project,Task,Description/);
    assert.match(header, /Status$/);
  });

  it("writes one row per exported entry", () => {
    assert.equal(rows(entriesToCsv([fixture(), fixture({ id: "entry-2" })])).length, 3);
  });

  it("omits deleted entries", () => {
    const csv = entriesToCsv([fixture({ deleted_at: "2026-07-27T11:00:00.000Z" })]);
    assert.equal(rows(csv).length, 1);
  });

  it("includes a running entry with empty end columns and a running status", () => {
    const csv = entriesToCsv([fixture({ end_at: "", duration_seconds: 0 })]);
    const cells = columns(rows(csv)[1]);

    assert.equal(cells.at(-1), "running");
    // End Date and End Time sit at indexes 8 and 9.
    assert.equal(cells[8], "");
    assert.equal(cells[9], "");
    // The multiplied duration is unknown until the timer stops.
    assert.equal(cells[11], "");
  });

  it("labels completed and review entries", () => {
    assert.equal(columns(rows(entriesToCsv([fixture()]))[1]).at(-1), "completed");
    assert.equal(
      columns(rows(entriesToCsv([fixture({ status: "needs_review" })]))[1]).at(-1),
      "needs_review"
    );
  });

  it("reports both actual and multiplied hours", () => {
    const cells = columns(rows(entriesToCsv([fixture({ duration_seconds: 5400 })]))[1]);
    assert.equal(cells[10], "1.00");
    assert.equal(cells[11], "1.50");
  });

  it("quotes values containing a comma, quote or newline", () => {
    const csv = entriesToCsv([fixture({ project: "A,B", task: 'say "hi"', description: "one\ntwo" })]);
    const line = rows(csv).slice(1).join("\n");

    assert.match(line, /"A,B"/);
    assert.match(line, /"say ""hi"""/);
    assert.match(line, /"one\ntwo"/);
  });

  it("exports only the proportional allocation inside a requested period", () => {
    const csv = entriesToCsv([fixture({
      start_at: "2026-07-26T23:00:00.000Z",
      end_at: "2026-07-27T01:00:00.000Z",
      duration_seconds: 10_800,
      multiply: "1.5"
    })], {
      periodStart: "2026-07-27T00:00:00.000Z",
      periodEnd: "2026-08-03T00:00:00.000Z"
    });
    const cells = columns(rows(csv)[1]);

    assert.equal(cells[0], "entry-1");
    assert.equal(cells[1], "2026-07-27T00:00:00.000Z");
    assert.equal(cells[2], "2026-07-27T01:00:00.000Z");
    assert.equal(cells[10], "1.00");
    assert.equal(cells[11], "1.50");
  });

  it("neutralizes spreadsheet formula fields", () => {
    const csv = entriesToCsv([fixture({
      project: "=SUM(A1:A2)",
      task: "+1+1",
      description: "\tunsafe"
    })]);

    assert.match(csv, /'=SUM\(A1:A2\)/);
    assert.match(csv, /'\+1\+1/);
    assert.match(csv, /'\tunsafe/);
  });
});

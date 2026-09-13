import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  runStaleTimerReminders,
  staleTimerNotification,
  staleTimerReminderCandidates
} from "../extension/src/timer-reminders.js";

const entry = (over = {}) => ({
  id: "timer-1",
  task: "Overnight work",
  project: "Project",
  start_at: "2026-09-12T00:00:00.000Z",
  end_at: "",
  deleted_at: "",
  revision: 3,
  ...over
});

describe("stale timer reminders", () => {
  it("finds old active timers without changing entries", () => {
    const candidates = staleTimerReminderCandidates([entry(), entry({ id: "fresh", start_at: "2026-09-12T09:00:00.000Z" })], {
      now: "2026-09-12T08:01:00.000Z",
      thresholdSeconds: 8 * 60 * 60
    });
    assert.deepEqual(candidates.map(({ entry: value }) => value.id), ["timer-1"]);
    assert.match(staleTimerNotification(candidates[0]).message, /8 hours/);
  });

  it("is opt-in and deduplicates one notification per revision", async () => {
    const calls = [];
    const notify = async (id, details) => calls.push({ id, details });
    assert.deepEqual(await runStaleTimerReminders({ enabled: false, entries: [entry()], notify, now: "2026-09-12T08:00:00.000Z" }), { created: [], notified: {} });
    const first = await runStaleTimerReminders({ enabled: true, entries: [entry()], notify, now: "2026-09-12T08:00:00.000Z" });
    const second = await runStaleTimerReminders({ enabled: true, entries: [entry()], notified: first.notified, notify, now: "2026-09-12T09:00:00.000Z" });
    const changed = await runStaleTimerReminders({ enabled: true, entries: [entry({ revision: 4 })], notified: second.notified, notify, now: "2026-09-12T09:00:00.000Z" });
    assert.equal(first.created.length, 1);
    assert.deepEqual(second.created, []);
    assert.equal(changed.created.length, 1);
    assert.equal(calls.length, 2);
  });
});

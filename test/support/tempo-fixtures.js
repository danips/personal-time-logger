import { normalizeEntry } from "../../extension/src/entries.js";
import { tempoAllocationIdentity } from "../../extension/src/tempo-submission-ledger.js";
import { prepareTempoWeek, tempoXhrRequest } from "../../extension/src/tempo.js";

export const tempoCalendarUrl = "moz-extension://smoke/calendar/calendar.html";
export const tempoPlatform = { getURL: (path) => `moz-extension://smoke/${path}` };

export const tempoEntry = normalizeEntry({
  id: "controller-entry",
  project: "Project",
  task: "Implementation",
  description: "Build preview",
  start_at: "2026-09-08T09:00:00.000Z",
  end_at: "2026-09-08T10:00:00.000Z",
  duration_seconds: 3600,
  created_at: "2026-09-08T10:00:00.000Z",
  updated_at: "2026-09-08T10:00:00.000Z",
  revision: 1
});

export const tempoSnapshot = {
  weekStart: new Date("2026-09-07T00:00:00.000Z"),
  weekEnd: new Date("2026-09-14T00:00:00.000Z"),
  entries: [tempoEntry]
};

export const tempoSelection = {
  includedDays: new Set(["2026-09-08"]),
  noneSelected: false,
  scopeLabel: "1 selected day",
  repeatScopeLabel: "day"
};

export function tempoPreparation(overrides = {}) {
  return prepareTempoWeek([tempoEntry], {
    periodStart: tempoSnapshot.weekStart,
    periodEnd: tempoSnapshot.weekEnd,
    authorAccountId: "author-1",
    taskIssueIds: { Implementation: "123" },
    includedDays: tempoSelection.includedDays,
    ...overrides
  });
}

export function tempoPreparedWorklog(overrides = {}) {
  return tempoPreparation(overrides).groups[0].worklogs[0];
}

export function tempoAllocationKey(worklog = tempoPreparedWorklog(), issueId = "123", authorAccountId = "author-1") {
  return tempoAllocationIdentity({
    entryFingerprint: worklog.entryFingerprint,
    localDate: worklog.startDate,
    timeSpentSeconds: worklog.timeSpentSeconds,
    issueId,
    authorAccountId
  }).key;
}

export const tempoGroup = (over = {}) => ({
  issueId: "42",
  worklogs: [{
    authorAccountId: "author-1",
    description: "Work comment",
    startDate: "2026-09-12",
    timeSpentSeconds: 3600,
    entryFingerprint: "entry-1",
    ...over
  }]
});

export function tempoResponse(status, body = "[]") {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

export function tempoXhrTransport({ status = 200, responseText = "[]", event = "load", onSend } = {}) {
  return (url, init) => tempoXhrRequest(url, init, class FakeXmlHttpRequest {
    constructor() {
      this.status = status;
      this.responseText = responseText;
    }

    open(method, requestUrl, async) {
      Object.assign(this, { method, url: requestUrl, async });
    }

    setRequestHeader() {}

    send(body) {
      onSend?.({ url: this.url, init, body });
      queueMicrotask(() => this[`on${event}`]());
    }
  });
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTempoController, buildTempoPreviewRows } from "../extension/calendar/tempo-controller.js";
import { tempoAllocationIdentity } from "../extension/src/tempo-submission-ledger.js";
import { normalizeEntry } from "../extension/src/entries.js";
import { prepareTempoWeek } from "../extension/src/tempo.js";

const entry = normalizeEntry({
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

const snapshot = {
  weekStart: new Date("2026-09-07T00:00:00.000Z"),
  weekEnd: new Date("2026-09-14T00:00:00.000Z"),
  entries: [entry]
};

const selection = {
  includedDays: new Set(["2026-09-08"]),
  noneSelected: false,
  scopeLabel: "1 selected day",
  repeatScopeLabel: "day"
};

describe("Tempo preview model", () => {
  it("includes task, project, daily seconds, hours, and ledger presentation", () => {
    const prepared = prepareTempoWeek([entry], {
      periodStart: snapshot.weekStart,
      periodEnd: snapshot.weekEnd,
      authorAccountId: "author-1",
      taskIssueIds: { Implementation: "123" },
      includedDays: selection.includedDays
    });
    const worklog = prepared.groups[0].worklogs[0];
    const key = tempoAllocationIdentity({
      entryFingerprint: worklog.entryFingerprint,
      localDate: worklog.startDate,
      timeSpentSeconds: worklog.timeSpentSeconds,
      issueId: "123",
      authorAccountId: "author-1"
    }).key;
    const rows = buildTempoPreviewRows(prepared, snapshot, new Map([[key, {
      state: "acknowledged",
      history: "known"
    }]]), "author-1");

    assert.deepEqual(rows[0], {
      ...worklog,
      key,
      issueId: "123",
      task: "Implementation",
      project: "Project",
      hours: "1.00",
      kind: "acknowledged",
      label: "Acknowledged · resend",
      selected: false,
      resend: true
    });
  });

  it("selects post-tracking unsent allocations and leaves historical work for review", () => {
    const prepared = prepareTempoWeek([entry], {
      periodStart: snapshot.weekStart,
      periodEnd: snapshot.weekEnd,
      authorAccountId: "author-1",
      taskIssueIds: { Implementation: "123" },
      includedDays: selection.includedDays
    });
    const worklog = prepared.groups[0].worklogs[0];
    const key = tempoAllocationIdentity({
      entryFingerprint: worklog.entryFingerprint,
      localDate: worklog.startDate,
      timeSpentSeconds: worklog.timeSpentSeconds,
      issueId: "123",
      authorAccountId: "author-1"
    }).key;
    const rows = buildTempoPreviewRows(prepared, snapshot, new Map([[key, {
      state: "unsent",
      reason: "unsent",
      eligible: true
    }]]), "author-1");

    assert.equal(rows[0].kind, "unsent");
    assert.equal(rows[0].selected, true);
    assert.equal(rows[0].resend, false);
  });
});

describe("Tempo controller preview flow", () => {
  it("keeps mapping edits in the preview, re-prepares allocations, and sends only selected rows", async () => {
    const previews = [];
    const settingWrites = [];
    let request;
    const controller = createTempoController({
      getSnapshot: () => snapshot,
      currentSelection: () => selection,
      getSetting: async (key, fallback) => key === "tempo_api_token" ? "token" : key === "tempo_author_account_id" ? "author-1" : (previews.length ? { Implementation: "123" } : fallback),
      mutateSetting: async (key, update) => {
        const next = update({});
        settingWrites.push({ key, next });
        return next;
      },
      platform: {
        requestOptionalHostPermission: async () => true,
        sendRuntimeMessage: async (message) => {
          request = message;
          return { ok: true, result: { sentWorklogs: 1 } };
        }
      },
      setStatus: () => {},
      setSelectionActive: () => {},
      ensureTempoSubmissionTrackingStartedImpl: async () => "2026-09-08T00:00:00.000Z",
      getTempoAllocationStatusImpl: async () => ({
        state: "unknown",
        history: "unknown",
        eligible: true,
        reason: "unknown-history"
      }),
      previewFn: async (state) => {
        previews.push(state);
        if (state.prepared.missingTasks.length) {
          return { confirmed: true, taskIssueIds: { Implementation: "123" } };
        }
        const worklog = state.prepared.groups[0].worklogs[0];
        const key = tempoAllocationIdentity({
          entryFingerprint: worklog.entryFingerprint,
          localDate: worklog.startDate,
          timeSpentSeconds: worklog.timeSpentSeconds,
          issueId: "123",
          authorAccountId: "author-1"
        }).key;
        return {
          confirmed: true,
          taskIssueIds: { Implementation: "123" },
          selectedAllocationKeys: [key]
        };
      }
    });

    await controller.send();

    assert.equal(previews.length, 2);
    assert.deepEqual(settingWrites, [{ key: "tempo_task_issue_ids", next: { Implementation: "123" } }]);
    assert.equal(request.groups[0].issueId, "123");
    assert.equal(request.groups[0].worklogs.length, 1);
    assert.equal(request.groups[0].worklogs[0].resend, false);
  });

  it("rejects a stale snapshot before dispatch", async () => {
    let current = snapshot;
    let requests = 0;
    const prepared = prepareTempoWeek([entry], {
      periodStart: snapshot.weekStart,
      periodEnd: snapshot.weekEnd,
      authorAccountId: "author-1",
      taskIssueIds: { Implementation: "123" },
      includedDays: selection.includedDays
    });
    const worklog = prepared.groups[0].worklogs[0];
    const key = tempoAllocationIdentity({
      entryFingerprint: worklog.entryFingerprint,
      localDate: worklog.startDate,
      timeSpentSeconds: worklog.timeSpentSeconds,
      issueId: "123",
      authorAccountId: "author-1"
    }).key;
    const controller = createTempoController({
      getSnapshot: () => current,
      currentSelection: () => selection,
      getSetting: async (keyName) => {
        if (keyName === "tempo_api_token") return "token";
        if (keyName === "tempo_author_account_id") return "author-1";
        return { Implementation: "123" };
      },
      mutateSetting: async (key, update) => update({ Implementation: "123" }),
      platform: {
        requestOptionalHostPermission: async () => true,
        sendRuntimeMessage: async () => { requests += 1; return { ok: true, result: { sentWorklogs: 1 } }; }
      },
      setStatus: () => {},
      setSelectionActive: () => {},
      ensureTempoSubmissionTrackingStartedImpl: async () => "2026-09-08T00:00:00.000Z",
      getTempoAllocationStatusImpl: async () => ({ state: "rejected", eligible: true, reason: "known-rejection" }),
      previewFn: async () => {
        current = { ...snapshot, entries: [{ ...entry, revision: 2, description: "Changed" }] };
        return { confirmed: true, taskIssueIds: { Implementation: "123" }, selectedAllocationKeys: [key] };
      }
    });

    await assert.rejects(() => controller.send(), /changed while the Tempo preview was open/);
      assert.equal(requests, 0);
  });

  it("refuses dispatch when the account or mappings changed after confirmation", async () => {
    let settings = {
      tempo_api_token: "token",
      tempo_author_account_id: "author-1",
      tempo_task_issue_ids: { Implementation: "123" }
    };
    let requests = 0;
    const prepared = prepareTempoWeek([entry], {
      periodStart: snapshot.weekStart,
      periodEnd: snapshot.weekEnd,
      authorAccountId: "author-1",
      taskIssueIds: settings.tempo_task_issue_ids,
      includedDays: selection.includedDays
    });
    const key = tempoAllocationIdentity({
      entryFingerprint: prepared.groups[0].worklogs[0].entryFingerprint,
      localDate: "2026-09-08",
      timeSpentSeconds: 3600,
      issueId: "123",
      authorAccountId: "author-1"
    }).key;
    const controller = createTempoController({
      getSnapshot: () => snapshot,
      currentSelection: () => selection,
      getSetting: async (name) => settings[name] || {},
      mutateSetting: async (name, update) => { settings[name] = update(settings[name]); return settings[name]; },
      platform: {
        requestOptionalHostPermission: async () => true,
        sendRuntimeMessage: async () => { requests += 1; return { ok: true, result: { sentWorklogs: 1 } }; }
      },
      setStatus: () => {},
      setSelectionActive: () => {},
      ensureTempoSubmissionTrackingStartedImpl: async () => "2026-09-08T00:00:00.000Z",
      getTempoAllocationStatusImpl: async () => ({ state: "rejected", eligible: true, reason: "known-rejection" }),
      previewFn: async () => {
        settings.tempo_author_account_id = "author-2";
        return { confirmed: true, taskIssueIds: { Implementation: "123" }, selectedAllocationKeys: [key] };
      }
    });

    await assert.rejects(() => controller.send(), /account or task mappings changed/);
    assert.equal(requests, 0);
  });

  it("exposes an operation cancellation message and clears upload state", async () => {
    let resolveUpload;
    let uploadMessage;
    let uploadState;
    const controller = createTempoController({
      getSnapshot: () => snapshot,
      currentSelection: () => selection,
      getSetting: async (name) => name === "tempo_api_token" ? "token" : name === "tempo_author_account_id" ? "author-1" : { Implementation: "123" },
      mutateSetting: async (name, update) => update({ Implementation: "123" }),
      platform: {
        requestOptionalHostPermission: async () => true,
        sendRuntimeMessage: async (message) => {
          if (message.type === "CANCEL_TEMPO_UPLOAD") return { ok: true };
          uploadMessage = message;
          return new Promise((resolve) => { resolveUpload = resolve; });
        }
      },
      setStatus: () => {},
      setSelectionActive: () => {},
      setUploadState: (state) => { uploadState = state; },
      ensureTempoSubmissionTrackingStartedImpl: async () => "2026-09-08T00:00:00.000Z",
      getTempoAllocationStatusImpl: async () => ({ state: "rejected", eligible: true, reason: "known-rejection" }),
      previewFn: async () => {
        const worklog = prepareTempoWeek([entry], {
          periodStart: snapshot.weekStart,
          periodEnd: snapshot.weekEnd,
          authorAccountId: "author-1",
          taskIssueIds: { Implementation: "123" },
          includedDays: selection.includedDays
        }).groups[0].worklogs[0];
        return {
          confirmed: true,
          taskIssueIds: { Implementation: "123" },
          selectedAllocationKeys: [tempoAllocationIdentity({
            entryFingerprint: worklog.entryFingerprint,
            localDate: worklog.startDate,
            timeSpentSeconds: worklog.timeSpentSeconds,
            issueId: "123",
            authorAccountId: "author-1"
          }).key]
        };
      }
    });

    const sending = controller.send();
    const deadline = Date.now() + 1000;
    while (!uploadState?.active) {
      if (Date.now() >= deadline) throw new Error("Tempo upload did not become active before the 1000ms deadline.");
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.match(uploadMessage.operationId, /^[0-9a-f-]{36}$/);
    assert.equal((await uploadState.cancel()).ok, true);
    resolveUpload({ ok: true, result: { sentWorklogs: 1 } });
    await sending;
    assert.deepEqual(uploadState, { active: false, cancel: null });
  });
});

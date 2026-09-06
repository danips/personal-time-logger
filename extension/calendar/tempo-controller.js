import { normalizeTempoIssueId, normalizeTempoTaskIssueIds, prepareTempoWeek, TEMPO_HOST_PERMISSION, TEMPO_UPLOAD_MESSAGE } from "../src/tempo.js";

function tempoError(code, message) {
  return Object.assign(new Error(message), { code });
}

function promptIssueId(task) {
  while (true) {
    const value = window.prompt(`Enter the numeric Jira issue ID for Task “${task || "(No task)"}”. It will be remembered for later weeks.`);
    if (value === null) return null;
    const issueId = normalizeTempoIssueId(value);
    if (issueId) return issueId;
    window.alert("The issue ID must be a positive whole number.");
  }
}

/** Captures the selected-week snapshot before any asynchronous Tempo work. */
export function createTempoController({ getSnapshot, currentSelection, getSetting, mutateSetting, platform, setStatus, setSelectionActive }) {
  return {
    async send() {
      const snapshot = getSnapshot();
      const selection = currentSelection(snapshot);
      if (selection.noneSelected) { setStatus("Check at least one day to send to Tempo"); return; }
      let granted;
      try { granted = await platform.requestOptionalHostPermission(TEMPO_HOST_PERMISSION); }
      catch { throw tempoError("TEMPO_PERMISSION_MISSING", "Tempo host permission request failed"); }
      if (!granted) throw tempoError("TEMPO_PERMISSION_MISSING", "Tempo host permission was not granted");
      const token = String(await getSetting("tempo_api_token", "")).trim();
      const authorAccountId = String(await getSetting("tempo_author_account_id", "")).trim();
      if (!token || !authorAccountId) throw tempoError("TEMPO_CONFIG_MISSING", "Enter the Tempo API token and author account ID in Options first");
      const taskIssueIds = normalizeTempoTaskIssueIds(await getSetting("tempo_task_issue_ids", {}));
      let prepared = prepareTempoWeek(snapshot.entries, {
        periodStart: snapshot.weekStart,
        periodEnd: snapshot.weekEnd,
        authorAccountId,
        taskIssueIds,
        includedDays: selection.includedDays
      });
      for (const task of prepared.missingTasks) {
        const issueId = promptIssueId(task);
        if (!issueId) { setStatus("Tempo send cancelled; no worklogs were sent"); return; }
        taskIssueIds[task] = issueId;
      }
      if (prepared.missingTasks.length) {
        const saved = await mutateSetting("tempo_task_issue_ids", (current) => ({ ...normalizeTempoTaskIssueIds(current), ...taskIssueIds }));
        prepared = prepareTempoWeek(snapshot.entries, {
          periodStart: snapshot.weekStart,
          periodEnd: snapshot.weekEnd,
          authorAccountId,
          taskIssueIds: saved,
          includedDays: selection.includedDays
        });
      }
      if (!prepared.totalWorklogs) {
        setStatus(prepared.skippedRunning ? "No completed worklogs to send; running timers were skipped" : `No worklogs to send for ${selection.scopeLabel}`);
        return;
      }
      const skipped = prepared.skippedRunning ? ` ${prepared.skippedRunning} running timer${prepared.skippedRunning === 1 ? " will" : "s will"} be skipped.` : "";
      if (!window.confirm(`Send ${prepared.totalWorklogs} worklog${prepared.totalWorklogs === 1 ? "" : "s"} from ${selection.scopeLabel} to Tempo?${skipped}\n\nSending the same ${selection.repeatScopeLabel} again creates duplicates in Tempo.`)) {
        setStatus("Tempo send cancelled; no worklogs were sent");
        return;
      }
      setStatus(`Sending ${prepared.totalWorklogs} worklog${prepared.totalWorklogs === 1 ? "" : "s"} to Tempo...`);
      let response;
      try { response = await platform.sendRuntimeMessage({ type: TEMPO_UPLOAD_MESSAGE, groups: prepared.groups }); }
      catch { throw tempoError("TEMPO_NETWORK", "Tempo background request failed"); }
      if (!response?.ok) throw Object.assign(tempoError(response?.error?.code || "TEMPO_NETWORK", "Tempo background request failed; inspect Tempo before resending."), response.error);
      setStatus(`Sent ${response.result.sentWorklogs} worklog${response.result.sentWorklogs === 1 ? "" : "s"} to Tempo`);
      setSelectionActive(false);
    }
  };
}

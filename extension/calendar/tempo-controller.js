import { ensureTempoSubmissionTrackingStarted, getTempoAllocationStatus, tempoAllocationIdentity } from "../src/tempo-submission-ledger.js";
import { entryFingerprint } from "../src/fingerprints.js";
import { normalizeTempoIssueId, normalizeTempoProjectTaskIssueIds, normalizeTempoTaskIssueIds, prepareTempoWeek, tempoProjectTaskKey, TEMPO_CANCEL_MESSAGE, TEMPO_HOST_PERMISSION, TEMPO_UPLOAD_MESSAGE } from "../src/tempo.js";

function tempoError(code, message) {
  return Object.assign(new Error(message), { code });
}

function mappingEntries(mappings) {
  return Object.entries(mappings || {}).sort(([first], [second]) => first.localeCompare(second));
}

function sameMappings(first, second) {
  return JSON.stringify(mappingEntries(first)) === JSON.stringify(mappingEntries(second));
}

function operationId() {
  return globalThis.crypto?.randomUUID?.()
    || `tempo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function allocationKey(worklog, issueId, authorAccountId) {
  return tempoAllocationIdentity({
    entryFingerprint: worklog.entryFingerprint,
    localDate: worklog.startDate,
    timeSpentSeconds: worklog.timeSpentSeconds,
    issueId,
    authorAccountId
  }).key;
}

function statusPresentation(status) {
  if (status?.reason === "changed-allocation") {
    return { kind: "changed", label: "Changed allocation · review", selected: false, resend: false };
  }
  if (status?.reason === "unknown-history") {
    return { kind: "untracked", label: "Untracked history · review", selected: false, resend: false };
  }
  if (status?.reason === "unsent") {
    return { kind: "unsent", label: "Unsent · send", selected: true, resend: false };
  }
  if (status?.state === "acknowledged") {
    return { kind: "acknowledged", label: "Acknowledged · resend", selected: false, resend: true };
  }
  if (status?.state === "unknown") {
    return { kind: "unknown", label: "Unknown result · resend", selected: false, resend: true };
  }
  if (status?.state === "rejected") {
    return { kind: "rejected", label: "Rejected · retry", selected: true, resend: false };
  }
  if (status?.state === "pending") {
    return { kind: "pending", label: "Pending recovery", selected: false, resend: false };
  }
  return { kind: "untracked", label: "Untracked history · review", selected: false, resend: false };
}

/** Builds the rows rendered by the calendar's Tempo preview. */
export function buildTempoPreviewRows(prepared, snapshot, statuses = new Map(), authorAccountId = "") {
  const entryByFingerprint = new Map(
    (snapshot?.entries || []).map((entry) => [entryFingerprint(entry), entry])
  );
  return prepared.groups.flatMap((group) => group.worklogs.map((worklog) => {
    const entry = entryByFingerprint.get(worklog.entryFingerprint);
    const key = allocationKey(worklog, group.issueId, authorAccountId);
    const status = statusPresentation(statuses.get(key));
    return {
      ...worklog,
      key,
      issueId: group.issueId,
      task: String(entry?.task ?? "(Unknown task)"),
      project: String(entry?.project ?? ""),
      hours: (worklog.timeSpentSeconds / 3600).toFixed(2),
      ...status
    };
  }));
}

function previewTaskRows(rows, missingTasks, missingTaskMappings) {
  const tasks = new Map();
  const projectMappingKeys = new Set((missingTaskMappings || []).map(({ key }) => key));
  for (const row of rows) {
    const projectKey = tempoProjectTaskKey(row.project, row.task);
    const key = projectMappingKeys.has(projectKey) ? projectKey : row.task;
    if (!tasks.has(key)) tasks.set(key, {
      task: row.task,
      project: projectMappingKeys.has(projectKey) ? row.project : "",
      mappingKey: projectMappingKeys.has(projectKey) ? projectKey : ""
    });
  }
  const projectMappedTasks = new Set((missingTaskMappings || []).map(({ task }) => task));
  for (const task of missingTasks || []) {
    if (!projectMappedTasks.has(task) && !tasks.has(task)) tasks.set(task, { task, project: "", mappingKey: "" });
  }
  for (const mapping of missingTaskMappings || []) {
    if (!tasks.has(mapping.key)) tasks.set(mapping.key, mapping);
  }
  return [...tasks.values()];
}

function textElement(tag, text, className = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function showTempoPreview({ prepared, snapshot, mappings, projectTaskMappings, statuses, authorAccountId, selectionLabel }) {
  const dialog = document.getElementById("tempoPreviewDialog");
  const form = document.getElementById("tempoPreviewForm");
  if (!dialog || !form) throw tempoError("TEMPO_API_ERROR", "Tempo preview is unavailable");

  const rows = buildTempoPreviewRows(prepared, snapshot, statuses, authorAccountId);
  const tasks = previewTaskRows(rows, prepared.missingTasks, prepared.missingTaskMappings);
  const summary = document.getElementById("tempoPreviewSummary");
  const skipped = document.getElementById("tempoPreviewSkipped");
  const error = document.getElementById("tempoPreviewError");
  const mappingsPanel = document.getElementById("tempoPreviewMappings");
  const body = document.getElementById("tempoPreviewRows");
  const confirmButton = document.getElementById("tempoPreviewConfirm");
  const cancelButton = document.getElementById("tempoPreviewCancel");

  summary.textContent = `${prepared.totalWorklogs} daily allocation${prepared.totalWorklogs === 1 ? "" : "s"} from ${selectionLabel}`;
  const skippedParts = [];
  if (prepared.skippedRunning) skippedParts.push(`${prepared.skippedRunning} running timer${prepared.skippedRunning === 1 ? "" : "s"} skipped`);
  if (prepared.skippedExcludedDays) skippedParts.push(`${prepared.skippedExcludedDays} allocation${prepared.skippedExcludedDays === 1 ? "" : "s"} outside the selected days`);
  if (prepared.skippedZeroDuration) skippedParts.push(`${prepared.skippedZeroDuration} zero-second allocation${prepared.skippedZeroDuration === 1 ? "" : "s"} skipped`);
  skipped.textContent = skippedParts.join(" · ") || "All prepared allocations are shown below.";
  error.hidden = true;
  error.textContent = "";

  mappingsPanel.replaceChildren();
  if (!tasks.length) {
    mappingsPanel.append(textElement("p", "No task mappings are needed.", "tempo-preview-empty"));
  } else {
    mappingsPanel.append(textElement("h3", "Task mappings"));
    for (const { task, project, mappingKey } of tasks) {
      const label = document.createElement("label");
      label.className = "tempo-mapping-field";
      label.append(textElement("span", `${project ? `${project} · ` : ""}${task}`));
      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = "numeric";
      input.dataset.tempoTask = task;
      input.dataset.tempoMappingKey = mappingKey || "";
      input.value = (mappingKey && projectTaskMappings?.[mappingKey]) || mappings[task] || "";
      input.placeholder = "Numeric issue ID";
      input.setAttribute("aria-label", `Tempo issue ID for ${task}`);
      input.addEventListener("input", () => input.setCustomValidity(""));
      label.append(input);
      mappingsPanel.append(label);
    }
  }

  body.replaceChildren();
  for (const row of rows) {
    const tableRow = document.createElement("tr");
    const selectCell = document.createElement("td");
    const select = document.createElement("input");
    select.type = "checkbox";
    select.dataset.tempoAllocationKey = row.key;
    select.checked = row.selected;
    select.disabled = row.kind === "pending";
    select.title = row.kind === "acknowledged" || row.kind === "unknown"
      ? "Explicitly resend this allocation"
      : "Include this allocation";
    selectCell.append(select);
    tableRow.append(selectCell);
    tableRow.append(textElement("td", row.task));
    tableRow.append(textElement("td", row.project || "—"));
    tableRow.append(textElement("td", row.startDate));
    tableRow.append(textElement("td", row.issueId));
    tableRow.append(textElement("td", String(row.timeSpentSeconds)));
    tableRow.append(textElement("td", row.hours));
    tableRow.append(textElement("td", row.label, `tempo-status tempo-status-${row.kind}`));
    body.append(tableRow);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("cancel", onCancel);
      dialog.close();
      resolve(result);
    };
    const onCancel = (event) => {
      event.preventDefault();
      finish({ confirmed: false });
    };
    const onSubmit = (event) => {
      event.preventDefault();
      const nextMappings = { ...mappings };
      const invalid = [];
      const nextProjectTaskMappings = { ...normalizeTempoProjectTaskIssueIds(projectTaskMappings) };
      form.querySelectorAll("[data-tempo-task]").forEach((input) => {
        const issueId = normalizeTempoIssueId(input.value);
        input.setCustomValidity(issueId ? "" : "Enter a positive whole-number issue ID");
        if (!issueId) invalid.push(input);
        else if (input.dataset.tempoMappingKey) nextProjectTaskMappings[input.dataset.tempoMappingKey] = issueId;
        else nextMappings[input.dataset.tempoTask] = issueId;
      });
      if (invalid.length) {
        error.hidden = false;
        error.textContent = "Enter a positive whole-number issue ID for each task before continuing.";
        invalid[0].focus();
        return;
      }
      const selectedAllocationKeys = [...form.querySelectorAll("[data-tempo-allocation-key]:checked")]
        .map((input) => input.dataset.tempoAllocationKey);
      if (!selectedAllocationKeys.length && !prepared.missingTasks.length) {
        error.hidden = false;
        error.textContent = "Select at least one allocation to send, or cancel.";
        return;
      }
      const resendAllocationKeys = rows
        .filter((row) => row.resend && selectedAllocationKeys.includes(row.key))
        .map((row) => row.key);
      finish({ confirmed: true, taskIssueIds: nextMappings, projectTaskIssueIds: nextProjectTaskMappings, selectedAllocationKeys, resendAllocationKeys });
    };
    cancelButton.onclick = () => finish({ confirmed: false });
    form.onsubmit = onSubmit;
    dialog.addEventListener("cancel", onCancel, { once: true });
    dialog.showModal();
    confirmButton.focus();
  });
}

function snapshotIdentity(snapshot) {
  return JSON.stringify({
    weekStart: new Date(snapshot.weekStart).toISOString(),
    weekEnd: new Date(snapshot.weekEnd).toISOString(),
    entries: (snapshot.entries || []).map((entry) => [entry.id, entry.revision, entryFingerprint(entry)])
  });
}

async function readStatuses(prepared, authorAccountId, getTempoAllocationStatusImpl, snapshot, trackingStartedAt) {
  const statuses = new Map();
  const entryByFingerprint = new Map(
    (snapshot?.entries || []).map((entry) => [entryFingerprint(entry), entry])
  );
  for (const group of prepared.groups) {
    for (const worklog of group.worklogs) {
      const key = allocationKey(worklog, group.issueId, authorAccountId);
      const entry = entryByFingerprint.get(worklog.entryFingerprint);
      statuses.set(key, await getTempoAllocationStatusImpl({
        entryFingerprint: worklog.entryFingerprint,
        localDate: worklog.startDate,
        timeSpentSeconds: worklog.timeSpentSeconds,
        issueId: group.issueId,
        authorAccountId,
        entryCreatedAt: entry?.created_at,
        trackingStartedAt
      }));
    }
  }
  return statuses;
}

function claimStillEligible(status, resend) {
  if (!status) return false;
  if (status.reason === "unsent") return true;
  if (status.reason === "unknown-history" || status.reason === "changed-allocation") return true;
  if (status.state === "acknowledged" || status.state === "unknown") return resend;
  return status.eligible === true;
}

/** Captures a selected-week snapshot and keeps all mapping/selection state in the preview. */
export function createTempoController({
  getSnapshot,
  currentSelection,
  getSetting,
  mutateSetting,
  platform,
  setStatus,
  setSelectionActive,
  setUploadState = () => {},
  previewFn = showTempoPreview,
  getTempoAllocationStatusImpl = getTempoAllocationStatus,
  ensureTempoSubmissionTrackingStartedImpl = ensureTempoSubmissionTrackingStarted
}) {
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
      let taskIssueIds = normalizeTempoTaskIssueIds(await getSetting("tempo_task_issue_ids", {}));
      let projectTaskIssueIds = normalizeTempoProjectTaskIssueIds(await getSetting("tempo_project_task_issue_ids", {}));
      const trackingStartedAt = await ensureTempoSubmissionTrackingStartedImpl();
      let prepared = prepareTempoWeek(snapshot.entries, {
        periodStart: snapshot.weekStart,
        periodEnd: snapshot.weekEnd,
        authorAccountId,
        taskIssueIds,
        projectTaskIssueIds,
        includedDays: selection.includedDays
      });

      while (true) {
        const statuses = await readStatuses(prepared, authorAccountId, getTempoAllocationStatusImpl, snapshot, trackingStartedAt);
        const preview = await previewFn({
          prepared,
          snapshot,
          mappings: taskIssueIds,
          projectTaskMappings: projectTaskIssueIds,
          statuses,
          authorAccountId,
          selectionLabel: selection.scopeLabel
        });
        if (!preview?.confirmed) {
          setStatus("Tempo send cancelled; no worklogs were sent");
          return;
        }
        const normalizedMappings = normalizeTempoTaskIssueIds(preview.taskIssueIds);
        const normalizedProjectMappings = normalizeTempoProjectTaskIssueIds(preview.projectTaskIssueIds);
        if (prepared.missingTasks.length
          || !sameMappings(taskIssueIds, normalizedMappings)
          || !sameMappings(projectTaskIssueIds, normalizedProjectMappings)) {
          taskIssueIds = await mutateSetting("tempo_task_issue_ids", (current) => ({
            ...normalizeTempoTaskIssueIds(current),
            ...normalizedMappings
          }));
          if (!sameMappings(projectTaskIssueIds, normalizedProjectMappings)) {
            projectTaskIssueIds = await mutateSetting("tempo_project_task_issue_ids", () => normalizedProjectMappings);
          }
          prepared = prepareTempoWeek(snapshot.entries, {
            periodStart: snapshot.weekStart,
            periodEnd: snapshot.weekEnd,
            authorAccountId,
            taskIssueIds,
            projectTaskIssueIds,
            includedDays: selection.includedDays
          });
          continue;
        }

        if (snapshotIdentity(getSnapshot()) !== snapshotIdentity(snapshot)) {
          throw tempoError("TEMPO_API_ERROR", "The displayed entries changed while the Tempo preview was open; review the refreshed preview before sending.");
        }
        const latestAuthorAccountId = String(await getSetting("tempo_author_account_id", "")).trim();
        const latestMappings = normalizeTempoTaskIssueIds(await getSetting("tempo_task_issue_ids", {}));
        if (latestAuthorAccountId !== authorAccountId || !sameMappings(latestMappings, taskIssueIds)) {
          throw tempoError("TEMPO_API_ERROR", "Tempo account or task mappings changed while the preview was open; review the refreshed preview before sending.");
        }
        const selected = new Set(preview.selectedAllocationKeys || []);
        const resend = new Set(preview.resendAllocationKeys || []);
        const selectedRows = buildTempoPreviewRows(prepared, snapshot, statuses, authorAccountId)
          .filter((row) => selected.has(row.key));
        const latestStatuses = await readStatuses(prepared, authorAccountId, getTempoAllocationStatusImpl, snapshot, trackingStartedAt);
        for (const row of selectedRows) {
          if (!claimStillEligible(latestStatuses.get(row.key), resend.has(row.key))) {
            throw tempoError("TEMPO_API_ERROR", `Tempo allocation for ${row.task} on ${row.startDate} changed status while the preview was open; review it again.`);
          }
        }
        const groups = prepared.groups.map((group) => ({
          issueId: group.issueId,
          worklogs: group.worklogs
            .filter((worklog) => selected.has(allocationKey(worklog, group.issueId, authorAccountId)))
            .map((worklog) => ({
              ...worklog,
              resend: resend.has(allocationKey(worklog, group.issueId, authorAccountId))
            }))
        })).filter((group) => group.worklogs.length);
        if (!groups.length) {
          setStatus("No worklog allocations selected; nothing was sent");
          return;
        }
        setStatus(`Sending ${selectedRows.length} worklog${selectedRows.length === 1 ? "" : "s"} to Tempo...`);
        const uploadOperationId = operationId();
        setUploadState({
          active: true,
          cancel: () => platform.sendRuntimeMessage({ type: TEMPO_CANCEL_MESSAGE, operationId: uploadOperationId })
        });
        let response;
        try {
          response = await platform.sendRuntimeMessage({ type: TEMPO_UPLOAD_MESSAGE, operationId: uploadOperationId, groups });
        } catch {
          throw Object.assign(tempoError("TEMPO_NETWORK", "Tempo background request failed; inspect Tempo before resending."), {
            acknowledgedWorklogs: 0,
            requestCount: 0,
            currentRequestOutcome: "unknown"
          });
        } finally {
          setUploadState({ active: false, cancel: null });
        }
        if (!response?.ok) {
          const details = response?.error || {};
          throw Object.assign(
            tempoError(details.code || "TEMPO_NETWORK", details.message || "Tempo background request failed; inspect Tempo before resending."),
            details
          );
        }
        setStatus(`Sent ${response.result.sentWorklogs} worklog${response.result.sentWorklogs === 1 ? "" : "s"} to Tempo`);
        setSelectionActive(false);
        return;
      }
    }
  };
}

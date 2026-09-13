import {
  deleteDuplicateRows,
  deleteEverywhere,
  entryFingerprint,
  keepLocal,
  keepRemote,
  loadReconciliation,
  resolveReconciliationBatch
} from "../src/reconcile.js";
import { runAction } from "../src/action-runner.js";
import { onEntriesChanged } from "../src/events.js";
import {
  bulkResolutionPreview,
  duplicateRecordsSupported,
  operationOutcome,
  paginateReconciliationItems,
  reconciliationActionDisabled,
  reconciliationActionEligibility,
  buildKeepNewestCommands
} from "../src/reconcile-ui-state.js";
import { serializeQuarantinedRecords } from "../src/reconcile-export.js";
import { syncNow } from "../src/sync.js";
import { recordDiagnostic } from "../src/diagnostics.js";
import { durationSeconds, formatElapsed, shortDateTime } from "../src/time.js";
import { $, entryTitle, formatError } from "../src/ui-helpers.js";
import { runPageTask, startPage } from "../src/page-runtime.js";

let report = null;
let busy = false;
let unsubscribeEntryEvents = null;
let eventsBound = false;
const PAGE_SIZE = 50;
let searchTerm = "";
const groupPages = new Map();
let reviewViewState = null;

function setStatus(message) {
  $("#reconcileStatusLine").textContent = message;
}

function setBusy(next) {
  busy = next;
  applyControlState();
}

function setStaticActionDisabled(selector, eligible) {
  $(selector).disabled = reconciliationActionDisabled(busy, eligible);
}

function applyControlState() {
  $("#rescanButton").disabled = busy;
  $("#syncButton").disabled = busy;
  const eligibility = reconciliationActionEligibility(report);
  setStaticActionDisabled("#deleteAllDuplicates", eligibility.deleteAllDuplicates);
  setStaticActionDisabled("#keepAllLocal", eligibility.keepAllLocal);
  setStaticActionDisabled("#keepAllRemote", eligibility.keepAllRemote);
  setStaticActionDisabled("#keepAllNewest", eligibility.keepAllNewest);
  setStaticActionDisabled("#pushAllLocal", eligibility.pushAllLocal);
  setStaticActionDisabled("#importAllRemote", eligibility.importAllRemote);
  for (const button of document.querySelectorAll("[data-resolution-action]")) button.disabled = busy;
}

function describe(entry) {
  const duration = Number(entry.duration_seconds) || durationSeconds(entry.start_at, entry.end_at || undefined);
  const when = shortDateTime(entry.start_at) || "no start time";
  const state = entry.deleted_at ? "deleted" : (entry.end_at ? "completed" : "running");
  return `${when} · ${formatElapsed(duration)} · ${state}`;
}

function badge(text) {
  const element = document.createElement("span");
  element.className = "badge";
  element.textContent = text;
  return element;
}

function rowHeading(entry, badges = []) {
  const heading = document.createElement("div");
  heading.className = "row-heading";

  const title = document.createElement("span");
  title.className = "row-title";
  title.textContent = entryTitle(entry);

  const meta = document.createElement("span");
  meta.className = "row-meta";
  meta.textContent = describe(entry);

  heading.append(title, meta, ...badges.map(badge));
  return heading;
}

function differenceTable(differences, remoteLabel) {
  const table = document.createElement("table");
  table.className = "diff-table";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Field", "This device", `Remote — ${remoteLabel}`]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);

  const body = document.createElement("tbody");
  for (const difference of differences) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    name.className = "field-name";
    name.textContent = difference.field;
    const local = document.createElement("td");
    local.textContent = difference.local || "(empty)";
    const remote = document.createElement("td");
    remote.textContent = difference.remote || "(empty)";
    row.append(name, local, remote);
    body.append(row);
  }

  table.append(head, body);
  return table;
}

function actionRow(buttons) {
  const container = document.createElement("div");
  container.className = "actions";
  for (const { label, action, danger, id } of buttons) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.resolutionAction = "true";
    button.textContent = label;
    if (id) button.dataset.reconcileActionId = id;
    if (danger) button.classList.add("danger");
    button.addEventListener("click", () => resolve(action));
    container.append(button);
  }
  return container;
}

function emptyNote(text) {
  const note = document.createElement("p");
  note.className = "empty";
  note.textContent = text;
  return note;
}

function renderDifferent(items) {
  if (!items.length) return [emptyNote("Nothing differs between this device and remote storage.")];

  return items.map((item) => {
    const row = document.createElement("article");
    row.className = "row";
    const badges = item.newer === "same" ? ["same timestamp"]
      : item.newer === "conflict" ? ["same timestamp conflict"] : [`${item.newer} is newer`];
    row.append(
      rowHeading(item.local, badges),
      differenceTable(item.differences, report.provider?.label || "Remote storage"),
      actionRow([
        { id: item.id, label: "Keep this device", action: () => keepLocal(item.id, item.remote, { expectedRevision: item.local.revision, expectedLocalFingerprint: entryFingerprint(item.local) }) },
        { id: item.id, label: "Keep remote", action: () => keepRemote(item.remote, { expectedLocalRevision: item.local.revision, expectedLocalFingerprint: entryFingerprint(item.local) }) }
      ])
    );
    return row;
  });
}

function renderDuplicates(items) {
  if (!items.length) return [emptyNote("No duplicate remote records were reported.")];

  return items.map((item) => {
    const row = document.createElement("article");
    row.className = "row";
    const rows = [item.keepRowIndex, ...item.extraRowIndexes].sort((a, b) => a - b);
    row.append(
      rowHeading(item.entry, [`rows ${rows.join(", ")}`, `keeping row ${item.keepRowIndex}`]),
      actionRow([
        {
          id: item.id,
          label: `Delete ${item.extraRowIndexes.length} extra row${item.extraRowIndexes.length === 1 ? "" : "s"}`,
          action: () => confirmDeleteRows(item.extraRows),
          danger: true
        }
      ])
    );
    return row;
  });
}

function renderQuarantined(items) {
  if (!items.length) return [emptyNote("No invalid remote records were reported.")];

  return items.map((item) => {
    const row = document.createElement("article");
    row.className = "row";
    const reference = item.rowIndex
      ? `row ${item.rowIndex}`
      : item.ref?.version ? `record version ${item.ref.version}` : "unknown record";
    const heading = document.createElement("div");
    heading.className = "row-heading";
    const title = document.createElement("span");
    title.className = "row-title";
    title.textContent = item.id || "Record without an ID";
    heading.append(title, badge(reference), badge(item.reason || "invalid entry"));
    row.append(
      heading,
      emptyNote(`Correct this record in ${report.provider?.label || "remote storage"}, then click Rescan. Sync will not push, pull, or purge this ID until it is valid.`)
    );
    return row;
  });
}

/**
 * Duplicate-row deletion cannot be undone from here and touches provider storage
 * directly, so it always asks first.
 */
async function confirmDeleteRows(rows) {
  if (!duplicateRecordsSupported(report)) return;
  const rowIndexes = rows.map((row) => row.rowIndex);
  const confirmed = confirm(
    `Delete ${rowIndexes.length} duplicate row${rowIndexes.length === 1 ? "" : "s"} from the spreadsheet?\n\n`
    + `Row${rowIndexes.length === 1 ? "" : "s"} ${rowIndexes.join(", ")} will be removed. `
    + "The most recently updated copy of each entry is kept. This cannot be undone from here."
  );
  if (!confirmed) return;
  await deleteDuplicateRows(rows, { interactiveAuth: false });
}

function renderLocalOnly(items) {
  if (!items.length) return [emptyNote("Every local entry exists in remote storage.")];

  return items.map((item) => {
    const row = document.createElement("article");
    row.className = "row";
    row.append(
      rowHeading(item.local, item.local.dirty ? ["pending upload"] : []),
      actionRow([
        { id: item.id, label: "Push to remote", action: () => keepLocal(item.id, null, { expectedRevision: item.local.revision, expectedLocalFingerprint: entryFingerprint(item.local) }) },
        { id: item.id, label: "Delete", action: () => deleteEverywhere(item.id, null, { expectedLocalRevision: item.local.revision, expectedLocalFingerprint: entryFingerprint(item.local) }), danger: true }
      ])
    );
    return row;
  });
}

function renderRemoteOnly(items) {
  if (!items.length) return [emptyNote("Every remote entry exists on this device.")];

  return items.map((item) => {
    const row = document.createElement("article");
    row.className = "row";
    row.append(
      rowHeading(item.remote),
      actionRow([
        { id: item.id, label: "Import from remote", action: () => keepRemote(item.remote) },
        { id: item.id, label: "Delete", action: () => deleteEverywhere(item.id, item.remote, { expectedRemoteFingerprint: entryFingerprint(item.remote) }), danger: true }
      ])
    );
    return row;
  });
}

function searchableText(group, item) {
  if (group === "different") return [item.id, entryTitle(item.local), item.local.project, item.local.task, item.local.description, ...(item.differences || []).flatMap((difference) => [difference.field, difference.local, difference.remote])].join(" ");
  if (group === "duplicates") return [item.id, entryTitle(item.entry), ...(item.extraRowIndexes || [])].join(" ");
  if (group === "quarantined") return [item.id, item.reason, item.rowIndex, item.ref?.version].join(" ");
  if (group === "localOnly") return [item.id, entryTitle(item.local), item.local.project, item.local.task, item.local.description].join(" ");
  return [item.id, entryTitle(item.remote), item.remote.project, item.remote.task, item.remote.description].join(" ");
}

function matchingItems(group, items) {
  const needle = searchTerm.trim().toLocaleLowerCase();
  if (!needle) return items;
  return items.filter((item) => searchableText(group, item).toLocaleLowerCase().includes(needle));
}

function groupPager(group, page, pageCount, total) {
  if (pageCount <= 1) return null;
  const nav = document.createElement("nav");
  nav.className = "pagination";
  nav.setAttribute("aria-label", `${group} pages`);
  const previous = document.createElement("button");
  previous.type = "button";
  previous.textContent = "Previous";
  previous.disabled = page === 0;
  previous.addEventListener("click", () => {
    groupPages.set(group, page - 1);
    render();
  });
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "Next";
  next.disabled = page >= pageCount - 1;
  next.addEventListener("click", () => {
    groupPages.set(group, page + 1);
    render();
  });
  const status = document.createElement("span");
  status.textContent = `Page ${page + 1} of ${pageCount} · ${total} shown`;
  nav.append(previous, status, next);
  return nav;
}

function renderGroup(group, items, renderer) {
  const matching = matchingItems(group, items);
  const paged = paginateReconciliationItems(matching, { page: groupPages.get(group) || 0, pageSize: PAGE_SIZE });
  groupPages.set(group, paged.page);
  const host = $(`#${group}List`);
  const pager = groupPager(group, paged.page, paged.pageCount, matching.length);
  host.replaceChildren(...renderer(paged.items), ...(pager ? [pager] : []));
  return { total: items.length, matching: matching.length };
}

function captureReviewViewState() {
  const active = document.activeElement;
  return {
    activeId: active?.id || "",
    actionId: active?.dataset?.reconcileActionId || "",
    scrollTop: window.scrollY
  };
}

function restoreReviewViewState(state) {
  if (!state) return;
  const target = state.activeId
    ? document.getElementById(state.activeId)
    : state.actionId
      ? document.querySelector(`[data-reconcile-action-id="${CSS.escape(state.actionId)}"]`)
      : null;
  target?.focus();
  window.scrollTo(0, state.scrollTop);
}

function showOperationOutcome(outcome) {
  const normalized = operationOutcome(outcome);
  const parts = [
    `Completed: ${normalized.completed}`,
    `Pending: ${normalized.pending}`,
    `Failed: ${normalized.failed}`
  ];
  const output = $("#operationOutcome");
  output.textContent = parts.join(" · ");
  output.hidden = false;
}

function previewBulk(items, label, action) {
  const preview = bulkResolutionPreview(items);
  if (!preview.affectedCount) return;
  const conflictNote = preview.equalTimestampConflicts
    ? ` Equal-timestamp conflicts left unresolved by this choice: ${preview.equalTimestampConflicts}.`
    : "";
  if (!confirm(`${label}\n\nAffected entries: ${preview.affectedCount}. Preconditions to recheck: ${preview.preconditionCount}.${conflictNote}\n\nContinue?`)) return;
  return resolveMany(items, action, preview.affectedCount);
}

function exportQuarantineReport() {
  if (!report) return;
  const csv = serializeQuarantinedRecords(report.quarantined, { provider: report.provider?.label });
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "time-logger-quarantined-records.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  setStatus("Quarantined-record report exported");
}

function divergenceCount() {
  if (!report) return 0;
  return report.different.length
    + report.localOnly.length
    + report.remoteOnly.length
    + report.quarantined.length
    + (report.provider?.capabilities?.duplicateRemoteRecords === true ? report.duplicateRowCount : 0);
}

function render() {
  if (!report) return;

  $("#remoteProviderLabel").textContent = `Remote backend: ${report.provider?.label || "Remote storage"}`;

  $("#localCount").textContent = String(report.localCount);
  $("#remoteRowCount").textContent = String(report.remoteRowCount);
  $("#remoteCount").textContent = String(report.remoteCount);
  $("#duplicateRowCount").textContent = String(report.duplicateRowCount);
  $("#quarantinedCount").textContent = String(report.quarantined.length);
  $("#inSyncCount").textContent = String(report.inSync);
  $("#divergenceCount").textContent = String(divergenceCount());

  const supportsDuplicateRecords = duplicateRecordsSupported(report);
  $("#duplicateSummaryMetric").hidden = !supportsDuplicateRecords;
  $("#duplicateSection").hidden = !supportsDuplicateRecords;
  $("#duplicateHeading").textContent = `Duplicate remote records (${report.duplicates.length})`;
  $("#duplicateList").replaceChildren(...(
    supportsDuplicateRecords ? renderDuplicates(report.duplicates) : []
  ));
  $("#quarantinedHeading").textContent = `Invalid remote records (${report.quarantined.length})`;
  $("#quarantinedList").replaceChildren(...renderQuarantined(report.quarantined));
  $("#differentHeading").textContent = `Different on each side (${report.different.length})`;
  $("#localOnlyHeading").textContent = `Only on this device (${report.localOnly.length})`;
  $("#remoteOnlyHeading").textContent = `Only in remote storage (${report.remoteOnly.length})`;

  const groups = [
    ["different", report.different, renderDifferent],
    ["duplicates", report.duplicates, renderDuplicates],
    ["quarantined", report.quarantined, renderQuarantined],
    ["localOnly", report.localOnly, renderLocalOnly],
    ["remoteOnly", report.remoteOnly, renderRemoteOnly]
  ];
  const counts = groups.map(([group, items, renderer]) => renderGroup(group, items, renderer));
  const total = counts.reduce((sum, count) => sum + count.total, 0);
  const matching = counts.reduce((sum, count) => sum + count.matching, 0);
  $("#reconcileFilterSummary").textContent = searchTerm.trim()
    ? `Showing ${matching} of ${total} report items`
    : `Showing all ${total} report items`;

  applyControlState();
}

async function scan({ quiet = false, manageBusy = true } = {}) {
  reviewViewState = captureReviewViewState();
  if (!quiet) setStatus("Comparing this device with remote storage...");
  if (manageBusy) setBusy(true);
  try {
    report = await loadReconciliation({ interactiveAuth: false });
    render();
    restoreReviewViewState(reviewViewState);
    const divergences = divergenceCount();
    setStatus(divergences
      ? `${divergences} divergence${divergences === 1 ? "" : "s"} found. Choose a side, then sync.`
      : "This device and remote storage agree on every entry.");
  } catch (error) {
    setStatus(`Could not compare: ${formatError(error)}`);
    try {
      await recordDiagnostic({
        subsystem: "reconciliation",
        phase: "scan",
        error,
        recovery: "Retry reconciliation. If it continues, check the remote backend and Options diagnostics."
      });
    } catch {
      // The visible failure remains useful when diagnostics storage is unavailable.
    }
  } finally {
    if (manageBusy) setBusy(false);
  }
}

/**
 * Resolutions only write locally, marking a side as the one to keep. The sync that
 * follows carries the decision to remote storage, so one code path owns remote writes.
 */
function resolve(action, status = "Applying...", affectedCount = 1) {
  if (busy) return;
  reviewViewState = captureReviewViewState();
  return runAction("reconciliation-resolution", async () => {
    setStatus(status);
    const outcome = await action();
    let syncError = null;
    if (outcome?.results) setStatus(`Applied ${outcome.results.length} selected entr${outcome.results.length === 1 ? "y" : "ies"}; syncing...`);
    try {
      await syncNow({ force: true });
    } catch (error) {
      syncError = error;
    }
    await scan({ quiet: true, manageBusy: false });
    showOperationOutcome({
      completed: outcome?.results?.length || affectedCount,
      pending: syncError ? affectedCount : 0,
      failed: syncError ? 1 : 0
    });
    if (syncError) throw syncError;
  }, {
    setBusy,
    onError(error) {
      setStatus(`Could not apply: ${formatError(error)}`);
      showOperationOutcome({ completed: 0, pending: 0, failed: affectedCount });
    },
    onFinally() {
      applyControlState();
    }
  });
}

function resolveMany(items, affectedCount = items.length) {
  return resolve(
    () => resolveReconciliationBatch(items, { interactiveAuth: false }),
    `Prevalidating and applying ${items.length} selected entr${items.length === 1 ? "y" : "ies"}...`,
    affectedCount
  );
}

async function runSync() {
  setBusy(true);
  try {
    setStatus("Syncing...");
    const result = await syncNow({ force: true });
    setStatus(`Sync ${result.status}`);
  } catch (error) {
    setStatus(`Sync failed: ${formatError(error)}`);
  } finally {
    setBusy(false);
  }
  await scan({ quiet: true });
}

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;
  $("#rescanButton").addEventListener("click", () => scan());
  $("#syncButton").addEventListener("click", runSync);
  $("#deleteAllDuplicates").addEventListener("click", () => {
    if (!duplicateRecordsSupported(report)) return;
    return resolve(() => confirmDeleteRows(report.duplicates.flatMap((item) => item.extraRows)));
  });
  $("#keepAllLocal").addEventListener("click", () => {
    const commands = report.different.map((item) => ({
      action: "keepLocal",
      id: item.id,
      remoteEntry: item.remote,
      expectedRevision: item.local.revision,
      expectedLocalFingerprint: entryFingerprint(item.local)
    }));
    return previewBulk(report.different, "Keep this device for every differing entry", () => resolveMany(commands));
  });
  $("#keepAllRemote").addEventListener("click", () => {
    const commands = report.different.map((item) => ({
      action: "keepRemote",
      id: item.id,
      remoteEntry: item.remote,
      expectedLocalRevision: item.local.revision,
      expectedLocalFingerprint: entryFingerprint(item.local)
    }));
    return previewBulk(report.different, "Keep remote for every differing entry", () => resolveMany(commands));
  });
  $("#keepAllNewest").addEventListener("click", () => {
    const eligible = report.different.filter((item) => item.newer === "local" || item.newer === "remote");
    return previewBulk(eligible, "Keep the newer side for each differing entry", () => resolveMany(buildKeepNewestCommands(report.different)));
  });
  $("#pushAllLocal").addEventListener("click", () => {
    const commands = report.localOnly.map((item) => ({ action: "keepLocal", id: item.id, expectedRevision: item.local.revision }));
    return previewBulk(report.localOnly, "Push every local-only entry", () => resolveMany(commands));
  });
  $("#importAllRemote").addEventListener("click", () => {
    const commands = report.remoteOnly.map((item) => ({ action: "keepRemote", id: item.id, remoteEntry: item.remote }));
    return previewBulk(report.remoteOnly, "Import every remote-only entry", () => resolveMany(commands));
  });
  $("#reconcileSearch").addEventListener("input", (event) => {
    searchTerm = event.currentTarget.value;
    groupPages.clear();
    render();
    event.currentTarget.focus();
  });
  $("#exportQuarantined").addEventListener("click", exportQuarantineReport);
}

export async function initReconcilePage() {
  bindEvents();
  if (!unsubscribeEntryEvents) {
    unsubscribeEntryEvents = onEntriesChanged((detail) => {
      // A sync started elsewhere can invalidate the comparison on screen.
      if (busy || detail.action === "reconcile") return;
      void runPageTask({
        page: "reconcile",
        phase: "entries-changed",
        task: () => scan({ quiet: true }),
        onError(error) {
          setStatus(`Could not refresh: ${formatError(error)}`);
        }
      });
    });
  }
  await scan();
}

window.addEventListener("pagehide", () => {
  if (unsubscribeEntryEvents) unsubscribeEntryEvents();
});

if (document.body?.dataset.page === "reconcile") {
  startPage({ page: "reconcile", title: "Reconcile", init: initReconcilePage });
}

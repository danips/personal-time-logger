import {
  deleteDuplicateRows,
  deleteEverywhere,
  keepLocal,
  keepRemote,
  loadReconciliation,
  resolveReconciliationBatch
} from "../src/reconcile.js";
import { runAction } from "../src/action-runner.js";
import { onEntriesChanged } from "../src/events.js";
import {
  duplicateRecordsSupported,
  reconciliationActionDisabled,
  reconciliationActionEligibility
} from "../src/reconcile-ui-state.js";
import { syncNow } from "../src/sync.js";
import { durationSeconds, formatElapsed, shortDateTime } from "../src/time.js";
import { $, entryTitle, formatError } from "../src/ui-helpers.js";
import { runPageTask, startPage } from "../src/page-runtime.js";

let report = null;
let busy = false;
let unsubscribeEntryEvents = null;
let eventsBound = false;

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
  for (const { label, action, danger } of buttons) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.resolutionAction = "true";
    button.textContent = label;
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
        { label: "Keep this device", action: () => keepLocal(item.id, item.remote, { expectedRevision: item.local.revision }) },
        { label: "Keep remote", action: () => keepRemote(item.remote, { expectedLocalRevision: item.local.revision }) }
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
        { label: "Push to remote", action: () => keepLocal(item.id, null, { expectedRevision: item.local.revision }) },
        { label: "Delete", action: () => deleteEverywhere(item.id, null, { expectedLocalRevision: item.local.revision }), danger: true }
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
        { label: "Import from remote", action: () => keepRemote(item.remote) },
        { label: "Delete", action: () => deleteEverywhere(item.id, item.remote), danger: true }
      ])
    );
    return row;
  });
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

  $("#differentList").replaceChildren(...renderDifferent(report.different));
  $("#localOnlyList").replaceChildren(...renderLocalOnly(report.localOnly));
  $("#remoteOnlyList").replaceChildren(...renderRemoteOnly(report.remoteOnly));

  applyControlState();
}

async function scan({ quiet = false, manageBusy = true } = {}) {
  if (!quiet) setStatus("Comparing this device with remote storage...");
  if (manageBusy) setBusy(true);
  try {
    report = await loadReconciliation({ interactiveAuth: false });
    render();
    const divergences = divergenceCount();
    setStatus(divergences
      ? `${divergences} divergence${divergences === 1 ? "" : "s"} found. Choose a side, then sync.`
      : "This device and remote storage agree on every entry.");
  } catch (error) {
    setStatus(`Could not compare: ${formatError(error)}`);
  } finally {
    if (manageBusy) setBusy(false);
  }
}

/**
 * Resolutions only write locally, marking a side as the one to keep. The sync that
 * follows carries the decision to remote storage, so one code path owns remote writes.
 */
function resolve(action, status = "Applying...") {
  if (busy) return;
  return runAction("reconciliation-resolution", async () => {
    setStatus(status);
    const outcome = await action();
    if (outcome?.results) setStatus(`Applied ${outcome.results.length} selected entr${outcome.results.length === 1 ? "y" : "ies"}; syncing...`);
    await syncNow({ force: true });
    await scan({ quiet: true, manageBusy: false });
  }, {
    setBusy,
    onError(error) {
      setStatus(`Could not apply: ${formatError(error)}`);
    },
    onFinally() {
      applyControlState();
    }
  });
}

function resolveMany(items) {
  return resolve(
    () => resolveReconciliationBatch(items, { interactiveAuth: false }),
    `Prevalidating and applying ${items.length} selected entr${items.length === 1 ? "y" : "ies"}...`
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
  $("#keepAllLocal").addEventListener("click", () => resolveMany(report.different.map((item) => ({
    action: "keepLocal",
    id: item.id,
    remoteEntry: item.remote,
    expectedRevision: item.local.revision
  }))));
  $("#keepAllRemote").addEventListener("click", () => resolveMany(report.different.map((item) => ({
    action: "keepRemote",
    id: item.id,
    remoteEntry: item.remote,
    expectedLocalRevision: item.local.revision
  }))));
  $("#keepAllNewest").addEventListener("click", () => resolveMany(report.different.map((item) => (
    item.newer === "remote"
      ? { action: "keepRemote", id: item.id, remoteEntry: item.remote, expectedLocalRevision: item.local.revision }
      : { action: "keepLocal", id: item.id, remoteEntry: item.remote, expectedRevision: item.local.revision }
  ))));
  $("#pushAllLocal").addEventListener("click", () => resolveMany(report.localOnly.map((item) => ({
    action: "keepLocal",
    id: item.id,
    expectedRevision: item.local.revision
  }))));
  $("#importAllRemote").addEventListener("click", () => resolveMany(report.remoteOnly.map((item) => ({
    action: "keepRemote",
    id: item.id,
    remoteEntry: item.remote
  }))));
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

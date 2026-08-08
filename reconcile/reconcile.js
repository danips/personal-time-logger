import {
  deleteDuplicateRows,
  deleteEverywhere,
  keepLocal,
  keepRemote,
  loadReconciliation
} from "../src/reconcile.js";
import { onEntriesChanged } from "../src/events.js";
import { syncNow } from "../src/sync.js";
import { durationSeconds, formatElapsed, shortDateTime } from "../src/time.js";
import { $, entryTitle, formatError } from "../src/ui-helpers.js";

let report = null;
let busy = false;
let unsubscribeEntryEvents = null;

function setStatus(message) {
  $("#statusLine").textContent = message;
}

function setBusy(next) {
  busy = next;
  for (const button of document.querySelectorAll("button")) button.disabled = next;
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

function differenceTable(differences) {
  const table = document.createElement("table");
  table.className = "diff-table";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Field", "This device", "Spreadsheet"]) {
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
  if (!items.length) return [emptyNote("Nothing differs between this device and the spreadsheet.")];

  return items.map((item) => {
    const row = document.createElement("article");
    row.className = "row";
    const badges = item.newer === "same" ? ["same timestamp"] : [`${item.newer} is newer`];
    row.append(
      rowHeading(item.local, badges),
      differenceTable(item.differences),
      actionRow([
        { label: "Keep this device", action: () => keepLocal(item.id, item.remote, { expectedRevision: item.local.revision }) },
        { label: "Keep spreadsheet", action: () => keepRemote(item.remote) }
      ])
    );
    return row;
  });
}

function renderDuplicates(items) {
  if (!items.length) return [emptyNote("No entry appears in more than one spreadsheet row.")];

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

/**
 * Row deletion cannot be undone from here and touches the spreadsheet directly,
 * so it always asks first.
 */
async function confirmDeleteRows(rows) {
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
  if (!items.length) return [emptyNote("Every local entry exists in the spreadsheet.")];

  return items.map((item) => {
    const row = document.createElement("article");
    row.className = "row";
    row.append(
      rowHeading(item.local, item.local.dirty ? ["pending upload"] : []),
      actionRow([
        { label: "Upload to spreadsheet", action: () => keepLocal(item.id, null, { expectedRevision: item.local.revision }) },
        { label: "Delete", action: () => deleteEverywhere(item.id), danger: true }
      ])
    );
    return row;
  });
}

function renderRemoteOnly(items) {
  if (!items.length) return [emptyNote("Every spreadsheet row exists on this device.")];

  return items.map((item) => {
    const row = document.createElement("article");
    row.className = "row";
    row.append(
      rowHeading(item.remote),
      actionRow([
        { label: "Import to this device", action: () => keepRemote(item.remote) },
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
    + report.duplicateRowCount;
}

function render() {
  if (!report) return;

  $("#localCount").textContent = String(report.localCount);
  $("#remoteRowCount").textContent = String(report.remoteRowCount);
  $("#remoteCount").textContent = String(report.remoteCount);
  $("#duplicateRowCount").textContent = String(report.duplicateRowCount);
  $("#inSyncCount").textContent = String(report.inSync);
  $("#divergenceCount").textContent = String(divergenceCount());

  $("#duplicateHeading").textContent = `Duplicate rows in the spreadsheet (${report.duplicates.length})`;
  $("#duplicateList").replaceChildren(...renderDuplicates(report.duplicates));
  $("#deleteAllDuplicates").disabled = !report.duplicates.length;

  $("#differentHeading").textContent = `Different on each side (${report.different.length})`;
  $("#localOnlyHeading").textContent = `Only on this device (${report.localOnly.length})`;
  $("#remoteOnlyHeading").textContent = `Only in the spreadsheet (${report.remoteOnly.length})`;

  $("#differentList").replaceChildren(...renderDifferent(report.different));
  $("#localOnlyList").replaceChildren(...renderLocalOnly(report.localOnly));
  $("#remoteOnlyList").replaceChildren(...renderRemoteOnly(report.remoteOnly));

  $("#keepAllLocal").disabled = !report.different.length;
  $("#keepAllRemote").disabled = !report.different.length;
  $("#keepAllNewest").disabled = !report.different.length;
  $("#pushAllLocal").disabled = !report.localOnly.length;
  $("#importAllRemote").disabled = !report.remoteOnly.length;
}

async function scan({ quiet = false } = {}) {
  if (!quiet) setStatus("Comparing this device with the spreadsheet...");
  setBusy(true);
  try {
    report = await loadReconciliation({ interactiveAuth: false });
    render();
    const divergences = divergenceCount();
    setStatus(divergences
      ? `${divergences} divergence${divergences === 1 ? "" : "s"} found. Choose a side, then sync.`
      : "This device and the spreadsheet agree on every entry.");
  } catch (error) {
    setStatus(`Could not compare: ${formatError(error)}`);
  } finally {
    setBusy(false);
  }
}

/**
 * Resolutions only write locally, marking a side as the one to keep. The sync that
 * follows is what carries the decision to the spreadsheet, so one code path owns
 * all remote writes.
 */
async function resolve(action) {
  if (busy) return;
  setBusy(true);
  try {
    setStatus("Applying...");
    await action();
    await syncNow({ force: true });
    setBusy(false);
    await scan({ quiet: true });
  } catch (error) {
    setStatus(`Could not apply: ${formatError(error)}`);
    setBusy(false);
  }
}

function resolveMany(items, pick) {
  return resolve(async () => {
    for (const item of items) await pick(item);
  });
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
  $("#rescanButton").addEventListener("click", () => scan());
  $("#syncButton").addEventListener("click", runSync);
  $("#deleteAllDuplicates").addEventListener("click", () => resolve(() => confirmDeleteRows(
    report.duplicates.flatMap((item) => item.extraRows)
  )));
  $("#keepAllLocal").addEventListener("click", () => resolveMany(report.different, (item) => (
    keepLocal(item.id, item.remote, { expectedRevision: item.local.revision })
  )));
  $("#keepAllRemote").addEventListener("click", () => resolveMany(report.different, (item) => keepRemote(item.remote)));
  $("#keepAllNewest").addEventListener("click", () => resolveMany(report.different, (item) => (
    item.newer === "remote" ? keepRemote(item.remote) : keepLocal(item.id, item.remote, { expectedRevision: item.local.revision })
  )));
  $("#pushAllLocal").addEventListener("click", () => resolveMany(report.localOnly, (item) => (
    keepLocal(item.id, null, { expectedRevision: item.local.revision })
  )));
  $("#importAllRemote").addEventListener("click", () => resolveMany(report.remoteOnly, (item) => keepRemote(item.remote)));
}

async function init() {
  bindEvents();
  unsubscribeEntryEvents = onEntriesChanged((detail) => {
    // A sync started elsewhere can invalidate the comparison on screen.
    if (busy || detail.action === "reconcile") return;
    scan({ quiet: true }).catch(() => {});
  });
  await scan();
}

window.addEventListener("pagehide", () => {
  if (unsubscribeEntryEvents) unsubscribeEntryEvents();
});

init();

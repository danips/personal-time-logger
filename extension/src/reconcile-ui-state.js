export function duplicateRecordsSupported(report) {
  return report?.provider?.capabilities?.duplicateRemoteRecords === true;
}

export function reconciliationActionEligibility(report) {
  const newest = (report?.different || []).filter((item) => item?.newer === "local" || item?.newer === "remote");
  return {
    deleteAllDuplicates: Boolean(report?.duplicates?.length),
    keepAllLocal: Boolean(report?.different?.length),
    keepAllRemote: Boolean(report?.different?.length),
    keepAllNewest: Boolean(newest.length),
    pushAllLocal: Boolean(report?.localOnly?.length),
    importAllRemote: Boolean(report?.remoteOnly?.length)
  };
}

export function buildKeepNewestCommands(different = []) {
  return different.filter((item) => item?.newer === "local" || item?.newer === "remote").map((item) => item.newer === "remote"
    ? { action: "keepRemote", id: item.id, remoteEntry: item.remote, expectedLocalRevision: item.local.revision }
    : { action: "keepLocal", id: item.id, remoteEntry: item.remote, expectedRevision: item.local.revision });
}

export function reconciliationActionDisabled(busy, eligible) {
  return Boolean(busy || !eligible);
}

export function bulkResolutionPreview(items = []) {
  const rows = Array.isArray(items) ? items : [];
  return {
    affectedCount: rows.length,
    equalTimestampConflicts: rows.filter((item) => item?.newer === "conflict").length,
    preconditionCount: rows.filter((item) => item?.id).length
  };
}

export function operationOutcome({ completed = 0, pending = 0, failed = 0 } = {}) {
  return {
    completed: Math.max(0, Number(completed) || 0),
    pending: Math.max(0, Number(pending) || 0),
    failed: Math.max(0, Number(failed) || 0)
  };
}

export function paginateReconciliationItems(items = [], { page = 0, pageSize = 50 } = {}) {
  const values = Array.isArray(items) ? items : [];
  const size = Math.max(1, Number(pageSize) || 50);
  const pageCount = Math.max(1, Math.ceil(values.length / size));
  const currentPage = Math.min(Math.max(0, Number(page) || 0), pageCount - 1);
  return {
    items: values.slice(currentPage * size, (currentPage + 1) * size),
    page: currentPage,
    pageCount,
    total: values.length
  };
}

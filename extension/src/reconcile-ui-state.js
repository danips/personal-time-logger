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

export function reconciliationActionEligibility(report) {
  return {
    deleteAllDuplicates: Boolean(report?.duplicates?.length),
    keepAllLocal: Boolean(report?.different?.length),
    keepAllRemote: Boolean(report?.different?.length),
    keepAllNewest: Boolean(report?.different?.length),
    pushAllLocal: Boolean(report?.localOnly?.length),
    importAllRemote: Boolean(report?.remoteOnly?.length)
  };
}

export function reconciliationActionDisabled(busy, eligible) {
  return Boolean(busy || !eligible);
}

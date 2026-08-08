let contextSequence = 0;

/**
 * Loads isolated ESM instances of the IndexedDB repository. Each import has a
 * unique URL, so its module-level state (including dbPromise) is independent,
 * while globalThis.indexedDB remains shared just as it is between extension
 * contexts.
 */
export async function createDbContexts(labels) {
  const batch = ++contextSequence;
  return Promise.all(labels.map((label, index) => {
    const moduleUrl = new URL("../../src/db.js", import.meta.url);
    moduleUrl.searchParams.set("test_context", `${batch}-${index}-${label}`);
    return import(moduleUrl.href);
  }));
}

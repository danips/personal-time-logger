import { ERROR_CODE } from "./error-codes.js";

const DB_NAME = "timelogger_db";
const DB_VERSION = 4;
const ENTRY_STORE = "time_entries";
const SETTINGS_STORE = "settings";
const LOCK_GENERATION_SUFFIX = ":generation";
const ENTRY_INDEX = {
  ACTIVE: "active_by_start",
  DIRTY: "dirty_key",
  DELETED_AT: "deleted_at",
  END_AT: "end_at",
  START_AT: "start_at",
  STATUS: "status"
};
const LEGACY_DIRTY_INDEX = "dirty";

let dbPromise = null;

export class StorageConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "StorageConflictError";
    this.code = ERROR_CODE.STORAGE_CONFLICT;
    Object.assign(this, details);
  }
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
  });
}

function openDb() {
  if (dbPromise) return dbPromise;

  const pending = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const entries = db.objectStoreNames.contains(ENTRY_STORE)
        ? request.transaction.objectStore(ENTRY_STORE)
        : db.createObjectStore(ENTRY_STORE, { keyPath: "id" });
      ensureEntryIndexes(entries);
      if (event.oldVersion < 4) migrateDirtyEntryKeys(entries);
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
      }
    };

    request.onblocked = () => {
      const error = new Error("IndexedDB upgrade is blocked by another extension context");
      error.code = ERROR_CODE.DB_BLOCKED;
      reject(error);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        if (dbPromise === pending) dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error("Could not open IndexedDB"));
  });
  dbPromise = pending;
  pending.catch(() => {
    if (dbPromise === pending) dbPromise = null;
  });
  return dbPromise;
}

function ensureEntryIndexes(entries) {
  if (entries.indexNames.contains(LEGACY_DIRTY_INDEX)) entries.deleteIndex(LEGACY_DIRTY_INDEX);
  const indexes = [
    [ENTRY_INDEX.DIRTY, "dirty_key"],
    [ENTRY_INDEX.DELETED_AT, "deleted_at"],
    [ENTRY_INDEX.START_AT, "start_at"],
    [ENTRY_INDEX.END_AT, "end_at"],
    [ENTRY_INDEX.STATUS, "status"],
    // Exact empty deleted/end values select active entries without scanning
    // completed history, then return them in start-time order.
    [ENTRY_INDEX.ACTIVE, ["deleted_at", "end_at", "start_at"]]
  ];
  for (const [name, keyPath] of indexes) {
    if (!entries.indexNames.contains(name)) entries.createIndex(name, keyPath);
  }
}

async function stores(names, mode, fn) {
  const db = await openDb();
  const storeNames = Array.isArray(names) ? names : [names];
  const tx = db.transaction(storeNames, mode);
  const objectStores = new Map(storeNames.map((name) => [name, tx.objectStore(name)]));
  const result = await fn(objectStores, tx);
  if (mode !== "readonly") await txDone(tx);
  return result;
}

async function store(name, mode, fn) {
  return stores(name, mode, (objectStores) => fn(objectStores.get(name)));
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function entryForStorage(entry) {
  const stored = { ...entry };
  delete stored.dirty_key;
  return entry.dirty === true ? { ...stored, dirty_key: 1 } : stored;
}

function entryFromStorage(entry) {
  if (entry === undefined) return undefined;
  const publicEntry = { ...entry };
  delete publicEntry.dirty_key;
  return publicEntry;
}

function sameStoredValue(left, right) {
  if (Object.is(left, right)) return true;
  // Entries and settings are persisted as JSON-shaped data. Comparing that shape
  // lets atomic helpers skip writes when a caller only read a value in order to
  // decide what to change.
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readSettings(objectStore, keys) {
  const original = new Map();
  const settings = new Map();
  for (const key of keys) {
    const record = await requestToPromise(objectStore.get(key));
    if (!record) continue;
    const value = clone(record.value);
    original.set(key, value);
    settings.set(key, clone(value));
  }
  return { original, settings };
}

async function writeChangedSettings(objectStore, keys, original, settings) {
  for (const key of keys) {
    const hadValue = original.has(key);
    const hasValue = settings.has(key);
    if (!hasValue) {
      if (hadValue) await requestToPromise(objectStore.delete(key));
      continue;
    }
    const next = settings.get(key);
    if (!hadValue || !sameStoredValue(original.get(key), next)) {
      await requestToPromise(objectStore.put({ key, value: next }));
    }
  }
}

async function writeChangedEntries(objectStore, original, entries) {
  for (const [id, previous] of original) {
    if (!entries.has(id) && previous !== undefined) {
      await requestToPromise(objectStore.delete(id));
    }
  }
  for (const [id, entry] of entries) {
    if (entry === undefined) {
      if (original.get(id) !== undefined) await requestToPromise(objectStore.delete(id));
      continue;
    }
    if (!entry || entry.id !== id) throw new TypeError("Mutated entries must retain their id");
    const stored = entryForStorage(entry);
    if (!original.has(id) || original.get(id) === undefined || !sameStoredValue(original.get(id), stored)) {
      await requestToPromise(objectStore.put(stored));
    }
  }
}

function migrateDirtyEntryKeys(entries) {
  const request = entries.getAll();
  request.onsuccess = () => {
    for (const entry of request.result || []) {
      const migrated = entryForStorage(entry);
      if (!sameStoredValue(entry, migrated)) entries.put(migrated);
    }
  };
}

function expectedRevisionFor(id, expectedRevisions, ids) {
  if (expectedRevisions === undefined || expectedRevisions === null) return undefined;
  if (expectedRevisions instanceof Map) return expectedRevisions.get(id);
  if (typeof expectedRevisions === "object") return expectedRevisions[id];
  return ids.length === 1 ? expectedRevisions : undefined;
}

function assertExpectedRevision(id, entry, expectedRevision) {
  if (!entry) {
    if (expectedRevision === undefined || expectedRevision === null) return;
    throw new StorageConflictError("Entry no longer exists", { id, reason: "missing" });
  }
  if (expectedRevision === undefined || expectedRevision === null) return;
  const actualRevision = Number(entry.revision || 0);
  if (actualRevision !== Number(expectedRevision)) {
    throw new StorageConflictError("Entry was changed in another context", {
      id,
      reason: "revision_mismatch",
      expectedRevision: Number(expectedRevision),
      actualRevision
    });
  }
}

export async function getSetting(key, fallback = null) {
  const record = await store(SETTINGS_STORE, "readonly", (s) => requestToPromise(s.get(key)));
  return record ? record.value : fallback;
}

export async function setSetting(key, value) {
  await store(SETTINGS_STORE, "readwrite", (s) => requestToPromise(s.put({ key, value })));
  return value;
}

/**
 * Reads and writes a fixed set of settings in one short transaction. The
 * mutator receives a Map of setting values, may call set/delete on it, and must
 * stay synchronous so IndexedDB keeps the transaction active.
 */
export async function mutateSettings(keys, mutator) {
  const uniqueKeys = [...new Set(keys)];
  return stores(SETTINGS_STORE, "readwrite", async (objectStores) => {
    const objectStore = objectStores.get(SETTINGS_STORE);
    const { original, settings } = await readSettings(objectStore, uniqueKeys);

    const result = mutator(settings);
    if (result && typeof result.then === "function") {
      throw new TypeError("Settings mutators must not return a Promise");
    }

    await writeChangedSettings(objectStore, uniqueKeys, original, settings);
    return result;
  });
}

export async function mutateSetting(key, mutator) {
  return mutateSettings([key], (values) => {
    const next = mutator(values.get(key));
    if (next && typeof next.then === "function") {
      throw new TypeError("Setting mutators must not return a Promise");
    }
    if (next === undefined) values.delete(key);
    else values.set(key, next);
    return next;
  });
}

/**
 * Claims a named lock, held in the settings store so it is visible to every
 * extension context. The get and the put share one readwrite transaction, and
 * IndexedDB serializes transactions across contexts, so two callers cannot both
 * observe the lock as free. Each successful new claim receives a monotonically
 * increasing generation, which callers use as a fencing token. Returns false
 * when someone else holds it.
 */
export async function claimLock(key, holder, ttlMs) {
  return store(SETTINGS_STORE, "readwrite", async (objectStore) => {
    const record = await requestToPromise(objectStore.get(key));
    const lock = record ? record.value : null;
    const heldUntil = lock ? Number(lock.acquired_at || 0) + ttlMs : 0;
    if (lock && lock.holder !== holder && heldUntil > Date.now()) return false;
    if (lock && lock.holder === holder && heldUntil > Date.now()) {
      const generation = Number(lock.generation || 0) || 1;
      await requestToPromise(objectStore.put({ key, value: { ...lock, generation, acquired_at: Date.now() } }));
      return { holder, generation };
    }
    const generationKey = `${key}${LOCK_GENERATION_SUFFIX}`;
    const generationRecord = await requestToPromise(objectStore.get(generationKey));
    const generation = Number(generationRecord?.value || 0) + 1;
    await requestToPromise(objectStore.put({ key: generationKey, value: generation }));
    await requestToPromise(objectStore.put({ key, value: { holder, generation, acquired_at: Date.now() } }));
    return { holder, generation };
  });
}

export async function releaseLock(key, holder, generation = undefined) {
  await store(SETTINGS_STORE, "readwrite", async (objectStore) => {
    const record = await requestToPromise(objectStore.get(key));
    const lock = record ? record.value : null;
    if (!lock || lock.holder !== holder || (generation !== undefined && Number(lock.generation) !== Number(generation))) return;
    await requestToPromise(objectStore.delete(key));
  });
}

export async function renewLock(key, holder, generation = undefined) {
  return store(SETTINGS_STORE, "readwrite", async (objectStore) => {
    const record = await requestToPromise(objectStore.get(key));
    const lock = record ? record.value : null;
    if (!lock || lock.holder !== holder || (generation !== undefined && Number(lock.generation) !== Number(generation))) return false;
    await requestToPromise(objectStore.put({ key, value: { ...lock, acquired_at: Date.now() } }));
    return true;
  });
}

export async function isLockCurrent(key, holder, generation, ttlMs) {
  return store(SETTINGS_STORE, "readonly", async (objectStore) => {
    const record = await requestToPromise(objectStore.get(key));
    const lock = record ? record.value : null;
    return Boolean(lock
      && lock.holder === holder
      && Number(lock.generation) === Number(generation)
      && Number(lock.acquired_at || 0) + ttlMs > Date.now());
  });
}

export async function deleteEntry(id) {
  await store(ENTRY_STORE, "readwrite", (s) => requestToPromise(s.delete(id)));
}

export async function removeSetting(key) {
  await store(SETTINGS_STORE, "readwrite", (s) => requestToPromise(s.delete(key)));
}

export async function getEntry(id) {
  return store(ENTRY_STORE, "readonly", async (s) => entryFromStorage(await requestToPromise(s.get(id))));
}

export async function putEntry(entry) {
  await store(ENTRY_STORE, "readwrite", (s) => requestToPromise(s.put(entryForStorage(entry))));
  return entry;
}

export async function putEntries(entries) {
  if (!entries.length) return;
  await store(ENTRY_STORE, "readwrite", async (s) => {
    for (const entry of entries) await requestToPromise(s.put(entryForStorage(entry)));
  });
}

/**
 * Mutates named entries in one transaction. A mutator can add new ids to the
 * supplied Map, which is useful for duplicate and replacement-timer actions.
 * Supplying expected revisions turns the read into a compare-and-swap.
 */
export async function mutateEntries(ids, expectedRevisions, mutator) {
  if (typeof expectedRevisions === "function") {
    mutator = expectedRevisions;
    expectedRevisions = undefined;
  }
  if (typeof mutator !== "function") throw new TypeError("An entry mutator is required");
  const uniqueIds = [...new Set(ids)];

  return stores(ENTRY_STORE, "readwrite", async (objectStores) => {
    const objectStore = objectStores.get(ENTRY_STORE);
    const original = new Map();
    const entries = new Map();
    for (const id of uniqueIds) {
      const entry = await requestToPromise(objectStore.get(id));
      assertExpectedRevision(id, entry, expectedRevisionFor(id, expectedRevisions, uniqueIds));
      original.set(id, clone(entry));
      entries.set(id, entryFromStorage(entry));
    }

    const result = mutator(entries);
    if (result && typeof result.then === "function") {
      throw new TypeError("Entry mutators must not return a Promise");
    }

    await writeChangedEntries(objectStore, original, entries);
    return result;
  });
}

export async function mutateEntry(id, expectedRevision, mutator) {
  if (typeof expectedRevision === "function") {
    mutator = expectedRevision;
    expectedRevision = undefined;
  }
  if (typeof mutator !== "function") throw new TypeError("An entry mutator is required");
  return mutateEntries([id], expectedRevision, (entries) => {
    const next = mutator(entries.get(id));
    if (next && typeof next.then === "function") {
      throw new TypeError("Entry mutators must not return a Promise");
    }
    if (next === undefined) entries.delete(id);
    else entries.set(id, next);
    return next;
  });
}

/** Mutates every entry in one transaction, for operations defined by a query. */
export async function mutateAllEntries(mutator) {
  if (typeof mutator !== "function") throw new TypeError("An entry mutator is required");
  return stores(ENTRY_STORE, "readwrite", async (objectStores) => {
    const objectStore = objectStores.get(ENTRY_STORE);
    const existing = await requestToPromise(objectStore.getAll());
    const original = new Map(existing.map((entry) => [entry.id, clone(entry)]));
    const entries = new Map(existing.map((entry) => [entry.id, entryFromStorage(entry)]));
    const result = mutator(entries);
    if (result && typeof result.then === "function") {
      throw new TypeError("Entry mutators must not return a Promise");
    }

    await writeChangedEntries(objectStore, original, entries);
    return result;
  });
}

export async function getAllEntries() {
  return store(ENTRY_STORE, "readonly", async (s) => (await requestToPromise(s.getAll())).map(entryFromStorage));
}

function keyRange(method, ...args) {
  return globalThis.IDBKeyRange[method](...args);
}

function readEntriesFromIndex(objectStore, name, { range = null, direction = "next", limit = Infinity, filter = () => true } = {}) {
  return new Promise((resolve, reject) => {
    const entries = [];
    const request = objectStore.index(name).openCursor(range, direction);
    request.onerror = () => reject(request.error || new Error("IndexedDB index query failed"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || entries.length >= limit) {
        resolve(entries);
        return;
      }
      const entry = cursor.value;
      if (filter(entry)) entries.push(entry);
      if (entries.length >= limit) {
        resolve(entries);
        return;
      }
      cursor.continue();
    };
  });
}

async function entriesFromIndex(name, options = {}) {
  return store(ENTRY_STORE, "readonly", async (objectStore) => (await readEntriesFromIndex(objectStore, name, options)).map(entryFromStorage));
}

/**
 * Mutates named entries and settings in one transaction. Callers may opt into
 * the active-entry index and add one or more setting-derived entry ids before
 * the synchronous mutator runs. It avoids loading unrelated history.
 */
export async function mutateEntryState({
  entryIds = [],
  settingKeys = [],
  includeActiveEntries = false,
  additionalEntryIds = () => []
} = {}, mutator) {
  if (typeof mutator !== "function") throw new TypeError("An entry-state mutator is required");
  const uniqueKeys = [...new Set(settingKeys)];
  return stores([ENTRY_STORE, SETTINGS_STORE], "readwrite", async (objectStores) => {
    const entryStore = objectStores.get(ENTRY_STORE);
    const settingsStore = objectStores.get(SETTINGS_STORE);
    const { original: originalSettings, settings } = await readSettings(settingsStore, uniqueKeys);
    const requestedIds = new Set(entryIds);
    for (const id of additionalEntryIds(settings) || []) requestedIds.add(id);

    const originalEntries = new Map();
    const entries = new Map();
    const addEntry = (entry) => {
      const value = clone(entry);
      originalEntries.set(entry.id, value);
      entries.set(entry.id, entryFromStorage(value));
    };

    if (includeActiveEntries) {
      const active = await readEntriesFromIndex(entryStore, ENTRY_INDEX.ACTIVE, {
        range: keyRange("bound", ["", "", ""], ["", "", "\uffff"])
      });
      for (const entry of active) addEntry(entry);
    }
    for (const id of requestedIds) {
      if (entries.has(id)) continue;
      const entry = await requestToPromise(entryStore.get(id));
      const value = clone(entry);
      originalEntries.set(id, value);
      entries.set(id, entryFromStorage(value));
    }

    const result = mutator({ entries, settings });
    if (result && typeof result.then === "function") {
      throw new TypeError("Entry-state mutators must not return a Promise");
    }

    await writeChangedEntries(entryStore, originalEntries, entries);
    await writeChangedSettings(settingsStore, uniqueKeys, originalSettings, settings);
    return result;
  });
}

/**
 * Mutates the complete entry table and named settings in one transaction.
 * Reserved for intentional whole-history operations such as spreadsheet reseed.
 */
export async function mutateAllLocalState(settingKeys, mutator) {
  if (typeof mutator !== "function") throw new TypeError("A local-state mutator is required");
  const uniqueKeys = [...new Set(settingKeys)];
  return stores([ENTRY_STORE, SETTINGS_STORE], "readwrite", async (objectStores) => {
    const entryStore = objectStores.get(ENTRY_STORE);
    const settingsStore = objectStores.get(SETTINGS_STORE);
    const existing = await requestToPromise(entryStore.getAll());
    const originalEntries = new Map(existing.map((entry) => [entry.id, clone(entry)]));
    const entries = new Map(existing.map((entry) => [entry.id, entryFromStorage(entry)]));
    const { original: originalSettings, settings } = await readSettings(settingsStore, uniqueKeys);

    const result = mutator({ entries, settings });
    if (result && typeof result.then === "function") {
      throw new TypeError("Local-state mutators must not return a Promise");
    }

    await writeChangedEntries(entryStore, originalEntries, entries);
    await writeChangedSettings(settingsStore, uniqueKeys, originalSettings, settings);
    return result;
  });
}

export async function getDirtyEntries() {
  return entriesFromIndex(ENTRY_INDEX.DIRTY, { range: keyRange("only", 1) });
}

export async function getDirtyEntryCount() {
  return store(ENTRY_STORE, "readonly", (objectStore) => requestToPromise(
    objectStore.index(ENTRY_INDEX.DIRTY).count(keyRange("only", 1))
  ));
}

/**
 * Reads the newest visible entries first. Supplying a limit keeps history pages
 * bounded; callers that need a specific time interval should use the interval
 * query below instead of scanning prior history.
 */
export async function getVisibleEntries({ limit = Infinity } = {}) {
  return entriesFromIndex(ENTRY_INDEX.START_AT, {
    direction: "prev",
    limit,
    filter: (entry) => !entry.deleted_at
  });
}

export async function getDeletedEntries() {
  return entriesFromIndex(ENTRY_INDEX.DELETED_AT, {
    range: keyRange("lowerBound", "", true)
  });
}

export async function getEntriesByStatus(status) {
  return entriesFromIndex(ENTRY_INDEX.STATUS, { range: keyRange("only", String(status || "")) });
}

export async function getActiveEntries() {
  return entriesFromIndex(ENTRY_INDEX.ACTIVE, {
    range: keyRange("bound", ["", "", ""], ["", "", "\uffff"])
  });
}

/**
 * Returns visible entries that may overlap [start, end). The end-time index
 * excludes completed history that ended before the requested interval; active
 * entries are included through their dedicated index.
 */
export async function getEntriesIntersecting(start, end) {
  const startAt = new Date(start).toISOString();
  const endAt = new Date(end).toISOString();
  const [completed, active] = await Promise.all([
    entriesFromIndex(ENTRY_INDEX.END_AT, {
      range: keyRange("lowerBound", startAt, true),
      filter: (entry) => !entry.deleted_at && Boolean(entry.end_at) && String(entry.start_at || "") < endAt
    }),
    getActiveEntries()
  ]);
  return [...new Map([...completed, ...active]
    .filter((entry) => String(entry.start_at || "") < endAt)
    .map((entry) => [entry.id, entry]))
    .values()]
    .sort((left, right) => String(left.start_at).localeCompare(String(right.start_at)));
}

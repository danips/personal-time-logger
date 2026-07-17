const DB_NAME = "timelogger_db";
const DB_VERSION = 1;
const ENTRY_STORE = "time_entries";
const SETTINGS_STORE = "settings";

let dbPromise = null;

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

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ENTRY_STORE)) {
        const entries = db.createObjectStore(ENTRY_STORE, { keyPath: "id" });
        entries.createIndex("updated_at", "updated_at", { unique: false });
        entries.createIndex("dirty", "dirty", { unique: false });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open IndexedDB"));
  });

  return dbPromise;
}

async function store(name, mode, fn) {
  const db = await openDb();
  const tx = db.transaction(name, mode);
  const objectStore = tx.objectStore(name);
  const result = await fn(objectStore);
  if (mode !== "readonly") await txDone(tx);
  return result;
}

export async function getSetting(key, fallback = null) {
  const record = await store(SETTINGS_STORE, "readonly", (s) => requestToPromise(s.get(key)));
  return record ? record.value : fallback;
}

export async function setSetting(key, value) {
  await store(SETTINGS_STORE, "readwrite", (s) => requestToPromise(s.put({ key, value })));
  return value;
}

export async function removeSetting(key) {
  await store(SETTINGS_STORE, "readwrite", (s) => requestToPromise(s.delete(key)));
}

export async function getEntry(id) {
  return store(ENTRY_STORE, "readonly", (s) => requestToPromise(s.get(id)));
}

export async function putEntry(entry) {
  await store(ENTRY_STORE, "readwrite", (s) => requestToPromise(s.put(entry)));
  return entry;
}

export async function putEntries(entries) {
  if (!entries.length) return;
  await store(ENTRY_STORE, "readwrite", async (s) => {
    for (const entry of entries) await requestToPromise(s.put(entry));
  });
}

export async function getAllEntries() {
  return store(ENTRY_STORE, "readonly", (s) => requestToPromise(s.getAll()));
}

export async function getDirtyEntries() {
  const entries = await getAllEntries();
  return entries.filter((entry) => entry.dirty);
}

export async function getVisibleEntries() {
  const entries = await getAllEntries();
  return entries
    .filter((entry) => !entry.deleted_at)
    .sort((a, b) => String(b.start_at || b.updated_at).localeCompare(String(a.start_at || a.updated_at)));
}

export async function getActiveEntries() {
  const entries = await getAllEntries();
  return entries
    .filter((entry) => !entry.deleted_at && !entry.end_at)
    .sort((a, b) => String(b.start_at).localeCompare(String(a.start_at)));
}

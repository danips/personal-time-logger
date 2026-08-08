const clone = (value) => (value === undefined ? undefined : structuredClone(value));

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
  }

  succeed(result) {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.({ target: this }));
  }

  fail(error) {
    this.error = error;
    queueMicrotask(() => this.onerror?.({ target: this }));
  }
}

class FakeObjectStoreNames {
  constructor(stores) {
    this.stores = stores;
  }

  contains(name) {
    return this.stores.has(name);
  }
}

class FakeDatabase {
  constructor(state) {
    this.state = state;
    this.objectStoreNames = new FakeObjectStoreNames(state.stores);
    this.onversionchange = null;
  }

  createObjectStore(name, options = {}) {
    if (this.state.stores.has(name)) throw new Error(`Store already exists: ${name}`);
    this.state.stores.set(name, {
      keyPath: options.keyPath,
      records: new Map()
    });
    return this.transactionStore(name, "versionchange");
  }

  transaction(name, mode = "readonly") {
    if (!this.state.stores.has(name)) throw new Error(`Unknown object store: ${name}`);
    const transaction = new FakeTransaction(this.state, name, mode);
    this.state.transactions.push(transaction);
    this.state.runNextTransaction();
    return transaction;
  }

  transactionStore(name, mode) {
    return new FakeObjectStore(this.state.stores.get(name), null, mode);
  }

  close() {}
}

class FakeTransaction {
  constructor(state, storeName, mode) {
    this.state = state;
    this.storeName = storeName;
    this.mode = mode;
    this.error = null;
    this.oncomplete = null;
    this.onabort = null;
    this.onerror = null;
    this.pending = 0;
    this.hasOperations = false;
    this.started = false;
    this.finished = false;
  }

  objectStore(name) {
    if (name !== this.storeName) throw new Error(`Store not in transaction: ${name}`);
    return new FakeObjectStore(this.state.stores.get(name), this, this.mode);
  }

  enqueue(operation) {
    if (this.finished) throw new Error("Transaction is no longer active");
    this.hasOperations = true;
    this.pending += 1;
    const request = new FakeRequest();
    setTimeout(() => {
      try {
        request.succeed(operation());
      } catch (error) {
        this.error = error;
        request.fail(error);
        this.finish(false);
        return;
      }
      this.pending -= 1;
      this.finishWhenIdle();
    }, 0);
    return request;
  }

  finishWhenIdle() {
    if (!this.started || this.finished || !this.hasOperations || this.pending !== 0) return;
    setTimeout(() => {
      if (this.pending === 0) this.finish(true);
    }, 0);
  }

  finish(success) {
    if (this.finished) return;
    this.finished = true;
    if (success) {
      this.oncomplete?.({ target: this });
    } else {
      this.onabort?.({ target: this });
      this.onerror?.({ target: this });
    }
    this.state.runNextTransaction();
  }
}

class FakeObjectStore {
  constructor(store, transaction, mode) {
    this.store = store;
    this.transaction = transaction;
    this.mode = mode;
  }

  request(operation) {
    return this.transaction.enqueue(operation);
  }

  get(key) {
    return this.request(() => clone(this.store.records.get(key)));
  }

  getAll() {
    return this.request(() => [...this.store.records.values()].map(clone));
  }

  put(value) {
    return this.request(() => {
      const key = value[this.store.keyPath];
      if (key === undefined) throw new Error(`Missing key path: ${this.store.keyPath}`);
      this.store.records.set(key, clone(value));
      return key;
    });
  }

  delete(key) {
    return this.request(() => {
      this.store.records.delete(key);
      return undefined;
    });
  }
}

function createIndexedDB() {
  const databases = new Map();
  const state = {
    transactions: [],
    runNextTransaction() {
      const next = this.transactions.find((transaction) => !transaction.started);
      if (!next) return;
      if (this.transactions.some((transaction) => transaction !== next && transaction.started && !transaction.finished)) {
        return;
      }
      next.started = true;
      next.finishWhenIdle();
    }
  };

  return {
    open(name, requestedVersion = 1) {
      const request = new FakeRequest();
      setTimeout(() => {
        let database = databases.get(name);
        const isNew = !database;
        if (!database) {
          database = { version: 0, stores: new Map(), transactions: [] };
          database.runNextTransaction = state.runNextTransaction;
          databases.set(name, database);
        }
        if (requestedVersion < database.version) {
          request.fail(new Error("VersionError"));
          return;
        }

        const connection = new FakeDatabase(database);
        request.result = connection;
        if (isNew || requestedVersion > database.version) {
          const oldVersion = database.version;
          database.version = requestedVersion;
          request.onupgradeneeded?.({ target: request, oldVersion, newVersion: requestedVersion });
        }
        request.succeed(connection);
      }, 0);
      return request;
    },

    deleteDatabase(name) {
      const request = new FakeRequest();
      setTimeout(() => {
        databases.delete(name);
        request.succeed(undefined);
      }, 0);
      return request;
    },

    _reset() {
      databases.clear();
    }
  };
}

export function installFakeIndexedDB() {
  const indexedDB = createIndexedDB();
  globalThis.indexedDB = indexedDB;
  return indexedDB;
}

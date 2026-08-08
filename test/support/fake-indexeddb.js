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

  transaction(names, mode = "readonly") {
    const storeNames = Array.isArray(names) ? names : [names];
    for (const name of storeNames) {
      if (!this.state.stores.has(name)) throw new Error(`Unknown object store: ${name}`);
    }
    const transaction = new FakeTransaction(this.state, storeNames, mode);
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
  constructor(state, storeNames, mode) {
    this.state = state;
    this.storeNames = storeNames;
    this.mode = mode;
    this.error = null;
    this.oncomplete = null;
    this.onabort = null;
    this.onerror = null;
    this.pending = 0;
    this.hasOperations = false;
    this.started = false;
    this.finished = false;
    this.operations = [];
    this.processing = false;
    this.workingRecords = null;
  }

  objectStore(name) {
    if (!this.storeNames.includes(name)) throw new Error(`Store not in transaction: ${name}`);
    return new FakeObjectStore(this.state.stores.get(name), this, this.mode);
  }

  enqueue(operation) {
    if (this.finished) throw new Error("Transaction is no longer active");
    this.hasOperations = true;
    this.pending += 1;
    const request = new FakeRequest();
    this.operations.push({ operation, request });
    this.runNextOperation();
    return request;
  }

  start() {
    this.started = true;
    this.workingRecords = new Map(this.storeNames.map((name) => {
      const store = this.state.stores.get(name);
      return [store, new Map([...store.records].map(([key, value]) => [key, clone(value)]))];
    }));
    this.runNextOperation();
    this.finishWhenIdle();
  }

  recordsFor(store) {
    return this.workingRecords?.get(store) || store.records;
  }

  consumeWriteFailure() {
    return this.state.consumeWriteFailure();
  }

  runNextOperation() {
    if (!this.started || this.finished || this.processing || !this.operations.length) return;
    this.processing = true;
    const { operation, request } = this.operations.shift();
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
      this.processing = false;
      this.runNextOperation();
      this.finishWhenIdle();
    }, 0);
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
      if (this.mode !== "readonly") {
        for (const [store, records] of this.workingRecords || []) store.records = records;
      }
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
    return this.request(() => clone(this.transaction.recordsFor(this.store).get(key)));
  }

  getAll() {
    return this.request(() => [...this.transaction.recordsFor(this.store).values()].map(clone));
  }

  put(value) {
    return this.request(() => {
      if (this.transaction.consumeWriteFailure()) throw new Error("Injected IndexedDB write failure");
      const key = value[this.store.keyPath];
      if (key === undefined) throw new Error(`Missing key path: ${this.store.keyPath}`);
      this.transaction.recordsFor(this.store).set(key, clone(value));
      return key;
    });
  }

  delete(key) {
    return this.request(() => {
      if (this.transaction.consumeWriteFailure()) throw new Error("Injected IndexedDB write failure");
      this.transaction.recordsFor(this.store).delete(key);
      return undefined;
    });
  }
}

function createIndexedDB() {
  const databases = new Map();
  const state = {
    transactions: [],
    writeFailure: null,
    consumeWriteFailure() {
      if (!this.writeFailure) return false;
      this.writeFailure.remaining -= 1;
      if (this.writeFailure.remaining > 0) return false;
      this.writeFailure = null;
      return true;
    },
    runNextTransaction() {
      const next = this.transactions.find((transaction) => !transaction.started);
      if (!next) return;
      if (this.transactions.some((transaction) => transaction !== next && transaction.started && !transaction.finished)) {
        return;
      }
      next.start();
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
          database.consumeWriteFailure = state.consumeWriteFailure.bind(state);
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
    },

    _failOnWrite(writeNumber = 1) {
      state.writeFailure = { remaining: Math.max(1, Number(writeNumber) || 1) };
    }
  };
}

export function installFakeIndexedDB() {
  const indexedDB = createIndexedDB();
  globalThis.indexedDB = indexedDB;
  return indexedDB;
}

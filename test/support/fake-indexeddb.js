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

class FakeIndexNames {
  constructor(indexes) {
    this.indexes = indexes;
  }

  contains(name) {
    return this.indexes.has(name);
  }
}

function indexedValue(value, keyPath) {
  if (Array.isArray(keyPath)) return keyPath.map((key) => value[key]);
  return value[keyPath];
}

function compareKeys(left, right) {
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      const compared = compareKeys(left[index], right[index]);
      if (compared) return compared;
    }
    return left.length - right.length;
  }
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

class FakeKeyRange {
  constructor(lower, upper, lowerOpen = false, upperOpen = false) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = lowerOpen;
    this.upperOpen = upperOpen;
  }

  includes(key) {
    if (this.lower !== undefined) {
      const compared = compareKeys(key, this.lower);
      if (compared < 0 || (this.lowerOpen && compared === 0)) return false;
    }
    if (this.upper !== undefined) {
      const compared = compareKeys(key, this.upper);
      if (compared > 0 || (this.upperOpen && compared === 0)) return false;
    }
    return true;
  }

  static only(value) { return new FakeKeyRange(value, value); }
  static lowerBound(value, open = false) { return new FakeKeyRange(value, undefined, open); }
  static upperBound(value, open = false) { return new FakeKeyRange(undefined, value, false, open); }
  static bound(lower, upper, lowerOpen = false, upperOpen = false) {
    return new FakeKeyRange(lower, upper, lowerOpen, upperOpen);
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
      name,
      keyPath: options.keyPath,
      indexes: new Map(),
      records: new Map(),
      writeLog: []
    });
    return this.transactionStore(name, "versionchange");
  }

  transaction(names, mode = "readonly") {
    const storeNames = Array.isArray(names) ? names : [names];
    for (const name of storeNames) {
      if (!this.state.stores.has(name)) throw new Error(`Unknown object store: ${name}`);
    }
    this.state.transactionLog.push({ storeNames: [...storeNames], mode });
    const transaction = new FakeTransaction(this.state, storeNames, mode);
    this.state.pendingTransactions.push(transaction);
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
    this.commitPaused = false;
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
    if (!this.started || this.finished || this.commitPaused || !this.hasOperations || this.pending !== 0) return;
    setTimeout(() => {
      if (this.pending === 0) this.finish(true);
    }, 0);
  }

  finish(success) {
    if (this.finished || this.commitPaused) return;
    if (success) {
      const gate = this.state.takeCommitGate();
      if (gate) {
        this.commitPaused = true;
        gate.reached.resolve();
        gate.resume = () => {
          if (!this.commitPaused) return;
          this.commitPaused = false;
          this.finish(true);
        };
        return;
      }
    }
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

  get indexNames() {
    this.store.indexes ||= new Map();
    return new FakeIndexNames(this.store.indexes);
  }

  createIndex(name, keyPath, options = {}) {
    this.store.indexes ||= new Map();
    if (this.store.indexes.has(name)) throw new Error(`Index already exists: ${name}`);
    this.store.indexes.set(name, { keyPath, unique: Boolean(options.unique) });
    return new FakeIndex(this.store, this.transaction, this.store.indexes.get(name));
  }

  deleteIndex(name) {
    this.store.indexes ||= new Map();
    this.store.indexes.delete(name);
  }

  index(name) {
    this.store.indexes ||= new Map();
    const definition = this.store.indexes.get(name);
    if (!definition) throw new Error(`Unknown index: ${name}`);
    return new FakeIndex(this.store, this.transaction, definition);
  }

  get(key) {
    return this.request(() => clone(this.records().get(key)));
  }

  getAll() {
    return this.request(() => [...this.records().values()].map(clone));
  }

  put(value) {
    return this.request(() => {
      if (this.transaction?.consumeWriteFailure()) throw new Error("Injected IndexedDB write failure");
      const key = value[this.store.keyPath];
      if (key === undefined) throw new Error(`Missing key path: ${this.store.keyPath}`);
      this.records().set(key, clone(value));
      this.store.writeLog.push({ store: this.store.name, operation: "put", key });
      return key;
    });
  }

  delete(key) {
    return this.request(() => {
      if (this.transaction?.consumeWriteFailure()) throw new Error("Injected IndexedDB write failure");
      this.records().delete(key);
      this.store.writeLog.push({ store: this.store.name, operation: "delete", key });
      return undefined;
    });
  }

  records() {
    return this.transaction ? this.transaction.recordsFor(this.store) : this.store.records;
  }

  request(operation) {
    if (this.transaction) return this.transaction.enqueue(operation);
    const request = new FakeRequest();
    queueMicrotask(() => {
      try {
        request.succeed(operation());
      } catch (error) {
        request.fail(error);
      }
    });
    return request;
  }
}

class FakeIndex {
  constructor(store, transaction, definition) {
    this.store = store;
    this.transaction = transaction;
    this.definition = definition;
  }

  records(range = null, direction = "next") {
    const records = this.transaction ? this.transaction.recordsFor(this.store) : this.store.records;
    const values = [...records.values()]
      .map((value) => ({ key: indexedValue(value, this.definition.keyPath), value: clone(value) }))
      .filter(({ key }) => key !== undefined && (!range || range.includes(key)))
      .sort((left, right) => compareKeys(left.key, right.key));
    if (direction === "prev" || direction === "prevunique") values.reverse();
    return values;
  }

  openCursor(range = null, direction = "next") {
    const rows = this.records(range, direction);
    const transaction = this.transaction;
    let position = 0;
    let request;
    const nextCursor = () => {
      const row = rows[position++];
      if (!row) return null;
      return {
        key: row.key,
        value: row.value,
        continue() {
          const emit = () => request.succeed(nextCursor());
          if (!transaction) {
            queueMicrotask(emit);
            return;
          }
          transaction.enqueue(() => {
            queueMicrotask(emit);
            return undefined;
          });
        }
      };
    };
    if (!transaction) {
      request = new FakeRequest();
      queueMicrotask(() => request.succeed(nextCursor()));
      return request;
    }
    request = transaction.enqueue(() => nextCursor());
    return request;
  }

  count(range = null) {
    return this.transaction.enqueue(() => this.records(range).length);
  }
}

function createIndexedDB() {
  const databases = new Map();
  const state = {
    commitGates: [],
    writeFailure: null,
    consumeWriteFailure() {
      if (!this.writeFailure) return false;
      this.writeFailure.remaining -= 1;
      if (this.writeFailure.remaining > 0) return false;
      this.writeFailure = null;
      return true;
    },
    runNextTransaction() {
      if (this.activeTransaction && !this.activeTransaction.finished) return;
      this.activeTransaction = this.pendingTransactions.shift() || null;
      this.activeTransaction?.start();
    }
  };

  return {
    open(name, requestedVersion = 1) {
      const request = new FakeRequest();
      setTimeout(() => {
        let database = databases.get(name);
        const isNew = !database;
        if (!database) {
          database = {
            version: 0,
            stores: new Map(),
            pendingTransactions: [],
            activeTransaction: null,
            transactionLog: []
          };
          database.runNextTransaction = state.runNextTransaction;
          database.consumeWriteFailure = state.consumeWriteFailure.bind(state);
          database.takeCommitGate = () => state.commitGates.shift();
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
          request.transaction = {
            objectStore(name) {
              return connection.transactionStore(name, "versionchange");
            }
          };
          request.onupgradeneeded?.({ target: request, oldVersion, newVersion: requestedVersion });
          // Versionchange requests scheduled by onupgradeneeded must settle
          // before the connection is exposed, matching IndexedDB upgrade
          // transaction completion semantics.
          setTimeout(() => request.succeed(connection), 0);
          return;
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
      state.commitGates = [];
    },

    _failOnWrite(writeNumber = 1) {
      state.writeFailure = { remaining: Math.max(1, Number(writeNumber) || 1) };
    },

    _resetWriteLog() {
      for (const database of databases.values()) {
        for (const store of database.stores.values()) store.writeLog = [];
      }
    },

    _getWriteLog() {
      return [...databases.values()].flatMap((database) =>
        [...database.stores.values()].flatMap((store) => store.writeLog.map((operation) => ({ ...operation })))
      );
    },

    _resetTransactionLog() {
      for (const database of databases.values()) database.transactionLog = [];
    },

    _getTransactionLog() {
      return [...databases.values()].flatMap((database) =>
        database.transactionLog.map((transaction) => ({ ...transaction, storeNames: [...transaction.storeNames] }))
      );
    },

    _pauseNextCommit() {
      let resolveReached;
      const reached = new Promise((resolve) => { resolveReached = resolve; });
      const gate = { reached: { resolve: resolveReached }, resume: null };
      state.commitGates.push(gate);
      return {
        waitForCommit() {
          return reached;
        },
        release() {
          gate.resume?.();
        }
      };
    }
  };
}

export function installFakeIndexedDB() {
  const indexedDB = createIndexedDB();
  globalThis.indexedDB = indexedDB;
  globalThis.IDBKeyRange = FakeKeyRange;
  return indexedDB;
}

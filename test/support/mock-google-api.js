const clone = (value) => (value === undefined ? undefined : structuredClone(value));

function response(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text);
    }
  };
}

function requestDetails(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url);
  const headers = new Headers(init.headers || (typeof input === "string" ? undefined : input.headers));
  return {
    url: url.toString(),
    pathname: url.pathname,
    search: url.search,
    method: String(init.method || (typeof input === "string" ? "GET" : input.method) || "GET").toUpperCase(),
    headers,
    body: init.body
  };
}

function matches(matcher, request) {
  if (typeof matcher === "function") return matcher(request);
  if (typeof matcher === "string") return request.url === matcher || request.pathname === matcher;
  if (matcher.method && request.method !== String(matcher.method).toUpperCase()) return false;
  if (matcher.url && request.url !== matcher.url) return false;
  if (matcher.pathname && request.pathname !== matcher.pathname) return false;
  return true;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function createGoogleApiMock() {
  const plans = [];
  const calls = [];
  const sheetRows = new Map();
  let previousFetch = null;

  const mock = {
    calls,

    install() {
      previousFetch = globalThis.fetch;
      globalThis.fetch = this.fetch;
      return this;
    },

    restore() {
      globalThis.fetch = previousFetch;
      previousFetch = null;
    },

    enqueue(matcher, responder) {
      plans.push({ matcher, responder });
      return responder;
    },

    json(body, options = {}) {
      return () => response(body, options);
    },

    text(body, options = {}) {
      return () => response(body, options);
    },

    status(status, body = { error: { message: `Google API error ${status}` } }) {
      return this.json(body, { status });
    },

    malformed(body = "{") {
      return this.text(body, { headers: { "Content-Type": "application/json" } });
    },

    barrier(label = "request") {
      const requested = deferred();
      const settled = deferred();
      let request = null;
      return {
        label,
        async respond(nextRequest) {
          request = nextRequest;
          requested.resolve(nextRequest);
          return settled.promise;
        },
        waitForRequest() {
          return requested.promise;
        },
        release(nextResponse = mock.json({})) {
          settled.resolve(typeof nextResponse === "function" ? nextResponse(request) : nextResponse);
        },
        fail(error = new Error(`Mock Google API barrier failed: ${label}`)) {
          settled.reject(error);
        }
      };
    },

    timeout(label = "request") {
      const timeout = this.barrier(label);
      return {
        ...timeout,
        expire(message = `Mock Google API request timed out: ${label}`) {
          timeout.fail(new Error(message));
        }
      };
    },

    setRows(sheetName, rows) {
      sheetRows.set(sheetName, clone(rows));
    },

    rows(sheetName) {
      return clone(sheetRows.get(sheetName) || []);
    },

    insertRows(sheetName, rowIndex, rows) {
      const current = sheetRows.get(sheetName) || [];
      current.splice(Math.max(0, rowIndex - 1), 0, ...clone(rows));
      sheetRows.set(sheetName, current);
    },

    deleteRows(sheetName, rowIndexes) {
      const current = sheetRows.get(sheetName) || [];
      for (const rowIndex of [...new Set(rowIndexes)].sort((a, b) => b - a)) {
        if (rowIndex > 0) current.splice(rowIndex - 1, 1);
      }
      sheetRows.set(sheetName, current);
    },

    async fetch(input, init = {}) {
      const request = requestDetails(input, init);
      calls.push(request);
      const index = plans.findIndex((plan) => matches(plan.matcher, request));
      if (index < 0) {
        throw new Error(`Unexpected Google API request: ${request.method} ${request.url}`);
      }
      const [{ responder }] = plans.splice(index, 1);
      if (responder && typeof responder.respond === "function") return responder.respond(request);
      return typeof responder === "function" ? responder(request) : responder;
    }
  };

  mock.fetch = mock.fetch.bind(mock);
  return mock;
}

import { execFile, spawn } from "node:child_process";
/* global browser, document */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const driverBin = process.env.GECKODRIVER_BIN || "geckodriver";
const firefoxBinary = process.env.FIREFOX_BINARY || "";
const sizes = (process.env.R34_SIZES || "10000,50000,100000")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const outputPath = path.resolve(process.env.R34_OUTPUT || "docs/benchmarks/r34-history-benchmark.json");
const seedName = "r34-history-v1";

if (!sizes.length) throw new Error("R34_SIZES must contain at least one positive integer.");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function webdriver(baseUrl, method, pathname, body = undefined) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.value?.error || payload.error) {
    throw new Error(payload.value?.message || payload.message || payload.error || `WebDriver ${method} ${pathname} failed: ${JSON.stringify(payload)}`);
  }
  return payload.value;
}

async function waitForDriver(baseUrl) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/status`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`geckodriver did not become ready: ${lastError?.message || "unknown error"}`);
}

async function waitForPage(baseUrl, sessionId) {
  let lastState = {};
  for (let attempt = 0; attempt < 100; attempt += 1) {
    lastState = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
      script: `return {
        ready: document.documentElement.dataset.pageRuntime === "ready" && Boolean(document.querySelector("#recentEntries")),
        state: document.documentElement.dataset.pageRuntime || "not started",
        fatal: document.querySelector("#pageFatalMessage")?.textContent || ""
      };`,
      args: []
    });
    if (lastState.ready) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Popup did not render: ${lastState.state || "unknown"}: ${lastState.fatal || "no fatal panel"}`);
}

async function waitForCalendar(baseUrl, sessionId) {
  let lastState = {};
  for (let attempt = 0; attempt < 100; attempt += 1) {
    lastState = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
      script: `return {
        ready: document.documentElement.dataset.pageRuntime === "ready" && Boolean(document.querySelector("#calendarGrid")),
        state: document.documentElement.dataset.pageRuntime || "not started",
        fatal: document.querySelector("#pageFatalMessage")?.textContent || ""
      };`,
      args: []
    });
    if (lastState.ready) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Calendar did not render: ${lastState.state || "unknown"}: ${lastState.fatal || "no fatal panel"}`);
}

async function extensionOrigin(baseUrl, sessionId) {
  await webdriver(baseUrl, "POST", `/session/${sessionId}/moz/context`, { context: "chrome" });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const raw = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
        script: "return Services.prefs.getStringPref('extensions.webextensions.uuids', '{}');",
        args: []
      });
      const uuid = JSON.parse(raw)["personal-time-logger@example.local"];
      if (uuid) return `moz-extension://${uuid}`;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await webdriver(baseUrl, "POST", `/session/${sessionId}/moz/context`, { context: "content" });
  }
  throw new Error("Firefox did not expose the installed extension origin.");
}

async function executeAsync(baseUrl, sessionId, functionSource, argument) {
  const response = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `const done = arguments[arguments.length - 1];
      Promise.resolve((${functionSource})(${JSON.stringify(argument)})).then(done, (error) => done({ error: error.message || String(error) }));`,
    args: []
  });
  if (response?.error) throw new Error(response.error);
  return response;
}

async function seedInFirefox(count) {
    const started = performance.now();
    const request = indexedDB.open("timelogger_db", 5);
    const database = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open benchmark database"));
    });
    const transaction = database.transaction(["time_entries", "settings"], "readwrite");
    const entries = transaction.objectStore("time_entries");
    const settings = transaction.objectStore("settings");
    entries.clear();
    settings.clear();
    const base = Date.parse("2026-09-12T12:00:00.000Z");
    for (let index = 0; index < count; index += 1) {
      const dayOffset = index % 730;
      const start = new Date(base - dayOffset * 24 * 60 * 60 * 1000);
      start.setUTCHours(8 + (index % 9), (index * 7) % 60, 0, 0);
      let duration = 30 * 60 + (index % 8) * 15 * 60;
      if (index === 0) {
        start.setUTCHours(23, 30, 0, 0);
        duration = 3 * 24 * 60 * 60;
      }
      const active = index === 1;
      const deleted = index % 997 === 0 && index !== 0;
      const dirty = index % 251 === 0;
      const startAt = start.toISOString();
      const entry = {
        id: `r34-${count}-${index}`,
        project: `Project ${index % 24}`,
        task: `Task ${index % 96}`,
        description: `Synthetic benchmark entry ${index % 32}`,
        start_at: startAt,
        end_at: active ? "" : new Date(start.getTime() + duration * 1000).toISOString(),
        duration_seconds: active ? 0 : duration,
        status: "ok",
        created_at: startAt,
        updated_at: startAt,
        deleted_at: deleted ? new Date(start.getTime() + 60 * 1000).toISOString() : "",
        device_id: "r34-benchmark-device",
        revision: 1,
        multiply: "",
        dirty,
        last_sync_at: dirty ? "" : startAt,
        sync_error: "",
        ...(dirty ? { dirty_key: 1 } : {})
      };
      entries.put(entry);
    }
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Benchmark seed transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("Benchmark seed transaction aborted"));
    });
    database.close();
  return { size: count, durationMs: Number((performance.now() - started).toFixed(2)) };
}

async function benchmarkInFirefox({ size, seed }) {
  const result = {
    size,
    seed,
    profile: "temporary Firefox WebDriver profile",
    networkTiming: "simulated provider plan; no live service was contacted",
    memoryBytes: null,
    memoryMetric: "unavailable: this Firefox runtime exposes neither measureUserAgentSpecificMemory nor performance.memory"
  };
  const waitFor = (predicate, label) => new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (performance.now() - started >= 2000) return reject(new Error(`${label} did not settle within 2000ms`));
      setTimeout(poll, 20);
    };
    poll();
  });
  const measureMemory = async () => {
    if (typeof performance.measureUserAgentSpecificMemory === "function") {
      const memory = await performance.measureUserAgentSpecificMemory();
      return Number(memory.bytes) || null;
    }
    if (Number.isFinite(performance.memory?.usedJSHeapSize)) return performance.memory.usedJSHeapSize;
    return null;
  };
  const cursorVisits = (storeName, indexName, range, direction = "next", filter = () => true) => new Promise((resolve, reject) => {
    const request = indexedDB.open("timelogger_db", 5);
    request.onerror = () => reject(request.error || new Error("Could not open cursor-count database"));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(storeName, "readonly");
      const cursorRequest = transaction.objectStore(storeName).index(indexName).openCursor(range, direction);
      let visits = 0;
      cursorRequest.onerror = () => reject(cursorRequest.error || new Error("Cursor count failed"));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          database.close();
          resolve(visits);
          return;
        }
        visits += 1;
        filter(cursor.value);
        cursor.continue();
      };
    };
  });
  const queryRange = () => {
    const end = new Date("2026-09-12T12:00:00.000Z");
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { start, end };
  };
  const intervalCursorVisits = async (start, end) => {
    const endIndexVisits = await cursorVisits("time_entries", "end_at", IDBKeyRange.lowerBound(start.toISOString(), true), "next", (entry) => (
      !entry.deleted_at && Boolean(entry.end_at) && String(entry.start_at || "") < end.toISOString()
    ));
    const activeIndexVisits = await cursorVisits("time_entries", "active_by_start", IDBKeyRange.bound(["", "", ""], ["", "", "\\uffff"]));
    return endIndexVisits + activeIndexVisits;
  };
  const recentRange = queryRange();
  const popupStarted = performance.now();
  const popupQuery = await import(browser.runtime.getURL("src/db.js")).then((db) => db.getEntriesIntersecting(recentRange.start, recentRange.end));
  const popupQueryMs = performance.now() - popupStarted;
  const popupCursorVisits = await intervalCursorVisits(recentRange.start, recentRange.end);
  const expansions = [];
  for (let index = 0; index < 3; index += 1) {
    const button = document.querySelector("#loadMoreRecent");
    if (!button || button.hidden || button.classList.contains("hidden")) break;
    const started = performance.now();
    const previousLabel = document.querySelector("#recentRangeLabel")?.textContent || "";
    button.click();
    await waitFor(() => document.querySelector("#recentRangeLabel")?.textContent !== previousLabel, "popup history expansion");
    expansions.push(Number((performance.now() - started).toFixed(2)));
  }
  result.popup = {
    queryMs: Number(popupQueryMs.toFixed(2)),
    returnedEntries: popupQuery.length,
    cursorVisits: popupCursorVisits,
    expansionMs: expansions
  };
  const calendarRange = {
    start: new Date("2026-09-07T00:00:00.000Z"),
    end: new Date("2026-09-14T00:00:00.000Z")
  };
  const calendarStarted = performance.now();
  const calendarEntries = await import(browser.runtime.getURL("src/db.js")).then((db) => db.getEntriesIntersecting(calendarRange.start, calendarRange.end));
  const calendarQueryMs = performance.now() - calendarStarted;
  result.calendar = {
    queryMs: Number(calendarQueryMs.toFixed(2)),
    returnedEntries: calendarEntries.length,
    cursorVisits: await intervalCursorVisits(calendarRange.start, calendarRange.end),
    longRunningEntryIncluded: calendarEntries.some((entry) => entry.id === `r34-${size}-0`)
  };
  const modules = await Promise.all([
    import(browser.runtime.getURL("src/backup.js")),
    import(browser.runtime.getURL("src/reconcile.js")),
    import(browser.runtime.getURL("src/storage-migration.js")),
    import(browser.runtime.getURL("src/db.js"))
  ]);
  const [backup, reconcile, migration, db] = modules;
  const localEntriesStarted = performance.now();
  const localEntries = await db.getAllEntries();
  const localEntriesMs = performance.now() - localEntriesStarted;
  const remoteEntries = localEntries.map((entry, index) => index % 499 === 0 ? { ...entry, description: `${entry.description} remote edit` } : entry);
  const reconciliationStarted = performance.now();
  const reconciliation = reconcile.compareEntries(localEntries, remoteEntries, [], []);
  const reconciliationMs = performance.now() - reconciliationStarted;
  result.reconciliation = {
    readAllMs: Number(localEntriesMs.toFixed(2)),
    compareMs: Number(reconciliationMs.toFixed(2)),
    localEntries: localEntries.length,
    differingGroups: reconciliation.different?.length || 0
  };
  const backupStarted = performance.now();
  const backupSnapshot = await backup.readPortableBackupSnapshot();
  const backupText = backup.serializeBackup(backupSnapshot);
  result.backup = {
    durationMs: Number((performance.now() - backupStarted).toFixed(2)),
    entries: backupSnapshot.entries.length,
    utf8Bytes: new TextEncoder().encode(backupText).byteLength
  };
  const migrationStarted = performance.now();
  const migrationSnapshot = { entries: localEntries, config: {} };
  const digest = await migration.migrationDigest(migrationSnapshot);
  const preview = migration.migrationPreview(migrationSnapshot, migrationSnapshot);
  result.migration = {
    durationMs: Number((performance.now() - migrationStarted).toFixed(2)),
    digestPrefix: digest.slice(0, 12),
    disagreementCount: preview.disagreementCount
  };
  const syncModes = [
    ["idle", ["change-token"]],
    ["dirty", ["read-snapshot", "write-entry", "change-token"]],
    ["forced", ["read-snapshot"]]
  ];
  result.sync = syncModes.map(([mode, requests]) => ({
    mode,
    requestCount: requests.length,
    requestPlan: requests,
    durationMs: 0,
    timing: "simulated; local provider/network was not contacted"
  }));
  result.memoryBytes = await measureMemory();
  if (result.memoryBytes !== null) result.memoryMetric = "Firefox performance memory measurement";
  return result;
}

async function calendarProbe({ size }) {
  const started = performance.now();
  const range = {
    start: new Date("2026-09-07T00:00:00.000Z"),
    end: new Date("2026-09-14T00:00:00.000Z")
  };
  const entries = await import(browser.runtime.getURL("src/db.js")).then((db) => db.getEntriesIntersecting(range.start, range.end));
  return {
    queryMs: Number((performance.now() - started).toFixed(2)),
    returnedEntries: entries.length,
    longRunningEntryIncluded: entries.some((entry) => entry.id === `r34-${size}-0`)
  };
}

async function packageExtension(output) {
  await execFileAsync("zip", ["-q", "-r", output, "."], { cwd: path.join(root, "extension") });
}

async function runSize(baseUrl, xpiPath, size) {
  let sessionId = "";
  try {
    const session = await webdriver(baseUrl, "POST", "/session", {
      capabilities: {
        alwaysMatch: {
          browserName: "firefox",
          "moz:firefoxOptions": {
            args: ["-headless"],
            ...(firefoxBinary ? { binary: firefoxBinary } : {})
          }
        }
      }
    });
    sessionId = session.sessionId;
    await webdriver(baseUrl, "POST", `/session/${sessionId}/moz/addon/install`, { path: xpiPath, temporary: true });
    const origin = await extensionOrigin(baseUrl, sessionId);
    await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
    await waitForPage(baseUrl, sessionId);
    const seed = await executeAsync(baseUrl, sessionId, seedInFirefox.toString(), size);
    await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
    await waitForPage(baseUrl, sessionId);
    const benchmark = await executeAsync(baseUrl, sessionId, benchmarkInFirefox.toString(), { size, seed: seedName });
    await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/calendar/calendar.html` });
    await waitForCalendar(baseUrl, sessionId);
    const calendar = await executeAsync(baseUrl, sessionId, calendarProbe.toString(), { size });
    return { ...benchmark, calendar: { ...benchmark.calendar, ...calendar }, seedDurationMs: seed.durationMs };
  } finally {
    if (sessionId) await webdriver(baseUrl, "DELETE", `/session/${sessionId}`).catch(() => {});
  }
}

const temporaryDirectory = await mkdtemp(path.join(root, "web-ext-artifacts", ".r34-history-"));
const xpiPath = path.join(temporaryDirectory, "extension.xpi");
let driver;
let baseUrl = "";
let driverOutput = "";
try {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync(driverBin, ["--version"]);
  await execFileAsync(firefoxBinary || "firefox", ["--version"]);
  await execFileAsync("zip", ["-v"]);
  await packageExtension(xpiPath);
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  driver = spawn(driverBin, ["--port", String(port), "--allow-system-access"], { stdio: ["ignore", "ignore", "pipe"] });
  driver.stderr.on("data", (chunk) => { driverOutput = `${driverOutput}${String(chunk)}`.slice(-32 * 1024); });
  await waitForDriver(baseUrl);
  const results = [];
  for (const size of sizes) results.push(await runSize(baseUrl, xpiPath, size));
  const report = {
    benchmark: "R34 history scaling",
    version: 1,
    generatedAt: new Date().toISOString(),
    seed: seedName,
    command: "GECKODRIVER_BIN=/usr/local/bin/geckodriver node scripts/history-benchmark.mjs",
    sizes,
    limitations: [
      "Network request counts and timings are synthetic provider plans, not live service measurements.",
      "Firefox memory is recorded as null when the runtime does not expose a supported metric.",
      "The benchmark uses a temporary Firefox profile and synthetic IndexedDB records; it does not choose an archive threshold."
    ],
    results
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`R34 benchmark wrote ${path.relative(root, outputPath)}`);
  for (const result of results) {
    console.log(`${result.size}: popup ${result.popup.queryMs}ms, calendar ${result.calendar.queryMs}ms, reconciliation ${result.reconciliation.compareMs}ms, backup ${result.backup.durationMs}ms, migration ${result.migration.durationMs}ms`);
  }
} finally {
  if (driver && !driver.killed) driver.kill("SIGTERM");
  await rm(temporaryDirectory, { recursive: true, force: true });
  if (driverOutput && !baseUrl) process.stderr.write(driverOutput);
}

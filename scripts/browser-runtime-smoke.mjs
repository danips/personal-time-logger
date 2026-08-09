import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const driverBin = process.env.GECKODRIVER_BIN || "geckodriver";
const firefoxBinary = process.env.FIREFOX_BINARY || "";
const extensionDirectories = ["background", "calendar", "content", "icons", "options", "popup", "reconcile", "src", "usage"];

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

async function waitFor(fetchUrl, label) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(fetchUrl);
      if (response.ok) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} did not become ready: ${lastError?.message || "unknown error"}`);
}

async function webdriver(baseUrl, method, pathname, body = undefined) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.value?.error) {
    throw new Error(payload.value?.message || payload.message || `WebDriver ${method} ${pathname} failed`);
  }
  return payload.value;
}

async function waitForPage(baseUrl, sessionId, selectors) {
  const script = `return {
    ready: document.documentElement.dataset.pageRuntime === "ready"
      && ${JSON.stringify(selectors)}.every((selector) => document.querySelector(selector))
      && document.querySelector("#pageFatalPanel")?.hidden !== false,
    state: document.documentElement.dataset.pageRuntime || "not started",
    fatal: document.querySelector("#pageFatalMessage")?.textContent || ""
  };`;
  let lastState = { state: "not started", fatal: "" };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    lastState = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, { script, args: [] });
    if (lastState.ready) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Page did not render expected controls: ${selectors.join(", ")} (runtime ${lastState.state}: ${lastState.fatal || "no fatal panel"})`);
}

async function extensionOriginFromFirefox(baseUrl, sessionId) {
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

async function packageExtension(output) {
  const { stdout } = await execFileAsync("git", ["ls-files", "--", "manifest.json", ...extensionDirectories], { cwd: root });
  const files = stdout.split("\n").filter(Boolean);
  await execFileAsync("zip", ["-q", output, ...files], { cwd: root });
}

async function extensionLock(baseUrl, sessionId, holder, release = false) {
  const script = `
    const done = arguments[arguments.length - 1];
    import(browser.runtime.getURL("src/db.js")).then(async (db) => {
      const lock = ${release
        ? `await db.releaseLock("browser-runtime-smoke-lock", ${JSON.stringify(holder)}, window.__browserSmokeGeneration); done(true);`
        : `await db.claimLock("browser-runtime-smoke-lock", ${JSON.stringify(holder)}, 60_000); window.__browserSmokeGeneration = lock?.generation || 0; done(Boolean(lock));`}
    }).catch((error) => done({ error: error.message || String(error) }));
  `;
  const result = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, { script, args: [] });
  if (result?.error) throw new Error(result.error);
  return result;
}

const artifactsDirectory = path.join(root, "web-ext-artifacts");
await mkdir(artifactsDirectory, { recursive: true });
const temporaryDirectory = await mkdtemp(path.join(artifactsDirectory, ".browser-runtime-"));
const xpiPath = path.join(temporaryDirectory, "extension.xpi");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
let sessionId = "";
let driver;
let driverOutput = "";

try {
  await packageExtension(xpiPath);
  driver = spawn(driverBin, ["--port", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
  driver.stderr.on("data", (chunk) => { driverOutput += String(chunk); });
  await waitFor(`${baseUrl}/status`, "geckodriver");

  const capabilities = {
    alwaysMatch: {
      browserName: "firefox",
      "moz:firefoxOptions": {
        args: ["-headless", "-remote-allow-system-access"],
        ...(firefoxBinary ? { binary: firefoxBinary } : {})
      }
    }
  };
  const session = await webdriver(baseUrl, "POST", "/session", { capabilities });
  sessionId = session.sessionId;
  await webdriver(baseUrl, "POST", `/session/${sessionId}/moz/addon/install`, { path: xpiPath, temporary: true });
  const origin = await extensionOriginFromFirefox(baseUrl, sessionId);

  const pages = [
    ["popup/popup.html", ["#recentEntries", "#syncStatus"]],
    ["calendar/calendar.html", ["#calendarGrid", "#statusLine"]],
    ["reconcile/reconcile.html", ["#summary", "#syncButton"]],
    ["options/options.html", ["#diagnosticsSummary", "#saveSettings"]],
    ["usage/usage.html", ["#accounts", "#pageStatus"]]
  ];
  for (const [page, selectors] of pages) {
    await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/${page}` });
    await waitForPage(baseUrl, sessionId, selectors);
  }

  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
  await waitForPage(baseUrl, sessionId, ["#recentEntries"]);
  if (!await extensionLock(baseUrl, sessionId, "popup")) throw new Error("Popup context could not claim its runtime lock.");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/calendar/calendar.html` });
  await waitForPage(baseUrl, sessionId, ["#calendarGrid"]);
  if (await extensionLock(baseUrl, sessionId, "calendar")) throw new Error("Calendar context acquired a lock already held by the popup context.");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
  await extensionLock(baseUrl, sessionId, "popup", true);

  console.log("Browser runtime smoke passed: popup, calendar, reconcile, options, usage, and cross-context lock.");
} finally {
  if (sessionId) await webdriver(baseUrl, "DELETE", `/session/${sessionId}`).catch(() => {});
  if (driver && !driver.killed) driver.kill("SIGTERM");
  await rm(temporaryDirectory, { recursive: true, force: true });
  if (driverOutput && !sessionId) process.stderr.write(driverOutput);
}

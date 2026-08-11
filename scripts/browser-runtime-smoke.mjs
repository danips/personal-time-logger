import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

async function waitForCondition(baseUrl, sessionId, label, script, diagnosticScript = "") {
  let diagnostic = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, { script, args: [] })) return;
    if (diagnosticScript) {
      diagnostic = JSON.stringify(await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
        script: diagnosticScript,
        args: []
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} did not complete.${diagnostic ? ` Last state: ${diagnostic}` : ""}`);
}

async function exercisePopupTimer(baseUrl, sessionId) {
  const started = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const toggle = document.querySelector("#newTimerToggle");
      const start = document.querySelector("#startButton");
      if (!toggle || !start) return false;
      if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
      document.querySelector("#project").value = "Browser smoke";
      document.querySelector("#task").value = "Timer lifecycle";
      document.querySelector("#description").value = "Created by Firefox smoke";
      document.querySelector("#multiply").checked = true;
      start.click();
      return true;
    `,
    args: []
  });
  if (!started) throw new Error("Popup timer controls are unavailable.");
  await waitForCondition(baseUrl, sessionId, "Popup timer start", `
    return document.querySelector("#activeTitle")?.textContent.includes("Browser smoke")
      && !document.querySelector("#stopButton")?.classList.contains("hidden");
  `);
  // Completed entries with a zero-length interval have no calendar segment.
  // Wait for a real elapsed second so the calendar assertion covers rendering.
  await new Promise((resolve) => setTimeout(resolve, 1100));

  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('#stopButton')?.click(); return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Popup timer stop", `
    return document.querySelector("#activeTitle")?.textContent === "No active timer"
      && Boolean(document.querySelector(".entry-row[data-edit-id]"));
  `);

  const openedEditor = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const entry = document.querySelector(".entry-row[data-edit-id]");
      if (!entry) return false;
      entry.click();
      return true;
    `,
    args: []
  });
  if (!openedEditor) throw new Error("Stopped timer was not rendered as an editable popup entry.");
  await waitForCondition(baseUrl, sessionId, "Popup entry editor", "return !document.querySelector('#editPanel')?.classList.contains('hidden');");

  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      document.querySelector("#editDescription").value = "Edited by Firefox smoke";
      document.querySelector("#saveEdit").click();
      return true;
    `,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Popup entry save", "return document.querySelector('#editPanel')?.classList.contains('hidden');");
}

async function exerciseCalendarAndOptions(baseUrl, sessionId, origin) {
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/calendar/calendar.html` });
  await waitForPage(baseUrl, sessionId, ["#calendarGrid", "#statusLine"]);
  const selectedWeek = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      Promise.all([
        import(browser.runtime.getURL("src/db.js")),
        import(browser.runtime.getURL("src/calendar-layout.js"))
      ]).then(async ([db, calendarLayout]) => {
        const entry = (await db.getAllEntries()).find((item) => item.project === "Browser smoke");
        if (!entry) return done(false);
        const picker = document.querySelector("#weekPicker");
        const selectedWeek = calendarLayout.isoWeekValue(new Date(entry.start_at));
        picker.value = selectedWeek;
        picker.dispatchEvent(new Event("change", { bubbles: true }));
        done(selectedWeek);
      }).catch(() => done(false));
    `,
    args: []
  });
  if (!selectedWeek) throw new Error("Calendar smoke entry could not be selected.");
  await waitForCondition(baseUrl, sessionId, "Calendar entry render", `
    return document.querySelectorAll(".entry-block").length > 0;
  `, `
    return {
      week: document.querySelector("#weekPicker")?.value,
      expectedWeek: ${JSON.stringify(selectedWeek)},
      blocks: document.querySelectorAll(".entry-block").length,
      status: document.querySelector("#statusLine")?.textContent
    };
  `);

  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/options/options.html` });
  await waitForPage(baseUrl, sessionId, ["#durationMultiplier", "#saveSettings"]);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      document.querySelector("#syncInterval").value = "30";
      document.querySelector("#durationMultiplier").value = "1.5";
      document.querySelector("#saveSettings").click();
      return true;
    `,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Options save", `
    return Number(document.querySelector("#durationMultiplier")?.value) === 1.5
      && document.querySelector("#statusLine")?.textContent.includes("Settings saved");
  `);

  const multiplierUpdatedAt = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js")).then(async (db) => {
        done(await db.getSetting("duration_multiplier_updated_at", ""));
      }).catch(() => done(""));
    `,
    args: []
  });
  if (!multiplierUpdatedAt) throw new Error("Options save did not publish a multiplier timestamp.");

  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      document.querySelector("#durationMultiplier").value = "0.999";
      document.querySelector("#saveSettings").click();
      return true;
    `,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Options multiplier validation", `
    return document.querySelector("#durationMultiplier")?.value === "0.999"
      && document.querySelector("#statusLine")?.textContent.includes("duration multiplier between 1 and 5.001");
  `);

  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      document.querySelector("#syncInterval").value = "60";
      document.querySelector("#durationMultiplier").value = "1.5";
      document.querySelector("#saveSettings").click();
      return true;
    `,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Options interval-only save", `
    return Number(document.querySelector("#syncInterval")?.value) === 60
      && document.querySelector("#statusLine")?.textContent.includes("sync schedule reset");
  `);
  const unchangedTimestamp = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js")).then(async (db) => {
        done(await db.getSetting("duration_multiplier_updated_at", ""));
      }).catch(() => done(""));
    `,
    args: []
  });
  if (unchangedTimestamp !== multiplierUpdatedAt) {
    throw new Error("An interval-only Options save changed the multiplier timestamp.");
  }
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
  await exercisePopupTimer(baseUrl, sessionId);
  await exerciseCalendarAndOptions(baseUrl, sessionId, origin);

  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
  await waitForPage(baseUrl, sessionId, ["#recentEntries"]);
  if (!await extensionLock(baseUrl, sessionId, "popup")) throw new Error("Popup context could not claim its runtime lock.");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/calendar/calendar.html` });
  await waitForPage(baseUrl, sessionId, ["#calendarGrid"]);
  if (await extensionLock(baseUrl, sessionId, "calendar")) throw new Error("Calendar context acquired a lock already held by the popup context.");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
  await extensionLock(baseUrl, sessionId, "popup", true);

  console.log("Browser runtime smoke passed: page readiness, popup timer lifecycle/edit, calendar render, options save, and cross-context lock.");
} finally {
  if (sessionId) await webdriver(baseUrl, "DELETE", `/session/${sessionId}`).catch(() => {});
  if (driver && !driver.killed) driver.kill("SIGTERM");
  await rm(temporaryDirectory, { recursive: true, force: true });
  if (driverOutput && !sessionId) process.stderr.write(driverOutput);
}

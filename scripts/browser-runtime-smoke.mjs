import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const driverBin = process.env.GECKODRIVER_BIN || "geckodriver";
const firefoxBinary = process.env.FIREFOX_BINARY || "";
const smokeUpdateBaseUrl = "https://example.invalid/personal-time-logger";

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

async function createAlarmRemoteFixture() {
  const certificateDirectory = await mkdtemp(path.join(artifactsDirectory, ".alarm-remote-"));
  const keyPath = path.join(certificateDirectory, "key.pem");
  const certificatePath = path.join(certificateDirectory, "certificate.pem");
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certificatePath, "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"
  ], { stdio: ["ignore", "ignore", "ignore"] });

  const token = "r04-browser-smoke-token";
  const entryId = "r04-alarm-entry";
  let phase = "baseline";
  let snapshotCalls = 0;
  const snapshotPhases = [];
  const requests = [];
  const response = (res, status, payload) => {
    res.statusCode = status;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  };
  const remoteEntry = (stopped) => ({
    id: entryId,
    project: "R04 alarm smoke",
    task: "Remote stop/start",
    description: stopped ? "Stopped by alarm import" : "Started by alarm import",
    start_at: "2026-09-01T09:00:00.000Z",
    end_at: stopped ? "2026-09-01T09:05:00.000Z" : "",
    duration_seconds: stopped ? 300 : 0,
    status: "ok",
    created_at: "2026-09-01T09:00:00.000Z",
    updated_at: stopped ? "2026-09-01T09:05:00.000Z" : "2026-09-01T09:10:00.000Z",
    deleted_at: "",
    device_id: "r04-remote-device",
    revision: stopped ? 2 : 3,
    multiply: "1"
  });
  const server = createServer({
    key: await readFile(keyPath),
    cert: await readFile(certificatePath)
  }, (req, res) => {
    requests.push(req.url || "");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      response(res, 401, { error: { code: "AUTH_REQUIRED" } });
      return;
    }
    if (req.url === "/v1/health") {
      response(res, 200, {
        ok: true,
        service: "personal-time-logger",
        apiVersion: 1,
        schemaVersion: 1,
        mysql: "8.4"
      });
      return;
    }
    if (req.url === "/v1/change-token") {
      response(res, 200, { changeToken: phase === "baseline" ? "r04-v0" : phase === "stop" ? "r04-v1" : "r04-v2" });
      return;
    }
    if (req.url === "/v1/snapshot") {
      snapshotCalls += 1;
      snapshotPhases.push(phase);
      const stopped = phase === "stop";
      response(res, 200, {
        entries: [{ entry: remoteEntry(stopped), version: stopped ? 2 : 3 }],
        config: [],
        changeToken: phase === "baseline" ? "r04-v0" : stopped ? "r04-v1" : "r04-v2"
      });
      return;
    }
    response(res, 404, { error: { code: "NOT_FOUND" } });
  });
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

  return {
    baseUrl: `https://127.0.0.1:${port}`,
    hostPermission: `https://127.0.0.1:${port}/*`,
    entryId,
    setPhase(nextPhase) { phase = nextPhase; },
    get snapshotCalls() { return snapshotCalls; },
    get snapshotPhases() { return [...snapshotPhases]; },
    get requests() { return [...requests]; },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      await rm(certificateDirectory, { recursive: true, force: true });
    }
  };
}

async function waitFor(fetchUrl, label) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (globalThis.__smokeProcessFailure) throw new Error(globalThis.__smokeProcessFailure);
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
  if (!response.ok || payload.error || payload.value?.error) {
    throw new Error(payload.value?.message || payload.message || payload.error || payload.value?.error || `WebDriver ${method} ${pathname} failed`);
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

async function exerciseThemeSelection(baseUrl, sessionId, origin) {
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/options/options.html#appearance` });
  await waitForPage(baseUrl, sessionId, ["#themeSelect", "#highContrast"]);
  const settingsTheme = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const select = document.querySelector("#themeSelect");
      const contrast = document.querySelector("#highContrast");
      select.value = "blue-archive";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      contrast.checked = true;
      contrast.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        theme: document.documentElement.dataset.theme,
        contrast: document.documentElement.dataset.contrast
      };
    `,
    args: []
  });
  if (settingsTheme.theme !== "blue-archive" || settingsTheme.contrast !== "high") {
    throw new Error(`Settings theme controls did not apply the selection: ${JSON.stringify(settingsTheme)}`);
  }

  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/calendar/calendar.html` });
  await waitForPage(baseUrl, sessionId, ["#calendarGrid"]);
  const calendarTheme = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "return { theme: document.documentElement.dataset.theme, contrast: document.documentElement.dataset.contrast };",
    args: []
  });
  if (calendarTheme.theme !== "blue-archive" || calendarTheme.contrast !== "high") {
    throw new Error(`Theme selection did not persist across extension pages: ${JSON.stringify(calendarTheme)}`);
  }

  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/options/options.html#appearance` });
  await waitForPage(baseUrl, sessionId, ["#themeSelect", ".section-nav"]);
  const renderedThemeState = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const control = document.querySelector("#themeSelect");
      control.focus();
      const style = getComputedStyle(control);
      return {
        themeText: getComputedStyle(document.body).color,
        highContrastBorder: getComputedStyle(document.querySelector(".section-nav")).borderTopWidth,
        focusStyle: { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth },
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        transitionDuration: getComputedStyle(document.querySelector("button")).transitionDuration
      };
    `,
    args: []
  });
  if (!renderedThemeState.themeText
    || renderedThemeState.highContrastBorder !== "2px"
    || renderedThemeState.focusStyle.outlineStyle !== "solid"
    || Number.parseFloat(renderedThemeState.focusStyle.outlineWidth) < 3
    || !renderedThemeState.reducedMotion
    || Number.parseFloat(renderedThemeState.transitionDuration) > 0.01) {
    throw new Error(`Rendered theme accessibility sample was incomplete: ${JSON.stringify(renderedThemeState)}`);
  }

  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
  await waitForPage(baseUrl, sessionId, ["#recentEntries", ".icon-button"]);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/window/rect`, { width: 360, height: 800 });
  const narrowPopup = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const buttons = [...document.querySelectorAll(".icon-button")];
      const root = document.documentElement;
      return {
        overflow: root.scrollWidth > window.innerWidth + 1,
        missingLabels: buttons.filter((button) => !button.getAttribute("aria-label")?.trim()).length,
        statusAnnouncements: document.querySelectorAll('[role="status"][aria-live]').length,
        elapsedAnnounced: document.querySelector("#elapsed")?.getAttribute("aria-live") || null,
        narrowWidth: window.innerWidth
      };
    `,
    args: []
  });
  if (narrowPopup.overflow
    || narrowPopup.missingLabels
    || narrowPopup.statusAnnouncements < 1
    || narrowPopup.elapsedAnnounced
    || narrowPopup.narrowWidth < 350) {
    throw new Error(`Narrow popup access check failed: ${JSON.stringify(narrowPopup)}`);
  }

  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/options/options.html#appearance` });
  await waitForPage(baseUrl, sessionId, ["#themeSelect", ".section-nav"]);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/window/rect`, { width: 480, height: 900 });
  const longLabelLayout = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const link = document.querySelector(".section-nav a");
      link.textContent = "A deliberately long settings section label for responsive access";
      document.documentElement.style.zoom = "2";
      const root = document.documentElement;
      const nav = document.querySelector(".section-nav");
      const navRect = nav.getBoundingClientRect();
      const linkRect = link.getBoundingClientRect();
      return {
        overflow: root.scrollWidth > window.innerWidth + 1,
        linkFitsNav: linkRect.right <= navRect.right + 1,
        navVisible: navRect.width > 0 && navRect.height > 0,
        zoom: document.documentElement.style.zoom
      };
    `,
    args: []
  });
  if (longLabelLayout.overflow || !longLabelLayout.linkFitsNav || !longLabelLayout.navVisible || longLabelLayout.zoom !== "2") {
    throw new Error(`Responsive long-label/zoom check failed: ${JSON.stringify(longLabelLayout)}`);
  }

  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/calendar/calendar.html` });
  await waitForPage(baseUrl, sessionId, ["#calendarGrid", ".toolbar"]);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/window/rect`, { width: 960, height: 800 });
  const resizedCalendar = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      document.documentElement.style.zoom = "1";
      const root = document.documentElement;
      const controls = [...document.querySelectorAll(".toolbar button, .toolbar input, .toolbar select")]
        .filter((control) => {
          const rect = control.getBoundingClientRect();
          return !control.hidden && getComputedStyle(control).display !== "none" && rect.width > 0 && rect.height > 0;
        });
      return {
        viewportWidth: window.innerWidth,
        documentWidth: root.scrollWidth,
        scrollContainer: Boolean(document.querySelector(".calendar-scroll")),
        controlsReachable: controls.every((control) => {
          const rect = control.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= window.innerWidth + 1;
        })
      };
    `,
    args: []
  });
  if (!resizedCalendar.scrollContainer || !resizedCalendar.controlsReachable) {
    throw new Error(`Resized calendar access check failed: ${JSON.stringify(resizedCalendar)}`);
  }
}

async function exerciseOfflineBackup(baseUrl, sessionId, origin) {
  const prepared = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      Promise.all([
        import(browser.runtime.getURL("src/db.js")),
        import(browser.runtime.getURL("src/entries.js")),
        import(browser.runtime.getURL("src/backup.js"))
      ]).then(async ([db, entries, backup]) => {
        await db.mutateSettings([
          "remote_backend", "remote_backend_established", "spreadsheet_id", "token_data"
        ], (settings) => {
          settings.delete("remote_backend");
          settings.delete("remote_backend_established");
          settings.delete("spreadsheet_id");
          settings.delete("token_data");
        });
        const source = entries.normalizeEntry({
          id: "browser-offline-dirty",
          project: "Offline local",
          task: "Unsent timer",
          description: "Preserved before setup",
          start_at: "2026-08-30T09:00:00.000Z",
          end_at: "2026-08-30T10:00:00.000Z",
          duration_seconds: 3600,
          created_at: "2026-08-30T09:00:00.000Z",
          updated_at: "2026-08-30T10:00:00.000Z",
          device_id: "browser-smoke",
          revision: 1,
          dirty: true
        });
        const conflict = entries.normalizeEntry({
          id: "browser-offline-conflict",
          project: "Local edit",
          task: "Concurrent restore",
          description: "Keep this edit",
          start_at: "2026-08-30T11:00:00.000Z",
          end_at: "2026-08-30T12:00:00.000Z",
          duration_seconds: 3600,
          created_at: "2026-08-30T11:00:00.000Z",
          updated_at: "2026-08-30T12:00:00.000Z",
          device_id: "browser-smoke",
          revision: 2,
          dirty: true
        });
        const imported = entries.normalizeEntry({
          id: "browser-offline-import",
          project: "Restored local",
          task: "Offline recovery",
          description: "Restored before backend setup",
          start_at: "2026-08-30T13:00:00.000Z",
          end_at: "2026-08-30T14:00:00.000Z",
          duration_seconds: 3600,
          created_at: "2026-08-30T13:00:00.000Z",
          updated_at: "2026-08-30T14:00:00.000Z",
          device_id: "browser-smoke",
          revision: 1,
          dirty: false
        });
        await db.mutateEntries([source.id, conflict.id], (stored) => {
          stored.set(source.id, source);
          stored.set(conflict.id, conflict);
        });
        const backupText = backup.serializeBackup({
          entries: [
            imported,
            { ...conflict, project: "<img src=x> Backup copy", dirty: false }
          ],
          settings: {}
        });
        done({ backupText, sourceId: source.id, conflictId: conflict.id, importedId: imported.id });
      }).catch((error) => done({ error: error.message || String(error) }));
    `,
    args: []
  });
  if (prepared?.error) throw new Error(`Could not prepare offline backup smoke: ${prepared.error}`);

  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/options/options.html#setup` });
  await waitForPage(baseUrl, sessionId, ["#setupExportBackup", "#setupChooseBackupFile"]);
  const firstRun = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `return {
      setupVisible: !document.querySelector("#firstRunSetup")?.hidden,
      settingsHidden: document.querySelector("#settingsLayout")?.hidden,
      exportVisible: !document.querySelector("#setupExportBackup")?.hidden,
      restoreVisible: !document.querySelector("#setupChooseBackupFile")?.hidden
    };`,
    args: []
  });
  if (!firstRun.setupVisible || !firstRun.settingsHidden || !firstRun.exportVisible || !firstRun.restoreVisible) {
    throw new Error(`Offline backup controls were not reachable before backend setup: ${JSON.stringify(firstRun)}`);
  }

  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('#setupExportBackup').click(); return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Offline local backup export", `
    return document.querySelector("#setupBackupStatus")?.textContent.includes("Backup downloaded");
  `);

  if (!await extensionLock(baseUrl, sessionId, "browser-smoke-migration", false, "sync_lock")) {
    throw new Error("Could not simulate an active migration for offline backup locking.");
  }
  try {
    await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
      script: "document.querySelector('#setupExportBackup').click(); return true;",
      args: []
    });
    await waitForCondition(baseUrl, sessionId, "Offline backup migration lock", `
      return document.querySelector("#setupBackupStatus")?.textContent.includes("Another sync is active");
    `);
  } finally {
    await extensionLock(baseUrl, sessionId, "browser-smoke-migration", true, "sync_lock");
  }

  const injected = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      try {
        window.confirm = () => true;
        const input = document.querySelector("#setupImportBackupFile");
        const file = new File([${JSON.stringify(prepared.backupText)}], "offline-backup.json", { type: "application/json" });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        done(true);
      } catch (error) {
        done({ error: error.message || String(error) });
      }
    `,
    args: []
  });
  if (injected?.error || !injected) throw new Error(`Could not inject offline backup: ${injected?.error || "unknown error"}`);
  await waitForCondition(baseUrl, sessionId, "Offline backup preview", `
    return !document.querySelector("#backupPreview")?.hidden
      && document.querySelector("#backupPreviewSummary")?.textContent.includes("1 addition")
      && document.querySelector("#backupPreviewSummary")?.textContent.includes("1 conflict");
  `);
  const preview = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `return {
      summary: document.querySelector("#backupPreviewSummary")?.textContent,
      conflictText: document.querySelector("#backupPreviewConflicts")?.textContent,
      unsafeElementCount: document.querySelectorAll("#backupPreview img, #backupPreview script").length
    };`,
    args: []
  });
  if (!preview.summary?.includes("0 identical")
    || !preview.conflictText?.includes("<img src=x> Backup copy")
    || preview.unsafeElementCount !== 0) {
    throw new Error(`Backup preview did not account for the conflict safely: ${JSON.stringify(preview)}`);
  }
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('#confirmBackupRestore').click(); return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Offline local backup restore", `
    return document.querySelector("#setupBackupStatus")?.textContent.includes("Synchronization is pending");
  `);
  const report = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `return {
      visible: !document.querySelector("#backupReport")?.hidden,
      summary: document.querySelector("#backupReportSummary")?.textContent,
      conflictText: document.querySelector("#backupReportConflicts")?.textContent,
      unsafeElementCount: document.querySelectorAll("#backupReport img, #backupReport script").length
    };`,
    args: []
  });
  if (!report.visible
    || !report.summary?.includes("1 added")
    || !report.summary?.includes("1 conflict")
    || !report.summary?.includes("Synchronization is pending")
    || !report.conflictText?.includes("<img src=x> Backup copy")
    || report.unsafeElementCount !== 0) {
    throw new Error(`Offline restore report was incomplete or unsafe: ${JSON.stringify(report)}`);
  }
  const restored = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js")).then(async (db) => {
        const imported = await db.getEntry(${JSON.stringify(prepared.importedId)});
        const conflict = await db.getEntry(${JSON.stringify(prepared.conflictId)});
        done({ importedDirty: imported?.dirty, conflictProject: conflict?.project, conflictDirty: conflict?.dirty });
      }).catch((error) => done({ error: error.message || String(error) }));
    `,
    args: []
  });
  if (restored?.error || !restored.importedDirty || restored.conflictProject !== "Local edit" || !restored.conflictDirty) {
    throw new Error(`Offline restore did not preserve local work/conflict: ${JSON.stringify(restored)}`);
  }
}

async function exercisePopupTimer(baseUrl, sessionId, origin) {
  const openedNewTimer = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('.active-panel')?.click(); return !document.querySelector('#newTimerSection')?.classList.contains('hidden');",
    args: []
  });
  if (!openedNewTimer) throw new Error("Inactive active-timer panel did not open the new-timer form.");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('.active-panel')?.click(); return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Inactive active-timer toggle", `
    return document.querySelector("#newTimerSection")?.classList.contains("hidden")
      && document.querySelector(".active-panel")?.getAttribute("aria-label") === "Start a new timer";
  `);

  const configuredMultiplier = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js"))
        .then((db) => db.setSetting("duration_multiplier", "1.5"))
        .then(() => done(true), () => done(false));
    `,
    args: []
  });
  if (!configuredMultiplier) throw new Error("Could not configure the browser-smoke duration multiplier.");

  let syncLockHeld = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await extensionLock(baseUrl, sessionId, "popup-local-first", false, "sync_lock")) {
      syncLockHeld = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!syncLockHeld) throw new Error("Popup smoke could not block background sync.");

  try {
    const started = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
      script: `
        document.querySelector(".active-panel")?.click();
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
      return document.querySelector("#activeTitle")?.textContent.includes("Timer lifecycle")
        && !document.querySelector("#stopButton")?.classList.contains("hidden");
    `);
    const committed = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
      script: `
        const done = arguments[arguments.length - 1];
        import(browser.runtime.getURL("src/db.js")).then(async (db) => {
          const active = await db.getActiveEntries();
          const entry = active.find((item) => item.task === "Timer lifecycle");
          done(Boolean(entry && entry.project === "Browser smoke" && entry.dirty));
        }).catch(() => done(false));
      `,
      args: []
    });
    if (!committed) throw new Error("Popup local timer mutation was not committed while background sync was blocked.");
  } finally {
    await extensionLock(baseUrl, sessionId, "popup-local-first", true, "sync_lock");
  }

  const openedActiveEditor = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('.active-panel')?.click(); return true;",
    args: []
  });
  if (!openedActiveEditor) throw new Error("Active popup timer could not open its editor.");
  await waitForCondition(baseUrl, sessionId, "Active popup entry editor", "return !document.querySelector('#editPanel')?.classList.contains('hidden');");
  const initialElapsed = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "return document.querySelector('#elapsed')?.textContent || '';",
    args: []
  });
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('#editDescription').value = 'Unsaved popup draft'; return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Popup elapsed tick preserves draft", `
    return document.querySelector("#editDescription")?.value === "Unsaved popup draft"
      && document.querySelector("#elapsed")?.textContent !== ${JSON.stringify(initialElapsed)};
  `);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('#cancelEdit')?.click(); return true;",
    args: []
  });

  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('#stopButton')?.click(); return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Popup timer stop", `
    return document.querySelector("#activeTitle")?.textContent === "No task"
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

  await waitForCondition(baseUrl, sessionId, "Popup edit undo control", "return document.querySelector('#undoDeleteButton')?.textContent === 'Undo change' && !document.querySelector('#undoDeleteButton')?.hidden;");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('#undoDeleteButton')?.click(); return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Popup edit undo", "return document.querySelector('#undoDeleteButton')?.hidden;");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const row = [...document.querySelectorAll(".entry-row[data-edit-id]")]
        .find((item) => item.textContent.includes("Timer lifecycle"));
      row?.click();
      return Boolean(row);
    `,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Popup edit re-open after undo", "return !document.querySelector('#editPanel')?.classList.contains('hidden');");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      document.querySelector("#editDescription").value = "Edited by Firefox smoke";
      document.querySelector("#saveEdit").click();
      return true;
    `,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Popup edit re-save", "return document.querySelector('#editPanel')?.classList.contains('hidden');");

  const openedPopupDeleteEditor = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const row = [...document.querySelectorAll(".entry-row[data-edit-id]")]
        .find((item) => item.textContent.includes("Timer lifecycle"));
      row?.click();
      return Boolean(row);
    `,
    args: []
  });
  if (!openedPopupDeleteEditor) throw new Error("Popup edited entry was not available for deletion undo smoke coverage.");
  await waitForCondition(baseUrl, sessionId, "Popup deletion editor", "return !document.querySelector('#editPanel')?.classList.contains('hidden');");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "window.confirm = () => true; document.querySelector('#deleteEdit')?.click(); return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Popup deletion undo control", "return !document.querySelector('#undoDeleteButton')?.hidden;");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('#undoDeleteButton')?.click(); return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Popup deletion undo", "return document.querySelector('#undoDeleteButton')?.hidden;");
  const popupDeletionState = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js")).then(async (db) => {
        const entry = (await db.getAllEntries()).find((item) => item.description === "Edited by Firefox smoke");
        done({ exists: Boolean(entry), deleted: Boolean(entry?.deleted_at) });
      }).catch(() => done({ error: "read failed" }));
    `,
    args: []
  });
  if (popupDeletionState?.error || !popupDeletionState.exists || popupDeletionState.deleted) {
    throw new Error(`Popup deletion undo did not restore the entry: ${JSON.stringify(popupDeletionState)}`);
  }

  const popupMergeFixture = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      Promise.all([
        import(browser.runtime.getURL("src/db.js")),
        import(browser.runtime.getURL("src/entries.js"))
      ]).then(async ([db, entries]) => {
        const target = (await db.getAllEntries()).find((item) => item.task === "Timer lifecycle" && !item.deleted_at && item.end_at);
        if (!target) return done({ error: "Timer lifecycle target was not found" });
        const end = new Date(target.start_at);
        end.setTime(end.getTime() - 60 * 60 * 1000);
        const start = new Date(end);
        start.setTime(start.getTime() - 60 * 60 * 1000);
        const source = entries.normalizeEntry({
          id: "popup-merge-source",
          project: target.project,
          task: target.task,
          description: target.description,
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          duration_seconds: 3600,
          status: target.status,
          created_at: start.toISOString(),
          updated_at: end.toISOString(),
          device_id: "popup-smoke",
          revision: 1,
          dirty: true,
          multiply: target.multiply
        });
        await db.mutateEntries([source.id], (stored) => stored.set(source.id, source));
        done({ targetId: target.id, sourceId: source.id });
      }).catch((error) => done({ error: error.message || String(error) }));
    `,
    args: []
  });
  if (popupMergeFixture?.error) throw new Error(`Could not create popup merge preview fixture: ${popupMergeFixture.error}`);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
  await waitForPage(baseUrl, sessionId, ["#recentEntries", "#editPanel"]);
  await waitForCondition(baseUrl, sessionId, "Popup merge fixture", `
    return Boolean(document.querySelector('[data-edit-id="${popupMergeFixture.targetId}"]'))
      && Boolean(document.querySelector('[data-edit-id="${popupMergeFixture.sourceId}"]'));
  `);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `document.querySelector('[data-edit-id="${popupMergeFixture.targetId}"]')?.click(); return true;`,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Popup merge editor", "return !document.querySelector('#editPanel')?.classList.contains('hidden');");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const target = document.querySelector("#mergeTarget");
      target.value = ${JSON.stringify(popupMergeFixture.sourceId)};
      document.querySelector("#mergeEdit")?.click();
      return true;
    `,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Popup merge preview", `
    return !document.querySelector("#editPreview")?.hidden
      && document.querySelector("#editPreviewText")?.textContent.includes("Actual duration")
      && document.querySelector("#editPreviewText")?.textContent.includes("effective duration")
      && document.querySelector("#editPreviewText")?.textContent.includes("gap is compacted")
      && document.querySelector("#editPreviewText")?.textContent.includes("multiplier")
      && document.querySelector("#editPreviewText")?.textContent.includes("status");
  `);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('#confirmEditPreview')?.click(); return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Popup merge confirmation", "return document.querySelector('#editPanel')?.classList.contains('hidden');");
  const popupMergeState = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js")).then(async (db) => {
        const target = await db.getEntry(${JSON.stringify(popupMergeFixture.targetId)});
        const source = await db.getEntry(${JSON.stringify(popupMergeFixture.sourceId)});
        done({ targetEnd: target?.end_at, sourceDeleted: Boolean(source?.deleted_at) });
      }).catch((error) => done({ error: error.message || String(error) }));
    `,
    args: []
  });
  if (popupMergeState?.error || !popupMergeState.targetEnd || !popupMergeState.sourceDeleted) {
    throw new Error(`Popup merge confirmation did not commit the guarded result: ${JSON.stringify(popupMergeState)}`);
  }

  const competingTimers = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      Promise.all([
        import(browser.runtime.getURL("src/db.js")),
        import(browser.runtime.getURL("src/entries.js"))
      ]).then(async ([db, entries]) => {
        const now = Date.now();
        const records = [
          { id: "popup-warning-overnight", start_at: new Date(now - 9 * 60 * 60 * 1000).toISOString(), device_id: "desktop" },
          { id: "popup-warning-current", start_at: new Date(now - 60 * 60 * 1000).toISOString(), device_id: "laptop" }
        ].map((record) => entries.normalizeEntry({
          id: record.id,
          project: "Warning smoke",
          task: record.id === "popup-warning-overnight" ? "Overnight timer" : "Competing timer",
          description: "Warning coverage",
          start_at: record.start_at,
          end_at: "",
          duration_seconds: 0,
          created_at: record.start_at,
          updated_at: record.start_at,
          device_id: record.device_id,
          revision: 1,
          dirty: true
        }));
        await db.mutateEntries(records.map(({ id }) => id), (stored) => {
          for (const record of records) stored.set(record.id, record);
        });
        done(true);
      }).catch(() => done(false));
    `,
    args: []
  });
  if (!competingTimers) throw new Error("Could not create competing active timers for warning smoke coverage.");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
  await waitForPage(baseUrl, sessionId, ["#activeWarning", "#activeTitle"]);
  await waitForCondition(baseUrl, sessionId, "Popup stale and competing timer warning", `
    return !document.querySelector("#activeWarning")?.classList.contains("hidden")
      && document.querySelectorAll("#activeWarning [data-warning-edit-id]").length === 2
      && document.querySelector("#activeWarning")?.textContent.includes("Overnight timer")
      && document.querySelector("#activeWarning")?.textContent.includes("desktop")
      && document.querySelector("#activeWarning")?.textContent.includes("laptop");
  `);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "const button = [...document.querySelectorAll('[data-warning-stop-id]')].find((item) => item.dataset.warningStopId === 'popup-warning-overnight'); button?.click(); return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Popup warning guarded stop", `
    return ![...document.querySelectorAll("[data-warning-stop-id]")].some((button) => button.dataset.warningStopId === "popup-warning-overnight")
      && document.querySelector("#activeWarning")?.classList.contains("hidden")
      && document.querySelector("#activeTitle")?.textContent.includes("Competing timer");
  `);
}

async function exerciseSyncFreshness(baseUrl, sessionId, origin) {
  const seeded = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      Promise.all([
        import(browser.runtime.getURL("src/db.js")),
        import(browser.runtime.getURL("src/entries.js")),
        import(browser.runtime.getURL("src/setting-keys.js"))
      ]).then(async ([db, entries, settings]) => {
        const now = Date.now();
        await db.setSetting(settings.SETTING_KEY.SYNC_LAST_SUCCESS_AT, new Date(now - 3600000).toISOString());
        await db.setSetting(settings.SETTING_KEY.SYNC_LAST_STATUS, "synced");
        await db.setSetting(settings.SETTING_KEY.SYNC_BACKOFF_UNTIL, now + 60000);
        await db.setSetting(settings.SETTING_KEY.BACKGROUND_SYNC_DUE_AT, now + 120000);
        await db.setSetting(settings.SETTING_KEY.SYNC_INTERVAL_SECONDS, 30);
        await db.setSetting(settings.SETTING_KEY.SYNC_IDLE_STREAK, 2);
        await db.mutateEntries(["r23-freshness-review"], (stored) => stored.set("r23-freshness-review", entries.normalizeEntry({
          id: "r23-freshness-review",
          project: "R23 browser smoke",
          task: "Freshness status",
          start_at: "2026-09-01T09:00:00.000Z",
          end_at: "2026-09-01T09:05:00.000Z",
          duration_seconds: 300,
          status: "needs_review",
          created_at: "2026-09-01T09:00:00.000Z",
          updated_at: "2026-09-01T09:05:00.000Z",
          device_id: "r23-browser-smoke",
          revision: 1,
          dirty: true
        })));
        done(true);
      }).catch((error) => done({ error: error.message || String(error) }));
    `,
    args: []
  });
  if (seeded?.error || seeded !== true) throw new Error(`Could not seed R23 freshness state: ${JSON.stringify(seeded)}`);

  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
  await waitForPage(baseUrl, sessionId, ["#syncContext", "#recentEntries"]);
  await waitForCondition(baseUrl, sessionId, "Popup sync freshness context", `
    const text = document.querySelector("#syncContext")?.textContent || "";
    return text.includes("Provider: Google Sheets")
      && text.includes("Local pending: 1")
      && text.includes("Review: 1")
      && text.includes("Last remote success:")
      && text.includes("next retry");
  `);

  const diagnosticsSeeded = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/diagnostics.js")).then(async (diagnostics) => {
        await diagnostics.clearDiagnostics();
        await diagnostics.recordDiagnostic({ subsystem: "sync", phase: "remote_read", code: "REMOTE_ROWS_QUARANTINED", entryCount: 1, recovery: "Open Reconciliation." });
        await diagnostics.recordDiagnostic({ subsystem: "background", phase: "remote_read", code: "REMOTE_ROWS_QUARANTINED", entryCount: 1, recovery: "Open Reconciliation." });
        done(true);
      }).catch((error) => done({ error: error.message || String(error) }));
    `,
    args: []
  });
  if (diagnosticsSeeded?.error || diagnosticsSeeded !== true) throw new Error(`Could not seed R29 diagnostics state: ${JSON.stringify(diagnosticsSeeded)}`);

  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/options/options.html#general` });
  await waitForPage(baseUrl, sessionId, ["#syncFreshnessDetails", "#syncCadenceDetails"]);
  await waitForCondition(baseUrl, sessionId, "Options sync cadence context", `
    const text = document.querySelector("#syncCadenceDetails")?.textContent || "";
    return text.includes("every 1 minute") && text.includes("30 seconds") && text.includes("idle streak 2");
  `);
  await waitForCondition(baseUrl, sessionId, "Options bounded diagnostics navigation", `
    const text = document.querySelector("#diagnosticsList")?.textContent || "";
    const item = [...document.querySelectorAll("#diagnosticsList .diagnostic-record")]
      .find((record) => record.textContent.includes("REMOTE_ROWS_QUARANTINED"));
    const link = item?.querySelector("a");
    return text.includes("REMOTE_ROWS_QUARANTINED")
      && text.includes("2 occurrences")
      && link?.getAttribute("href") === "#reconciliation";
  `);
}

async function exerciseAnalytics(baseUrl, sessionId, origin) {
  const analyticsSeeded = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      Promise.all([
        import(browser.runtime.getURL("src/db.js")),
        import(browser.runtime.getURL("src/entries.js"))
      ]).then(async ([db, entries]) => {
        const start = new Date(Date.now() - 45 * 60 * 1000);
        const end = new Date(start.getTime() + 30 * 1000);
        const created = new Date().toISOString();
        await db.mutateEntries(["analytics-browser-smoke-anomaly"], (stored) => stored.set("analytics-browser-smoke-anomaly", entries.normalizeEntry({
          id: "analytics-browser-smoke-anomaly",
          project: "Browser smoke",
          task: "Analytics anomaly",
          description: "Analytics anomaly target",
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          duration_seconds: 30,
          created_at: created,
          updated_at: created,
          device_id: "browser-smoke",
          revision: 1,
          dirty: false
        })));
        done(true);
      }).catch(() => done(false));
    `,
    args: []
  });
  if (!analyticsSeeded) throw new Error("Could not seed the browser-smoke analytics anomaly.");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/analytics/analytics.html` });
  await waitForPage(baseUrl, sessionId, ["#periodPreset", "#summaryCards", "#projectRows", "#descriptionRows", "#analyticsProjectFilter", "#analyticsTaskFilter"]);
  await waitForCondition(baseUrl, sessionId, "Analytics smoke entry render", `
    return document.querySelector("#summaryCards")?.textContent.includes("Total effective time")
      && document.querySelector("#projectRows")?.textContent.includes("Browser smoke")
      && document.querySelector("#descriptionRows")?.textContent.includes("Edited by Firefox smoke");
  `, `
    return {
      status: document.querySelector("#statusLine")?.textContent,
      projects: document.querySelector("#projectRows")?.textContent,
      descriptions: document.querySelector("#descriptionRows")?.textContent
    };
  `);

  const themeAndRerender = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const before = document.querySelector("#primaryRange")?.textContent;
      const preset = document.querySelector("#periodPreset");
      preset.value = "last_30_days";
      preset.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        before,
        theme: document.documentElement.dataset.theme,
        contrast: document.documentElement.dataset.contrast
      };
    `,
    args: []
  });
  if (themeAndRerender.theme !== "blue-archive" || themeAndRerender.contrast !== "high") {
    throw new Error(`Analytics did not apply the selected theme: ${JSON.stringify(themeAndRerender)}`);
  }
  await waitForCondition(baseUrl, sessionId, "Analytics period rerender", `
    return document.documentElement.dataset.pageRuntime === "ready"
      && document.querySelector("#statusLine")?.dataset.status === "ready"
      && document.querySelector("#primaryRange")?.textContent !== ${JSON.stringify(themeAndRerender.before)}
      && document.querySelector("#pageFatalPanel")?.hidden !== false;
  `);

  const reportActions = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      let csvCreated = false;
      let printCalled = false;
      URL.createObjectURL = () => { csvCreated = true; return "blob:analytics-smoke"; };
      URL.revokeObjectURL = () => {};
      HTMLAnchorElement.prototype.click = function () { this.dataset.smokeClicked = "true"; };
      window.print = () => { printCalled = true; };
      document.querySelector("#exportAnalytics")?.click();
      const exportButton = document.querySelector("#exportAnalytics");
      document.querySelector("#printAnalytics")?.click();
      return { csvCreated, printCalled, status: document.querySelector("#statusLine")?.textContent, exportPresent: Boolean(exportButton) };
    `,
    args: []
  });
  if (!reportActions.csvCreated || !reportActions.printCalled || !reportActions.exportPresent) {
    throw new Error(`Analytics export/print actions were unavailable: ${JSON.stringify(reportActions)}`);
  }

  const filtered = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const project = document.querySelector("#analyticsProjectFilter");
      project.value = "Browser smoke";
      project.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        actualCard: document.querySelector("#summaryCards")?.textContent.includes("Total actual time"),
        option: [...project.options].some((option) => option.value === "Browser smoke")
      };
    `,
    args: []
  });
  if (!filtered.option || !filtered.actualCard) throw new Error(`Analytics filters were not available: ${JSON.stringify(filtered)}`);
  await waitForCondition(baseUrl, sessionId, "Analytics project filter", `
    return document.querySelector("#analyticsProjectFilter")?.value === "Browser smoke"
      && document.querySelector("#projectRows")?.textContent.includes("Browser smoke")
      && document.querySelector("#summaryCards")?.textContent.includes("Total actual time");
  `);

  const preserved = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const toggle = document.querySelector(".project-toggle");
      if (!toggle) return false;
      toggle.click();
      const filter = document.querySelector("#analyticsProjectFilter");
      filter.focus();
      globalThis.dispatchEvent(new Event("visibilitychange"));
      return { expanded: toggle.getAttribute("aria-expanded"), focused: document.activeElement === filter };
    `,
    args: []
  });
  if (!preserved || preserved.expanded !== "false" || !preserved.focused) {
    throw new Error(`Analytics refresh setup did not capture view state: ${JSON.stringify(preserved)}`);
  }
  await waitForCondition(baseUrl, sessionId, "Analytics refresh state preservation", `
    return document.querySelector("#analyticsProjectFilter")?.value === "Browser smoke"
      && document.querySelector(".project-toggle")?.getAttribute("aria-expanded") === "false"
      && document.activeElement?.id === "analyticsProjectFilter";
  `);

  const anomalyNavigation = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      const button = document.querySelector('[data-anomaly-entry-id="analytics-browser-smoke-anomaly"]');
      done(button?.dataset.anomalyDestination || "");
    `,
    args: []
  });
  if (!anomalyNavigation.includes("calendar/calendar.html?entry=analytics-browser-smoke-anomaly")) {
    const diagnostic = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
      script: `return {
        links: document.querySelectorAll(".anomaly-link").length,
        rows: document.querySelector("#anomalyRows")?.textContent || "",
        project: document.querySelector("#analyticsProjectFilter")?.value || "",
        status: document.querySelector("#statusLine")?.textContent || ""
      };`,
      args: []
    });
    throw new Error(`Analytics anomaly navigation was not actionable: ${anomalyNavigation}; ${JSON.stringify(diagnostic)}`);
  }
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/${anomalyNavigation}` });
  await waitForPage(baseUrl, sessionId, ["#calendarGrid", "#calendarEditOverlay", "#calendarEditProject"]);
  await waitForCondition(baseUrl, sessionId, "Analytics calendar entry destination", `
    return !document.querySelector("#calendarEditOverlay")?.hidden
      && document.querySelector("#calendarEditProject")?.value === "Browser smoke";
  `);
}

async function exerciseCalendarAndOptions(baseUrl, sessionId, origin) {
  const optionsReady = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js"))
        .then((db) => db.setSetting("remote_backend", "google-sheets"))
        .then(() => done(true), () => done(false));
    `,
    args: []
  });
  if (!optionsReady) throw new Error("Could not establish a backend for Options smoke coverage.");

  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/calendar/calendar.html` });
  await waitForPage(baseUrl, sessionId, ["#calendarGrid", "#statusLine"]);
  const directEntry = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      Promise.all([
        import(browser.runtime.getURL("src/db.js")),
        import(browser.runtime.getURL("src/entries.js"))
      ]).then(async ([db, entries]) => {
        const activeStart = new Date(Date.now() - 60 * 60 * 1000);
        const active = entries.normalizeEntry({
          id: "calendar-active-preserved",
          project: "Calendar smoke",
          task: "Keep active",
          description: "Must remain active",
          start_at: activeStart.toISOString(),
          end_at: "",
          duration_seconds: 0,
          created_at: activeStart.toISOString(),
          updated_at: activeStart.toISOString(),
          device_id: "calendar-smoke",
          revision: 1,
          dirty: true
        });
        await db.mutateEntries([active.id], (stored) => stored.set(active.id, active));
        document.querySelector("#addCompletedEntryButton")?.click();
        await new Promise((resolve, reject) => {
          const deadline = Date.now() + 3000;
          const check = () => {
            if (!document.querySelector("#calendarEditOverlay")?.hidden) return resolve();
            if (Date.now() >= deadline) return reject(new Error("completed-entry editor did not open"));
            setTimeout(check, 10);
          };
          check();
        });
        const pad = (value) => String(value).padStart(2, "0");
        const localInput = (date) => [
          date.getFullYear(), "-", pad(date.getMonth() + 1), "-", pad(date.getDate()),
          "T", pad(date.getHours()), ":", pad(date.getMinutes()), ":", pad(date.getSeconds())
        ].join("");
        const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const end = new Date(Date.now() - 60 * 60 * 1000 - 30 * 60 * 1000);
        document.querySelector("#calendarEditProject").value = "Calendar smoke";
        document.querySelector("#calendarEditTask").value = "Backfill";
        document.querySelector("#calendarEditDescription").value = "Completed locally";
        document.querySelector("#calendarEditStart").value = localInput(start);
        document.querySelector("#calendarEditEnd").value = localInput(end);
        document.querySelector("#calendarEditMultiply").checked = true;
        document.querySelector("#calendarSaveEntry").click();
        done(true);
      }).catch(() => done(false));
    `,
    args: []
  });
  if (!directEntry) throw new Error("Could not create the direct calendar-entry smoke fixture.");
  await waitForCondition(baseUrl, sessionId, "Calendar direct completed entry", `
    return document.querySelector("#calendarEditOverlay")?.hidden;
  `, `
    return {
      overlayHidden: document.querySelector("#calendarEditOverlay")?.hidden,
      status: document.querySelector("#statusLine")?.textContent,
      startValidity: document.querySelector("#calendarEditStart")?.validationMessage,
      endValidity: document.querySelector("#calendarEditEnd")?.validationMessage
    };
  `);
  const directEntryState = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js")).then(async (db) => {
        const entries = await db.getAllEntries();
        const created = entries.find((entry) => entry.task === "Backfill");
        const active = await db.getEntry("calendar-active-preserved");
        done({ completed: Boolean(created?.end_at), duration: created?.duration_seconds, dirty: created?.dirty, activeEnd: active?.end_at });
      }).catch(() => done({ error: "read failed" }));
    `,
    args: []
  });
  if (directEntryState?.error || !directEntryState.completed || directEntryState.duration !== 2700
    || !directEntryState.dirty || directEntryState.activeEnd !== "") {
    throw new Error(`Calendar direct entry did not preserve the active timer: ${JSON.stringify(directEntryState)}`);
  }
  const calendarKeyboardEntry = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const block = [...document.querySelectorAll("[data-entry-id]")]
        .find((item) => item.dataset.entryId && item.dataset.entryId !== "calendar-active-preserved");
      if (!block) return false;
      block.focus();
      block.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return true;
    `,
    args: []
  });
  if (!calendarKeyboardEntry) throw new Error("Calendar entry was not keyboard-focusable in smoke coverage.");
  await waitForCondition(baseUrl, sessionId, "Calendar keyboard editor", `return !document.querySelector('#calendarEditOverlay')?.hidden;`);
  const calendarEditorSummary = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `return {
      summary: document.querySelector("#calendarEditTimeSummary")?.textContent,
      focused: document.activeElement?.id
    };`,
    args: []
  });
  if (!calendarEditorSummary.summary?.includes("Displayed timezone")
    || !calendarEditorSummary.summary.includes("Actual duration")
    || !calendarEditorSummary.summary.includes("Effective duration")
    || !calendarEditorSummary.summary.includes("Multiplier")
    || calendarEditorSummary.focused !== "calendarEditProject") {
    throw new Error(`Calendar editor time summary or keyboard focus was incomplete: ${JSON.stringify(calendarEditorSummary)}`);
  }
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Calendar Escape cancellation", `
    return document.querySelector("#calendarEditOverlay")?.hidden
      && document.activeElement?.dataset?.entryId;
  `);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      window.confirm = () => true;
      const block = [...document.querySelectorAll("[data-entry-id]")]
        .find((item) => item.dataset.entryId === "calendar-active-preserved");
      block?.click();
      return Boolean(block);
    `,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Calendar deletion editor", "return !document.querySelector('#calendarEditOverlay')?.hidden;");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('#deleteCalendarEntry')?.click(); return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Calendar deletion undo control", "return document.querySelector('#undoCalendarButton')?.textContent === 'Undo deletion';");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('#undoCalendarButton')?.click(); return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Calendar deletion undo", "return document.querySelector('#undoCalendarButton')?.hidden;");
  const calendarDeletionState = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js")).then(async (db) => {
        const entry = await db.getEntry("calendar-active-preserved");
        done({ exists: Boolean(entry), deleted: Boolean(entry?.deleted_at), active: entry?.end_at === "" });
      }).catch(() => done({ error: "read failed" }));
    `,
    args: []
  });
  if (calendarDeletionState?.error || !calendarDeletionState.exists || calendarDeletionState.deleted || !calendarDeletionState.active) {
    throw new Error(`Calendar deletion undo did not restore the active entry: ${JSON.stringify(calendarDeletionState)}`);
  }
  const mergeFixture = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      Promise.all([
        import(browser.runtime.getURL("src/db.js")),
        import(browser.runtime.getURL("src/entries.js"))
      ]).then(async ([db, entries]) => {
        const target = (await db.getAllEntries()).find((item) => item.task === "Backfill" && !item.deleted_at);
        if (!target) return done({ error: "Backfill target was not found" });
        const end = new Date(target.start_at);
        end.setTime(end.getTime() - 2 * 60 * 60 * 1000);
        const start = new Date(end);
        start.setTime(start.getTime() - 60 * 60 * 1000);
        const source = entries.normalizeEntry({
          id: "calendar-merge-source",
          project: target.project,
          task: target.task,
          description: target.description,
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          duration_seconds: 5400,
          status: target.status,
          created_at: start.toISOString(),
          updated_at: end.toISOString(),
          device_id: "calendar-smoke",
          revision: 1,
          dirty: true,
          multiply: target.multiply
        });
        await db.mutateEntries([source.id], (stored) => stored.set(source.id, source));
        done({ targetId: target.id, sourceId: source.id });
      }).catch((error) => done({ error: error.message || String(error) }));
    `,
    args: []
  });
  if (mergeFixture?.error) throw new Error(`Could not create merge preview fixture: ${mergeFixture.error}`);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "window.location.reload(); return true;",
    args: []
  });
  await waitForPage(baseUrl, sessionId, ["#calendarGrid", "#calendarEditOverlay"]);
  await waitForCondition(baseUrl, sessionId, "Calendar merge fixture", `
    return Boolean(document.querySelector('[data-entry-id="${mergeFixture.targetId}"]'))
      && Boolean(document.querySelector('[data-entry-id="${mergeFixture.sourceId}"]'));
  `, `
    return {
      targetId: ${JSON.stringify(mergeFixture.targetId)},
      sourceId: ${JSON.stringify(mergeFixture.sourceId)},
      renderedIds: [...document.querySelectorAll("[data-entry-id]")].map((item) => item.dataset.entryId),
      blocks: document.querySelectorAll(".entry-block").length,
      status: document.querySelector("#statusLine")?.textContent
    };
  `);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `document.querySelector('[data-entry-id="${mergeFixture.targetId}"]')?.click(); return true;`,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Calendar merge editor", "return !document.querySelector('#calendarEditOverlay')?.hidden;");
  const mergePreview = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const target = document.querySelector("#calendarMergeTarget");
      target.value = ${JSON.stringify(mergeFixture.sourceId)};
      document.querySelector("#calendarMergeButton")?.click();
      return true;
    `,
    args: []
  });
  if (!mergePreview) throw new Error("Calendar merge preview could not be opened.");
  await waitForCondition(baseUrl, sessionId, "Calendar merge preview", `
    return !document.querySelector("#calendarPreview")?.hidden
      && document.querySelector("#calendarPreviewText")?.textContent.includes("Actual duration")
      && document.querySelector("#calendarPreviewText")?.textContent.includes("effective duration")
      && document.querySelector("#calendarPreviewText")?.textContent.includes("gap is compacted")
      && document.querySelector("#calendarPreviewText")?.textContent.includes("multiplier")
      && document.querySelector("#calendarPreviewText")?.textContent.includes("status");
  `);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('#confirmCalendarPreview')?.click(); return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Calendar merge confirmation", "return document.querySelector('#calendarEditOverlay')?.hidden;");
  const mergedState = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js")).then(async (db) => {
        const target = await db.getEntry(${JSON.stringify(mergeFixture.targetId)});
        const source = await db.getEntry(${JSON.stringify(mergeFixture.sourceId)});
        done({ targetDuration: target?.duration_seconds, sourceDeleted: Boolean(source?.deleted_at) });
      }).catch(() => done({ error: "read failed" }));
    `,
    args: []
  });
  if (mergedState?.error || mergedState.targetDuration !== 8100 || !mergedState.sourceDeleted) {
    throw new Error(`Calendar merge confirmation did not preserve its previewed effects: ${JSON.stringify(mergedState)}`);
  }
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `document.querySelector('[data-entry-id="${mergeFixture.targetId}"]')?.click(); return true;`,
    args: []
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `document.querySelector('[data-entry-id="${mergeFixture.targetId}"]')?.click(); return true;`,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Calendar duplicate editor", "return !document.querySelector('#calendarEditOverlay')?.hidden;");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('#duplicateEntryButton')?.click(); return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Calendar duplicate preview", `
    return !document.querySelector("#calendarPreview")?.hidden
      && document.querySelector("#calendarPreviewText")?.textContent.includes("overlaps the original")
      && document.querySelector("#calendarPreviewText")?.textContent.includes("effective seconds");
  `);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('#confirmCalendarPreview')?.click(); return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Calendar duplicate confirmation", "return document.querySelector('#calendarEditOverlay')?.hidden;");
  const duplicateState = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js")).then(async (db) => {
        const live = (await db.getAllEntries()).filter((item) => item.task === "Backfill" && !item.deleted_at);
        done({ liveCount: live.length, duplicateDirty: live.some((item) => item.id !== ${JSON.stringify(mergeFixture.targetId)} && item.dirty) });
      }).catch(() => done({ error: "read failed" }));
    `,
    args: []
  });
  if (duplicateState?.error || duplicateState.liveCount !== 2 || !duplicateState.duplicateDirty) {
    throw new Error(`Calendar duplicate confirmation did not create the expected copy: ${JSON.stringify(duplicateState)}`);
  }
  const tempoScope = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const toggles = [...document.querySelectorAll(".day-send-toggle")];
      const sendButton = document.querySelector("#sendTempoButton");
      const menu = document.querySelector("#tempoSendMenu");
      const initial = {
        togglesHidden: toggles.every((toggle) => toggle.hidden),
        label: sendButton?.textContent
      };
      document.querySelector("#tempoSendMenuButton")?.click();
      const menuOpened = menu?.hidden === false;
      document.querySelector("#chooseTempoDaysOption")?.click();
      const choosing = {
        togglesVisible: toggles.every((toggle) => !toggle.hidden),
        startsEmpty: toggles.every((toggle) => !toggle.checked),
        sendDisabled: sendButton?.disabled
      };
      const first = toggles[0];
      if (first) {
        first.checked = true;
        first.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return {
        initial,
        menuOpened,
        choosing,
        selectedLabel: sendButton?.textContent,
        selectedSendDisabled: sendButton?.disabled
      };
    `,
    args: []
  });
  if (!tempoScope.initial.togglesHidden
    || tempoScope.initial.label !== "Send week to Tempo"
    || !tempoScope.menuOpened
    || !tempoScope.choosing.togglesVisible
    || !tempoScope.choosing.startsEmpty
    || !tempoScope.choosing.sendDisabled
    || tempoScope.selectedLabel !== "Send 1 day to Tempo"
    || tempoScope.selectedSendDisabled) {
    throw new Error(`Tempo scope controls did not move cleanly into day selection: ${JSON.stringify(tempoScope)}`);
  }
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
    const multiplied = document.querySelector(".entry-block.multiplied-entry");
    return document.querySelectorAll(".entry-block").length > 0
      && Number.parseFloat(multiplied?.style.getPropertyValue("--actual-percent")) < 100;
  `, `
    return {
      week: document.querySelector("#weekPicker")?.value,
      expectedWeek: ${JSON.stringify(selectedWeek)},
      blocks: document.querySelectorAll(".entry-block").length,
      status: document.querySelector("#statusLine")?.textContent
    };
  `);

  const tempoConfirmation = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      Promise.all([
        import(browser.runtime.getURL("src/db.js")),
        import(browser.runtime.getURL("src/entries.js")),
        import(browser.runtime.getURL("src/calendar-layout.js"))
      ]).then(async ([db, entries, calendarLayout]) => {
        const weekStart = calendarLayout.weekStartFromInput(document.querySelector("#weekPicker").value);
        const start = new Date(weekStart);
        start.setDate(start.getDate() + 1);
        start.setHours(23, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        end.setHours(1, 0, 0, 0);
        const created = new Date().toISOString();
        await db.setSetting("tempo_submission_tracking_started_at", new Date(Date.now() - 1000).toISOString());
        await db.mutateEntries([], (stored) => stored.set("tempo-browser-smoke", entries.normalizeEntry({
          id: "tempo-browser-smoke",
          project: "Browser smoke",
          task: "Tempo midnight",
          description: "Daily allocation confirmation",
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          duration_seconds: 7200,
          created_at: created,
          updated_at: created,
          device_id: "browser-smoke",
          revision: 1,
          dirty: true
        })));
        await db.setSetting("tempo_api_token", "browser-smoke-token");
        await db.setSetting("tempo_author_account_id", "account-123");
        await db.setSetting("tempo_task_issue_ids", { "Tempo midnight": "10042" });
        done(true);
      }).catch(() => done(false));
    `,
    args: []
  });
  if (!tempoConfirmation) throw new Error("Could not create the browser-smoke Tempo midnight entry.");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/calendar/calendar.html` });
  await waitForPage(baseUrl, sessionId, ["#calendarGrid", "#sendTempoButton", "#cancelTempoButton"]);
  const confirmation = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      Promise.all([
        import(browser.runtime.getURL("src/db.js")),
        import(browser.runtime.getURL("src/calendar-layout.js")),
        import(browser.runtime.getURL("src/tempo-day-selection.js")),
        import(browser.runtime.getURL("calendar/tempo-controller.js"))
      ]).then(async ([db, calendarLayout, tempoDaySelection, tempoControllerModule]) => {
        const weekStart = calendarLayout.weekStartFromInput(document.querySelector("#weekPicker").value);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);
        const entry = (await db.getAllEntries()).find((item) => item.id === "tempo-browser-smoke");
        if (!entry) return done({ error: "Tempo midnight entry was not rendered in the browser page." });
        const controller = tempoControllerModule.createTempoController({
          getSnapshot: () => ({ entries: [entry], weekStart, weekEnd }),
          currentSelection: () => ({
            includedDays: new Set(tempoDaySelection.weekDayKeys(weekStart, 7)),
            noneSelected: false,
            scopeLabel: "the displayed week",
            repeatScopeLabel: "week"
          }),
          getSetting: db.getSetting,
          mutateSetting: db.mutateSetting,
          platform: {
            requestOptionalHostPermission: async () => true,
            sendRuntimeMessage: async () => ({ ok: true, result: { sentWorklogs: 2 } })
          },
          setStatus: () => {},
          setSelectionActive: () => {}
        });
        const sending = controller.send();
        for (let attempt = 0; attempt < 100 && !document.querySelector("#tempoPreviewDialog")?.open; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const dialog = document.querySelector("#tempoPreviewDialog");
        if (!dialog?.open) return done({ error: "Tempo preview did not open." });
          const preview = {
            summary: document.querySelector("#tempoPreviewSummary")?.textContent || "",
            rowCount: document.querySelectorAll("#tempoPreviewRows tr").length,
            statuses: [...document.querySelectorAll("#tempoPreviewRows .tempo-status")].map((item) => item.textContent),
            mapping: document.querySelector("[data-tempo-task='Tempo midnight']")?.value || "",
            cancelButtonPresent: Boolean(document.querySelector("#cancelTempoButton"))
        };
        const mappingInput = document.querySelector("[data-tempo-task='Tempo midnight']");
        mappingInput.value = "not-an-issue";
        document.querySelector("#tempoPreviewConfirm").click();
        for (let attempt = 0; attempt < 50 && document.querySelector("#tempoPreviewError")?.hidden; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        preview.invalidMappingPreserved = mappingInput.value;
        preview.invalidMessage = document.querySelector("#tempoPreviewError")?.textContent || "";
        mappingInput.value = "10042";
        mappingInput.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelectorAll("#tempoPreviewRows [data-tempo-allocation-key]").forEach((input) => {
          if (!input.checked && !input.disabled) input.click();
        });
        document.querySelector("#tempoPreviewConfirm").click();
        await sending;
        done(preview);
      }).catch((error) => done({ error: error.message || String(error) }));
    `,
    args: []
  });
  if (confirmation?.error) throw new Error(`Tempo confirmation smoke failed: ${confirmation.error}`);
  if (!confirmation.summary.includes("2 daily allocations")
    || confirmation.rowCount !== 2
    || !confirmation.cancelButtonPresent
    || confirmation.mapping !== "10042"
    || confirmation.invalidMappingPreserved !== "not-an-issue"
    || !confirmation.invalidMessage.includes("positive whole-number")
    || confirmation.statuses.some((status) => !status.includes("Unsent · send"))) {
    throw new Error(`Tempo preview did not show the expected allocation/mapping state: ${JSON.stringify(confirmation)}`);
  }

  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/options/options.html` });
  await waitForPage(baseUrl, sessionId, ["#durationMultiplier", "#saveSettings"]);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      document.querySelector("#syncInterval").value = "30";
      document.querySelector("#durationMultiplier").value = "1.5";
      document.querySelector("#staleTimerReminderEnabled").checked = true;
      document.querySelector("#saveSettings").click();
      return true;
    `,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Options save", `
    return Number(document.querySelector("#durationMultiplier")?.value) === 1.5
      && document.querySelector("#staleTimerReminderEnabled")?.checked === true
      && document.querySelector("#statusLine")?.textContent.includes("Settings saved")
      && !document.querySelector("#saveSettings")?.disabled;
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
      && document.querySelector("#statusLine")?.textContent.includes("duration multiplier between 1 and 5.001")
      && !document.querySelector("#saveSettings")?.disabled;
  `, `
    const multiplier = document.querySelector("#durationMultiplier");
    const save = document.querySelector("#saveSettings");
    return {
      multiplier: multiplier?.value,
      validationMessage: multiplier?.validationMessage,
      saveDisabled: save?.disabled,
      status: document.querySelector("#statusLine")?.textContent
    };
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

async function exerciseReconcileUi(baseUrl, sessionId, origin) {
  const prepared = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js"))
        .then((db) => db.setSetting("remote_backend", "mysql"))
        .then(() => done(true), () => done(false));
    `,
    args: []
  });
  if (!prepared) throw new Error("Could not prepare the reconciliation UI smoke.");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/reconcile/reconcile.html` });
  await waitForPage(baseUrl, sessionId, ["#summary", "#syncButton", "#reconcileSearch", "#exportQuarantined", "#operationOutcome"]);
  const state = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      Promise.all([
        import(browser.runtime.getURL("src/reconcile-ui-state.js")),
        import(browser.runtime.getURL("src/reconcile-export.js"))
      ]).then(([ui, exporter]) => {
        const page = ui.paginateReconciliationItems(Array.from({ length: 121 }, (_, index) => index), { page: 1 });
        const csv = exporter.serializeQuarantinedRecords([{ id: "smoke-invalid", rowIndex: 9, reason: "invalid" }]);
        return { pageSize: page.items.length, pageCount: page.pageCount, csv: csv.includes("row 9") };
      }).then((value) => arguments[arguments.length - 1](value), () => arguments[arguments.length - 1]({}));
    `,
    args: []
  });
  if (state.pageSize !== 50 || state.pageCount !== 3 || !state.csv) {
    throw new Error(`Reconciliation bounded state/export was unavailable: ${JSON.stringify(state)}`);
  }
  const googleControls = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js"))
        .then((db) => db.setSetting("remote_backend", "google-sheets"))
        .then(() => done(true), () => done(false));
    `,
    args: []
  });
  if (!googleControls) throw new Error("Could not prepare Google reconciliation controls.");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/reconcile/reconcile.html` });
  await waitForPage(baseUrl, sessionId, ["#summary", "#reconcileSearch", "#exportQuarantined", "#operationOutcome"]);
  const renderedControls = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `return {
      search: document.querySelector("#reconcileSearch")?.tagName,
      export: document.querySelector("#exportQuarantined")?.textContent,
      outcome: document.querySelector("#operationOutcome")?.hidden
    };`,
    args: []
  });
  if (!renderedControls || renderedControls.search !== "INPUT" || renderedControls.export !== "Export locations" || renderedControls.outcome !== true) {
    throw new Error(`Provider-aware reconciliation controls did not render: ${JSON.stringify(renderedControls)}`);
  }
}

async function exerciseProviderAwareSettings(baseUrl, sessionId, origin) {
  const customMysqlPermission = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/remote-mysql.js")).then((mysql) => done({
        declared: browser.runtime.getManifest().optional_host_permissions.includes("https://*/*"),
        requested: mysql.mysqlHostPermission("https://self-hosted.example/api")
      })).catch(() => done({}));
    `,
    args: []
  });
  if (!customMysqlPermission.declared || customMysqlPermission.requested !== "https://self-hosted.example/*") {
    throw new Error(`Custom MySQL host permission is not requestable: ${JSON.stringify(customMysqlPermission)}`);
  }

  const setBackend = async (backend) => {
    const result = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
      script: `
        const done = arguments[arguments.length - 1];
        import(browser.runtime.getURL("src/db.js"))
          .then(async (db) => {
            await db.setSetting("remote_backend", ${JSON.stringify(backend)});
            done(await db.getSetting("remote_backend", "") === ${JSON.stringify(backend)});
          })
          .catch(() => done(false));
      `,
      args: []
    });
    if (!result) throw new Error(`Could not set browser-smoke backend to ${backend}.`);
  };

  await setBackend("mysql");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
  await waitForPage(baseUrl, sessionId, ["#recentEntries"]);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/options/options.html#google-account` });
  await waitForPage(baseUrl, sessionId, ["#remoteBackendTarget", "#preparedRemoteBackend", "#migrationPreview", "#googleAccountNav", "#google-account"]);
  await waitForCondition(baseUrl, sessionId, "MySQL active settings reload", `
    return document.querySelector("#activeRemoteBackend")?.textContent === "MySQL 8.4";
  `);
  const hiddenMysqlState = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `return {
      active: document.querySelector("#activeRemoteBackend")?.textContent,
      hash: window.location.hash,
      accountNavHidden: document.querySelector("#googleAccountNav")?.hidden,
      accountHidden: document.querySelector("#google-account")?.hidden,
      spreadsheetNavHidden: document.querySelector("#spreadsheetNav")?.hidden,
      spreadsheetHidden: document.querySelector("#spreadsheet")?.hidden,
      mysqlFieldsHidden: document.querySelector("#mysqlStorageFields")?.hidden,
      testMysqlHidden: document.querySelector("#testMysqlConnection")?.hidden,
      prepared: document.querySelector("#preparedRemoteBackend")?.textContent,
      migrationPreviewHidden: document.querySelector("#migrationPreview")?.hidden,
      migrateLabel: document.querySelector("#migrateStorage")?.textContent,
      localLabel: document.querySelector("#activateMysqlFromLocal")?.textContent,
      remoteLabel: document.querySelector("#activateMysqlFromRemote")?.textContent,
      clearTokenLabel: document.querySelector("#clearMysqlToken")?.textContent
    };`,
    args: []
  });
  if (hiddenMysqlState.active !== "MySQL 8.4"
    || hiddenMysqlState.hash !== "#appearance"
    || !hiddenMysqlState.accountNavHidden
    || !hiddenMysqlState.accountHidden
    || !hiddenMysqlState.spreadsheetNavHidden
    || !hiddenMysqlState.spreadsheetHidden
    || hiddenMysqlState.mysqlFieldsHidden
    || !hiddenMysqlState.testMysqlHidden
    || hiddenMysqlState.prepared !== "Prepared backend: MySQL 8.4"
    || !hiddenMysqlState.migrationPreviewHidden
    || hiddenMysqlState.migrateLabel !== "Migrate verified data and switch to MySQL 8.4"
    || hiddenMysqlState.localLabel !== "Initialize from this device"
    || hiddenMysqlState.remoteLabel !== "Adopt existing MySQL data"
    || hiddenMysqlState.clearTokenLabel !== "Clear MySQL token") {
    throw new Error(`MySQL settings did not hide Google controls safely: ${JSON.stringify(hiddenMysqlState)}`);
  }

  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/options/options.html#spreadsheet` });
  await waitForPage(baseUrl, sessionId, ["#remoteBackendTarget", "#spreadsheetNav", "#spreadsheet"]);
  const hiddenSpreadsheetHash = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "return window.location.hash;",
    args: []
  });
  if (hiddenSpreadsheetHash !== "#appearance") {
    throw new Error(`Hidden spreadsheet hash did not fall back to Appearance: ${hiddenSpreadsheetHash}`);
  }
  const hiddenFocusState = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const hiddenLink = document.querySelector("#googleAccountNav");
      hiddenLink?.focus();
      return {
        focusedHiddenLink: document.activeElement === hiddenLink,
        storageHeading: document.querySelector("#storageHeading")?.textContent
      };
    `,
    args: []
  });
  if (hiddenFocusState.focusedHiddenLink || hiddenFocusState.storageHeading !== "Storage") {
    throw new Error(`Hidden settings controls were focusable or Storage was unlabeled: ${JSON.stringify(hiddenFocusState)}`);
  }

  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const target = document.querySelector("#remoteBackendTarget");
      target.value = "google-sheets";
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    `,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Google migration-target settings", `
    return document.querySelector("#activeRemoteBackend")?.textContent === "MySQL 8.4"
      && document.querySelector("#preparedRemoteBackend")?.textContent === "Prepared backend: Google Sheets"
      && !document.querySelector("#googleAccountNav")?.hidden
      && !document.querySelector("#google-account")?.hidden
      && !document.querySelector("#spreadsheetNav")?.hidden
      && !document.querySelector("#spreadsheet")?.hidden
      && document.querySelector("#mysqlStorageFields")?.hidden
      && document.querySelector("#testMysqlConnection")?.hidden;
  `);

  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const target = document.querySelector("#remoteBackendTarget");
      target.value = "mysql";
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    `,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "MySQL migration-target settings", `
    return document.querySelector("#googleAccountNav")?.hidden
      && document.querySelector("#google-account")?.hidden
      && !document.querySelector("#mysqlStorageFields")?.hidden
      && document.querySelector("#testMysqlConnection")?.hidden
      && document.querySelector("#preparedRemoteBackend")?.textContent === "Prepared backend: MySQL 8.4";
  `);

  await setBackend("google-sheets");
  const usageFixture = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js")).then(async (db) => {
        await db.setSetting("chatgpt_usage_state", {
          snapshot: {
            account: { plan_type: "plus" },
            access: { allowed: true, limit_reached: false, limit_reached_type: null },
            primary_window: { used_percent: 12, remaining_percent: 88, window_seconds: 18000, reset_at: new Date(Date.now() + 90 * 60 * 1000).toISOString() },
            secondary_window: { used_percent: 34, remaining_percent: 66, window_seconds: 604800, reset_at: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() },
            collected_at: new Date(Date.now() - 20 * 60 * 1000).toISOString()
          },
          last_attempt_at: Date.now(),
          last_error: null
        });
        done(true);
      }).catch(() => done(false));
    `,
    args: []
  });
  if (!usageFixture) throw new Error("Could not create ChatGPT usage smoke fixture.");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/usage/usage.html` });
  await waitForPage(baseUrl, sessionId, ["#usageSnapshot", "#refreshUsage", "#pageStatus"]);
  await waitForCondition(baseUrl, sessionId, "Usage presentation", `
    const text = document.querySelector("#usageSnapshot")?.textContent || "";
    return text.includes("12% used") && text.includes("88% remaining") && text.includes("Resets") && text.includes("Last refreshed") && text.includes("Stale");
  `);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
  await waitForPage(baseUrl, sessionId, ["#chatGptUsageValues"]);
  await waitForCondition(baseUrl, sessionId, "Popup usage presentation", `
    return document.querySelector("#chatGptUsageValues")?.textContent.includes("remaining")
      && document.querySelector("#chatGptUsageValues")?.textContent.includes("in ");
  `);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js")).then((db) => db.setSetting("chatgpt_usage_state", null).then(() => done(true), () => done(false)), () => done(false));
    `,
    args: []
  });
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
  await waitForPage(baseUrl, sessionId, ["#recentEntries"]);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/options/options.html` });
  await waitForPage(baseUrl, sessionId, ["#remoteBackendTarget", "#googleAccountNav"]);
  const googleActiveState = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `return {
      active: document.querySelector("#activeRemoteBackend")?.textContent,
      accountNavHidden: document.querySelector("#googleAccountNav")?.hidden,
      spreadsheetNavHidden: document.querySelector("#spreadsheetNav")?.hidden,
      mysqlFieldsHidden: document.querySelector("#mysqlStorageFields")?.hidden,
      testMysqlHidden: document.querySelector("#testMysqlConnection")?.hidden
    };`,
    args: []
  });
  if (googleActiveState.active !== "Google Sheets"
    || googleActiveState.accountNavHidden
    || googleActiveState.spreadsheetNavHidden) {
    throw new Error(`Google-active settings did not restore Google controls: ${JSON.stringify(googleActiveState)}`);
  }
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const input = document.querySelector("#syncInterval");
      input.value = "20";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    `,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Options draft indicator", `
    return !document.querySelector("#generalDraftIndicator")?.hidden
      && document.querySelector("#generalDraftMessage")?.textContent === "Unsaved changes";
  `);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('#generalDiscardDraft')?.click(); return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Options draft discard", `
    return document.querySelector("#generalDraftIndicator")?.hidden
      && document.querySelector("#syncInterval")?.value === "60";
  `);
  const persistedMigrationPreview = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js")).then(async (db) => {
        await db.setSetting("storage_migration_state", {
          migration_id: "browser-smoke-migration-preview",
          source_provider: "google-sheets",
          target_provider: "mysql",
          phase: "seeding",
          completed_entries: 3,
          total_entries: 5,
          preview: { sourceEntryCount: 5, targetEntryCount: 4, sourceConfigCount: 2, targetConfigCount: 2, disagreementCount: 2 }
        });
        done(true);
      }).catch(() => done(false));
    `,
    args: []
  });
  if (!persistedMigrationPreview) throw new Error("Could not persist migration preview smoke state.");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, { script: "window.location.reload(); return true;", args: [] });
  await waitForCondition(baseUrl, sessionId, "Persisted migration preview", `
    return document.querySelector("#migrationPreview")?.textContent.includes("5 entries")
      && document.querySelector("#migrationPreview")?.textContent.includes("2 disagreements");
  `);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js")).then((db) => db.setSetting("storage_migration_state", null).then(() => done(true), () => done(false)), () => done(false));
    `,
    args: []
  });
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const target = document.querySelector("#remoteBackendTarget");
      target.value = "mysql";
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    `,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Google-active settings", `
    return document.querySelector("#activeRemoteBackend")?.textContent === "Google Sheets"
      && !document.querySelector("#googleAccountNav")?.hidden
      && !document.querySelector("#spreadsheetNav")?.hidden
      && !document.querySelector("#mysqlStorageFields")?.hidden
      && !document.querySelector("#testMysqlConnection")?.hidden;
  `);

  await setBackend("google-sheets");
}

async function exercisePopupHistoryPagination(baseUrl, sessionId, origin) {
  const seeded = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      import(browser.runtime.getURL("src/db.js")).then(async (db) => {
        const currentWeek = new Date();
        currentWeek.setHours(12, 0, 0, 0);
        currentWeek.setDate(currentWeek.getDate() - ((currentWeek.getDay() + 6) % 7));
        const entryForWeek = (id, weeksAgo, task) => {
          const start = new Date(currentWeek);
          start.setDate(start.getDate() - weeksAgo * 7 + 1);
          start.setHours(10, 0, 0, 0);
          const end = new Date(start);
          end.setHours(end.getHours() + 1);
          return {
            id,
            project: "Browser smoke history",
            task,
            description: "",
            start_at: start.toISOString(),
            end_at: end.toISOString(),
            duration_seconds: 3600,
            multiply: false,
            dirty: false,
            deleted_at: "",
            status: task === "Older browser smoke" ? "needs_review" : "ok",
            revision: 1
          };
        };
        const history = [
          entryForWeek("browser-smoke-last-week", 1, "Previous-week browser smoke"),
          entryForWeek("browser-smoke-two-weeks", 2, "Older browser smoke")
        ];
        const existing = await db.getAllEntries();
        await db.mutateEntries([...existing.map((entry) => entry.id), ...history.map((entry) => entry.id)], (entries) => {
          for (const entry of existing) entries.delete(entry.id);
          for (const entry of history) entries.set(entry.id, entry);
        });
        done(true);
      }).catch(() => done(false));
    `,
    args: []
  });
  if (!seeded) throw new Error("Could not seed popup history pagination data.");

  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
  await waitForPage(baseUrl, sessionId, ["#recentEntries"]);
  await waitForCondition(baseUrl, sessionId, "Popup previous-week fallback", `
    return document.querySelector("#loadMoreRecent")?.textContent === "Load previous week"
      && document.querySelector("#recentEntries")?.textContent.includes("Previous-week browser smoke")
      && [...document.querySelectorAll(".week-group-header strong")].some((label) => label.textContent === "Last week");
  `);

  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: "document.querySelector('#loadMoreRecent')?.click(); return true;",
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Popup previous-week pagination", `
    return document.querySelector("#recentEntries")?.textContent.includes("Older browser smoke")
      && document.querySelectorAll(".week-group").length === 2;
  `);

  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const text = document.querySelector("#recentTextFilter");
      text.focus();
      text.value = "Older browser smoke";
      text.dispatchEvent(new Event("input", { bubbles: true }));
      return document.activeElement === text;
    `,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Popup history text filter", `
    return document.querySelector("#recentEntries")?.textContent.includes("Older browser smoke")
      && !document.querySelector("#recentEntries")?.textContent.includes("Previous-week browser smoke")
      && document.querySelector("#recentTotals")?.textContent.includes("Period total: 02:00:00")
      && document.querySelector("#recentTotals")?.textContent.includes("Filtered total: 01:00:00")
      && document.activeElement?.id === "recentTextFilter";
  `, `
    return {
      entries: document.querySelector("#recentEntries")?.textContent,
      totals: document.querySelector("#recentTotals")?.textContent,
      activeId: document.activeElement?.id,
      range: document.querySelector("#recentRangeLabel")?.textContent
    };
  `);
  const filterControls = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const text = document.querySelector("#recentTextFilter");
      text.value = "";
      text.dispatchEvent(new Event("input", { bubbles: true }));
      const project = document.querySelector("#recentProjectFilter");
      project.focus();
      project.value = "Browser smoke history";
      project.dispatchEvent(new Event("input", { bubbles: true }));
      const review = document.querySelector("#recentReviewFilter");
      review.focus();
      review.value = "needs_review";
      review.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        projectSuggestion: Boolean(document.querySelector('#recentProjects option[value="Browser smoke history"]')),
        taskSuggestion: Boolean(document.querySelector('#recentTasks option[value="Older browser smoke"]'))
      };
    `,
    args: []
  });
  if (!filterControls.projectSuggestion || !filterControls.taskSuggestion) {
    throw new Error(`Popup history autocomplete values were not loaded: ${JSON.stringify(filterControls)}`);
  }
  await waitForCondition(baseUrl, sessionId, "Popup history project/review filters", `
    return document.querySelector("#recentEntries")?.textContent.includes("Older browser smoke")
      && !document.querySelector("#recentEntries")?.textContent.includes("Previous-week browser smoke")
      && document.querySelector("#recentTotals")?.textContent.includes("Filtered total: 01:00:00")
      && document.activeElement?.id === "recentReviewFilter";
  `);

  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const date = document.querySelector("#recentDate");
      date.value = "2026-01-05";
      document.querySelector("#jumpRecentDate")?.click();
      return true;
    `,
    args: []
  });
  await waitForCondition(baseUrl, sessionId, "Popup empty date jump", `
    return document.querySelector("#recentEntries")?.textContent.includes("No entries in the loaded range.")
      && document.querySelector("#recentRangeLabel")?.textContent.includes("2026");
  `);
}

async function browserSmokeRuntimeMessage(baseUrl, sessionId, message) {
  return webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      browser.runtime.sendMessage(${JSON.stringify(message)}).then(done, (error) => done({ error: error.message || String(error) }));
    `,
    args: []
  });
}

async function exerciseAlarmDrivenToolbar(baseUrl, sessionId, origin, fixture) {
  const prepared = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      Promise.all([
        import(browser.runtime.getURL("src/db.js")),
        import(browser.runtime.getURL("src/entries.js")),
        import(browser.runtime.getURL("src/setting-keys.js"))
      ]).then(async ([db, entries, settings]) => {
        const entry = entries.normalizeEntry({
          id: ${JSON.stringify(fixture.entryId)},
          project: "R04 alarm smoke",
          task: "Remote stop/start",
          description: "Initial active state",
          start_at: "2026-09-01T09:00:00.000Z",
          end_at: "",
          duration_seconds: 0,
          status: "ok",
          created_at: "2026-09-01T09:00:00.000Z",
          updated_at: "2026-09-01T09:00:00.000Z",
          deleted_at: "",
          device_id: "r04-local-device",
          revision: 1,
          multiply: "1",
          dirty: false,
          last_sync_at: "2026-09-01T09:01:00.000Z"
        });
        await db.mutateAllLocalState([
          settings.SETTING_KEY.REMOTE_BACKEND,
          settings.SETTING_KEY.REMOTE_BACKEND_ESTABLISHED,
          settings.SETTING_KEY.MYSQL_API_BASE_URL,
          settings.SETTING_KEY.MYSQL_API_TOKEN,
          settings.SETTING_KEY.MYSQL_REMOTE_CHANGE_TOKEN,
          settings.SETTING_KEY.BACKGROUND_SYNC_DUE_AT,
          settings.SETTING_KEY.SYNC_BACKOFF_SECONDS,
          settings.SETTING_KEY.SYNC_BACKOFF_UNTIL,
          settings.SETTING_KEY.SYNC_IDLE_STREAK,
          settings.SETTING_KEY.DURATION_MULTIPLIER,
          settings.SETTING_KEY.DURATION_MULTIPLIER_UPDATED_AT,
          settings.SETTING_KEY.DURATION_MULTIPLIER_SYNCED_AT
        ], ({ entries: storedEntries, settings: storedSettings }) => {
          storedEntries.set(entry.id, entry);
          storedSettings.set(settings.SETTING_KEY.REMOTE_BACKEND, "mysql");
          storedSettings.set(settings.SETTING_KEY.REMOTE_BACKEND_ESTABLISHED, true);
          storedSettings.set(settings.SETTING_KEY.MYSQL_API_BASE_URL, ${JSON.stringify(fixture.baseUrl)});
          storedSettings.set(settings.SETTING_KEY.MYSQL_API_TOKEN, "r04-browser-smoke-token");
          storedSettings.set(settings.SETTING_KEY.MYSQL_REMOTE_CHANGE_TOKEN, "r04-v0");
          storedSettings.set(settings.SETTING_KEY.BACKGROUND_SYNC_DUE_AT, 0);
          storedSettings.set(settings.SETTING_KEY.SYNC_BACKOFF_SECONDS, 0);
          storedSettings.set(settings.SETTING_KEY.SYNC_BACKOFF_UNTIL, 0);
          storedSettings.set(settings.SETTING_KEY.SYNC_IDLE_STREAK, 0);
          storedSettings.set(settings.SETTING_KEY.DURATION_MULTIPLIER, "1");
          storedSettings.set(settings.SETTING_KEY.DURATION_MULTIPLIER_UPDATED_AT, "");
          storedSettings.set(settings.SETTING_KEY.DURATION_MULTIPLIER_SYNCED_AT, "");
        });
        done({ ok: true });
      }).catch((error) => done({ error: error.message || String(error) }));
    `,
    args: []
  });
  if (prepared?.error || prepared?.ok !== true) throw new Error(`R04 fixture setup failed: ${JSON.stringify(prepared)}`);

  fixture.setPhase("stop");
  const alarmMessage = await browserSmokeRuntimeMessage(baseUrl, sessionId, { type: "browser_smoke_arm_alarm" });
  if (alarmMessage?.error || alarmMessage?.ok !== true) throw new Error(`R04 alarm arm failed: ${JSON.stringify(alarmMessage)}`);

  // The page that armed the one-shot alarm is navigated away before the alarm
  // can fire. The next page is opened only after the background run window.
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: "about:blank" });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
  await waitForPage(baseUrl, sessionId, ["#recentEntries"]);
  const firstState = await browserSmokeRuntimeMessage(baseUrl, sessionId, { type: "browser_smoke_alarm_state" });
  const firstEntry = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `return import(browser.runtime.getURL("src/db.js")).then((db) => db.getEntry(${JSON.stringify(fixture.entryId)}));`,
    args: []
  });
  if (firstState?.alarmRuns !== 1 || firstState.toolbarActive !== false || !firstEntry?.end_at) {
    throw new Error(`R04 remote stop alarm state was not applied with the toolbar inactive: ${JSON.stringify({ firstState, firstEntry, requests: fixture.requests })}`);
  }

  fixture.setPhase("start");
  const secondAlarm = await browserSmokeRuntimeMessage(baseUrl, sessionId, { type: "browser_smoke_arm_alarm" });
  if (secondAlarm?.error || secondAlarm?.ok !== true) throw new Error(`R04 second alarm arm failed: ${JSON.stringify(secondAlarm)}`);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: "about:blank" });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
  await waitForPage(baseUrl, sessionId, ["#recentEntries"]);
  const secondState = await browserSmokeRuntimeMessage(baseUrl, sessionId, { type: "browser_smoke_alarm_state" });
  const secondEntry = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `return import(browser.runtime.getURL("src/db.js")).then((db) => db.getEntry(${JSON.stringify(fixture.entryId)}));`,
    args: []
  });
  if (secondState?.alarmRuns !== 2 || secondState.toolbarActive !== true || secondEntry?.end_at) {
    throw new Error(`R04 remote start alarm state was not applied with the toolbar active: ${JSON.stringify({ secondState, secondEntry, requests: fixture.requests })}`);
  }
  if (!fixture.snapshotPhases.includes("stop") || !fixture.snapshotPhases.includes("start")) {
    throw new Error(`R04 fixture did not receive both remote phases: ${JSON.stringify(fixture.snapshotPhases)}.`);
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

async function packageExtension(output, additionalHostPermission = "") {
  const sourceDirectory = path.join(path.dirname(output), "prepared-source");
  await execFileAsync(process.execPath, [
    "scripts/prepare-firefox-release.mjs",
    "--base-url", smokeUpdateBaseUrl,
    "--output", path.relative(root, sourceDirectory)
  ], { cwd: root });
  if (additionalHostPermission) {
    const manifestPath = path.join(sourceDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), additionalHostPermission])];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  await execFileAsync("zip", ["-q", "-r", output, "."], { cwd: sourceDirectory });
}

async function extensionLock(baseUrl, sessionId, holder, release = false, key = "browser-runtime-smoke-lock") {
  const script = `
    const done = arguments[arguments.length - 1];
    import(browser.runtime.getURL("src/db.js")).then(async (db) => {
      const lock = ${release
        ? `await db.releaseLock(window.__browserSmokeLockHandle); window.__browserSmokeLockHandle = null; done(true);`
        : `window.__browserSmokeLockHandle = await db.claimLock(${JSON.stringify(key)}, ${JSON.stringify(holder)}, 60_000); done(Boolean(window.__browserSmokeLockHandle));`}
    }).catch((error) => done({ error: error.message || String(error) }));
  `;
  const result = await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/async`, { script, args: [] });
  if (result?.error) throw new Error(result.error);
  return result;
}

async function currentWindow(baseUrl, sessionId) {
  return webdriver(baseUrl, "GET", `/session/${sessionId}/window`);
}

async function openWindow(baseUrl, sessionId, url) {
  const original = await currentWindow(baseUrl, sessionId);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/execute/sync`, {
    script: `window.open(${JSON.stringify(url)}, "browser-smoke-calendar"); return true;`,
    args: []
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const handles = await webdriver(baseUrl, "GET", `/session/${sessionId}/window/handles`);
    const created = handles.find((handle) => handle !== original);
    if (created) return { original, created };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Firefox did not create the second extension page window.");
}

const artifactsDirectory = path.join(root, "web-ext-artifacts");
await mkdir(artifactsDirectory, { recursive: true });
const temporaryDirectory = await mkdtemp(path.join(artifactsDirectory, ".browser-runtime-"));
const xpiPath = path.join(temporaryDirectory, "extension.xpi");
let baseUrl = "";
let sessionId = "";
let driver;
let driverOutput = "";
let alarmRemoteFixture;

try {
  const check = async (command, label) => {
    try { await execFileAsync(command, ["--version"], { windowsHide: true }); }
    catch { throw new Error(`${label} is unavailable. Set ${label === "geckodriver" ? "GECKODRIVER_BIN" : "FIREFOX_BINARY"} or install it before running browser smoke.`); }
  };
  await check(driverBin, "geckodriver");
  await check(firefoxBinary || "firefox", "Firefox");
  await check("zip", "zip");
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  alarmRemoteFixture = await createAlarmRemoteFixture();
  await packageExtension(xpiPath, alarmRemoteFixture.hostPermission);
  driver = spawn(driverBin, ["--port", String(port), "--allow-system-access"], { stdio: ["ignore", "ignore", "pipe"] });
  driver.stderr.on("data", (chunk) => { driverOutput = `${driverOutput}${String(chunk)}`.slice(-32 * 1024); });
  driver.on("error", (error) => { globalThis.__smokeProcessFailure = `Could not start geckodriver: ${error.message}`; });
  driver.on("exit", (code, signal) => {
    if (!sessionId && !globalThis.__smokeProcessFailure) globalThis.__smokeProcessFailure = `geckodriver exited before readiness (code ${code ?? "unknown"}, signal ${signal || "none"}).`;
  });
  await waitFor(`${baseUrl}/status`, "geckodriver");

  const capabilities = {
    alwaysMatch: {
      browserName: "firefox",
      "moz:firefoxOptions": {
        args: ["-headless"],
        prefs: { "ui.prefersReducedMotion": 1 },
        ...(firefoxBinary ? { binary: firefoxBinary } : {})
      },
      acceptInsecureCerts: true
    }
  };
  const session = await webdriver(baseUrl, "POST", "/session", { capabilities });
  sessionId = session.sessionId;
  await webdriver(baseUrl, "POST", `/session/${sessionId}/moz/addon/install`, { path: xpiPath, temporary: true });
  const origin = await extensionOriginFromFirefox(baseUrl, sessionId);

  const pages = [
    ["popup/popup.html", ["#recentEntries", "#syncStatus"]],
    ["calendar/calendar.html", ["#calendarGrid", "#statusLine"]],
    ["analytics/analytics.html", ["#periodPreset", "#summaryCards"]],
    ["reconcile/reconcile.html", ["#summary", "#syncButton"]],
    ["options/options.html", ["#diagnosticsSummary", "#saveSettings"]],
    ["usage/usage.html", ["#usageSnapshot", "#refreshUsage", "#pageStatus"]]
  ];
  for (const [page, selectors] of pages) {
    await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/${page}` });
    await waitForPage(baseUrl, sessionId, selectors);
  }

  await exerciseThemeSelection(baseUrl, sessionId, origin);
  await exerciseSyncFreshness(baseUrl, sessionId, origin);
  await exerciseOfflineBackup(baseUrl, sessionId, origin);

  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
  await waitForPage(baseUrl, sessionId, ["#recentEntries"]);
  await exercisePopupTimer(baseUrl, sessionId, origin);
  await exerciseAnalytics(baseUrl, sessionId, origin);
  await exerciseCalendarAndOptions(baseUrl, sessionId, origin);
  await exerciseReconcileUi(baseUrl, sessionId, origin);
  await exerciseProviderAwareSettings(baseUrl, sessionId, origin);
  await exercisePopupHistoryPagination(baseUrl, sessionId, origin);
  await exerciseAlarmDrivenToolbar(baseUrl, sessionId, origin, alarmRemoteFixture);

  await webdriver(baseUrl, "POST", `/session/${sessionId}/url`, { url: `${origin}/popup/popup.html` });
  await waitForPage(baseUrl, sessionId, ["#recentEntries"]);
  if (!await extensionLock(baseUrl, sessionId, "popup")) throw new Error("Popup context could not claim its runtime lock.");
  const windows = await openWindow(baseUrl, sessionId, `${origin}/calendar/calendar.html`);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/window`, { handle: windows.created });
  await waitForPage(baseUrl, sessionId, ["#calendarGrid"]);
  if (await extensionLock(baseUrl, sessionId, "calendar")) throw new Error("Calendar context acquired a lock already held by the popup context.");
  await webdriver(baseUrl, "POST", `/session/${sessionId}/window`, { handle: windows.original });
  await extensionLock(baseUrl, sessionId, "popup", true);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/window`, { handle: windows.created });
  await webdriver(baseUrl, "DELETE", `/session/${sessionId}/window`);
  await webdriver(baseUrl, "POST", `/session/${sessionId}/window`, { handle: windows.original });

  console.log("Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, cross-context lock, and R04 closed-page alarm stop/start toolbar transitions.");
} finally {
  if (sessionId) await webdriver(baseUrl, "DELETE", `/session/${sessionId}`).catch(() => {});
  if (driver && !driver.killed) driver.kill("SIGTERM");
  if (alarmRemoteFixture) await alarmRemoteFixture.close().catch(() => {});
  await rm(temporaryDirectory, { recursive: true, force: true });
  if (driverOutput && !sessionId) process.stderr.write(driverOutput);
}

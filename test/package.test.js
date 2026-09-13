import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDirectory = join(root, "web-ext-artifacts");
const expectedFiles = [
  "analytics/analytics.css",
  "analytics/analytics.html",
  "analytics/analytics.js",
  "background/background.js",
  "calendar/calendar.css",
  "calendar/calendar.html",
  "calendar/calendar.js",
  "calendar/popup-drag.js",
  "calendar/tempo-controller.js",
  "icons/icon-active.svg",
  "icons/icon.svg",
  "manifest.json",
  "options/options.css",
  "options/options.html",
  "options/options.js",
  "options/provider-setup-controller.js",
  "popup/popup.css",
  "popup/popup.html",
  "popup/popup.js",
  "popup/window-size-controller.js",
  "reconcile/reconcile.css",
  "reconcile/reconcile.html",
  "reconcile/reconcile.js",
  "src/action-runner.js",
  "src/analytics-export.js",
  "src/analytics-period.js",
  "src/analytics.js",
  "src/background-schedule.js",
  "src/backup.js",
  "src/bounded-json.js",
  "src/calendar-gesture-state.js",
  "src/calendar-layout.js",
  "src/chatgpt-usage-service.js",
  "src/coded-error.js",
  "src/codex-usage.js",
  "src/db.js",
  "src/diagnostics.js",
  "src/entries.js",
  "src/entry-contract.js",
  "src/entry-editor.css",
  "src/entry-editor.js",
  "src/entry-form.js",
  "src/error-codes.js",
  "src/error-registry.js",
  "src/events.js",
  "src/fingerprints.js",
  "src/icon.js",
  "src/operation-states.js",
  "src/options-settings.js",
  "src/page-runtime.js",
  "src/platform.js",
  "src/popup-active-state.js",
  "src/popup-recent-groups.js",
  "src/provider-retirement.js",
  "src/reconcile-export.js",
  "src/reconcile-ui-state.js",
  "src/reconcile.js",
  "src/remote-api-client.js",
  "src/remote-cloudflare-d1.js",
  "src/remote-mysql.js",
  "src/remote-provider.js",
  "src/remote-versioned-mutations.js",
  "src/setting-keys.js",
  "src/storage-migration.js",
  "src/sync-config.js",
  "src/sync-request.js",
  "src/sync-status.js",
  "src/sync.js",
  "src/tempo-day-selection.js",
  "src/tempo-submission-ledger.js",
  "src/tempo-upload-handler.js",
  "src/tempo.js",
  "src/themes.css",
  "src/themes.js",
  "src/time-allocation.js",
  "src/time.js",
  "src/timer-reminders.js",
  "src/ui-helpers.js",
  "src/usage-presentation.js",
  "src/window-resize.js",
  "usage/usage.css",
  "usage/usage.html",
  "usage/usage.js"
];

async function filesIn(directory) {
  const children = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(children.map(async (child) => {
    const childPath = join(directory, child.name);
    if (child.isDirectory()) return filesIn(childPath);
    return [relative(directory, childPath)];
  }));
  return files.flatMap((paths, index) => {
    const child = children[index];
    return child.isDirectory()
      ? paths.map((path) => join(child.name, path))
      : paths;
  });
}

async function directoryDigest(directory) {
  const files = (await filesIn(directory)).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(join(directory, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function packagePathFromReference(reference) {
  const value = String(reference || "").trim();
  if (!value || value.startsWith("#") || value.startsWith("data:") || value.startsWith("http:") || value.startsWith("https:") || value.startsWith("mailto:") || value.startsWith("javascript:")) return null;
  return value.split(/[?#]/, 1)[0];
}

function relativeReferences(text, pattern) {
  const references = [];
  for (const match of text.matchAll(pattern)) {
    const reference = packagePathFromReference(match[1]);
    if (reference && (reference.startsWith("./") || reference.startsWith("../") || !reference.includes(":"))) references.push(reference);
  }
  return references;
}

function manifestReferences(manifest) {
  return [
    ...(manifest.background?.scripts || []),
    manifest.action?.default_popup,
    ...Object.values(manifest.action?.default_icon || {}),
    manifest.options_ui?.page,
    ...Object.values(manifest.icons || {})
  ].filter(Boolean);
}

async function assertPackagedReferencesResolve(directory) {
  const files = new Set(await filesIn(directory));
  const references = [];
  const addReferences = (file, values) => {
    for (const value of values) references.push({ file, value });
  };

  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  addReferences("manifest.json", manifestReferences(manifest));
  for (const file of files) {
    const source = await readFile(join(directory, file), "utf8");
    if (file.endsWith(".html")) {
      addReferences(file, relativeReferences(source, /\b(?:src|href)=["']([^"']+)["']/gi));
    } else if (file.endsWith(".css")) {
      addReferences(file, relativeReferences(source, /\burl\(\s*["']?([^"')]+)["']?\s*\)/gi));
    } else if (file.endsWith(".js")) {
      addReferences(file, relativeReferences(source, /\b(?:import|export)\s+(?:[^"'();]*?\sfrom\s*)?["']([^"']+)["']/g));
      addReferences(file, relativeReferences(source, /\bimport\(\s*["']([^"']+)["']\s*\)/g));
    }
  }

  for (const { file, value } of references) {
    const sourceDirectory = dirname(file);
    const target = resolve(sourceDirectory, value).replaceAll("\\", "/");
    const packageRoot = resolve(".");
    const targetRelative = relative(packageRoot, target).replaceAll("\\", "/");
    if (isAbsolute(targetRelative) || targetRelative.startsWith("../") || !files.has(targetRelative)) {
      throw new Error(`Packaged reference from ${file} does not resolve: ${value}`);
    }
  }
}

async function temporaryPackageDirectory() {
  await mkdir(artifactsDirectory, { recursive: true });
  return mkdtemp(join(artifactsDirectory, ".package-test-"));
}

describe("Firefox release package", () => {
  it("contains exactly the extension allow-list", async () => {
    const manifest = JSON.parse(await readFile(join(root, "extension/manifest.json"), "utf8"));
    const outputDirectory = await temporaryPackageDirectory();

    try {
      await execFileAsync(process.execPath, [
        "scripts/prepare-firefox-release.mjs",
        "--base-url", "https://example.invalid/personal-time-logger",
        "--expected-version", manifest.version,
        "--output", relative(root, outputDirectory)
      ], { cwd: root });

      assert.deepEqual((await filesIn(outputDirectory)).sort(), expectedFiles);

      const packagedManifest = JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8"));
      assert.equal(packagedManifest.version, manifest.version);
      assert.equal(
        packagedManifest.browser_specific_settings.gecko.update_url,
        "https://example.invalid/personal-time-logger/updates.json"
      );
      await assertPackagedReferencesResolve(outputDirectory);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a package with a missing referenced module without executing it", async () => {
    const manifest = JSON.parse(await readFile(join(root, "extension/manifest.json"), "utf8"));
    const outputDirectory = await temporaryPackageDirectory();
    try {
      await execFileAsync(process.execPath, [
        "scripts/prepare-firefox-release.mjs",
        "--base-url", "https://example.invalid/personal-time-logger",
        "--expected-version", manifest.version,
        "--output", relative(root, outputDirectory)
      ], { cwd: root });
      await rm(join(outputDirectory, "src", "themes.js"));
      await assert.rejects(
        () => assertPackagedReferencesResolve(outputDirectory),
        /manifest\.json|\.html.*themes\.js|does not resolve/
      );
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("excludes untracked files placed beside extension source", async () => {
    const manifest = JSON.parse(await readFile(join(root, "extension/manifest.json"), "utf8"));
    const planted = join(root, "extension/src", ".package-test-untracked.js");
    const outputDirectory = await temporaryPackageDirectory();
    await writeFile(planted, "unexpected local file\n", "utf8");
    try {
      await execFileAsync(process.execPath, [
        "scripts/prepare-firefox-release.mjs",
        "--base-url", "https://example.invalid/personal-time-logger",
        "--expected-version", manifest.version,
        "--output", relative(root, outputDirectory)
      ], { cwd: root });
      await assert.rejects(() => readFile(join(outputDirectory, "src", ".package-test-untracked.js")));
    } finally {
      await rm(planted, { force: true });
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("prepares identical source for identical release inputs", async () => {
    const manifest = JSON.parse(await readFile(join(root, "extension/manifest.json"), "utf8"));
    const firstOutput = await temporaryPackageDirectory();
    const secondOutput = await temporaryPackageDirectory();
    const argumentsFor = (outputDirectory) => [
      "scripts/prepare-firefox-release.mjs",
      "--base-url", "https://example.invalid/personal-time-logger",
      "--expected-version", manifest.version,
      "--output", relative(root, outputDirectory)
    ];

    try {
      await execFileAsync(process.execPath, argumentsFor(firstOutput), { cwd: root });
      await execFileAsync(process.execPath, argumentsFor(secondOutput), { cwd: root });
      assert.equal(await directoryDigest(firstOutput), await directoryDigest(secondOutput));
    } finally {
      await rm(firstOutput, { recursive: true, force: true });
      await rm(secondOutput, { recursive: true, force: true });
    }
  });
});

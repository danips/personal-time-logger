import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDirectory = join(root, "web-ext-artifacts");
const expectedFiles = [
  "background/background.js",
  "calendar/calendar.css",
  "calendar/calendar.html",
  "calendar/calendar.js",
  "calendar/popup-drag.js",
  "content/chatgpt-usage-page.js",
  "content/chatgpt-usage.js",
  "icons/icon.svg",
  "manifest.json",
  "options/options.css",
  "options/options.html",
  "options/options.js",
  "popup/popup.css",
  "popup/popup.html",
  "popup/popup.js",
  "reconcile/reconcile.css",
  "reconcile/reconcile.html",
  "reconcile/reconcile.js",
  "src/action-runner.js",
  "src/auth-session-store.js",
  "src/auth.js",
  "src/background-schedule.js",
  "src/calendar-layout.js",
  "src/chatgpt-account-cache.js",
  "src/chatgpt-containers.js",
  "src/codex-usage.js",
  "src/config-loader.js",
  "src/db.js",
  "src/diagnostics.js",
  "src/entries.js",
  "src/entry-editor.css",
  "src/entry-editor.js",
  "src/entry-form.js",
  "src/error-codes.js",
  "src/error-registry.js",
  "src/events.js",
  "src/icon.js",
  "src/operation-states.js",
  "src/options-settings.js",
  "src/page-runtime.js",
  "src/platform.js",
  "src/reconcile-ui-state.js",
  "src/reconcile.js",
  "src/remote-google-sheets.js",
  "src/remote-mysql.js",
  "src/remote-provider.js",
  "src/setting-keys.js",
  "src/sheets.js",
  "src/sync-request.js",
  "src/sync.js",
  "src/tempo.js",
  "src/themes.css",
  "src/themes.js",
  "src/time-allocation.js",
  "src/time.js",
  "src/ui-helpers.js",
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

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
  "src/auth.js",
  "src/calendar-layout.js",
  "src/chatgpt-containers.js",
  "src/codex-usage.js",
  "src/config-loader.js",
  "src/csv.js",
  "src/db.js",
  "src/entries.js",
  "src/entry-form.js",
  "src/events.js",
  "src/icon.js",
  "src/platform.js",
  "src/reconcile.js",
  "src/sheets.js",
  "src/sync.js",
  "src/time-allocation.js",
  "src/time.js",
  "src/ui-helpers.js",
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

describe("Firefox release package", () => {
  it("contains exactly the extension allow-list", async () => {
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    const outputDirectory = await mkdtemp(join(artifactsDirectory, ".package-test-"));

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
});

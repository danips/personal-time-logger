import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDirectory = join(root, "web-ext-artifacts");

async function fixture() {
  await mkdir(artifactsDirectory, { recursive: true });
  const directory = await mkdtemp(join(artifactsDirectory, ".update-site-test-"));
  const source = join(directory, "source");
  const xpi = join(directory, "signed.xpi");
  await mkdir(source);
  await writeFile(join(source, "manifest.json"), JSON.stringify({
    version: "1.2.3",
    browser_specific_settings: { gecko: { id: "personal-time-logger@example.local", strict_min_version: "128.0" } }
  }));
  await writeFile(xpi, "signed extension bytes");
  return { directory, source, xpi, output: join(directory, "site") };
}

function command(...args) {
  return execFileAsync(process.execPath, ["scripts/create-update-site.mjs", ...args], { cwd: root });
}

describe("create update site CLI", () => {
  it("requires strict named options and writes the matching update manifest", async () => {
    const files = await fixture();
    try {
      await command("--base-url", "https://example.invalid/releases/", "--xpi", files.xpi, "--source", files.source, "--output", files.output);
      const updates = JSON.parse(await readFile(join(files.output, "updates.json"), "utf8"));
      const update = updates.addons["personal-time-logger@example.local"].updates[0];
      assert.equal(update.version, "1.2.3");
      assert.equal(update.update_link, "https://example.invalid/releases/personal-time-logger-1.2.3.xpi");
      assert.match(update.update_hash, /^sha256:[0-9a-f]{64}$/);
      await assert.rejects(() => command("--xpi", files.xpi), /--base-url is required/);
      await assert.rejects(() => command("--base-url", "https://example.invalid", "--xpi", files.xpi, "--unknown"), /Unknown option/);
      await assert.rejects(() => command("--base-url", "https://example.invalid", "--base-url", "https://other.invalid", "--xpi", files.xpi), /can only be used once/);
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });
});

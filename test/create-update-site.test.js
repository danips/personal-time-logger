import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDirectory = join(root, "web-ext-artifacts");

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const localFiles = [];
  const centralDirectory = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const fileName = Buffer.from(name);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    localFiles.push(local, fileName, bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    centralDirectory.push(central, fileName);
    offset += local.length + fileName.length + bytes.length;
  }
  const centralBytes = Buffer.concat(centralDirectory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localFiles, centralBytes, end]);
}

async function fixture({ signedVersion = "1.2.3", signedId = "personal-time-logger@example.local" } = {}) {
  await mkdir(artifactsDirectory, { recursive: true });
  const directory = await mkdtemp(join(artifactsDirectory, ".update-site-test-"));
  const source = join(directory, "source");
  const xpi = join(directory, "signed.xpi");
  await mkdir(source);
  const sourceManifest = {
    version: "1.2.3",
    browser_specific_settings: { gecko: { id: "personal-time-logger@example.local", strict_min_version: "128.0" } }
  };
  await writeFile(join(source, "manifest.json"), JSON.stringify(sourceManifest));
  await writeFile(xpi, storedZip([
    ["manifest.json", JSON.stringify({
      ...sourceManifest,
      version: signedVersion,
      browser_specific_settings: { gecko: { ...sourceManifest.browser_specific_settings.gecko, id: signedId } }
    })],
    ["background.js", "signed extension bytes"]
  ]));
  return { directory, source, xpi, output: join(directory, "site") };
}

function command(...args) {
  return execFileAsync(process.execPath, ["scripts/create-update-site.mjs", ...args], { cwd: root });
}

describe("create update site CLI", () => {
  it("requires strict named options and writes the matching update manifest", async () => {
    const files = await fixture();
    try {
      await command("--base-url", "https://example.invalid/releases/", "--expected-version", "1.2.3", "--xpi", files.xpi, "--source", files.source, "--output", files.output);
      const updates = JSON.parse(await readFile(join(files.output, "updates.json"), "utf8"));
      const update = updates.addons["personal-time-logger@example.local"].updates[0];
      assert.equal(update.version, "1.2.3");
      assert.equal(update.update_link, "https://example.invalid/releases/personal-time-logger-1.2.3.xpi");
      assert.match(update.update_hash, /^sha256:[0-9a-f]{64}$/);
      const checksums = Object.fromEntries((await readFile(join(files.output, "checksums.txt"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => line.split(/  +/).reverse()));
      const xpiBytes = await readFile(join(files.output, "personal-time-logger-1.2.3.xpi"));
      assert.equal(checksums["personal-time-logger-1.2.3.xpi"], createHash("sha256").update(xpiBytes).digest("hex"));
      assert.equal(checksums["updates.json"], createHash("sha256").update(await readFile(join(files.output, "updates.json"))).digest("hex"));
      const provenance = JSON.parse(await readFile(join(files.output, "provenance.json"), "utf8"));
      assert.equal(provenance.release.version, "1.2.3");
      assert.equal(provenance.release.source_manifest_sha256, createHash("sha256")
        .update(await readFile(join(files.source, "manifest.json")))
        .digest("hex"));
      assert.equal(provenance.artifacts["personal-time-logger-1.2.3.xpi"].sha256, checksums["personal-time-logger-1.2.3.xpi"]);
      assert.equal(provenance.artifacts["updates.json"].sha256, checksums["updates.json"]);
      assert.match(await readFile(join(files.output, "index.html"), "utf8"), /checksums\.txt.*provenance\.json/);
      await assert.rejects(() => command("--xpi", files.xpi), /--base-url is required/);
      await assert.rejects(() => command("--base-url", "https://example.invalid", "--xpi", files.xpi, "--unknown"), /Unknown option/);
      await assert.rejects(() => command("--base-url", "https://example.invalid", "--base-url", "https://other.invalid", "--xpi", files.xpi), /can only be used once/);
      await assert.rejects(() => command("--base-url", "https://example.invalid", "--expected-version", "9.9.9", "--xpi", files.xpi, "--source", files.source, "--output", files.output), /does not match release version/);
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });

  it("rejects a signed XPI whose manifest differs from the release source", async () => {
    const files = await fixture({ signedVersion: "1.2.4" });
    try {
      await assert.rejects(
        () => command("--base-url", "https://example.invalid", "--expected-version", "1.2.3", "--xpi", files.xpi, "--source", files.source, "--output", files.output),
        /signed XPI manifest version.*does not match source manifest version/
      );
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });
});

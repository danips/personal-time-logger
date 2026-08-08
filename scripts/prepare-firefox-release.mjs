import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const baseUrl = String(args.get("--base-url") || "").replace(/\/+$/, "");
const outputArgument = args.get("--output") || "web-ext-artifacts/release-source";
const expectedVersion = args.get("--expected-version") || "";
const projectRoot = process.cwd();
const artifactsRoot = path.resolve(projectRoot, "web-ext-artifacts");
const outputDirectory = path.resolve(projectRoot, outputArgument);

if (!baseUrl.startsWith("https://")) {
  throw new Error("--base-url must be an HTTPS URL");
}
if (outputDirectory !== artifactsRoot && !outputDirectory.startsWith(`${artifactsRoot}${path.sep}`)) {
  throw new Error("--output must be inside web-ext-artifacts/");
}

const manifest = JSON.parse(await readFile(path.join(projectRoot, "manifest.json"), "utf8"));
if (expectedVersion && manifest.version !== expectedVersion) {
  throw new Error(`manifest version ${manifest.version} does not match release version ${expectedVersion}`);
}

manifest.browser_specific_settings ||= {};
manifest.browser_specific_settings.gecko ||= {};
manifest.browser_specific_settings.gecko.update_url = `${baseUrl}/updates.json`;

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const extensionDirectories = ["background", "calendar", "content", "icons", "options", "popup", "reconcile", "src", "usage"];
const { stdout } = await execFileAsync("git", ["ls-files", "--", "manifest.json", ...extensionDirectories], { cwd: projectRoot });
const trackedFiles = stdout.split("\n").filter(Boolean);
for (const file of trackedFiles) {
  const target = path.join(outputDirectory, file);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(projectRoot, file), target);
}

await writeFile(
  path.join(outputDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);

console.log(`Prepared Firefox ${manifest.version} in ${path.relative(projectRoot, outputDirectory)}`);
console.log(`Update feed: ${manifest.browser_specific_settings.gecko.update_url}`);

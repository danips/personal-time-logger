import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { parseArgs, promisify } from "node:util";

const execFileAsync = promisify(execFile);

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

async function listSourceFiles(directory, relative = "") {
  const files = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listSourceFiles(directory, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`release source contains unsupported file type: ${name}`);
  }
  return files.sort();
}

const cliArgs = process.argv.slice(2);
const optionNames = ["base-url", "expected-version", "output", "source", "xpi"];
for (const name of optionNames) {
  const occurrences = cliArgs.filter((argument) => argument === `--${name}` || argument.startsWith(`--${name}=`)).length;
  if (occurrences > 1) throw new Error(`--${name} can only be used once`);
}

const { values } = parseArgs({
  args: cliArgs,
  options: {
    "base-url": { type: "string" },
    "expected-version": { type: "string" },
    output: { type: "string", default: "web-ext-artifacts/site" },
    source: { type: "string", default: "web-ext-artifacts/release-source" },
    xpi: { type: "string" }
  },
  strict: true,
  allowPositionals: false
});

for (const name of ["base-url", "xpi"]) {
  if (!values[name]) throw new Error(`--${name} is required`);
}

const baseUrl = String(values["base-url"]).replace(/\/+$/, "");
const xpiPath = path.resolve(values.xpi);
const projectRoot = process.cwd();
const artifactsRoot = path.resolve(projectRoot, "web-ext-artifacts");
const outputDirectory = path.resolve(values.output);
const sourceDirectory = path.resolve(values.source);

if (!baseUrl.startsWith("https://")) {
  throw new Error("--base-url must be an HTTPS URL");
}
if (outputDirectory !== artifactsRoot && !outputDirectory.startsWith(`${artifactsRoot}${path.sep}`)) {
  throw new Error("--output must be inside web-ext-artifacts/");
}

const sourceManifestBytes = await readFile(path.join(sourceDirectory, "manifest.json"));
const manifest = JSON.parse(sourceManifestBytes);
const extensionId = manifest.browser_specific_settings?.gecko?.id;
if (!extensionId) throw new Error("The Firefox extension ID is missing");
if (values["expected-version"] && manifest.version !== values["expected-version"]) {
  throw new Error(`source manifest version ${manifest.version} does not match release version ${values["expected-version"]}`);
}

let signedManifest;
try {
  const { stdout } = await execFileAsync("unzip", ["-p", xpiPath, "manifest.json"]);
  signedManifest = JSON.parse(stdout);
} catch {
  throw new Error("The signed XPI must contain a readable manifest.json at its root");
}
if (signedManifest.version !== manifest.version) {
  throw new Error(`signed XPI manifest version ${signedManifest.version} does not match source manifest version ${manifest.version}`);
}
if (signedManifest.browser_specific_settings?.gecko?.id !== extensionId) {
  throw new Error("The signed XPI extension ID does not match the release source manifest");
}
if (JSON.stringify(canonicalJson(signedManifest)) !== JSON.stringify(canonicalJson(manifest))) {
  throw new Error("The signed XPI manifest contents differ from the release source manifest");
}

// Firefox signing adds only META-INF signature records. The manifest is compared
// semantically because signing may normalize its JSON serialization; every other
// application file must remain byte-for-byte identical to the prepared source.
let archiveFiles;
try {
  const { stdout } = await execFileAsync("unzip", ["-Z1", xpiPath]);
  archiveFiles = stdout.split(/\r?\n/)
    .filter((name) => name && !name.endsWith("/") && !name.startsWith("META-INF/"))
    .sort();
} catch {
  throw new Error("The signed XPI file list could not be read");
}
const sourceFiles = await listSourceFiles(sourceDirectory);
if (new Set(archiveFiles).size !== archiveFiles.length
  || JSON.stringify(archiveFiles) !== JSON.stringify(sourceFiles)) {
  throw new Error("The signed XPI application file list does not match the release source");
}
for (const name of sourceFiles) {
  if (name === "manifest.json") continue;
  const [{ stdout }, sourceBytes] = await Promise.all([
    execFileAsync("unzip", ["-p", xpiPath, name], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }),
    readFile(path.join(sourceDirectory, name))
  ]);
  if (!Buffer.from(stdout).equals(sourceBytes)) {
    throw new Error(`The signed XPI application file differs from the release source: ${name}`);
  }
}

const xpiBytes = await readFile(xpiPath);
const hash = createHash("sha256").update(xpiBytes).digest("hex");
const versionedName = `personal-time-logger-${manifest.version}.xpi`;
const versionedUrl = `${baseUrl}/${versionedName}`;

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await copyFile(xpiPath, path.join(outputDirectory, versionedName));

const updates = {
  addons: {
    [extensionId]: {
      updates: [
        {
          version: manifest.version,
          update_link: versionedUrl,
          update_hash: `sha256:${hash}`,
          applications: {
            gecko: {
              strict_min_version: manifest.browser_specific_settings.gecko.strict_min_version
            }
          }
        }
      ]
    }
  }
};

const updatesText = `${JSON.stringify(updates, null, 2)}\n`;
const updatesHash = createHash("sha256").update(updatesText).digest("hex");
const provenance = {
  schema_version: 1,
  release: {
    extension_id: extensionId,
    version: manifest.version,
    source_manifest_sha256: createHash("sha256").update(sourceManifestBytes).digest("hex")
  },
  artifacts: {
    [versionedName]: { sha256: hash, bytes: xpiBytes.length },
    "updates.json": { sha256: updatesHash, bytes: Buffer.byteLength(updatesText) }
  }
};
const provenanceText = `${JSON.stringify(provenance, null, 2)}\n`;
const provenanceHash = createHash("sha256").update(provenanceText).digest("hex");
const checksumsText = `${hash}  ${versionedName}\n${updatesHash}  updates.json\n${provenanceHash}  provenance.json\n`;

await writeFile(path.join(outputDirectory, "updates.json"), updatesText);
await writeFile(path.join(outputDirectory, "provenance.json"), provenanceText);
await writeFile(path.join(outputDirectory, "checksums.txt"), checksumsText);
await writeFile(
  path.join(outputDirectory, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Personal Time Logger for Firefox</title>
  </head>
  <body>
    <main>
      <h1>Personal Time Logger for Firefox</h1>
      <p>Current signed version: ${manifest.version}</p>
      <p><a href="${versionedName}">Install the Firefox extension</a></p>
      <p><a href="checksums.txt">SHA-256 checksums</a> · <a href="provenance.json">Release provenance</a></p>
      <p>If Firefox downloads the file, open <code>about:addons</code>, use the gear menu, and choose <strong>Install Add-on From File</strong>.</p>
    </main>
  </body>
</html>
`,
  "utf8"
);

console.log(`Created update site for Firefox ${manifest.version}`);

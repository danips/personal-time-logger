import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const baseUrl = String(args.get("--base-url") || "").replace(/\/+$/, "");
const xpiPath = path.resolve(args.get("--xpi") || "");
const outputDirectory = path.resolve(args.get("--output") || "web-ext-artifacts/site");
const sourceDirectory = path.resolve(args.get("--source") || "web-ext-artifacts/release-source");

if (!baseUrl.startsWith("https://")) {
  throw new Error("--base-url must be an HTTPS URL");
}

const manifest = JSON.parse(await readFile(path.join(sourceDirectory, "manifest.json"), "utf8"));
const extensionId = manifest.browser_specific_settings?.gecko?.id;
if (!extensionId) throw new Error("The Firefox extension ID is missing");

const xpiBytes = await readFile(xpiPath);
const hash = createHash("sha256").update(xpiBytes).digest("hex");
const versionedName = `personal-time-logger-${manifest.version}.xpi`;
const versionedUrl = `${baseUrl}/${versionedName}`;

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

await writeFile(path.join(outputDirectory, "updates.json"), `${JSON.stringify(updates, null, 2)}\n`);
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
      <p>If Firefox downloads the file, open <code>about:addons</code>, use the gear menu, and choose <strong>Install Add-on From File</strong>.</p>
    </main>
  </body>
</html>
`,
  "utf8"
);

console.log(`Created update site for Firefox ${manifest.version}`);

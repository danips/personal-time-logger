import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const artifactsRoot = join(repositoryRoot, "web-ext-artifacts");
const defaultOutput = artifactsRoot;
const defaultSourceDateEpoch = 315532800; // 1980-01-01: earliest ZIP timestamp

function parseArguments(args) {
  const options = { output: defaultOutput };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--output" && args[index + 1]) {
      options.output = resolve(args[++index]);
      continue;
    }
    throw new Error("Usage: node scripts/build-xpi.mjs [--output DIR]");
  }
  return options;
}

function collectFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(join(directory, entry.name), relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

const options = parseArguments(process.argv.slice(2));
const sourceDirectory = join(artifactsRoot, `.xpi-source-${process.pid}`);
const manifestPath = join(sourceDirectory, "manifest.json");
const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH || defaultSourceDateEpoch);

if (!Number.isInteger(sourceDateEpoch) || sourceDateEpoch < defaultSourceDateEpoch) {
  throw new Error(`SOURCE_DATE_EPOCH must be an integer at or after ${defaultSourceDateEpoch}.`);
}

mkdirSync(options.output, { recursive: true });
rmSync(sourceDirectory, { recursive: true, force: true });

try {
  execFileSync(process.execPath, [
    "scripts/prepare-firefox-release.mjs",
    "--base-url", "https://example.invalid/personal-time-logger",
    "--output", relative(repositoryRoot, sourceDirectory)
  ], { cwd: repositoryRoot, stdio: "inherit" });

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const artifactName = `personal-time-logger-${manifest.version}.xpi`;
  const artifactPath = join(options.output, artifactName);
  const temporaryPath = join(options.output, `.${basename(artifactName)}.${process.pid}.tmp`);
  const sourceDate = new Date(sourceDateEpoch * 1000);
  const files = collectFiles(sourceDirectory);

  for (const file of files) {
    const filePath = join(sourceDirectory, file);
    chmodSync(filePath, 0o644);
    utimesSync(filePath, sourceDate, sourceDate);
  }

  try {
    execFileSync("zip", ["-q", "-X", temporaryPath, ...files], {
      cwd: sourceDirectory,
      env: { ...process.env, TZ: "UTC" },
      stdio: "inherit"
    });
    rmSync(artifactPath, { force: true });
    renameSync(temporaryPath, artifactPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }

  console.log(relative(repositoryRoot, artifactPath));
} finally {
  rmSync(sourceDirectory, { recursive: true, force: true });
}

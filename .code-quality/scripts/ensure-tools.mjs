#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const toolsDir = path.join(root, '.code-quality', '.tools');
mkdirSync(toolsDir, { recursive: true });

const deep = process.argv.includes('--deep');
const packages = [
  { name: 'eslint', version: '10.9.1' },
  { name: 'eslint-plugin-sonarjs', version: '4.2.0' },
  { name: 'jscpd', version: '5.2.0' },
  { name: 'c8', version: '12.0.0' },
];
if (deep) packages.push({ name: '@stryker-mutator/core', version: '10.0.0' });

function installedVersion(name) {
  const packageJson = path.join(toolsDir, 'node_modules', ...name.split('/'), 'package.json');
  if (!existsSync(packageJson)) return null;
  try {
    return JSON.parse(readFileSync(packageJson, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

const mismatches = packages
  .map((pkg) => ({ ...pkg, installed: installedVersion(pkg.name) }))
  .filter((pkg) => pkg.installed !== pkg.version);

if (mismatches.length === 0) {
  console.log(`Using cached isolated quality tools in ${path.relative(root, toolsDir) || toolsDir}; all configured versions match.`);
  for (const pkg of packages) console.log(`  ${pkg.name}@${pkg.version}`);
  process.exit(0);
}

console.log('Quality-tool installation/update required:');
for (const pkg of mismatches) {
  console.log(`  ${pkg.name}: ${pkg.installed ?? 'missing'} -> ${pkg.version}`);
}

const timeoutMsRaw = process.env.CODE_QUALITY_NPM_INSTALL_TIMEOUT_MS ?? '180000';
const timeoutMs = Number.parseInt(timeoutMsRaw, 10);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error(`Invalid CODE_QUALITY_NPM_INSTALL_TIMEOUT_MS=${timeoutMsRaw}`);
}

const specs = packages.map((pkg) => `${pkg.name}@${pkg.version}`);
const args = [
  'install',
  '--prefix', toolsDir,
  '--no-save',
  '--package-lock=false',
  '--no-audit',
  '--no-fund',
  '--prefer-offline',
  ...specs,
];

console.log(`Installing isolated quality tools into ${path.relative(root, toolsDir) || toolsDir} (timeout ${timeoutMs} ms)`);
const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit', timeout: timeoutMs });
if (result.error) {
  if (result.error.code === 'ETIMEDOUT') {
    throw new Error(`Timed out after ${timeoutMs} ms while installing isolated quality tools. Existing matching cached tools remain usable; missing or mismatched required tools must be reported by the workflow.`);
  }
  throw result.error;
}
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

const unresolved = packages
  .map((pkg) => ({ ...pkg, installed: installedVersion(pkg.name) }))
  .filter((pkg) => pkg.installed !== pkg.version);
if (unresolved.length > 0) {
  throw new Error(`Quality-tool install completed but configured versions are still unresolved: ${unresolved.map((pkg) => `${pkg.name}=${pkg.installed ?? 'missing'} (wanted ${pkg.version})`).join(', ')}`);
}

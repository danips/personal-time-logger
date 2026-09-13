#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const args = process.argv.slice(2);
const outputArg = args.indexOf('--output');
const output = outputArg >= 0 ? args[outputArg + 1] : null;
const worktreeCleanArg = args.indexOf('--worktree-clean');
const worktreeCleanOverride = worktreeCleanArg >= 0 ? args[worktreeCleanArg + 1] : null;
if (!output) {
  console.error('Usage: node .code-quality/scripts/collect-metrics.mjs --output <file.json> [--worktree-clean <true|false>]');
  process.exit(2);
}
if (worktreeCleanOverride !== null && !['true', 'false'].includes(worktreeCleanOverride)) {
  console.error('--worktree-clean must be true or false');
  process.exit(2);
}

const tmpRoot = path.join(root, '.code-quality', '.tmp');
mkdirSync(tmpRoot, { recursive: true });
const toolsDir = path.join(root, '.code-quality', '.tools');
const qualityRequire = createRequire(path.join(toolsDir, 'package.json'));

function run(command, commandArgs = [], options = {}) {
  try {
    return execFileSync(command, commandArgs, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trim();
  } catch {
    return null;
  }
}

function runShell(command) {
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
  return run(shell, shellArgs);
}

function version(command, commandArgs = [], shellFallback = null) {
  const direct = run(command, commandArgs);
  if (direct) return direct;
  if (shellFallback) {
    const fallback = runShell(shellFallback);
    if (fallback) return fallback;
  }
  return null;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function summarize(values) {
  if (!values.length) return { count: 0, total: 0, mean: 0, median: 0, p90: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((a, b) => a + b, 0);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    count: sorted.length,
    total,
    mean: Number((total / sorted.length).toFixed(3)),
    median,
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
  };
}

const ignoredDirNames = new Set(['.git', 'node_modules', 'vendor', 'web-ext-artifacts', 'coverage', '.tools', '.tmp', 'runs']);
const productionRoots = ['extension', 'server'];
const supportingRoots = ['scripts'];
const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.php']);

function isTestPath(rel) {
  const parts = rel.split('/');
  const base = path.basename(rel);
  return parts.includes('test') || parts.includes('tests') || /\.test\.[cm]?[jt]sx?$/.test(base) || /_test\.php$/.test(base);
}

function walk(startRel) {
  const start = path.join(root, startRel);
  if (!existsSync(start)) return [];
  const out = [];
  const stack = [start];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const rel = path.relative(root, abs).replaceAll(path.sep, '/');
      if (entry.isDirectory()) {
        if (ignoredDirNames.has(entry.name)) continue;
        stack.push(abs);
      } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
        out.push(rel);
      }
    }
  }
  return out.sort();
}

const allFiles = [...new Set([...productionRoots, ...supportingRoots, 'test'].flatMap(walk))];
const productionFiles = allFiles.filter((f) => !isTestPath(f) && !f.startsWith('scripts/'));
const supportingFiles = allFiles.filter((f) => f.startsWith('scripts/'));
const testFiles = allFiles.filter(isTestPath);

function lineStats(files) {
  let physical = 0;
  let nonblank = 0;
  const perFile = [];
  for (const rel of files) {
    const text = readFileSync(path.join(root, rel), 'utf8');
    const lines = text.length ? text.split(/\r?\n/) : [];
    const p = lines.length;
    const n = lines.filter((line) => line.trim().length > 0).length;
    physical += p;
    nonblank += n;
    perFile.push({ file: rel, physical_loc: p, nonblank_lines: n });
  }
  return {
    files: files.length,
    physical_loc: physical,
    nonblank_lines: nonblank,
    file_loc: summarize(perFile.map((x) => x.physical_loc)),
    largest_files: perFile.sort((a, b) => b.physical_loc - a.physical_loc).slice(0, 20),
  };
}

async function collectJsComplexity(files) {
  const jsFiles = files.filter((f) => /\.[cm]?js$/.test(f));
  const status = { eslint: false, sonarjs: false, parse_errors: [] };
  const cyclomatic = [];
  const cognitive = [];
  const hotspots = [];
  if (!jsFiles.length) return { status, cyclomatic: summarize([]), cognitive: summarize([]), hotspots };

  try {
    const { ESLint } = qualityRequire('eslint');
    const sonarModule = qualityRequire('eslint-plugin-sonarjs');
    const sonarjs = sonarModule.default ?? sonarModule;
    status.eslint = true;
    status.sonarjs = true;

    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        {
          languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
          plugins: { sonarjs },
          rules: {
            complexity: ['warn', 0],
            'sonarjs/cognitive-complexity': ['warn', 0],
          },
        },
      ],
    });

    for (const rel of jsFiles) {
      const text = readFileSync(path.join(root, rel), 'utf8');
      const [result] = await eslint.lintText(text, { filePath: path.join(root, rel) });
      const fileCyclomatic = [];
      const fileCognitive = [];
      for (const msg of result.messages) {
        if (msg.fatal || msg.ruleId === null) {
          status.parse_errors.push({ file: rel, line: msg.line ?? null, message: msg.message });
          continue;
        }
        if (msg.ruleId === 'complexity') {
          const match = msg.message.match(/complexity of\s+(\d+)/i);
          if (match) fileCyclomatic.push({ value: Number(match[1]), line: msg.line ?? null });
        }
        if (msg.ruleId === 'sonarjs/cognitive-complexity') {
          const match = msg.message.match(/Cognitive Complexity from\s+(\d+)/i);
          if (match) fileCognitive.push({ value: Number(match[1]), line: msg.line ?? null });
        }
      }
      cyclomatic.push(...fileCyclomatic.map((x) => x.value));
      cognitive.push(...fileCognitive.map((x) => x.value));
      const maxCyclo = fileCyclomatic.reduce((m, x) => Math.max(m, x.value), 0);
      const maxCog = fileCognitive.reduce((m, x) => Math.max(m, x.value), 0);
      hotspots.push({ file: rel, cyclomatic_max: maxCyclo, cognitive_max: maxCog, functions: fileCyclomatic.length });
    }
  } catch (error) {
    status.error = String(error?.message ?? error);
  }

  if (!status.eslint || !status.sonarjs) {
    return { status, cyclomatic: null, cognitive: null, hotspots: [] };
  }
  return {
    status,
    cyclomatic: summarize(cyclomatic),
    cognitive: summarize(cognitive),
    hotspots: hotspots.sort((a, b) => (b.cognitive_max - a.cognitive_max) || (b.cyclomatic_max - a.cyclomatic_max)).slice(0, 25),
  };
}

function collectPhpComplexity(files) {
  const phpFiles = files.filter((f) => f.endsWith('.php'));
  if (!phpFiles.length) {
    return { status: { available: true, parser: 'php-tokenizer' }, cyclomatic: summarize([]), hotspots: [] };
  }
  const php = version('php', ['-r', 'echo PHP_VERSION;'], 'php -r \'echo PHP_VERSION;\'');
  if (!php) return { status: { available: false, reason: 'php CLI unavailable' }, cyclomatic: null, hotspots: [] };
  const script = path.join(root, '.code-quality', 'scripts', 'php-complexity.php');
  if (!existsSync(script)) return { status: { available: false, reason: 'php-complexity.php missing' }, cyclomatic: null, hotspots: [] };

  try {
    const raw = execFileSync('php', [script, ...phpFiles], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw);
    const functions = Array.isArray(parsed.functions) ? parsed.functions : [];
    return {
      status: { available: true, parser: 'php-tokenizer', parse_errors: parsed.parse_errors ?? [] },
      cyclomatic: summarize(functions.map((item) => Number(item.cyclomatic)).filter(Number.isFinite)),
      hotspots: functions
        .map((item) => ({ file: item.file, symbol: item.symbol, line: item.line, cyclomatic: Number(item.cyclomatic) }))
        .sort((a, b) => b.cyclomatic - a.cyclomatic)
        .slice(0, 25),
      scope_note: 'Tokenizer-based function/method cyclomatic metric for trend comparison; it is not a cognitive-complexity metric.',
    };
  } catch (error) {
    return { status: { available: false, reason: String(error?.message ?? error) }, cyclomatic: null, hotspots: [] };
  }
}

function collectDuplication() {
  const bin = path.join(toolsDir, 'node_modules', '.bin', process.platform === 'win32' ? 'jscpd.cmd' : 'jscpd');
  if (!existsSync(bin)) return { status: 'unavailable', reason: 'jscpd not installed' };
  const outDir = path.join(tmpRoot, 'jscpd');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const result = spawnSync(bin, ['--config', '.code-quality/jscpd.json', '--reporters', 'json', '--output', outDir, 'extension', 'server'], {
    cwd: root,
    encoding: 'utf8',
  });
  const reportPath = path.join(outDir, 'jscpd-report.json');
  if (!existsSync(reportPath)) return { status: 'error', exit_code: result.status, stderr: result.stderr?.trim() || null };
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const total = report?.statistics?.total ?? {};
  return {
    status: result.status === 0 ? 'ok' : 'nonzero_with_report',
    exit_code: result.status,
    clones: total.clones ?? null,
    lines: total.lines ?? null,
    duplicated_lines: total.duplicatedLines ?? null,
    percentage: total.percentage ?? null,
  };
}

function parseNodeTestSummary(output) {
  if (!output) return null;
  const fields = {
    tests: 'tests',
    suites: 'suites',
    pass: 'pass',
    fail: 'fail',
    cancelled: 'cancelled',
    skipped: 'skipped',
    todo: 'todo',
  };
  const summary = {};
  for (const [label, key] of Object.entries(fields)) {
    const matches = [...output.matchAll(new RegExp(`^#\\s+${label}\\s+(\\d+)\\s*$`, 'gmi'))];
    if (matches.length > 0) summary[key] = Number(matches.at(-1)[1]);
  }
  const durationMatches = [...output.matchAll(/^#\s+duration_ms\s+([0-9.]+)\s*$/gmi)];
  if (durationMatches.length > 0) summary.duration_ms = Number(durationMatches.at(-1)[1]);
  return Object.keys(summary).length > 0 ? summary : null;
}

function collectCoverageComponent(name, includes, npmArgs) {
  const bin = path.join(toolsDir, 'node_modules', '.bin', process.platform === 'win32' ? 'c8.cmd' : 'c8');
  if (!existsSync(bin)) return { status: 'unavailable', reason: 'c8 not installed' };
  const reportsDir = path.join(tmpRoot, `coverage-${name}`);
  rmSync(reportsDir, { recursive: true, force: true });
  mkdirSync(reportsDir, { recursive: true });
  const c8Args = [
    '--reporter=json-summary',
    `--reports-dir=${reportsDir}`,
    '--all',
    ...includes.flatMap((pattern) => [`--include=${pattern}`]),
    '--exclude=server/**/test/**',
    '--exclude=server/**/tests/**',
    '--exclude=**/*.test.js',
    'npm', ...npmArgs,
  ];
  const result = spawnSync(bin, c8Args, { cwd: root, encoding: 'utf8' });
  const summaryPath = path.join(reportsDir, 'coverage-summary.json');
  const testExecution = parseNodeTestSummary(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (!existsSync(summaryPath)) {
    return {
      status: 'error',
      exit_code: result.status,
      stderr: result.stderr?.trim() || null,
      test_execution: testExecution,
    };
  }
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))?.total ?? null;
  return {
    status: result.status === 0 ? 'ok' : 'tests_failed',
    exit_code: result.status,
    total: summary,
    test_execution: testExecution,
  };
}

function collectCoverage() {
  return {
    components: {
      extension_unit: collectCoverageComponent('extension-unit', ['extension/src/**/*.js'], ['test']),
      cloudflare: collectCoverageComponent('cloudflare', ['server/cloudflare-d1/src/**/*.js', 'server/http-contract.mjs'], ['run', 'test:cloudflare']),
      php: {
        status: 'not_collected',
        reason: 'PHP line coverage requires a coverage driver/harness such as Xdebug or PCOV; the current repository does not configure one.',
      },
      browser_runtime: {
        status: 'not_collected',
        reason: 'The Firefox runtime smoke is a behavioral gate; deterministic source-line coverage is not collected by the current harness.',
      },
    },
  };
}

function collectChurn() {
  const raw = run('git', ['log', '--since=12 months ago', '--name-only', '--format=@@COMMIT:%H']);
  if (raw === null) return { status: 'unavailable', files: [] };
  const counts = new Map();
  let currentFiles = new Set();
  const flush = () => {
    for (const file of currentFiles) counts.set(file, (counts.get(file) ?? 0) + 1);
    currentFiles = new Set();
  };
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('@@COMMIT:')) { flush(); continue; }
    const rel = line.trim().replaceAll('\\', '/');
    if (!rel) continue;
    if (productionFiles.includes(rel)) currentFiles.add(rel);
  }
  flush();
  return {
    status: 'ok',
    window: '12 months',
    top_files: [...counts.entries()].map(([file, commits]) => ({ file, commits })).sort((a, b) => b.commits - a.commits).slice(0, 30),
  };
}

function countTests(files) {
  let declarations = 0;
  const byFile = [];
  for (const rel of files) {
    const text = readFileSync(path.join(root, rel), 'utf8');
    const count = (text.match(/\b(?:test|it)\s*\(/g) ?? []).length + (text.match(/\bfunction\s+test[A-Za-z0-9_]*\s*\(/g) ?? []).length;
    declarations += count;
    byFile.push({ file: rel, declarations: count });
  }
  return { files: files.length, approximate_test_declarations: declarations, by_file: byFile };
}

function scopedWorktreeClean() {
  const status = run('git', [
    'status', '--porcelain', '--untracked-files=all', '--', '.',
    ':(exclude).code-quality/runs/**',
    ':(exclude).code-quality/.tmp/**',
    ':(exclude).code-quality/.tools/**',
  ]);
  return status === '';
}

const jsComplexity = await collectJsComplexity(productionFiles);
const phpComplexity = collectPhpComplexity(productionFiles);
const effectiveWorktreeClean = worktreeCleanOverride === null ? scopedWorktreeClean() : worktreeCleanOverride === 'true';
const metrics = {
  schema_version: 3,
  generated_at: new Date().toISOString(),
  repository: {
    commit: run('git', ['rev-parse', 'HEAD']) ?? 'unknown',
    branch: run('git', ['branch', '--show-current']) ?? 'unknown',
    worktree_clean: effectiveWorktreeClean,
    worktree_clean_scope: worktreeCleanOverride === null
      ? 'current worktree excluding generated .code-quality/runs, .tmp, and .tools content'
      : 'caller-supplied pre-artifact snapshot',
  },
  environment: {
    node: process.version,
    npm: version('npm', ['--version'], 'npm --version'),
    php: version('php', ['-r', 'echo PHP_VERSION;'], "php -r 'echo PHP_VERSION;'"),
    firefox: version('firefox', ['--version'], 'firefox --version'),
  },
  size: {
    production: lineStats(productionFiles),
    tests: lineStats(testFiles),
    supporting: lineStats(supportingFiles),
    languages: {
      javascript: productionFiles.filter((f) => /\.[cm]?js$/.test(f)).length,
      typescript: productionFiles.filter((f) => /\.tsx?$/.test(f)).length,
      php: productionFiles.filter((f) => f.endsWith('.php')).length,
    },
  },
  complexity: {
    javascript: {
      cyclomatic: jsComplexity.cyclomatic,
      cognitive: jsComplexity.cognitive,
      hotspots: jsComplexity.hotspots,
      scope_note: 'Function-level JS/MJS cyclomatic and SonarJS cognitive metrics.',
    },
    php: phpComplexity,
  },
  duplication: collectDuplication(),
  coverage: collectCoverage(),
  git_history: collectChurn(),
  test_inventory: countTests(testFiles),
  tool_status: {
    javascript_complexity: jsComplexity.status,
    php_complexity: phpComplexity.status,
    isolated_tools_dir: path.relative(root, toolsDir).replaceAll(path.sep, '/'),
  },
  notes: [
    'LOC metrics are physical/nonblank lines, not semantic executable LOC.',
    'JavaScript cognitive complexity uses the configured SonarJS ESLint rule when the isolated tools are installed.',
    'PHP cyclomatic complexity is tokenizer-based and intended for stable trend comparison; PHP cognitive complexity is not collected.',
    'Duplication is production-oriented and excludes test directories via .code-quality/jscpd.json.',
    'Coverage is component-scoped. Extension unit and Cloudflare coverage are independent; browser-runtime and PHP line coverage are not fabricated when unavailable.',
    'Node test execution counts come from the final TAP summary emitted by each instrumented component. test_inventory.approximate_test_declarations is source inventory only and must not be reported as the executed test count.',
    'Qualitative overengineering, dead-code, architecture, and test-value findings belong in 01-analysis.md rather than being fabricated as numeric metrics.',
  ],
};

const outputPath = path.resolve(root, output);
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(metrics, null, 2) + '\n');
console.log(outputPath);

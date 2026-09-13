#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const [baselinePath, finalPath, outputPath] = process.argv.slice(2);
if (!baselinePath || !finalPath || !outputPath) {
  console.error('Usage: node .code-quality/scripts/compare-metrics.mjs <baseline.json> <final.json> <report.md>');
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const final = JSON.parse(readFileSync(finalPath, 'utf8'));

function get(obj, pathText) {
  return pathText.split('.').reduce((value, key) => value?.[key], obj);
}
function firstNumber(obj, paths) {
  for (const pathText of paths) {
    const value = get(obj, pathText);
    if (typeof value === 'number') return value;
  }
  return null;
}
function fmt(value, suffix = '') {
  if (value === null || value === undefined) return 'n/a';
  return `${typeof value === 'number' ? Number(value.toFixed?.(3) ?? value) : value}${suffix}`;
}
function delta(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return 'n/a';
  const d = b - a;
  return `${d > 0 ? '+' : ''}${Number(d.toFixed(3))}`;
}

const rows = [
  ['Production physical LOC', ['size.production.physical_loc'], 'context'],
  ['Production files', ['size.production.files'], 'context'],
  ['JS cyclomatic total', ['complexity.javascript.cyclomatic.total'], 'lower'],
  ['JS cyclomatic p95', ['complexity.javascript.cyclomatic.p95'], 'nonregress'],
  ['JS cyclomatic max', ['complexity.javascript.cyclomatic.max'], 'nonregress'],
  ['JS cognitive total', ['complexity.javascript.cognitive.total'], 'lower'],
  ['JS cognitive p95', ['complexity.javascript.cognitive.p95'], 'nonregress'],
  ['JS cognitive max', ['complexity.javascript.cognitive.max'], 'nonregress'],
  ['PHP cyclomatic total', ['complexity.php.cyclomatic.total'], 'lower'],
  ['PHP cyclomatic p95', ['complexity.php.cyclomatic.p95'], 'nonregress'],
  ['PHP cyclomatic max', ['complexity.php.cyclomatic.max'], 'nonregress'],
  ['Duplicated lines', ['duplication.duplicated_lines'], 'lower'],
  ['Duplication %', ['duplication.percentage'], 'nonregress'],
  ['Extension unit line coverage %', ['coverage.components.extension_unit.total.lines.pct', 'coverage.total.lines.pct'], 'higher_nonregress'],
  ['Extension unit branch coverage %', ['coverage.components.extension_unit.total.branches.pct', 'coverage.total.branches.pct'], 'context'],
  ['Cloudflare line coverage %', ['coverage.components.cloudflare.total.lines.pct'], 'higher_nonregress'],
  ['Cloudflare branch coverage %', ['coverage.components.cloudflare.total.branches.pct'], 'context'],
  ['Extension executed tests', ['coverage.components.extension_unit.test_execution.tests'], 'context'],
  ['Extension test suites', ['coverage.components.extension_unit.test_execution.suites'], 'context'],
  ['Extension test failures', ['coverage.components.extension_unit.test_execution.fail'], 'context'],
  ['Cloudflare executed tests', ['coverage.components.cloudflare.test_execution.tests'], 'context'],
  ['Cloudflare test failures', ['coverage.components.cloudflare.test_execution.fail'], 'context'],
  ['Test source files', ['test_inventory.files'], 'context'],
  ['Approx. test declarations', ['test_inventory.approximate_test_declarations'], 'context'],
];

let automatedGate = 'PASS';
const rendered = rows.map(([name, keys, policy]) => {
  const a = firstNumber(baseline, keys);
  const b = firstNumber(final, keys);
  let gate = '—';
  if (typeof a === 'number' && typeof b === 'number') {
    if (policy === 'nonregress') gate = b <= a ? 'PASS' : 'FAIL';
    if (policy === 'higher_nonregress') gate = b >= a ? 'PASS' : 'FAIL';
    if (policy === 'lower') gate = b < a ? 'IMPROVED' : (b === a ? 'UNCHANGED' : 'REGRESSED');
    if (gate === 'FAIL') automatedGate = 'FAIL';
  } else if (policy === 'nonregress' || policy === 'higher_nonregress') {
    gate = 'N/A';
  }
  return `| ${name} | ${fmt(a)} | ${fmt(b)} | ${delta(a, b)} | ${gate} |`;
});

const baselineCommit = baseline.repository?.commit ?? 'unknown';
const finalCommit = final.repository?.commit ?? 'unknown';
const text = `# Automated quality-metrics comparison\n\nBaseline measured commit: \`${baselineCommit}\`  \nFinal measured commit: \`${finalCommit}\`\n\n| Metric | Before | After | Delta | Automated gate |\n| --- | ---: | ---: | ---: | --- |\n${rendered.join('\n')}\n\n## Automated gate result\n\n**${automatedGate}**\n\nA metric marked N/A was not comparably available in both snapshots and cannot silently pass a gate. Component coverage is compared only against the same component/harness. This result is evidence only. The Analyst must also review behavior, tests, architecture, overengineering findings, dependency/cycle changes, worker-plan compliance, touched-boundary validation, and unavailable metrics before assigning the workflow terminal state.\n`;

writeFileSync(path.resolve(outputPath), text);
console.log(path.resolve(outputPath));

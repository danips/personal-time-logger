#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const TERMINAL_STATES = new Set(['ACCEPTED', 'ACCEPTED_WITH_NOTES', 'NEEDS_FURTHER_WORK', 'BLOCKED']);
const PHASES = new Set([
  'INITIALIZED', 'PREFLIGHT', 'BASELINE', 'ANALYSIS', 'PLAN', 'IMPLEMENTATION',
  'REVIEW', 'CORRECTION', 'FINAL_MEASUREMENT', 'REPORT', 'COMPLETE',
]);
const TASK_STATES = new Set(['pending', 'in_progress', 'completed', 'partial', 'blocked']);

function usage(exitCode = 2) {
  console.error(`Usage:
  workflow-state.mjs active [--runs-dir .code-quality/runs] [--branch <name>]
  workflow-state.mjs init --file <state.json> --run-id <id> --mode <standard|deep> --baseline-commit <sha> --branch <name> [--baseline-worktree-clean <true|false>]
  workflow-state.mjs checkpoint --file <state.json> --phase <phase> [--commit <sha>] [--verified] [--measured] [--correction-cycle <n>] [--next-action <text>] [--note <text>]
  workflow-state.mjs task --file <state.json> --id <Q-NNN> --status <pending|in_progress|completed|partial|blocked> [--commit <sha>] [--note <text>]
  workflow-state.mjs finish --file <state.json> --state <terminal-state> [--commit <sha>] [--note <text>]
  workflow-state.mjs show --file <state.json>`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === 'verified' || key === 'measured') {
      out[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      console.error(`Missing value for --${key}`);
      usage();
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

function now() {
  return new Date().toISOString();
}

function readState(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function atomicWrite(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

function pushHistory(state, event, { phase = state.phase ?? null, commit = null, note = null } = {}) {
  state.history ??= [];
  state.history.push({ at: now(), event, phase, commit, note });
  if (state.history.length > 500) state.history = state.history.slice(-500);
}

function requireArg(args, name) {
  if (!args[name]) {
    console.error(`Missing --${name}`);
    usage();
  }
  return args[name];
}

function active(args) {
  const runsDir = path.resolve(args['runs-dir'] ?? '.code-quality/runs');
  if (!existsSync(runsDir)) return;
  const candidates = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(runsDir, entry.name, 'state.json');
    if (!existsSync(file)) continue;
    try {
      const state = readState(file);
      if (state.workflow_status !== 'IN_PROGRESS') continue;
      if (args.branch !== undefined && state.branch !== args.branch) continue;
      candidates.push({ file, state });
    } catch (error) {
      console.error(`Ignoring unreadable state ${file}: ${error.message}`);
    }
  }
  if (candidates.length === 0) return;
  candidates.sort((a, b) => String(b.state.updated_at).localeCompare(String(a.state.updated_at)));
  if (candidates.length > 1) {
    console.error('Ambiguous active runs:');
    for (const item of candidates) console.error(item.file);
    process.exit(4);
  }
  console.log(candidates[0].file);
}

function init(args) {
  const file = path.resolve(requireArg(args, 'file'));
  if (existsSync(file)) {
    console.error(`Refusing to overwrite existing workflow state: ${file}`);
    process.exit(3);
  }
  const mode = requireArg(args, 'mode');
  if (!['standard', 'deep'].includes(mode)) {
    console.error(`Invalid mode: ${mode}`);
    process.exit(2);
  }
  if (args['baseline-worktree-clean'] !== undefined && !['true', 'false'].includes(args['baseline-worktree-clean'])) {
    console.error('--baseline-worktree-clean must be true or false');
    process.exit(2);
  }
  const at = now();
  const baseline = requireArg(args, 'baseline-commit');
  const state = {
    schema_version: 1,
    run_id: requireArg(args, 'run-id'),
    workflow_status: 'IN_PROGRESS',
    terminal_state: null,
    mode,
    branch: requireArg(args, 'branch'),
    baseline_commit: baseline,
    baseline_worktree_clean: args['baseline-worktree-clean'] === undefined ? null : args['baseline-worktree-clean'] === 'true',
    phase: 'INITIALIZED',
    correction_cycle: 0,
    head_commit: baseline,
    last_verified_commit: null,
    measured_commit: null,
    current_task: null,
    created_at: at,
    updated_at: at,
    next_action: 'Complete preflight and establish baseline',
    tasks: {},
    artifacts: {},
    history: [],
  };
  pushHistory(state, 'initialized', { phase: 'INITIALIZED', commit: baseline });
  atomicWrite(file, state);
  console.log(file);
}

function checkpoint(args) {
  const file = path.resolve(requireArg(args, 'file'));
  const phase = requireArg(args, 'phase');
  if (!PHASES.has(phase)) {
    console.error(`Invalid phase: ${phase}`);
    process.exit(2);
  }
  const state = readState(file);
  if (state.workflow_status !== 'IN_PROGRESS') {
    console.error('Cannot checkpoint a terminal workflow.');
    process.exit(3);
  }
  state.phase = phase;
  if (args.commit) state.head_commit = args.commit;
  if (args.verified) {
    if (!args.commit) {
      console.error('--verified requires --commit');
      process.exit(2);
    }
    state.last_verified_commit = args.commit;
  }
  if (args.measured) {
    if (!args.commit) {
      console.error('--measured requires --commit');
      process.exit(2);
    }
    state.measured_commit = args.commit;
  }
  if (args['correction-cycle'] !== undefined) {
    const cycle = Number(args['correction-cycle']);
    if (!Number.isInteger(cycle) || cycle < 0) {
      console.error('Invalid --correction-cycle');
      process.exit(2);
    }
    state.correction_cycle = cycle;
  }
  if (args['next-action'] !== undefined) state.next_action = args['next-action'];
  state.updated_at = now();
  pushHistory(state, 'checkpoint', { phase, commit: args.commit ?? null, note: args.note ?? null });
  atomicWrite(file, state);
  console.log(file);
}

function task(args) {
  const file = path.resolve(requireArg(args, 'file'));
  const id = requireArg(args, 'id');
  const status = requireArg(args, 'status');
  if (!TASK_STATES.has(status)) {
    console.error(`Invalid task status: ${status}`);
    process.exit(2);
  }
  if (status === 'completed' && !args.commit) {
    console.error('Completed task requires --commit');
    process.exit(2);
  }
  const state = readState(file);
  if (state.workflow_status !== 'IN_PROGRESS') {
    console.error('Cannot update tasks on a terminal workflow.');
    process.exit(3);
  }
  const at = now();
  state.tasks ??= {};
  state.tasks[id] = {
    ...(state.tasks[id] ?? {}),
    status,
    commit: args.commit ?? state.tasks[id]?.commit ?? null,
    updated_at: at,
    note: args.note ?? state.tasks[id]?.note ?? null,
  };
  if (status === 'in_progress') state.current_task = id;
  if (['completed', 'blocked'].includes(status) && state.current_task === id) state.current_task = null;
  if (args.commit) state.head_commit = args.commit;
  state.updated_at = at;
  pushHistory(state, `task:${id}:${status}`, { phase: state.phase, commit: args.commit ?? null, note: args.note ?? null });
  atomicWrite(file, state);
  console.log(file);
}

function finish(args) {
  const file = path.resolve(requireArg(args, 'file'));
  const terminal = requireArg(args, 'state');
  if (!TERMINAL_STATES.has(terminal)) {
    console.error(`Invalid terminal state: ${terminal}`);
    process.exit(2);
  }
  const state = readState(file);
  state.workflow_status = 'TERMINAL';
  state.terminal_state = terminal;
  state.phase = 'COMPLETE';
  state.next_action = null;
  state.current_task = null;
  if (args.commit) state.head_commit = args.commit;
  state.updated_at = now();
  pushHistory(state, `finished:${terminal}`, { phase: 'COMPLETE', commit: args.commit ?? null, note: args.note ?? null });
  atomicWrite(file, state);
  console.log(file);
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (!command) usage();
if (command === 'active') active(args);
else if (command === 'init') init(args);
else if (command === 'checkpoint') checkpoint(args);
else if (command === 'task') task(args);
else if (command === 'finish') finish(args);
else if (command === 'show') console.log(JSON.stringify(readState(path.resolve(requireArg(args, 'file'))), null, 2));
else usage();

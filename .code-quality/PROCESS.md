# Repository Quality-Improvement Process

## 1. Purpose

This process defines a repeatable, evidence-driven maintenance cycle for `personal-time-logger` and similar Firefox WebExtension projects with JavaScript/TypeScript and PHP backends.

The goal is not to maximize a single quality score. The goal is to preserve behavior while reducing **accidental complexity**: unnecessary indirection, duplication, dead code, hard-to-understand control flow, weak architecture boundaries, and tests that add maintenance cost without adding meaningful defect-detection value.

The workflow deliberately separates two roles:

- **Quality Analyst / Architect (parent session):** measures, investigates, plans, delegates, reviews, accepts/rejects, and produces the final report.
- **Refactor Worker (subagent):** implements only the approved plan, tests its own changes, commits them, and hands control back to the parent.

The parent is responsible for the whole cycle. Worker completion is not workflow completion.

## 2. Activation and model policy

Run this process only when explicitly requested by the user.

Preferred configuration:

- Parent Analyst: GPT-5.6 Sol, High reasoning.
- Worker: GPT-5.6 Luna, High reasoning.

The project defines a `refactor_worker` custom agent. If the current Codex build does not expose project-scoped custom roles, the parent must use a generic child agent with the project-wide Luna High subagent defaults and include the worker contract in the delegation instructions. The workflow must not be abandoned merely because the named custom role is unavailable.

Use one implementation worker at a time. Workers must not spawn subagents.

## 2.1 Canonical execution environment

The canonical execution surface for this workflow is **Codex CLI launched from the repository root**. The VS Code Codex extension remains supported, but the CLI is the reference environment for repository-local configuration, subagent orchestration, long-running shell commands, and reproducible path resolution.

Start the workflow from the repository root:

```bash
cd <repository-root>
codex
```

For long-running runs, use a persistent terminal multiplexer when available:

```bash
tmux new -s code-quality
cd <repository-root>
codex
```

If the terminal UI disappears while Codex is still running, reconnect with:

```bash
tmux attach -t code-quality
```

Launching from a subdirectory is unsupported for the canonical workflow because it can make `AGENTS.md`, `.codex/config.toml`, `.code-quality/config.yaml`, Git state, and relative tool paths resolve inconsistently.

While a quality cycle is active, treat the checkout as workflow-owned: do not manually edit application or test files from VS Code or another terminal. Passive inspection is fine. Manual changes during a run can make checkpoint ownership ambiguous and force a `BLOCKED` result.

## 3. Non-negotiable principles

1. **Behavior first.** Observable behavior and protected contracts outrank metric improvements.
2. **Metrics are evidence, not the objective.** Never trade clarity or architecture for a prettier number.
3. **No self-review.** The worker cannot approve its own implementation.
4. **Baseline is immutable.** Never rewrite baseline metrics after implementation starts.
5. **Small, reversible changes.** Prefer one logical task per commit.
6. **No speculative refactoring.** A change needs concrete evidence and a favorable benefit/risk ratio.
7. **Deletion requires proof.** Dead code, abstractions, and tests may be removed aggressively only when evidence supports removal.
8. **Essential complexity is allowed.** Browser contexts, IndexedDB, synchronization, reconciliation, leases/fencing, provider contracts, and release constraints can legitimately require complexity.
9. **No scope creep.** Worker-discovered opportunities return to the parent for a new plan decision.
10. **Stopping is a feature.** `NO FURTHER HIGH-CONFIDENCE CHANGES RECOMMENDED` is a successful analytical outcome.
11. **One user turn should be enough.** Once a run starts, do not pause for confirmation, preference checks, or permission to continue between phases. Use configured safe defaults and continue autonomously.
12. **Checkpoint before handoffs.** Persist enough state to resume after interruption, context loss, quota exhaustion, IDE restart, or worker failure without repeating completed analysis or implementation.
13. **Never fake continuity.** A resumed run must verify repository HEAD/worktree against its checkpoint before continuing.

## 4. Protected project contracts

Unless an approved task explicitly changes a contract, preserve:

- Firefox Manifest V3 behavior and extension entry points;
- manifest permissions, host permissions, and optional permissions;
- browser/storage keys and persistence semantics;
- IndexedDB database name, schema version, stores, indexes, and migration behavior;
- canonical entry/time model, duration and multiplier semantics;
- sync ordering, coalescing, locking/leases, fencing, reconciliation, and conflict semantics;
- backup/import/export formats;
- Google Sheets/Drive remote behavior;
- MySQL HTTPS API behavior;
- Cloudflare Worker/D1 behavior;
- remote-provider abstractions that represent genuinely different provider capabilities;
- release packaging/signing inputs and Firefox runtime compatibility;
- documented user-visible behavior.

An apparent extra layer that enforces one of these boundaries is not overengineering merely because it adds code.

## 5. Run modes

### Standard (default)

Use for periodic maintenance. Collect deterministic size, JS cyclomatic/cognitive complexity, tokenizer-based PHP cyclomatic complexity, duplication, component-scoped extension/Cloudflare coverage, Git churn, test inventory, and all existing repository checks. Add qualitative architecture, dead-code, overengineering, change-coupling, and test-value analysis. Standard remains conservative: automatic implementation requires HIGH confidence and LOW/MEDIUM risk.

### Deep

Use occasionally or when Standard finds substantial risk. Deep includes Standard plus targeted mutation testing and any justified language-specific static/dependency analysis. Mutation testing should be scoped to code actually exercised by a meaningful test harness; do not blindly mutate the whole extension UI if that only creates infrastructure noise.

Deep may additionally authorize **at most one bounded experimental refactor** that has MEDIUM-or-better confidence, MEDIUM-or-lower risk, and meaningful expected impact. The experiment must have explicit rollback criteria. If independent review cannot demonstrate a clear readability/maintenance benefit without behavioral or metric regression, revert the entire experimental task. HIGH-risk state-machine/trust-boundary refactors remain document-only unless separately and explicitly authorized.

## 6. Non-interactive execution, checkpoints, and resume

A quality cycle is designed to complete inside one parent turn whenever the environment allows it. The parent must not stop between phases to ask whether it should continue. Mid-run questions are forbidden unless continuing would require an unsafe, destructive, or unauthorized action that cannot be handled conservatively.

When information is missing:

- use a documented safe default for non-essential choices;
- skip optional work and record a note when the environment cannot support it;
- if a required decision/authorization is genuinely unavailable, persist a checkpoint, set the run to `BLOCKED`, and finish the current turn rather than asking the user to supervise each phase.

Every run has a resumable state file:

```text
.code-quality/runs/<run>/state.json
```

The state file is operational metadata and is updated throughout the run. It is part of the final run artifacts, but intermediate state updates do not need their own Git commits.

Use the deterministic helper:

```bash
node .code-quality/scripts/workflow-state.mjs ...
```

### Starting or resuming

Before creating a new run, search for an active compatible run:

```bash
node .code-quality/scripts/workflow-state.mjs active \
  --branch "$(git branch --show-current)"
```

If exactly one compatible `IN_PROGRESS` run exists, resume it instead of creating a new baseline. Do not overwrite its baseline.

If multiple compatible active runs exist, end `BLOCKED` and report the conflicting state files. Do not guess which run should win.

For a new run, initialize state immediately after the run directory is created:

```bash
node .code-quality/scripts/workflow-state.mjs init \
  --file .code-quality/runs/<run>/state.json \
  --run-id <run> \
  --mode <standard-or-deep> \
  --baseline-commit "$(git rev-parse HEAD)" \
  --branch "$(git branch --show-current)" \
  --baseline-worktree-clean <captured-pre-artifact-true-or-false>
```

### Mandatory checkpoints

Checkpoint at least after preflight, baseline, analysis, plan creation, before implementation delegation, after each worker task commit, after worker handover, after each independent review, before/after each correction cycle, after final metrics, and after final report/terminal decision.

Example:

```bash
node .code-quality/scripts/workflow-state.mjs checkpoint \
  --file .code-quality/runs/<run>/state.json \
  --phase ANALYSIS \
  --commit "$(git rev-parse HEAD)" \
  --next-action "Create the prioritized implementation plan" \
  --note "Analysis artifact complete"
```

The worker must mark each delegated task after its commit:

```bash
node .code-quality/scripts/workflow-state.mjs task \
  --file .code-quality/runs/<run>/state.json \
  --id Q-001 \
  --status completed \
  --commit <task-commit-sha>
```

The parent records `last_verified_commit` only after independently reviewing/verifying that commit or batch.

### Resume verification

On resume, read `state.json` and verify branch, baseline ancestry, required artifacts for completed phases, recorded task commits, current HEAD, and worktree. If the worktree is clean apart from run metadata, continue from `next_action`.

If application/test files are dirty and the state shows an implementation task was in progress, treat those edits as interrupted worker work: inspect them, associate them with the pending task, and delegate that same task for completion/reconciliation. Never discard interrupted edits automatically.

If dirty application changes cannot be mapped safely to the active run/task, end `BLOCKED`; do not reset, overwrite, or silently absorb them.

Do not rerun completed expensive phases merely because a new chat/session started. Reuse immutable artifacts and rerun only checks needed to re-establish confidence from the checkpoint.

### Terminal checkpoint

At the end, finalize the state:

```bash
node .code-quality/scripts/workflow-state.mjs finish \
  --file .code-quality/runs/<run>/state.json \
  --state ACCEPTED \
  --commit "$(git rev-parse HEAD)" \
  --note "Final independent review complete"
```

The allowed terminal states remain `ACCEPTED`, `ACCEPTED_WITH_NOTES`, `NEEDS_FURTHER_WORK`, and `BLOCKED`.


## 6.1 Subagent configuration smoke test

Before the **first real quality run** after installing this workflow, and again after a Codex upgrade or any change to `.codex/config.toml` / `.codex/agents/**`, run the read-only subagent smoke test in `.code-quality/prompts/preflight-subagent-smoke.md`.

The smoke test must verify all of the following without modifying tracked files:

- the parent can read the repository instructions from the repository root;
- the `refactor_worker` custom role is available, or the documented generic-child fallback works;
- delegation actually occurs and returns control to the parent;
- the worker can identify the repository's primary languages and canonical test/check commands;
- no application/test files or workflow state are modified;
- no quality run is created.

If delegation cannot be demonstrated, **do not start the full quality cycle**. Fix the Codex configuration first, or use the generic-child fallback explicitly and rerun the smoke test. This prevents spending a large usage window on a run whose Analyst cannot delegate implementation correctly.

The smoke test is an installation/runtime validation, not part of each periodic quality cycle. It does not need to be rerun before every maintenance run unless Codex or the agent configuration changed.

## 7. Preflight

Before baseline collection:

1. Verify the current working directory is the repository root (for example, `git rev-parse --show-toplevel` must resolve to the current directory), then read `AGENTS.md`, this file, `.code-quality/config.yaml`, `docs/architecture.md`, and any relevant contract documentation. If launched outside the repository root, stop `BLOCKED` with instructions to relaunch from the root rather than guessing paths.
2. Search for a resumable active run as defined in section 6. If one exists, verify it and resume from its recorded phase/`next_action`; do **not** create a new baseline.
3. If no resumable run exists, record `git rev-parse HEAD`, branch, and **pre-artifact** worktree status before creating `.code-quality/runs/<run>`. Use `git status --porcelain --untracked-files=all` and preserve whether the repository was clean at that moment.
4. If `require_clean_worktree` is true and unrelated uncommitted changes exist, end `BLOCKED` unless the user explicitly identifies those changes as part of the work. Generated `.code-quality/.tools`, `.tmp`, and the current run directory do not count as application/workflow dirtiness after the pre-artifact snapshot.
5. Run `npm ci` when dependencies are not already in the expected lockfile state.
6. Install isolated quality tooling:

   ```bash
   node .code-quality/scripts/ensure-tools.mjs
   ```

   For Deep mode:

   ```bash
   node .code-quality/scripts/ensure-tools.mjs --deep
   ```

   These tools live under `.code-quality/.tools/` and must not change application `package.json` or `package-lock.json`. If every configured package is already present at the exact requested version, `ensure-tools.mjs` must reuse the cache and exit without invoking `npm install`. Installation is only for missing/mismatched versions and is bounded by `CODE_QUALITY_NPM_INSTALL_TIMEOUT_MS` (default 180000 ms).
7. Create the run directory specified by `.code-quality/config.yaml`, using the date and baseline short SHA.
8. Initialize `state.json` immediately and pass the captured pre-artifact cleanliness explicitly, for example `--baseline-worktree-clean true`. This prevents the run's own untracked artifacts from making a clean baseline appear dirty. Then checkpoint `PREFLIGHT` before starting baseline checks.

If required tooling cannot be installed because the environment has no network and no cached copy exists, continue with available repository-native checks and end no better than `ACCEPTED_WITH_NOTES` unless all unavailable metrics are demonstrably non-material. Record the limitation explicitly.

## 8. Phase A — Baseline

Run repository-native checks before implementation. At minimum attempt all `required_checks` from config. Also attempt environment-dependent checks when the environment supports them.

Current important project checks include:

```bash
npm test
npm run test:cloudflare
find server/mysql-api -name '*.php' -print0 | xargs -0 -n1 php -l
bash server/mysql-api/tests/run.sh
npm run lint
npm run test:browser
npm run build:xpi
git diff --check
```

When recording Node test results, distinguish **executed test cases** from test files/top-level subtests and from static source declarations. Prefer the structured TAP summary captured in the metric snapshot under `coverage.components.<component>.test_execution` (`tests`, `suites`, `pass`, `fail`, `skipped`, etc.). `test_inventory.files` and `approximate_test_declarations` are inventory/context metrics only and must never be substituted for the executed test-case count. If a TAP execution summary is unavailable, report the count as unavailable rather than inferring it from console nesting.

If a required check already fails at baseline:

- determine whether failure is environmental or a real repository failure;
- record it exactly;
- do not let the worker silently “fix” an unrelated baseline failure unless the parent adds a task for it;
- final acceptance must compare like-for-like and cannot conceal a baseline failure.

Collect baseline metrics:

```bash
node .code-quality/scripts/collect-metrics.mjs \
  --output .code-quality/runs/<run>/00-baseline.json \
  --worktree-clean <captured-pre-artifact-true-or-false>
```

Do not edit `00-baseline.json` after implementation begins. If the collector itself is wrong, stop the run, fix the workflow tooling separately, and start a fresh run.

After baseline checks and metrics are recorded, checkpoint phase `BASELINE` with `next_action` set to analysis.

## 9. Phase B — Analysis

Create `01-analysis.md`. The analysis must be evidence-based and cover both deterministic metrics and source/history inspection.

Investigate at least:

- functions/files with high cognitive and cyclomatic complexity, including PHP cyclomatic outliers when PHP is present;
- p90/p95/max outliers, not only averages;
- duplicated production code;
- large or deeply nested responsibilities;
- dead/unreachable code and unused integration paths;
- dependency direction and cycles;
- modules that change together frequently;
- high-churn + high-complexity hotspots;
- trivial wrappers/delegators;
- interfaces/abstractions with one implementation where variability is not a real domain boundary;
- factories/builders/strategies/configurability that have no current or strongly evidenced need;
- abstractions that merely relocate complexity rather than reduce it;
- repeated provider-specific logic that should genuinely be shared;
- shared logic incorrectly duplicated across WebExtension contexts;
- tests that are exact behavioral duplicates, obsolete, implementation-detail-only, or fully subsumed by a stronger test;
- gaps where apparently “redundant” tests actually protect distinct contracts.

For every candidate, record:

- evidence (file/symbol/history/metric);
- why the complexity appears accidental or essential;
- impact: HIGH / MEDIUM / LOW;
- confidence: HIGH / MEDIUM / LOW;
- risk: LOW / MEDIUM / HIGH;
- expected improvement;
- likely verification method.

Do not invent a numeric “overengineering score”.

Maintain a complete candidate ledger during analysis. Every concrete improvement candidate considered by the Analyst must remain traceable through the end of the run, including candidates classified as document-only, rejected, environment-blocked, Deep-eligible-but-not-selected, or later reverted. This ledger is the source for the final `07-deferred-candidates.md`; do not silently drop a candidate merely because it fails the Standard implementation threshold.

After `01-analysis.md` is complete, checkpoint phase `ANALYSIS` before creating the plan.

## 10. Phase C — Plan

Create `02-plan.md`. In Standard mode, only auto-delegate candidates permitted by the conservative ranking policy in config. In Deep mode, the parent may additionally choose at most one bounded experimental candidate allowed by `candidate_ranking.deep_exploration`; mark it explicitly as experimental and include a whole-task revert criterion.

Every task must contain:

- stable ID (`Q-001`, `Q-002`, ...);
- objective;
- concrete files and symbols;
- observed problem/evidence;
- exact proposed change;
- why the change is simpler/better;
- protected contracts involved;
- risk assessment;
- expected metric/quality effect;
- required tests/checks;
- acceptance criteria;
- rollback note if the task is risky.

After `02-plan.md` is complete, checkpoint phase `PLAN` before delegating any implementation.

Bad task:

> Simplify the sync architecture.

Good task:

> `Q-004`: remove wrapper X because all three callers immediately delegate to Y, no provider capability is hidden by X, and Git history shows no alternate implementation. Update callers, delete wrapper-specific tests that are exact duplicates of Y's behavior tests, run A/B/C checks, and require no coverage/duplication regression.

The plan must not include style-only rewrites, broad renaming campaigns, speculative abstractions, or changes whose primary justification is improving a metric. A Deep experimental task is not permission for speculative architecture: it must still target concrete maintenance evidence and must be reverted if the benefit is unclear.

## 11. Phase D — Delegated implementation

Spawn `refactor_worker` and pass the complete approved plan or a clearly bounded subset. Prefer one worker session executing tasks sequentially when tasks touch overlapping code.

Worker rules are defined in `.codex/agents/refactor_worker.toml` and are mandatory even in fallback generic-worker mode.

Expected commit convention:

```text
refactor(Q-001): <short description>
test(Q-002): <short description>
cleanup(Q-003): <short description>
```

One logical task should produce one commit. A task may use more than one commit only when technically necessary and the handover explains why.

The worker must produce a structured handover. The parent records it in `03-implementation.md`; the worker does not decide the final state.

## 12. Test-deletion policy

Test reduction is allowed, but it has a higher evidence threshold than ordinary code cleanup.

A test may be removed only when the approved plan identifies a concrete rationale such as:

- exact behavioral duplicate;
- fully subsumed by a stronger parameterized/table-driven test;
- obsolete or unreachable behavior;
- implementation-detail assertion with no useful behavioral contract;
- testing third-party behavior rather than project behavior.

The following are never sufficient reasons by themselves:

- “the test is simple”;
- “coverage stays high”;
- “the test is long”;
- “the test makes the refactor harder”;
- “another test looks similar”.

After deletion, coverage must not regress without an explicit exception. When mutation testing is part of the run, mutation score must not regress.

## 13. Phase E — Independent review

After the worker finishes, the parent must independently:

1. inspect `git log <baseline>..HEAD`;
2. inspect the actual diff, preferably per task commit and cumulatively;
3. map every change to an approved task;
4. flag unplanned changes;
5. rerun task-specific tests;
6. rerun the repository checks relevant to touched boundaries;
7. rerun deterministic metrics and compare coverage only within the same execution component/harness;
8. assess architecture/readability and whether any metric gaming occurred;
9. verify test deletions against the stated rationale;
10. confirm no protected contract changed unintentionally.

Create `04-review.md` with findings ordered by severity.

Worker claims such as “all tests pass” or “complexity decreased” are evidence to verify, not facts to trust.

After each independent review, checkpoint phase `REVIEW`, update `last_verified_commit`, and record the next action (`CORRECTION`, `FINAL_MEASUREMENT`, or terminalization).

## 14. Phase F — Correction loop

If the review finds material problems:

1. produce a precise correction section in `04-review.md` or a new correction subsection;
2. delegate only those corrections to the worker;
3. wait for completion;
4. independently review again.

Maximum automatic correction cycles: value from config (currently 3).

After the limit:

- `NEEDS_FURTHER_WORK` if material fixable problems remain;
- `BLOCKED` if an external/environmental constraint prevents a defensible conclusion.

Checkpoint `CORRECTION` before every correction delegation and increment `correction_cycle`. After the correction worker returns, checkpoint again before re-entering independent review.

Do not continue indefinitely.

## 15. Phase G — Final measurement

When the implementation is review-ready, first record the exact code commit being measured. `head_commit` is operational state; `measured_commit` is the explicit commit to which `05-final.json` applies. Artifact-only commits created later must not be confused with the measured code commit. Then collect final metrics:

```bash
node .code-quality/scripts/collect-metrics.mjs \
  --output .code-quality/runs/<run>/05-final.json
```

Generate the automated comparison:

```bash
node .code-quality/scripts/compare-metrics.mjs \
  .code-quality/runs/<run>/00-baseline.json \
  .code-quality/runs/<run>/05-final.json \
  .code-quality/runs/<run>/06-report.md
```

The comparison script is not the final verdict. The parent must extend `06-report.md` with qualitative review, unavailable metrics, contract verification, task summary, and terminal state.

Checkpoint `FINAL_MEASUREMENT` after `05-final.json` using `--commit <measured-sha> --measured`. After `06-report.md`, create `07-deferred-candidates.md` from the complete candidate ledger and the final implementation/review outcome. Only then checkpoint `REPORT`. Final reports should label baseline/final SHAs as **measured commits**. Artifact-only commits created after measurement are outside the metric comparison. Finally call `workflow-state.mjs finish` with the chosen terminal state.

`07-deferred-candidates.md` is required even when there are no deferred candidates. It exists to make Analyst restraint inspectable without weakening Standard-mode safety. Include every candidate considered during the run that is **not present as an accepted change in the final measured commit**. For each candidate, record:

- candidate ID and concise title;
- final disposition: `DOCUMENT_ONLY`, `REJECTED`, `DEFERRED`, `BLOCKED_BY_ENVIRONMENT`, `DEEP_NOT_SELECTED`, or `EXPERIMENT_REVERTED`;
- affected files/symbols;
- evidence and proposed improvement;
- expected engineering benefit;
- why it was not implemented or not retained;
- impact / confidence / risk;
- what additional evidence, environment, or design condition would make it eligible later;
- required verification if attempted;
- Deep-mode suitability: `YES`, `NO`, or `CONDITIONAL`, with a short rationale.

Rank entries by expected engineering value for human review, independently of whether Standard mode allowed automatic delegation. This ranking is informational only and must not retroactively authorize implementation. If no such candidates exist, write an explicit `No deferred candidates` entry rather than omitting the file.

## 15.1 Touched-boundary validation

Environment-dependent checks are evaluated against the files actually changed, not as a single global all-or-nothing flag.

For MySQL/PHP specifically:

- if `server/mysql-api/**` or `server/http-contract.mjs` changed, fresh full disposable-MySQL 8.4 endpoint integration is **required** before `ACCEPTED`; if the required environment is unavailable, end `BLOCKED` rather than silently accepting;
- if those paths did not change, unavailable local MySQL 8.4 integration may produce `ACCEPTED_WITH_NOTES` when deterministic PHP checks pass and the change is demonstrably unrelated;
- existing historical CI is context, not a substitute for fresh evidence when the MySQL boundary itself changed.

Apply the same principle to other protected boundaries: stronger validation follows the touched behavior.

## 16. Quality gates

### Must pass

- required tests/checks appropriate to the touched areas;
- protected behavior/contracts unchanged unless explicitly planned;
- no unexplained implementation outside plan scope.

### Must not regress

When measured comparably:

- duplication percentage;
- extension-unit line coverage percentage;
- Cloudflare line coverage percentage when collected comparably in both snapshots;
- cognitive complexity p95 and max;
- JS cyclomatic complexity p95;
- PHP cyclomatic complexity p95 when collected comparably;
- dependency cycles;
- mutation score in Deep runs.

A tiny numerical regression may be accepted only if the parent documents a concrete compensating benefit and explains why the metric is misleading in that case. Never hide the regression.

### Desired improvement

Prefer improvement in:

- total cognitive/cyclomatic complexity;
- duplicated lines;
- dead code;
- excessive nesting;
- coupling/change hotspots;
- unnecessary layers and indirection;
- maintenance burden of low-value tests.

### Context only

Do not optimize these blindly:

- LOC;
- file count;
- function count;
- class/interface count;
- test count.

Reducing them can be useful, but an increase can also be correct.

## 17. Anti-metric-gaming review

The parent must explicitly check whether a change only moved complexity around. Examples:

- splitting one understandable function into many tiny wrappers just to reduce max complexity;
- replacing straightforward conditionals with a class hierarchy;
- creating generic infrastructure for a single real use case;
- deleting tests solely to reduce test LOC;
- hiding duplication behind indirection that is harder to understand;
- combining unrelated responsibilities to reduce file/class counts.

A metric improvement that worsens comprehension or architecture is not a quality improvement.

## 18. Stopping rule

Stop changing code when all of the following are true:

- required acceptance criteria pass;
- no HIGH-priority, HIGH-confidence issue remains with favorable benefit/risk;
- remaining MEDIUM/LOW opportunities are speculative, cosmetic, risky, or low-value;
- another iteration would mainly reshuffle code or optimize metrics rather than reduce maintenance risk.

It is valid for analysis to conclude that no further changes are justified.

## 19. Terminal states

### ACCEPTED

All required checks/gates pass, protected contracts are preserved, delegated work is complete, no material review findings remain, and final evidence supports the changes.

### ACCEPTED_WITH_NOTES

Core acceptance criteria pass, but a non-material limitation remains. An unavailable environment-dependent check is acceptable here only when the touched-boundary rules say that check was not required for the actual change. Notes must be explicit.

### NEEDS_FURTHER_WORK

The repository remains usable, but material fixable issues remain after the correction budget or the result does not satisfy the quality gates.

### BLOCKED

The process cannot reach a defensible conclusion due to an external constraint such as unavailable required environment, unresolved baseline failure, unsafe dirty worktree, or missing authorization.

## 20. Run artifacts

Each run is versioned under:

```text
.code-quality/runs/YYYY-MM-DD-<baseline-short-sha>/
├── state.json
├── 00-baseline.json
├── 01-analysis.md
├── 02-plan.md
├── 03-implementation.md
├── 04-review.md
├── 05-final.json
├── 06-report.md
└── 07-deferred-candidates.md
```

`state.json` is the machine-readable checkpoint/resume record. `01-analysis.md`, `02-plan.md`, `03-implementation.md`, `04-review.md`, `06-report.md`, and `07-deferred-candidates.md` should cite repository files/symbols/commits precisely enough that a later maintainer can reconstruct why each decision was made. `07-deferred-candidates.md` is a transparency artifact, not an implementation queue: its contents do not authorize future edits without a new run/plan decision.

If a run is interrupted, starting the workflow again must first resume the active run rather than create a duplicate run directory.

## 21. Periodic use

For normal periodic maintenance, start a Sol High Codex session at the repository root and use the prompt in `.code-quality/prompts/run-quality-cycle.md` (or simply ask: `Run the full repository code-quality cycle.`). The same command resumes an interrupted compatible run automatically; `Resume the interrupted code-quality cycle.` is an equivalent explicit instruction.

The resulting historical run directories allow future analysis of trends instead of only one before/after comparison. Historical metrics should never override current correctness evidence, but they are useful for detecting gradual growth in complexity, duplication, dependencies, or test burden.

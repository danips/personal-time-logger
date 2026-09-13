Run or resume the full repository code-quality cycle defined by `.code-quality/PROCESS.md` and `.code-quality/config.yaml`.

Act as the Quality Analyst / Architect for the entire run. You own the process from preflight/baseline through final verdict. Do not edit application production code or tests yourself.

Canonical execution is Codex CLI from the repository root. Before doing anything else, verify the current working directory is the Git repository root. If it is not, end `BLOCKED` and instruct the caller to relaunch Codex from the repository root; do not infer or silently change the intended repository.

This workflow is NON-INTERACTIVE once started:
- Do not stop between phases to ask whether to continue.
- Do not ask for confirmation before implementing an already approved plan, reviewing worker changes, running correction cycles, or producing final metrics.
- Use conservative documented defaults for non-essential ambiguity.
- If a required authorization/decision is unavailable and cannot be handled safely, checkpoint the run, end `BLOCKED`, and explain the blocker instead of pausing for user supervision.

Before creating a new run, search for an `IN_PROGRESS` run with `.code-quality/scripts/workflow-state.mjs active`. If exactly one compatible run exists, verify its branch/baseline/HEAD/worktree and RESUME from `state.json` rather than recalculating completed phases. Never overwrite an existing immutable baseline.

Persist `.code-quality/runs/<run>/state.json` throughout the workflow. Checkpoint after every major phase, before/after every worker handoff, after each worker task commit, after each independent review, and before/after each correction cycle. The workflow must be recoverable after context loss, quota exhaustion, IDE restart, or worker interruption.

For a new run, use the repository's deterministic checks and metrics to establish the baseline. Analyze the codebase for accidental complexity, overengineering, unnecessary abstraction/indirection, duplication, dead code, architecture/coupling problems, oversized or deeply nested code, and low-value/redundant tests. Distinguish essential Firefox/WebExtension, persistence, synchronization, concurrency, and remote-provider complexity from accidental complexity. Maintain a complete candidate ledger: every concrete candidate considered must remain traceable even when it is rejected, document-only, blocked by environment, eligible for Deep but not selected, or later reverted.

Create an evidence-based, prioritized implementation plan. Every task must contain a task ID, concrete files/symbols, evidence, proposed change, benefit, risk, expected metric/quality impact, required tests, and acceptance criteria. In Standard mode, delegate only HIGH-confidence changes with a favorable benefit/risk ratio. In Deep mode, you may additionally select at most one bounded MEDIUM-confidence/MEDIUM-or-lower-risk experimental refactor allowed by config; require a whole-task revert if the benefit is unclear.

Delegate implementation to the `refactor_worker` subagent and wait for it to finish. If that project custom agent is unavailable in this Codex build, spawn a generic implementation subagent instead, using the configured Luna High defaults, and pass it the worker contract from `.codex/agents/refactor_worker.toml`. Use only one implementation worker at a time and do not allow recursive delegation. Pass the active `state.json` path to the worker so it can checkpoint each task commit.

After implementation, independently inspect the actual commits/diff, determine which protected boundaries were touched, rerun the required scope-sensitive checks, recalculate component-scoped metrics, and compare results against the immutable baseline. Do not trust the worker's self-reported validation without independent verification. Update `last_verified_commit` only after your own review.

If material problems, regressions, incomplete tasks, or unjustified changes remain, create a correction plan and delegate it to a fresh/continued implementation worker. Repeat review -> correction -> review automatically, up to the configured correction-cycle limit.

If execution is interrupted while a worker has uncommitted application changes, do not discard them automatically. On resume, inspect and reconcile them against the pending task; if they cannot be mapped safely to the run, end `BLOCKED`.

Stop when acceptance criteria are satisfied and no remaining high-priority, high-confidence improvement has a favorable benefit/risk ratio; or when the correction-cycle limit or an external blocker is reached. Do not continue with cosmetic, speculative, or metric-gaming refactors.

Produce and version all run artifacts required by the process, including `state.json`, baseline metrics, analysis, plan, implementation handover, review, final metrics, before/after report, and `07-deferred-candidates.md`. The deferred-candidates artifact must include every considered candidate that is not present as an accepted change in the final measured commit, with its disposition, evidence, benefit, rejection/defer reason, impact/confidence/risk, future eligibility conditions, verification requirements, and Deep-mode suitability. Rank it for human review by expected engineering value; it is informational and does not authorize implementation. Record the exact `measured_commit` before final metrics so later artifact-only commits cannot be confused with the code state that was measured.

Finish by finalizing `state.json` and returning exactly one terminal state: `ACCEPTED`, `ACCEPTED_WITH_NOTES`, `NEEDS_FURTHER_WORK`, or `BLOCKED`, with the evidence for that state.

- When reporting Node test counts, use structured TAP execution counts from the metrics; never infer executed tests from file/subtest nesting.

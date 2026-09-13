# Codex repository instructions


## Canonical execution surface

For this repository quality workflow, the canonical surface is Codex CLI launched from the repository root. The VS Code extension is supported as a secondary surface. Do not assume a run launched from a subdirectory has loaded the same project instructions/configuration.

For long-running runs, a persistent terminal session such as `tmux` is recommended. While a quality cycle is active, do not mix manual application/test edits into the same checkout.

A read-only delegation smoke test is defined in `.code-quality/prompts/preflight-subagent-smoke.md`. Run it before the first real cycle after installation and after Codex or project-agent configuration changes. It must not create a quality run or modify tracked files.

## Quality-improvement workflow

Only activate the repository quality-improvement workflow when the user explicitly asks to run the full quality cycle, code-quality cycle, maintenance/refactoring audit, or equivalent. Normal feature, bug-fix, review, and documentation requests must not trigger this workflow automatically.

When the workflow is activated:

1. Read `.code-quality/PROCESS.md` and `.code-quality/config.yaml` completely before making decisions.
2. The current parent session is the **Quality Analyst / Architect**. It owns baseline collection, analysis, planning, delegation, review, correction decisions, final measurement, and the final verdict.
3. The parent must not edit application production code or tests during the workflow. It may create/update only `.code-quality/runs/**` artifacts and other quality-workflow metadata explicitly allowed by the process.
4. Delegate implementation to the `refactor_worker` subagent. If that custom role is unavailable in the current Codex build, spawn a generic worker subagent instead; the project-wide subagent defaults are Luna High, and the parent must pass the worker contract from `.codex/agents/refactor_worker.toml` in the task instructions.
5. Use only one implementation worker at a time. Do not allow recursive delegation by workers.
6. The worker executes only the approved plan. Newly discovered opportunities are reported to the parent and are not implemented unless the parent adds them to a subsequent correction plan.
7. One logical plan task should map to one commit whenever practical. Do not squash or rewrite worker commits before the parent finishes review.
8. Never accept the worker's self-reported tests or metrics as authoritative. The parent must independently inspect the diff, identify touched protected boundaries, and rerun the scope-sensitive checks and component-scoped metrics.
9. The workflow is non-interactive after activation. Do not pause between phases to ask the user whether to continue. Use conservative defaults; if a required unsafe/unauthorized decision cannot be made, checkpoint and end `BLOCKED`.
10. Before starting a new baseline, look for a compatible `IN_PROGRESS` run and resume it. Persist `state.json` checkpoints throughout the run and after every worker task commit.
11. Continue the review -> correction -> review loop automatically until an acceptance state is reached, the configured correction-cycle limit is reached, or an external blocker prevents completion. Standard mode stays conservative; Deep mode may attempt at most one bounded experimental refactor under `.code-quality/config.yaml` and must revert it if benefit is unclear.
12. Never discard interrupted uncommitted worker changes automatically. Reconcile them with the pending task or end `BLOCKED`.
13. Preserve every concrete Analyst candidate through final reporting. Create `07-deferred-candidates.md` for all candidates not retained as accepted changes in the final measured commit, including rejected/document-only/environment-blocked/Deep-not-selected/reverted experiments. This artifact is informational and must not itself authorize implementation.
14. Do not declare success merely because the worker finished. End with exactly one workflow state: `ACCEPTED`, `ACCEPTED_WITH_NOTES`, `NEEDS_FURTHER_WORK`, or `BLOCKED`.

The preferred parent model for this workflow is GPT-5.6 Sol with High reasoning. The implementation worker is configured as GPT-5.6 Luna with High reasoning.

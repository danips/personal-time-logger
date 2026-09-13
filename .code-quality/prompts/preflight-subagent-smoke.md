# Read-only subagent delegation smoke test

Run a READ-ONLY preflight for the repository quality workflow. Do **not** start the quality cycle, do not create `.code-quality/runs/**`, do not modify tracked files, and do not commit anything.

You are the parent Analyst session. First verify that the current working directory is the Git repository root and that `AGENTS.md`, `.codex/config.toml`, `.codex/agents/refactor_worker.toml`, `.code-quality/PROCESS.md`, and `.code-quality/config.yaml` are readable.

Then verify delegation:

1. Delegate one read-only task to the `refactor_worker` custom subagent.
2. If that named role is unavailable, use the documented generic child-agent fallback with the configured GPT-5.6 Luna / High defaults and pass the worker contract from `.codex/agents/refactor_worker.toml`.
3. Ask the child only to inspect the repository and return:
   - primary implementation languages;
   - the main repository test/lint/build commands it can identify;
   - confirmation that it made no edits.
4. Wait for the child to return and independently check `git status --porcelain` afterward.
5. Do not repair or clean any pre-existing worktree changes. Compare before/after status and ensure the smoke test itself added no changes.

Return `SUBAGENT_PREFLIGHT_OK` only if delegation occurred, control returned to the parent, the answer is plausible for this repository, and the smoke test introduced no filesystem changes. Otherwise return `SUBAGENT_PREFLIGHT_FAILED` with the exact reason and do not start the quality workflow.

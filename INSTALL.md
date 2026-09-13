Workflow overlay version: **v1.3**.

# Install this workflow into personal-time-logger

**Canonical runtime:** Codex CLI, launched from the repository root. The VS Code extension remains supported, but CLI is the reference path for this workflow.

Copy the contents of this overlay into the repository root, preserving paths.

Example from the parent directory of `personal-time-logger`:

```bash
cp -a code-quality-workflow-v1/AGENTS.md personal-time-logger/
cp -a code-quality-workflow-v1/.codex personal-time-logger/
cp -a code-quality-workflow-v1/.code-quality personal-time-logger/
```

Then, from the repository root:

```bash
node .code-quality/scripts/ensure-tools.mjs
node .code-quality/scripts/collect-metrics.mjs --output /tmp/quality-smoke.json
```

Before the first real run, validate subagent delegation with the read-only prompt in `.code-quality/prompts/preflight-subagent-smoke.md`. Repeat that smoke test after a Codex upgrade or changes to `.codex/config.toml` / `.codex/agents/**`. It must complete without modifying tracked files.

For the first real run, start Codex CLI from the repository root with GPT-5.6 Sol and High reasoning for the parent session:

```bash
tmux new -s code-quality
cd /path/to/personal-time-logger
codex
```

If you do not use `tmux`, `cd` to the repository root and run `codex` directly. Then paste `.code-quality/prompts/run-quality-cycle.md` or say `Run the full repository code-quality cycle.`

You may keep VS Code open for passive inspection, but do not manually edit application/test files in the same checkout while the cycle is active.

The cycle is non-interactive after it starts and writes a resumable `state.json`. If Codex, the IDE, or your usage window interrupts execution, start a new Sol High session and say `Run the full repository code-quality cycle.` or `Resume the interrupted code-quality cycle.` The workflow first searches for a compatible `IN_PROGRESS` run and continues from its last checkpoint rather than creating a new baseline.

If the terminal window or SSH connection disappears but the `tmux` session remains alive, reconnect with:

```bash
tmux attach -t code-quality
```

Inspect the active checkpoint with:

```bash
node .code-quality/scripts/workflow-state.mjs active --branch "$(git branch --show-current)"
```

The isolated quality-tool installation is ignored by `.code-quality/.gitignore`; the workflow definition and generated `.code-quality/runs/**` reports, including final `state.json` and `07-deferred-candidates.md`, are intended to be committed.

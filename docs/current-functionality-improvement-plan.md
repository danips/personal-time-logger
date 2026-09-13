# Current functionality improvement plan

Reviewed: 2026-09-12 · Baseline: `3a1f13f` · Extension manifest: `0.1.76`

Status: core implementation complete; session progress and explicitly authorized follow-ups are tracked in the ledger and handoff log below.

## Start here for an implementation session

Target implementer: **GPT-5.6 Luna, Medium reasoning**, in separate sessions with no conversation history. This single document contains the findings (F01–F22), simplification recommendations (S01–S10), test audit, execution rules, work cards, and progress records. No previous chat or deleted historical plan is required.

The findings define the intended outcomes; the work cards define execution order and session boundaries. Execute one eligible card per implementation session, treating child cards as separate steps. Broad delivery phases are not individual sessions. Optional improvements remain conditional, and investigation cards must establish evidence before their dependent implementation begins. Consolidating this document does not start implementation or authorize deployment.

Navigate directly to the sections needed for the current session:

- [Reusable session prompt](#copyable-session-instruction)
- [Startup and completion protocol](#startup-and-completion-protocol)
- [Settled defaults and protected contracts](#settled-defaults-and-protected-contracts)
- [Check commands and environment](#check-commands-and-environment)
- [Scope and review baseline](#scope-and-assessment)
- [Functional improvements](#functional-improvements)
- [Overengineering and simplification review](#overengineering-and-simplification-review)
- [Test audit](#test-audit-remove-merge-replace-or-keep)
- [Delivery order and acceptance](#delivery-order-and-acceptance)
- [Work cards](#work-cards)
- [Conditional register](#conditional-register)
- [Session ledger](#session-ledger)
- [Decision log](#decision-log)
- [Handoff log](#handoff-log)

## Copyable session instruction

Paste the same prompt into each new implementation session:

```text
Complete the next eligible unfinished step in docs/current-functionality-improvement-plan.md.

Read the startup protocol, settled defaults, session ledger, and latest handoff. Resume any partially completed step first; otherwise select the next step whose dependencies are complete. Treat child cards as separate steps.

Read the selected step's referenced findings in this same document and inspect the current code. Complete only that step, including implementation, required tests, and documentation. Preserve unrelated work.

Before finishing:
- Update the ledger and only the finding checkboxes actually completed.
- Append a self-contained handoff recording changes, decisions, exact validation results, and remaining limitations.
- Identify the next eligible step and its first concrete action.

If blocked, record the precise blocker and leave the step incomplete. Never mark missing validation as passed.

Stop after this one step. Do not begin the next step, commit, push, or deploy.
```

To select a particular card, replace “the next eligible unfinished step” with its ID. The model/reasoning selection is made by the person launching the session; this document does not change it. Use one agent; delegation is not required.

## Startup and completion protocol

### Start every session

1. Run `pwd`, `git status --short`, and `git diff --stat`; inspect applicable `AGENTS.md` instructions. All commands below run from the repository root. Do not reset, clean, restore, stage, or commit existing work as part of startup.
2. Read this protocol, the settled defaults, the latest handoff entries, and the selected card. Read only the corresponding F/S findings and named source/tests next; do not load the entire repository or all historical plans.
3. Select the first unfinished card whose dependencies are **done**. `needs-validation` is not done. A card explicitly marked `conditional` is eligible only when its written trigger is met. If a prior session is in progress, resume its recorded next step before starting another.
4. Read actual callers and named functions with `rg` before editing. Paths and baseline failures describe the review checkout, not a permanent truth. For storage/sync changes read `docs/architecture.md`; for time changes read `docs/time-model.md`; for provider/API changes also read `docs/remote-api-v1.md`.
5. Run the card's focused baseline checks. Record an existing failure separately from any failure introduced by this session. Reuse dependencies already installed; use the lockfile and normal permission flow if required tooling must be installed. Do not call production services.
6. Update the ledger row to `in-progress`, record the starting revision and relevant worktree changes, then perform the numbered tasks in order. A “read/edit” path identifies the likely boundary, not permission for unrelated cleanup in that file.

### Finish every session

1. Check observable behavior against the card's exit criteria and its linked finding. For correctness fixes, add a focused regression that fails for the old behavior and passes after the change. Do not invent tests for prose edits or one-line unused-field removal; update the meaningful existing coverage instead.
2. Run the named test groups and required gates below. Record exact commands, exit/result counts, and any unavailable prerequisite. Do not treat a mocked check as a Firefox or real-database pass.
3. Inspect the diff, `git diff --check`, and every new file. When a new extension module is added, check packaging as described below. Preserve unrelated edits/deletions and pre-existing untracked documents.
4. Set the ledger state and append the handoff template. Update only the finding checkboxes actually satisfied; a card may complete one part of a larger finding. Do not mark F04 complete after implementing only its ledger model, for example.
5. Leave the next session a concrete starting action, file/function, test to run, and any settled decision. Do not rely on a chat summary as the only handoff. No commit, push, release, remote migration, or deployment is part of these cards unless separately requested.

### Scope, failure, and resume rules

- States: `todo`, `in-progress`, `needs-validation`, `blocked`, `done`, `not-applicable`. These are document statuses, not tool-managed goals. `done` requires the card's exit checks. `not-applicable` requires a concrete inspected reason, not “too hard” or “no time.”
- If a required browser/backend prerequisite is absent, finish safe independent code/review work, record `needs-validation`, and name the exact command/environment needed. A later session may validate that card or pick another dependency-independent card. Never claim the overall plan complete while such rows remain.
- If a task spans more than one coherent production boundary, split it into numbered child cards here **before** implementing the larger change. Each child needs read/edit paths, one deliverable, tests, dependencies, and exit criteria. Parent completion requires all children. Do not build an entire L-sized feature in one session.
- A newly discovered unrelated issue becomes a short follow-up entry with evidence, not extra work in the active card. If it invalidates the active design, write the contradiction and a concrete next step; do not silently change storage/protocol semantics.
- Use the settled defaults for ordinary implementation choices. Only request user input when a material product requirement or destructive external action cannot be resolved from the requested scope. Routine reversible local edits do not require another approval.

## Settled defaults and protected contracts

These defaults resolve the review's open implementation choices for the initial delivery. Change one only when code evidence shows it cannot meet an acceptance criterion; record the reason and replacement in the handoff.

1. **Keep the stack and ownership.** Vanilla JavaScript modules, no new runtime framework/dependency, IndexedDB as local authority, network outside transactions. UI actions show committed local changes without awaiting remote success. Preserve revision/fingerprint checks, lease generations, migration ownership, and provider-bound references.
2. **Tempo daily rounding.** For each entry separately, clip to the displayed week, split into at most seven civil-day allocations, and calculate their exact effective seconds. Let that entry's weekly integer target be `ceil(sum(exact day seconds))`, preserving the existing per-entry weekly rounding policy. Floor each day, distribute the remaining seconds by descending fractional remainder with date order as tie-breaker, then apply selected-day filtering. Omit zero-second worklogs. The same date receives the same integer allocation whether sent alone or with the whole week. Never recalculate rounding only over selected days or redistribute seconds between different entries. Cover floating-point boundary cases deliberately. Update time-model D-04 because splitting changes its existing policy.
3. **Portable backup compatibility.** Prefer retaining schema v1 and exporting canonical entry values with normalized transport bookkeeping (`dirty: false`, empty sync metadata) from one coherent local snapshot, even when the source entry is dirty. This normalization affects the exported copy only; the live record must remain dirty. New IDs become dirty on restore regardless of export state. Do not import credentials, provider bindings, leases, reconciliation intents, or Tempo send claims. If inspection shows the current parser cannot safely accept this existing shape, document and test a versioned format before changing it; continue reading v1.
4. **Restore policy.** Merge by ID; differing existing records are conflicts, not replacements. Preview defaults to restoring entries, with an explicit checkbox for allowed settings/appearance. Capture the choice and recheck inside the atomic commit. Use the existing sync/migration exclusion mechanism around local restore, with no remote preflight. Report local results and follow-up sync status separately. No streaming importer in this first delivery.
5. **Tempo ledger scope.** Same-profile duplicate protection, not distributed exactly-once delivery. Version its record shape; identify work by canonical entry fingerprint, local date/allocated seconds, issue ID, author, and the fixed Tempo destination. Keep the fingerprint in a local ledger, never in diagnostics. A missing HTTP response is `unknown`, not `failed`; only a response whose contract proves no work was committed is a safely retryable rejection. Persist pending claims before dispatch, acknowledgements per chunk, and never automatically replay pending/unknown claims after restart. Do not purge acknowledgement evidence silently or include it in portable backups. Work sent before this feature has no reliable ledger: explicitly report its history as unknown; do not label every old entry “never sent.”
6. **UI defaults.** Preserve current task-only Tempo mappings, browser-local timezone, selected multiplier behavior, merge semantics, and active-timer drag prohibition. Prefer existing editor/forms, a small inline preview, bounded lists, and ordinary buttons over a new UI system. Calendar editing offers the keyboard equivalent; it need not recreate pointer gestures with arrow keys.
7. **Deferred options.** No notifications, automatic stopping, split-at-time editing, project+task mapping migration, multiple saved backend profiles, delta API, partitioning, dual-token rotation, or new settings sync in the initial cards. They remain visible proposals with triggers in the conditional register below, not silently implemented scope.
8. **Tombstone policy is a discovery dependency.** Do not remove deletion protection or assume remote absence means deletion. R06 must choose and document a compatibility-safe policy before R07 is eligible. It must distinguish upgraded devices from older clients capable of purging records. A local-only fix cannot promise convergence when another client deletes all shared evidence.
9. **Test pruning.** Delete a useless case only after identifying its actual replacement or documenting that it asserts no behavior. Keep all independent race schedules, wire/storage contracts, security boundaries, and real-engine tests. Do not derive an expected result with the same production function under test.

Current scope update (2026-09-13): The user explicitly requested the
previously conditional F05, F07, and F08 follow-up work. Project+task Tempo
mapping, opt-in stale-timer reminders, and conflict-safe bounded edit undo are
implemented and validated in the final follow-up handoff. Split-at-time was
evaluated and remains deferred because no demonstrated workflow requires
automatic interval surgery. The original defaults remain the baseline for all
other conditional proposals.

## Check commands and environment

Cards name the groups below; execute the full command, not just one convenient test in it. If a test file was intentionally removed by an earlier card, use its recorded replacement and update this catalog. Add new regression files to the applicable group. No dedicated test file is required when a current suite owns the regression.

For additional individual test files named in a card, run `node --experimental-global-webcrypto --test` followed by those exact paths. UI checks require the actual feature scenario, not only a generic page-readiness assertion.

| Group | Command from repository root |
| --- | --- |
| PACKAGE | `node --experimental-global-webcrypto --test test/package.test.js test/create-update-site.test.js` |
| ACTION | `node --experimental-global-webcrypto --test test/action-runner.test.js test/options-storage-ui.test.js test/popup-render-state.test.js` |
| TEMPO | `node --experimental-global-webcrypto --test test/tempo.test.js test/tempo-day-selection.test.js test/time-allocation.test.js` |
| BACKUP | `node --experimental-global-webcrypto --test test/backup.test.js test/options-settings.test.js test/atomic-entries.test.js test/storage-migration.test.js` |
| SYNC | `node --experimental-global-webcrypto --test test/sync-maintenance.test.js test/sync-pull.test.js test/sync-acknowledgement.test.js test/sync-lease-fence.test.js test/sync-coalescing.test.js test/sync-config.test.js test/sync-cloudflare-recovery.test.js test/tombstone-policy-investigation.test.js` |
| ENTRY | `node --experimental-global-webcrypto --test test/entries.test.js test/atomic-entries.test.js test/entry-form.test.js test/entry-editor.test.js test/time.test.js test/calendar-layout.test.js test/calendar-gesture-state.test.js` |
| HISTORY | `node --experimental-global-webcrypto --test test/db.test.js test/popup-recent-groups.test.js test/analytics.test.js test/analytics-period.test.js test/time-allocation.test.js` |
| PROVIDER | `node --experimental-global-webcrypto --test test/remote-provider.test.js test/remote-cloudflare-d1.test.js test/remote-versioned-mutations.test.js test/storage-migration.test.js test/reconciliation-intent.test.js test/reconcile.test.js test/provider-setup-controller.test.js` |
| USAGE | `node --experimental-global-webcrypto --test test/chatgpt-usage-service.test.js test/chatgpt-structure.test.js test/codex-usage.test.js test/bounded-json.test.js` |
| AUTH | `node --experimental-global-webcrypto --test test/auth-session-store.test.js test/auth-refresh.test.js test/api-auth-retry.test.js test/multi-context.test.js` |
| DB | `node --experimental-global-webcrypto --test test/db.test.js test/db-dirty-migration.test.js test/db-open-lifecycle.test.js test/fake-indexeddb.test.js test/fixtures.test.js test/google-api-mock.test.js test/runtime-barriers.test.js` |

Gates applied at the end of a card, in addition to its focused group:

- **JS:** `npm test`, `npm run lint:js`, `git diff --check`. Use for JavaScript changes, including test-only changes. Run once after the final change, not after each edit.
- **UI:** JS plus `npm run test:browser`. Requires Firefox, geckodriver, and zip; respect `FIREFOX_BINARY` and `GECKODRIVER_BIN`. Add the card's scenario to the existing smoke where necessary; the current generic smoke passing does not prove a new feature's acceptance criterion.
- **PACKAGE-GATE:** `npm run lint:extension` and PACKAGE, plus import/asset inspection of the prepared package. `npm run build:xpi` when changing build/package behavior. Inspect every newly added runtime module because preparation uses `git ls-files`: new untracked files will not enter the archive. Use a disposable Git index/object directory to include only the session's runtime files for validation, without changing the user's index. Record the procedure and included paths. Never use `git add .` as a test workaround.
- **PHP:** `php server/mysql-api/tests/config_test.php`, `php server/mysql-api/tests/validator_test.php`, and `php -l` for each modified PHP file. Pure configuration changes do not need a real database; API/schema changes additionally require MYSQL.
- **MYSQL:** `bash server/mysql-api/tests/run.sh` with `pdo_mysql`, a verified disposable MySQL 8.4 schema, and the documented `PTL_TEST_MYSQL_*` variables. Read `server/mysql-api/tests/README.md` first. The runner can skip integration if variables are absent; inspect output and do not count a skip as passed. Never set `PTL_TEST_MYSQL_ALLOW_RESET=1` for an existing personal/production database.
- **D1:** `npm run test:cloudflare`; requires the locked dependencies under `server/cloudflare-d1` and local Worker/D1 execution. No deployment or remote D1 command is needed.
- **DOC:** `git diff --check`, verify all relative Markdown links and named current paths, and review claims against source. No application test rerun is necessary for prose-only edits.

### Temporary package index recipe

Use this only when intended runtime files are still untracked. First list the exact new extension paths from this and earlier handoff entries. Copy the current Git index into a temporary directory, preserving the user's staged set. Use a separate object directory for any temporary staging:

```bash
task_package_dir="$(mktemp -d /tmp/ptl-package-check.XXXXXX)"
task_real_index="$(git rev-parse --path-format=absolute --git-path index)"
task_real_objects="$(git rev-parse --path-format=absolute --git-path objects)"
mkdir "$task_package_dir/objects"
cp "$task_real_index" "$task_package_dir/index"
```

In a subshell, set `GIT_INDEX_FILE` to that copied index, `GIT_OBJECT_DIRECTORY` to the temporary objects directory, and `GIT_ALTERNATE_OBJECT_DIRECTORIES` to the real objects directory. Run `git add --` with **only the explicit intended new runtime paths**, then run PACKAGE and the relevant package/lint/build commands within that same subshell so their child processes inherit the temporary environment. Do not run those `git add` commands before setting all three variables. If the real index does not exist, initialize the temporary index with `git read-tree HEAD` under the same environment instead of copying it.

Afterward, verify ordinary `git status --short` still shows the original index state, inspect archive assets, and record the temporary directory and admitted paths in the handoff. Never copy the temporary index back. This procedure validates inclusion, not permission to commit the runtime files.

Initial checkout facts: manifest `0.1.76`, review revision `3a1f13f`, and a stale package expected-file list causing one of 75 test files to fail. Four packaged modules were absent from the expected list (see F22). Two old plan files are already deleted in the worktree; leave those deletions alone. Both pre-existing untracked product-gap/MySQL-plan documents must remain untouched. Recheck these facts; do not recreate a historical failure that has since been fixed.

## Scope and assessment

This is a new review of the current implementation: timer and entry editing, history, calendar, analytics, synchronization, reconciliation, provider setup/migration, backups, Tempo, ChatGPT usage, appearance, diagnostics, packaging, and tests. It is a prioritized backlog, not an instruction to implement everything at once. Application code and tests were not changed during this review.

The application already has substantial data-integrity protection. Its main opportunities are recovery without a working backend, correct and recoverable Tempo exports, clearer existing workflows, and removing tests/abstractions that imply more protection than they provide. A framework rewrite or a new synchronization engine would increase the work without addressing these problems.

Evidence labels:

- **Reproduced:** exercised locally during this review.
- **Observed:** directly visible in the current implementation; not necessarily a defect.
- **Risk:** inferred failure path requiring a focused reproduction before changing behavior.
- **Proposal:** improvement to an existing feature, not a claim that it is broken.

Priorities: **P1** correctness, recovery, or a failing gate; **P2** meaningful usability/maintenance improvement; **P3** optional improvement justified by use or measurement. Effort: **S** localized change; **M** multiple modules or a complete UI flow; **L** persistence/protocol work. These are relative sizes, not delivery promises.

### Validation baseline

- `npm test`: **74 of 75 test files passed; `test/package.test.js` failed**. These are the runner's file-level results, not a count of individual assertions.
- `node --experimental-global-webcrypto test/package.test.js`: **2 tests passed, 1 failed**. The expected package list omits four files that packaging actually includes: `options/provider-setup-controller.js`, `src/coded-error.js`, `src/remote-versioned-mutations.js`, and `src/sync-config.js`.
- A pure-function Tempo probe under `TZ=UTC` reproduced the midnight/day-selection issue in F01 below. No Tempo request was sent.
- Browser smoke, lint, PHP/MySQL integration, D1 integration, dependency audit, and release build were not run for this documentation review. This is not a certification of those checks or of live integrations.
- Existing untracked `docs/subscription-product-gaps.md` and `personal-time-logger-mysql-hardening-plan.md` were preserved.
- The two historical plan files named below were present at the start and externally removed during the review. Those workspace deletions were left untouched.

### Relationship to existing plans

The historical `docs/code-improvement-plan.md` and `docs/software-simplicity-improvement-plan.md`, available in baseline Git history, record completed work. Do not restart their completed phases or assume their historical passing checks describe today's checkout. Shared entry contracts, coded errors, API mutation helpers, provider setup helpers, and configuration-sync extraction already exist.

[History scaling](scaling.md) remains the starting point for performance measurement. The existing MySQL hardening document and subscription product-gap document are separate references, not authorization to implement their entire scope here. Team accounts, subscriptions, billing, new providers, and a mobile application are outside this plan.

## Functional improvements

### F01 — Allocate Tempo uploads by each selected civil day

**P1 · M · Reproduced behavior; proposed policy change.** Evidence: [tempo.js](../extension/src/tempo.js), `prepareTempoWeek`; [time-allocation.js](../extension/src/time-allocation.js); [time-model.md](time-model.md), D-04.

The code clips an entry to the week once, derives `startDate` from that clipped start, and filters selected days using only that date. Probe: a 7 September 23:00–8 September 01:00 UTC entry containing 7,200 seconds sends all 7,200 seconds on 7 September. Selecting only 8 September sends nothing. D-04 explicitly documents this existing behavior: it is not a failure to implement the current specification. This plan proposes changing day selection to mean work performed during each selected day. Update D-04 and the user documentation in the same implementation slice; distinguish previously submitted work from newly split allocations before enabling resend tracking.

- [x] Clip to the displayed week, then allocate across intersecting local civil days before applying the day selection. Reuse the existing interval/allocation policy; do not walk the entry's entire lifetime for a one-week upload.
- [x] Define integer-second rounding across segments so splitting cannot inflate or lose the entry's effective total. Apply its stored multiplier proportionally.
- [x] Include the allocation in the confirmation preview.

**Done when:** the example sends 3,600 seconds on each date, either selected date sends only its share, and DST, week boundaries, multiplied entries, empty selection, and fractional allocations have focused regression coverage.

### F02 — Make backups and restore usable without synchronization

**P1 · M · Observed limitation.** Evidence: [options.js](../extension/options/options.js), `withLocalBackupLock`, `syncRestoredBackup`, `exportBackupClicked`, `importBackupClicked`; [backup.js](../extension/src/backup.js).

Before R08/R09, both export and restore required a successful sync before doing useful work. The model now captures dirty entries in a canonical v1 copy, and Options commits local restore before attempting a follow-up sync, including for an offline or unconfigured profile.

- [x] Make a coherent local export available regardless of provider availability. Include pending work and tombstones while retaining the secret/settings exclusion policy.
- [x] Decide and document how pending state is represented: canonical portable entries plus synchronization metadata, or a versioned recovery format. Keep old backups readable; do not simply delete the dirty-entry guard without addressing parsing and restore semantics.
- [x] Permit local conflict-preserving restore without a remote preflight. Coordinate restore with migration and local mutations, commit atomically, then attempt background sync.
- [x] Keep Backup/Restore reachable before remote onboarding is complete; distinguish a local snapshot from a verified synchronized snapshot.

**Done when:** an offline profile can export its latest unsent timer changes and restore to a fresh profile without credentials; the next sync preserves dirty work, and existing differing IDs remain conflicts.

### F03 — Provide a restore preview and usable conflict report

**P2 · M · Observed limitation.** Evidence: [backup.js](../extension/src/backup.js), `restoreBackup`; [options.js](../extension/options/options.js), `importBackupClicked`.

Restore now previews additions, identical records, conflicts, and allowed settings before commit. The final local report retains those counts and details, including when follow-up synchronization is pending; conflicting records remain unchanged and secret settings stay excluded.

- [x] Preview additions, identical records, conflicts, and settings changes before committing; allow an entries-only restore.
- [x] Preserve the full result when follow-up sync is pending. Offer a local conflict report with readable dates/tasks and field differences.
- [x] Recheck conflicts transactionally at commit; a preview cannot authorize overwriting later edits.
- [x] Replace references to a “documented alternate recovery path” for files over 128 MiB with an actual documented procedure, or an accurate limitation. Measure before implementing streaming imports.

**Done when:** a mixed restore explains exactly what changed and what remained unchanged, including when offline; oversized files have a truthful next step.

### F04 — Track Tempo submissions and prevent accidental resends

**P1 · L · Observed limitation.** Evidence: [tempo.js](../extension/src/tempo.js), `sendTempoWorklogs`; [tempo-controller.js](../extension/calendar/tempo-controller.js); [background.js](../extension/background/background.js), `uploadTempoWorklogs`.

The extension now identifies daily allocations with a local ledger, claims them in the background, and records acknowledged, rejected, or unknown outcomes. The preview selects post-tracking unsent allocations by default and requires explicit selection for acknowledged, unknown, changed, or pre-ledger history. The ledger is intentionally profile-local; it does not provide distributed exactly-once delivery across devices or cleared profiles.

- [x] After F01 establishes stable allocation identity, persist a small submission ledger containing entry fingerprint, date allocation, destination/account identity, and acknowledged/failed/unknown outcome. Exclude tokens.
- [x] Coordinate submissions in the background so two tabs cannot upload the same allocations concurrently.
- [x] Default the preview to unsent allocations. Require an explicit choice to resend acknowledged or changed work.
- [x] Persist progress after each acknowledged chunk. Keep an uncertain network outcome unresolved; do not automatically retry a possibly accepted write.
- [x] Before proposing remote matching or update/delete behavior, verify Tempo's current API capabilities. A local ledger alone cannot promise duplicate prevention across separate devices or cleared profiles.

**Done when:** reload and partial failure preserve identifiable progress; a second tab cannot concurrently resend the same batch; uncertain outcomes remain visibly uncertain.

### F05 — Replace repeated Tempo mapping prompts with one preview

**P2 · M · Observed/Proposal.** Evidence: [tempo-controller.js](../extension/calendar/tempo-controller.js), `promptIssueId` and `send`.

- [x] Use one editable preview for unmapped tasks, issue IDs, dates, effective hours, skipped timers, and submission status instead of a prompt/alert loop.
- [x] Preserve entered mappings when the user corrects an invalid field; show task/project context to distinguish similarly named work.
- [x] Evaluate project+task mapping when real collisions occur; migrate the current task-only mapping compatibly rather than silently changing lookup precedence.
- [x] Stop between chunks on cancellation, preserve acknowledged results, and label any in-flight request outcome honestly.

**Done when:** multiple missing mappings can be reviewed together and canceling never implies that previously acknowledged work was rolled back.

### F06 — Define safe behavior for devices offline beyond tombstone retention

**P1 · L · Risk requiring reproduction.** Evidence: [sync.js](../extension/src/sync.js), `isExpiredDeletion`, `purgeDeletedEntries`, `pushDirtyEntries`.

Deletion evidence is physically removed after 14 days. A device returning later with a dirty old live copy can encounter no remote ID and take the append path. A clean old local copy may also remain visible because absence alone is not treated as deletion. The current retention window does not establish that every device observed a delete.

- [x] Reproduce with two isolated profiles: delete/purge on A, reconnect B both with a clean copy and with an offline edit. Include an old backup restore.
- [x] Choose the smallest explicit retention policy: retain compact deletion evidence, or detect stale profiles and require a reconciliation/rebootstrap step before uploads. Merely lengthening 14 days postpones the same problem.
- [x] Specify behavior for each provider and old clients before changing cleanup or the API contract. Do not interpret every missing remote ID as a deletion, since legitimate new local entries also lack remote IDs.

**Done when:** a long-offline profile cannot silently resurrect a known deletion, and unsent new entries remain recoverable.

### F07 — Surface forgotten and competing timers where action is possible

**P2 · M · Observed/Proposal.** Evidence: [entries.js](../extension/src/entries.js), [popup.js](../extension/popup/popup.js), [analytics.js](../extension/src/analytics.js).

- [x] Show a contextual warning for unusually old running timers with Edit and Stop actions; keep the user in control of recorded time.
- [x] Make every competing active timer reachable from the popup, with clear device/start information and an explicit resolution flow.
- [x] Consider opt-in reminders only after the inline warning works; avoid notification permissions or automatic timer stops by default.

**Done when:** a forgotten overnight timer and two devices' active timers can be understood and corrected without digging through diagnostics.

### F08 — Improve manual entry creation, correction, and undo

**P2 · M · Proposal.** Evidence: [entries.js](../extension/src/entries.js), [entry-editor.js](../extension/src/entry-editor.js), [popup.js](../extension/popup/popup.js), [calendar.js](../extension/calendar/calendar.js).

- [x] Add a direct completed-entry flow using the existing editor/model, avoiding the need to start a timer merely to backfill work.
- [x] Offer bounded undo for deletion and other common corrections; preserve revision/fingerprint checks so undo cannot overwrite a newer remote/local edit.
- [x] Explain Duplicate's overlapping copy and Merge's contiguous interval, selected multiplier, and status before committing. Preview changes to actual and effective duration.
- [x] Evaluate split-at-time as an optional correction tool only after direct entry and undo are sound; do not automatically split or merge data.

**Done when:** backfilling and correcting a mistaken deletion are straightforward, and merge/duplicate consequences are visible before saving.

### F09 — Make history easier to find and navigate

**P2 · M · Proposal.** Evidence: [popup-recent-groups.js](../extension/src/popup-recent-groups.js), [popup.js](../extension/popup/popup.js), [db.js](../extension/src/db.js).

- [x] Add text/project/task/review filters and a date jump while preserving bounded history queries.
- [x] Show filtered totals separately from period totals; preserve expansion and focus through refresh and Load more.
- [x] Reuse recent field values for autocomplete without introducing a separate project-management model.

**Done when:** an older entry can be found without expanding every intervening week and filtering cannot silently mislabel totals.

### F10 — Finish calendar accessibility and clarify time semantics

**P2 · M · Observed/Proposal.** Evidence: [calendar.js](../extension/calendar/calendar.js), gesture handlers and resize handles; [calendar-layout.js](../extension/src/calendar-layout.js); [entry-form.js](../extension/src/entry-form.js).

- [x] Provide keyboard-accessible equivalents for pointer move/resize using the existing editor or small explicit controls. Preserve Enter/Space selection, focus, Escape cancellation, and operation announcements.
- [x] Show actual duration, effective duration, multiplier, and the displayed timezone near editing controls. Explain multiplied visual tails without treating them as actual work intervals.
- [x] For ambiguous local DST input, offer a clear correction or offset choice rather than only the generic error path. Preserve rejection of nonexistent local times.
- [x] Keep active-timer movement policy consistent across UI, help, and tests. Current `beginDrag` explicitly refuses active entries, while README says active timers can be dragged.

**Done when:** existing calendar edits work without a pointer, focus survives rerendering, and repeated-hour/multiplier behavior is understandable.

### F11 — Turn analytics findings into actionable reports

**P2 · M · Proposal.** Evidence: [analytics.html](../extension/analytics/analytics.html), [analytics.js](../extension/analytics/analytics.js), [analytics-period.js](../extension/src/analytics-period.js).

- [x] Add project/task filters and explicit actual-versus-effective totals while keeping session-quality metrics based on actual elapsed time.
- [x] Link anomaly records to the corresponding calendar entry/editor, retaining period context on return.
- [x] Provide CSV export and a printable view of the selected report; use the same computed report as the screen. Quote/escape text and address spreadsheet formula interpretation in exported user fields.
- [x] Preserve selected period, expanded project rows, and scroll/focus when the minute refresh runs. Define short-month/leap-day comparisons visibly and test their boundary semantics.

**Done when:** users can explain a total, inspect its contributing entries, correct an anomaly, and export the same numbers they saw.

### F12 — Make sync status explain freshness and recovery

**P2 · M · Observed/Proposal.** Evidence: [sync.js](../extension/src/sync.js), [background-schedule.js](../extension/src/background-schedule.js), [background.js](../extension/background/background.js), existing page status renderers.

- [x] Show last successful exchange, pending local changes, review count, next retry, and active provider together. Distinguish locally saved, remotely synchronized, and needs review.
- [x] Explain idle polling delay in Options; display the effective background cadence. The current scheduler rounds to whole minutes although settings accept 30 seconds.
- [x] Count real provider requests before optimizing: API-provider `ensureReady` calls health before the later change-token gate, so README's blanket “one request” idle claim is not accurate for that path.
- [x] After measurement, consider bounded health validation reuse for an unchanged binding. Preserve compatibility checks after configuration changes, recovery, and relevant failures. R23 measured the path but deliberately deferred health caching; the scheduler and compatibility checks remain unchanged.

**Done when:** a user can see whether their work is safe locally, why another device is stale, and what Retry will do; cadence/request claims match observed behavior.

### F13 — Verify toolbar state after alarm-driven remote changes

**P2 · S · Risk requiring browser reproduction.** Evidence: [background.js](../extension/background/background.js), `runAlarmLifecycle`, `refreshToolbarIndicator`; [events.js](../extension/src/events.js); [sync.js](../extension/src/sync.js).

Requested sync explicitly refreshes the toolbar, but the alarm lifecycle only rearms scheduling. Entry events use one cached BroadcastChannel per context; an originating background sync should not rely on its own broadcast to update its own indicator.

- [x] Reproduce a remote stop/start arriving through an alarm while every UI page is closed.
- [x] Refresh the background-owned indicator after a committed alarm cycle, and coalesce overlapping indicator reads so an older result cannot overwrite the latest state.
- [x] Contain failures from the async entry-event callback so a storage error does not become an unhandled rejection.

**Done when:** toolbar state follows alarm-driven imports and rapid state changes without opening the popup.

### F14 — Make reconciliation manageable for larger reports

**P2 · M · Observed/Proposal.** Evidence: [reconcile.js](../extension/reconcile/reconcile.js), report renderers; [reconcile.js](../extension/src/reconcile.js).

- [x] Filter/search and paginate large groups; preserve review position after an action.
- [x] Preview bulk actions with affected counts and unresolved equal-time conflicts. Keep explicit local/remote choices and stale-reference validation.
- [x] Show actionable quarantined-record locations/reasons and a safe local report export; never silently normalize away invalid records.
- [x] Show completed/pending/failed results when a bulk operation only partly succeeds, with a refreshed comparison before retry.

**Done when:** thousands of differing entries do not produce an unbounded initial DOM or force users to restart review after each resolution.

### F15 — Simplify provider setup and migration recovery

**P2 · M · Proposal.** Evidence: [options.js](../extension/options/options.js), [provider-setup-controller.js](../extension/options/provider-setup-controller.js), [storage-migration.js](../extension/src/storage-migration.js).

- [x] Use consistent language for configure, test, adopt existing data, initialize from this device, migrate, and resume. Keep the active backend distinct from the prepared destination.
- [x] Preview source/target identity, entry/config counts, and disagreements before activation; retain persisted resume state after reopening Options.
- [x] Explain token rotation separately from changing datasets. Consider multiple saved destinations only if endpoint switching is a demonstrated need.
- [x] Keep local tracking and F02 recovery tools accessible during failed onboarding. Include all three supported providers in the first-run documentation.

**Done when:** users can recover a failed setup/migration without guessing which backend is active or resubmitting completed work.

### F16 — Improve settings drafts and validation without another state framework

**P2 · M · Proposal.** Evidence: [options.js](../extension/options/options.js), draft revision functions; [options-settings.js](../extension/src/options-settings.js).

- [x] Add visible unsaved-section indicators, explicit discard, and field-level validation associated with the affected input.
- [x] Explain external changes while a section has a draft; do not overwrite typed input or silently claim the draft is current.
- [x] Keep non-secret settings refresh separate from secret inputs; provide deliberate token replacement/clear controls.
- [x] Keep section-specific status near its action instead of mirroring unrelated success text across setup/backup/settings areas.

**Done when:** users know which edits are unsaved, which action failed, and whether a save affected the value currently on screen.

### F17 — Consolidate and clarify ChatGPT usage presentation

**P2 · M · Observed/Proposal.** Evidence: [usage.js](../extension/usage/usage.js), [popup.js](../extension/popup/popup.js), [chatgpt-usage-service.js](../extension/src/chatgpt-usage-service.js).

- [x] Use consistent used/remaining terminology, reset countdowns, collection age, and stale/error state across the popup and Options usage view.
- [x] Refresh visible countdowns without unnecessary network calls. Preserve the last successful snapshot on failure.
- [x] Test overlapping refreshes from two contexts. Manual refresh currently bypasses the cooldown; consider a shared request claim if overlap causes redundant requests or older results replacing newer results.
- [x] Distinguish clearing the stored snapshot/consent from revoking host access, and offer a clear disable path.
- [x] Keep the integration optional and its undocumented-endpoint limitation visible. Do not extend private-endpoint dependence or collect more account data merely to enrich the card.

**Done when:** all usage surfaces communicate the same freshness and consent state, and clear/revoke cannot be undone by a delayed request.

### F18 — Improve appearance and responsive behavior through real rendering checks

**P2 · M · Proposal.** Evidence: page HTML/CSS, [themes.css](../extension/src/themes.css), [window-resize.js](../extension/src/window-resize.js).

- [x] Check narrow popup widths, resized calendar windows, 200% zoom, long task names, high contrast, focus outlines, and reduced motion where animation exists.
- [x] Provide readable accessible names for icon-only controls and announce important async results without announcing every elapsed-second tick.
- [x] Preserve usable fallback styling if saved theme preferences cannot load.

**Done when:** all existing features remain reachable without clipped controls, color-only meaning, or lost keyboard focus.

### F19 — Make diagnostics useful without growing telemetry

**P2 · S/M · Observed/Proposal.** Evidence: [diagnostics.js](../extension/src/diagnostics.js), [error-registry.js](../extension/src/error-registry.js), background error paths.

- [x] Show provider, extension version, last successful sync, retry time, and stable error/recovery guidance in a local support summary; exclude credentials and entry content.
- [x] Deduplicate recurring failures across the sync/background reporting layers. Current deduplication only compares the last record, so alternating layers can fill the ring with one underlying failure.
- [x] Count repeated occurrences rather than silently replacing their history; retain a bounded ring.
- [x] Make recovery actions navigate directly to the relevant settings/reconciliation section.

**Done when:** an offline/auth failure loop leaves a compact, understandable history and diagnostics remain safe to copy.

### F20 — Finish proportionate backend operational support

**P2 · M/L · Observed/Proposal.** Evidence: [MySQL README](../server/mysql-api/README.md), [Config.php](../server/mysql-api/src/Config.php), [D1 README](../server/cloudflare-d1/README.md), backend schemas and integration suites.

- [x] Document and exercise backup restoration to a disposable database for each backend. Distinguish an extension JSON backup from a server/schema backup.
- [x] Document token replacement and per-device recovery. Dual-token rotation is optional until downtime during rotation is a practical problem; do not build a multi-user identity system for a personal installation.
- [x] Add an explicit MySQL schema-upgrade procedure before a second schema version is needed; avoid a generic migration framework while there is only one schema.
- [x] Add a focused PHP configuration regression: the constructor accepts omitted `cors_origins` using a default, but `allowsOrigin` accesses `$this->values['cors_origins']` directly. Normalize the default or make the field consistently required. The regression now executes under PHP.
- [x] Extend existing disposable-server tests for shared HTTP behavior where coverage is missing; keep real-engine concurrency and rollback checks.

**Done when:** an operator can restore and reconnect devices using documented steps, and accepted configuration shapes work when requests reach the API.

### F21 — Measure history and snapshot costs before changing storage architecture

**P2 measurement / P3 redesign · M/L · Observed.** Evidence: [db.js](../extension/src/db.js), `getEntriesIntersecting`; [sync.js](../extension/src/sync.js), `runSyncCycle`; [scaling.md](scaling.md).

The interval query bounds returned records, but its completed-entry index scans every `end_at > requestedStart` and filters start times afterward. An old requested week can therefore scan much later history. Sync also loads all local entries before its remote no-change gate. Neither fact alone justifies partitioning.

- [x] Benchmark 10k/50k/100k realistic entries in Firefox: current and old weeks, idle sync, one dirty edit, reconciliation, backup, and migration. Record cursor visits, request count, payload size, peak memory, and timings.
- [x] Set explicit user-facing budgets from these measurements; include long-running entries and dense overlaps.
- [ ] Optimize the measured path first: selective local queries, bounded rendering, or less work before the idle gate. Preserve complete snapshot/conflict/cleanup semantics.
- [ ] Consider delta APIs, archives, workers, caching, or virtualization only after a measured bottleneck and a compatible recovery design.

**Done when:** performance decisions have a reproducible baseline and improve the actual bottleneck rather than only reducing line count.

### F22 — Bring documentation and release checks back in sync

**P1 for the failing test; P2 for documentation · S · Reproduced/Observed.** Evidence: [package.test.js](../test/package.test.js), [prepare-firefox-release.mjs](../scripts/prepare-firefox-release.mjs), [README](../README.md), [manifest.json](../extension/manifest.json).

- [x] Fix the four missing expected package files identified in the baseline, retaining the checks for unintended files and release metadata.
- [x] Correct README's `0.1.75` release reference against manifest `0.1.76`, active-timer drag claim, first-run provider list, backup preconditions, and provider-specific idle request/cadence claims.
- [x] Clarify that packaging admits Git-tracked files under allowed extension directories; it does not independently approve every individual runtime file for safety.
- [x] Check packaged module imports, HTML scripts/styles, and required assets resolve. Do not replace the expected list with the packager's own result and call that independent verification.

**Done when:** the package test passes for the intended files, unresolved packaged imports fail, and user documentation describes this checkout.

## Overengineering and simplification review

These are bounded changes, not reasons to strip data-integrity guarantees.

| ID | Priority / effort | Evidence and recommendation | Completion criterion |
| --- | --- | --- | --- |
| S01 | P2 / S | `popup-active-state.js` exports `elapsedTimerState`, a wrapper that returns one elapsed field immediately read by its sole runtime caller. Inline that expression. `activeTimerState.iconActive` is asserted in tests but not consumed by the popup; remove the unused property and stale toolbar wording. Retain meaningful accessibility/state derivation. | Fewer wrappers/unused fields, identical visible timer behavior, toolbar tests exercise its real background owner. |
| S02 | P2 / S–M | `options-action-lifecycle.test.js` and `action-render-ownership.test.js` duplicate generic `runAction` scenarios while claiming page behavior. Consolidate generic cases in `action-runner.test.js`; test actual page wiring separately. Do not invent a controller abstraction solely to replace these tests. | One owner for runner semantics and browser evidence for real local-first page actions. |
| S03 | P2 / M | Popup/calendar editor orchestration still has parallel save/delete/merge/session handling despite shared `entry-editor.js` and `entry-form.js`. Compare the policies, then share only identical session/commit mechanics if it reduces total complexity. Keep positioning, gestures, and page rendering local. | A common edit rule changes once; no callback-heavy general page controller appears. |
| S04 | P3 / S–M | MySQL and D1 still have similar provider facades, but mutation/chunking mechanics and Options setup already have shared owners. Keep the thin provider-specific adapters unless a concrete defect forces another duplication fix. | No second provider framework, registration DSL, or boolean-heavy descriptor expansion. |
| S05 | P2 / S–M | `getAuthSessionSnapshot` uses `mutateSettings` for a read. Evaluate a focused coherent readonly settings read if contention is measurable; preserve generation+token atomicity. Avoid building a generic repository layer for this small improvement. | Snapshot reads do not unnecessarily take a write transaction; sign-out/refresh races remain covered. |
| S06 | P2 / M | Theme selectors override semantic variables that also exist in page CSS; source-regex tests lock in both definitions. Keep one authoritative palette and only necessary page fallback/layout variables. | Rendered themes and fallback readability remain correct with less duplicated color policy. |
| S07 | P2 / M | Generic error construction still coexists with small `tempoError`, `backupError`, and page wrappers. Use existing `codedError` where the domain/code contract matches; keep specialized error types when they carry behavior. Remove duplicate wrappers during feature work, not as a blind repository-wide replacement. | Fewer generic constructors without losing safe metadata, progress, or domain error handling. |
| S08 | P2 / M | The custom IndexedDB fake is substantial and security-critical tests depend on its transaction behavior. Keep the barrier/rollback semantics currently used; stop expanding it toward a complete browser database. Put unsupported browser semantics into a few real Firefox tests. | Fake behavior has explicit limits and focused contract checks; no parallel full database implementation grows in tests. |
| S09 | P2 / S–M | `browser-runtime-smoke.mjs` combines driver lifecycle and many long scenarios. Keep one temporary-browser owner but separate coherent scenario functions/modules when a change requires it. Avoid a custom general test framework. | A failing scenario reports its name and useful state; setup/teardown is not copied. |
| S10 | P2 / S | Multiple completed planning documents can look like active work. Add clear status/baseline links when maintaining docs; do not generate new overlapping plans for each extraction. | One current backlog, historical execution logs preserved, no repeated completed refactors. |

### Complexity that is justified and should remain

- IndexedDB atomic mutations and rollback; version/revision checks; canonical entry and raw-row fingerprints. They protect against lost edits and stale decisions.
- Renewable sync leases, lease-generation checks, migration ownership, durable reconciliation intent, and endpoint-binding protections. A single in-memory “busy” flag cannot replace cross-context guarantees.
- Provider-specific Google row checks and ambiguous-append recovery. Google Sheets and versioned API providers do not have the same mutation semantics.
- Input validation at the extension, PHP, and Worker trust boundaries. Share conformance fixtures, not unsafe assumptions that upstream validation already ran.
- Bounded response parsing, secret-free backups/diagnostics, and usage clear/revoke generation checks.
- Pure time-allocation and period functions. Midnight, DST, multiplier, and historical compatibility cases justify focused tests.

Do not add event sourcing, a command bus, a state-machine framework, an ORM, generated cross-language validators, background workers, distributed device tracking, or remote partitioning merely to implement small UI improvements. Protocol-scale machinery needs a demonstrated requirement, particularly for F06/F21.

## Test audit: remove, merge, replace, or keep

“Useless” here means an assertion does not detect the production regression it claims to cover, duplicates an existing contract without adding a boundary, or merely fixes incidental source spelling. A small test is not automatically useless, and a failing test is not automatically a bad test.

| Test / scenario | Assessment | Planned action |
| --- | --- | --- |
| `test/options-storage-ui.test.js` — “does not mutate Google settings while deciding visibility” | **Remove this case.** The function only destructures provider IDs; the supplied `googleSettings` object is never used. Freezing/asserting that object does not prove credentials survive actual settings actions. | Keep the compact visibility matrix. Verify real provider switching preserves stored Google credentials in the Options/browser flow. |
| `test/action-render-ownership.test.js` — “publishes a local mutation and queues remote work without waiting for it” | **Replace.** The test itself pushes a string into an array, sets a boolean, and ignores a promise. No production entry mutation, render, or sync queue runs. | Exercise a real popup/calendar action while background sync is deliberately blocked; assert the committed entry and updated UI before releasing the request. |
| `test/options-action-lifecycle.test.js` and the other action-render error case | **Merge redundant runner cases.** They exercise `runAction`, not Options/render ownership. Some finalizer/error ordering is worth retaining. | Move unique assertions into `action-runner.test.js`; add page tests only for page-specific regressions such as draft preservation and initiating-button ownership. |
| `test/remote-api-contract.test.js` | **Remove prose-regex tests from the behavioral suite.** Finding route names and safety language in Markdown cannot prove routing, schema, or error sanitization. | Extend `server/http-contract.mjs`, which currently checks only three shared HTTP cases, using actual disposable backends. Retain documentation review without calling it API conformance. |
| `test/chatgpt-structure.test.js` — endpoint/fetch/token/body-size source matching | **Replace source-shape assertions.** Renaming `accessToken` can break a test without changing behavior; finding a helper call does not prove every response is bounded or every token stays private. | Capture actual request URLs/options and storage/diagnostics writes using synthetic token markers. Assert fixed destinations, credentials/auth placement, response limits, and absence of tokens in durable/output state. Reuse existing service tests where they already cover the case. |
| `test/chatgpt-structure.test.js` — manifest permission/data declarations | **Keep policy assertions.** They inspect a shipped permission contract, not incidental function spelling. | Preserve deliberate permission-review coverage separately from service source checks. |
| `test/chatgpt-structure.test.js` — “keeps fixtures redacted” | **Replace or remove the narrow claim.** Searching two files for a few email domains and a redacted placeholder is not general secret detection. | Keep synthetic fixtures by policy; use an existing repository secret scanner if available. Do not introduce a bespoke scanner to justify this test. |
| `test/themes.test.js` — exact palette labels/default and CSS text | **Trim/replace selectively.** Legacy theme aliases and preference normalization matter; exact human labels, stylesheet declarations, and a literal outline width mostly constrain harmless edits. | Keep valid preference/alias/default fallback tests and asset coverage. Use a small browser sample for computed colors, high contrast, focus, and readable fallback. No screenshot for every color. |
| `test/tempo.test.js` — “keeps the authenticated request in the privileged background context” | **Replace the source assertions; keep transport behavior tests.** Matching `fetchImpl: tempoXhrRequest` does not prove the calendar actually routes a request there. | Test the actual runtime-message/background handler with mocked XHR, denied permission, invalid sender, and safe failure/progress response. Preserve batching and ambiguous-outcome tests. |
| `test/reconciliation-provider-ui.test.js` — source phrase/identifier checks | **Replace UI source checks; keep model checks.** Presence of `duplicateRecordsSupported` or an element ID does not prove controls are hidden or correctly wired. | Keep `loadReconciliation` metadata/invalid-snapshot behavior; assert rendered controls and labels for Google and an API provider. |
| `server/cloudflare-d1/test/scaffold.test.js` — exact SQL spelling | **Replace with executable schema assertions.** Text can match while SQL execution/constraints fail, or fail after harmless formatting. | Apply the migration to local D1 and inspect required metadata and constraint behavior. Keep a small separate configuration-placeholder/no-real-secret check. |
| `test/storage-migration.test.js` — “recognizes every registered source and target direction” | **Trim/rename.** Constructing a Cartesian product of registered IDs does not execute any migration direction. Registration is also asserted in `remote-provider.test.js`. | Keep one provider registry assertion; ensure the actual migration harness tests each claimed direction with verification, interrupted resume, and mismatched target behavior where not already covered. |
| `test/fixtures.test.js` — version-2 IndexedDB fixture | **Keep compatibility data, correct the coverage claim.** It seeds entries into the current database instead of opening a real v2 database and exercising upgrade. | Call it fixture import compatibility, or seed the old schema then upgrade. Keep the real v3→v5 migration case in `db-dirty-migration.test.js`; add older-version coverage only if that version remains supported. |
| `test/popup-render-state.test.js` | **Trim implementation mirrors.** `iconActive` is an unused output, and a one-field elapsed wrapper does not prove ticking preserves the editor. | Follow S01; keep meaningful active/inactive accessibility assertions and one real DOM check that elapsed ticks preserve an unsaved edit. |
| `test/package.test.js` | **Keep and repair.** The stale list currently fails, but independent package boundaries, untracked-file exclusion, metadata, and determinism are useful. | F22. Add packaged import/asset resolution. Avoid tests that simply compute expected output using the same production logic. |
| `test/fake-indexeddb.test.js`, `google-api-mock.test.js`, `runtime-barriers.test.js` | **Keep focused harness contracts.** Transaction FIFO, delayed commit, body/ack barriers, and physical row shifts underpin real race tests. | Remove only demonstrably duplicated trivial mock cases. Give polling loops deadlines so a broken fake fails rather than hanging. |
| Sync lease/acknowledgement/coalescing/pull/recovery, atomic entries, auth generation, reconciliation intents, remote version fencing, contract fixtures, bounded JSON, backup rollback, DST/time allocation | **Keep.** These cover independent failure boundaries with real consequences even where setup looks repetitive. | Share minimal setup when helpful; do not merge away distinct race schedules or substitute happy-path integration tests for them. |

### Rules for pruning tests

1. Identify the real regression an assertion detects. For a replacement, point to the test that now detects it before deleting the original.
2. Delete only the useless case inside a mixed-value file; do not discard useful neighboring tests.
3. Prefer production inputs and observable outputs to source regexes, helper names, exact object shape, and duplicated constants. Keep intentional wire/storage/security contracts exact.
4. Use a small number of Firefox tests for DOM focus, form drafts, browser permissions, real IndexedDB lifecycle, and cross-context behavior. Keep arithmetic and injected race schedules in fast deterministic tests.
5. Do not pursue a lower test count or higher coverage percentage as an outcome. Measure maintenance noise, distinct regressions detected, execution time, and clarity of failures.

## Delivery order and acceptance

| Phase | Work | Exit evidence |
| --- | --- | --- |
| 1 — Establish a trustworthy baseline | F22 package expectation repair; prune the unambiguous unused-settings test; consolidate runner duplicates without behavior changes. | Correct package contents/imports, passing relevant tests, full `npm test`, no deleted unique coverage. |
| 2 — Correct existing behavior | F01 Tempo daily allocation; reproduce F06/F13; fix confirmed toolbar/config-default issues; document cadence limitations. | Focused before/after regressions, real Firefox toolbar case, PHP config case where available. F06 has an explicit retention decision before protocol changes. |
| 3 — Recover local work | F02/F03 offline backups and restore; retain format compatibility and conflict safety. | Offline dirty-entry export, old/new backup restore, concurrent edit, settings preview, conflict report, and failed post-restore sync cases. |
| 4 — Make Tempo recoverable | F04/F05, building on F01. | Persisted per-allocation outcomes, concurrent-tab exclusion, interrupted/partial upload and uncertain-outcome checks, usable preview. |
| 5 — Improve daily workflows | F07–F11, F14–F19, ordered by actual user pain; fold in S01/S03/S06/S07 only where touched. | Representative browser flows, keyboard/focus checks, consistent totals and draft preservation. Ship coherent features separately. |
| 6 — Operations and measured scale | F20/F21 and remaining harness simplifications. | Disposable restore drill, backend contract evidence, Firefox benchmark report, and a separately justified decision for any architecture change. |

For each implementation slice:

- Record the IDs completed, changed behavior, checks run, and any remaining limitation. Keep unimplemented proposals unchecked.
- Run focused regressions and appropriate lint; use `npm test` for shared runtime changes. Run Firefox smoke for UI/context changes, PHP/MySQL checks for that backend, and D1 checks for Worker changes.
- For packaging or runtime module changes, inspect the prepared package and its imports/assets. Release/signing/deployment is separate from implementing this plan.
- Record unavailable prerequisites explicitly; neither a skipped backend nor a mocked browser interaction counts as a real integration pass.
- Run `git diff --check` and preserve unrelated user work. Avoid installing tooling or contacting live backends merely to complete a documentation or source-cleanup slice.

The first implementation session repairs the existing package test. Test cleanup and the proposed Tempo day-allocation change have separate work cards. Offline recovery is the next substantial improvement. Defer storage redesign and speculative abstractions until their specific evidence and compatibility requirements are established.

## Work cards

Dependencies refer to ledger IDs below. R01 is the baseline prerequisite for every later code card. Perform the numbered tasks inside a card sequentially. A card owns only the listed slice of a finding.

### R01 — Repair package expectations and current documentation

**Depends:** none. **Owns:** F22 except the deeper import-closure check (R30), S10. **Read/edit:** `test/package.test.js`, `scripts/prepare-firefox-release.mjs`, `extension/manifest.json`, `README.md`.

1. Reproduce the package failure and add only the four intended missing modules to the independent expectation after checking their imports/callers.
2. Correct version, provider list, active-timer drag, backup preflight, and idle-request/cadence claims to match current behavior. Do not document later cards as already implemented.
3. Keep untracked-file exclusion and determinism tests. Record the new baseline and historical-document status.

**Checks:** PACKAGE, JS, PACKAGE-GATE. **Exit:** the existing package failure is resolved for the correct reason; unrelated failures are explicitly recorded.

### R02 — Remove unambiguous test duplication and trivial popup outputs

**Depends:** R01. **Owns:** S01/S02 and corresponding test-audit rows. **Read/edit:** ACTION files, `extension/src/action-runner.js`, `extension/src/popup-active-state.js`, `extension/popup/popup.js`, browser smoke.

1. Delete only the unused-`googleSettings` assertion; preserve the provider visibility matrix. Consolidate unique generic runner cases into `action-runner.test.js`.
2. Replace the test-authored local mutation scenario with a real popup action under blocked background sync; assert stored entry and rendered state before releasing the block. Preserve draft content during an elapsed tick.
3. Inline the one-field elapsed wrapper and remove unused `iconActive`; retain accessible active/inactive labels. Update test catalog paths after file deletions.

**Checks:** ACTION, UI. **Exit:** removed cases have a named replacement or a recorded no-behavior reason; actual local-first rendering is exercised.

### R03 — Implement daily Tempo allocation policy

**Depends:** R01. **Owns:** F01 allocation and interim confirmation, not the complete preview. **Read/edit:** `extension/src/tempo.js`, `time-allocation.js`, `extension/calendar/tempo-controller.js`, TEMPO tests, `docs/time-model.md` D-04, README.

1. Add the UTC 23:00–01:00 case, selected-day subsets, empty selection, week clipping, multiplied/fractional seconds, and DST cases in Europe/Lisbon and Australia/Lord_Howe.
2. Implement the settled seven-day allocation/rounding policy. Verify selected-day totals equal the same days taken from a full-week result.
3. Update D-04 and confirmation text to disclose daily splitting. Do not add ledger or mapping UI yet.

**Checks:** TEMPO with `TZ=UTC`, `TZ=Europe/Lisbon`, and `TZ=Australia/Lord_Howe` prefixed to its command; UI. **Exit:** the target 3,600+3,600 example and deterministic rounding pass; docs explicitly record the policy change.

### R04 — Verify and correct alarm-driven toolbar ownership

**Depends:** R01. **Owns:** F13. **Read/edit:** `extension/background/background.js`, `extension/src/events.js`, `icon.js`, `test/icon.test.js`, `test/background-schedule.test.js`, browser smoke.

1. Add a Firefox scenario that imports a remote stop/start via the alarm path with all extension UI pages closed.
2. If reproduced, update the indicator after the cycle; coalesce reads and handle event-callback rejections. Do not replace the shared event system.
3. Cover a stale indicator read resolving after a newer state. If the issue is already fixed, document the actual path and retain only useful coverage.

**Checks:** named tests, SYNC, UI. **Exit:** current persisted activity owns the icon without popup participation, including read failure and rapid transitions.

### R05 — Make accepted PHP configuration shapes consistent

**Depends:** R01. **Owns:** F20 omitted-origin default only. **Read/edit:** `server/mysql-api/src/Config.php`, `tests/config_test.php` under that backend.

1. Add omitted-`cors_origins`, empty-list, allowed-origin, denied-origin, and malformed-value cases.
2. Retain optional empty-list semantics by using the validated default consistently in origin lookup. Do not broaden allowed origins or authentication.

**Checks:** PHP, DOC. **Exit:** omitted optional configuration does not produce a warning/TypeError; malformed values still fail. No server token or schema changes.

### R06 — Reproduce deletion resurrection and settle a compatible policy

**Depends:** R01. **Owns:** F06 investigation; no production policy change. **Read:** `sync.js` purge/push/pull, provider cleanup implementations, backup/migration code, SYNC/PROVIDER tests, API/time contracts.

1. Build a synthetic two-profile scenario for clean and dirty old live copies after tombstone purge, plus new unsent IDs and an old-backup restore. Use controlled time; never wait 14 days or access real profiles.
2. Record actual outcomes per provider. Compare retaining existing tombstones (no new wire shape) against compact deletion evidence and stale-profile recovery; explicitly analyze older purging clients.
3. Write the chosen retention/compatibility contract into the decision log below: exact persisted evidence, purge rule, dirty-new-entry distinction, upgrade behavior, and recovery path. Prefer existing tombstone records if they satisfy the requirements without a schema change. Do not promise protection from historical evidence already lost.
4. Replace reserved R07 with independently executable child cards if backend/schema changes are necessary. Each must name affected providers, fixtures, rollout behavior, and validation gates. A design with unresolved data-loss questions leaves R07 blocked; continue dependency-independent cards.

**Checks:** SYNC, PROVIDER, JS for added scenarios. **Exit:** reproducible evidence plus a complete bounded implementation contract, or a precise unresolved decision. A discovery completion does not complete F06.

### R07 — Implement the settled deletion-retention policy

**Depends:** R06 done with a complete decision; otherwise ineligible. **Owns:** F06 implementation. **Read/edit:** only paths identified by R06, existing cleanup tests, retention docs.

1. Read R06's decision and implement its smallest coherent local/sync change. If it needs backend/schema work, execute the R07 child cards R06 must define; do not improvise a multi-backend migration here.
2. Preserve unsent-new-entry behavior, imported tombstones, and migration/backup compatibility. Add the explicit recovery case for a profile whose deletion evidence is already gone.
3. Update the retention statement and old-client limitations. Keep intermediate child changes compatible and do not enable a new writer before its reader/schema contract exists.

**Checks:** SYNC, PROVIDER, BACKUP, JS; MYSQL/D1 only for affected backend children. **Exit:** every R06 case meets the written policy; all children/compatibility checks pass before F06 completion.

### R08 — Implement coherent offline portable backup data

**Depends:** R01. **Owns:** F02 model/export semantics. **Read/edit:** `extension/src/backup.js`, `db.js` snapshot functions, `options-settings.js`, `test/backup.test.js`, legacy backup fixtures.

1. Implement the settled schema-v1 portable-copy policy and preserve live dirty state. Keep the coherent entries/settings read and secret exclusion.
2. Keep existing v1 files readable; test active entries, tombstones, dirty changes, duplicate IDs, invalid payloads, size bounds, and canonical field round-trip.
3. Add a direct model-level restore test proving new imported IDs become dirty and differing existing IDs remain unchanged. Leave Options wiring for R09.

**Checks:** BACKUP, JS. **Exit:** a portable snapshot captures pending work without mutating the source or requiring any network call.

### R09 — Wire offline backup/restore and first-run access

**Depends:** R08. **Owns:** remaining F02. **Read/edit:** Options HTML/JS/CSS, `backup.js`, sync/migration exclusion helpers, browser smoke.

1. Remove remote success as a prerequisite for export/local restore. Use existing transaction/exclusion boundaries; acquire/release local ownership without a network request inside it.
2. Make recovery controls reachable in first-run/failed-provider setup. Trigger optional follow-up sync after commit; show local completion separately from pending sync.
3. Cover a fresh offline profile, concurrent edit, active migration, and failed follow-up sync. Update README backup instructions.

**Checks:** BACKUP, PROVIDER, UI. **Exit:** an offline unconfigured user can export/restore safely, and a migration cannot race the restore commit.

### R10 — Add restore preview and complete conflict reporting

**Depends:** R09. **Owns:** F03. **Read/edit:** backup model and Options, backup/browser tests.

1. Derive a preview of additions/identical/conflicting entries and allowed settings. Use captured entries-only/settings choice; keep appearance in the optional settings choice.
2. Recompute conflict decisions in the existing transaction, then render/export a complete local report even when follow-up sync fails. Escape entry text and do not expose secret settings.
3. Replace the nonexistent oversized-file recovery promise with an accurate limit and documented supported alternatives. Do not implement chunked restore.

**Checks:** BACKUP, UI. **Exit:** a preview race preserves newer edits and the final report accounts for every proposed record and selected setting.

### R11 — Implement the Tempo submission ledger model

**Depends:** R03. **Owns:** F04 persistence only. **Read/edit:** Tempo model, DB mutation helpers, setting keys; add one focused ledger module/test if needed.

1. Write and test the versioned identity/state transitions from the settled defaults: pending claim, acknowledged, known rejection, unknown result, and explicit resend decision.
2. Persist claims atomically before dispatch is possible; ensure account/issue/date/fingerprint differences do not collide. A changed entry or day allocation requires review rather than overwriting old acknowledgement evidence.
3. Define pending-after-restart as unknown, with no automatic replay. Keep ledger data out of backups/diagnostics. Do not wire network calls yet.

**Checks:** TEMPO, BACKUP, JS, PACKAGE-GATE for new runtime files. **Exit:** direct model tests prove claim exclusion, preserved outcomes, and explicit retry eligibility.

### R12 — Make background Tempo dispatch use durable claims

**Depends:** R11. **Owns:** F04 dispatch and actual message-path test replacement. **Read/edit:** background upload handler, `tempo.js` request loop, ledger, Tempo tests, browser smoke.

1. Capture the destination/account/mappings and allocation payload for the operation; validate the calendar sender and payload before claiming work.
2. Route every upload through the ledger. Record each chunk outcome before accepting a further retry. Two calendar contexts must not dispatch the same claimed allocation.
3. Test the real runtime-message handler with injected XHR success, denial, rejection, interrupted body/request, and lost response. Replace source matching only after these cover that boundary.

**Checks:** TEMPO, ledger regression, UI. **Exit:** two tabs and background restart cannot silently duplicate acknowledged work or replay an unknown claim.

### R13 — Build one Tempo mapping and submission preview

**Depends:** R12. **Owns:** F05 mapping UI; F04 resend UI; F01 complete preview. **Read/edit:** calendar Tempo controller/HTML/CSS, ledger read model, existing day-selection tests.

1. Replace sequential mapping prompts with an inline form/table showing task/project, day, issue, seconds/hours, skipped timers, and ledger state. Preserve current task-only mapping storage.
2. Preserve typed mappings on validation failures. Separate eligible new work from acknowledged/changed/unknown-history records; explicit selection is required for any resend or pre-ledger history.
3. Keep snapshot identity through confirmation; revalidate claim eligibility before dispatch rather than trusting an old preview.

**Checks:** TEMPO, UI. **Exit:** all displayed totals match R03 allocations and mapping corrections do not discard typed values or bypass duplicate review.

### R14 — Finish Tempo cancellation and recovery flow

**Depends:** R13. **Owns:** F04/F05 recovery completion. **Read/edit:** controller/background protocol/ledger, preview, error-progress tests.

1. Cancel only future chunks; preserve acknowledged results and make the current in-flight outcome explicit.
2. Reopen a partially completed upload and show identifiable acknowledged/rejected/unknown work. Do not offer automatic whole-week retry.
3. Test cancellation between chunks, after a lost response, after popup/calendar closure, and after account/mapping changes. Document same-profile and pre-ledger limitations.

**Checks:** TEMPO, ledger tests, UI. **Exit:** the entire preview→partial send→close→reopen→review sequence is usable and never implies rollback of completed work.

### R15 — Add actionable stale/competing timer warnings

**Depends:** R01. **Owns:** F07 initial scope. **Read/edit:** popup active/history renderers, entries, existing analytics stale-timer threshold and tests.

1. Reuse the existing stale-timer threshold/policy; show Edit and Stop without automatically modifying entries.
2. List competing active timers with start/device information and guarded actions. Keep start/stop atomicity and expected revisions.
3. Test overnight persistence and two active records; no new notification permission.

**Checks:** ENTRY, UI. **Exit:** each problematic timer is independently reachable and correction preserves unrelated entries.

### R16 — Add a direct completed-entry flow

**Depends:** R01. **Owns:** F08 manual creation. **Read/edit:** entries model, shared editor/form, calendar entry point and corresponding tests.

1. Add a manual completed-entry model operation using current normalization, device ID, timestamps, and dirty-state rules; never create an intermediate running timer.
2. Reuse the calendar editor for explicit start/end creation. Do not alter active timer state.
3. Test invalid/repeated/nonexistent local times, multiplier, zero/minimum duration per current contract, and offline creation.

**Checks:** ENTRY, UI. **Exit:** a backfilled log commits locally while an existing active timer continues unchanged.

### R17 — Add guarded undo for deletion

**Depends:** R16. **Owns:** F08 deletion undo. **Read/edit:** delete mutation, popup/calendar deletion actions, existing calendar undo pattern.

1. Keep a single recent deletion undo per page session, with original values and expected tombstone identity; no global history engine.
2. Undo by a new guarded local mutation and sync normally. If the row was edited, replaced, or physically purged, explain why undo is unavailable rather than resurrecting it blindly.
3. Test double undo, a newer remote/local tombstone, and an acknowledged deletion followed by undo.

**Checks:** ENTRY, SYNC, UI. **Exit:** undo restores only the intended unchanged tombstone and never overwrites a newer decision.

### R18 — Clarify merge/duplicate effects and review shared editor mechanics

**Depends:** R16/R17. **Owns:** F08 remaining initial scope, S03 evaluation. **Read/edit:** both page editor flows, shared entry form/editor, time-model D-02.

1. Preview merge target/source, actual/effective duration, interval compaction, multiplier/status, and duplicate overlap without changing existing semantics.
2. Compare repeated session/commit code. Extract only identical policy if it reduces callers/callbacks; otherwise record S03 as reviewed with no extraction warranted.
3. Test a stale source/target during confirmation and preserve page-specific focus/session ownership.

**Checks:** ENTRY, UI. **Exit:** users see the committed effects before confirming; no generic page controller was introduced.

### R19 — Add bounded history filtering and date navigation

**Depends:** R01. **Owns:** F09. **Read/edit:** popup history/grouping and DB query functions, HISTORY tests.

1. Add date jump and filters over the loaded date range; label that range explicitly. Do not imply a search of all history while only filtering the loaded page.
2. Display filtered and period totals distinctly. Preserve expansion/focus through external refresh and Load more.
3. Reuse loaded/recent field values for autocomplete; do not create a project registry or full-history index unless measurements justify it.

**Checks:** HISTORY, UI. **Exit:** old-date navigation and filtered totals are correct with bounded query results, including an empty selected week.

### R20 — Finish calendar keyboard editing and time explanations

**Depends:** R16/R18. **Owns:** F10 initial scope. **Read/edit:** calendar/editor UI, `entry-form.js`, `time.js`, calendar/layout tests.

1. Ensure keyboard users can select, edit start/end, save, cancel, and return focus using ordinary controls; keep active-timer dragging disabled.
2. Display timezone, actual/effective duration, and multiplier. For ambiguous/nonexistent local times, give actionable correction text; an explicit occurrence selector is conditional, not required in this first slice.
3. Test DST boundaries, long labels, Escape, and focus after rerender. Keep actual interval and visual multiplier tail distinct.

**Checks:** ENTRY under Lisbon/Lord Howe timezones, UI. **Exit:** every existing pointer-edit result can be achieved through accessible editor controls without guessing the time model.

### R21 — Add analytics filters and entry navigation

**Depends:** R19/R20. **Owns:** F11 filters, drill-down, refresh preservation. **Read/edit:** analytics model/page, calendar entry selection/navigation, period tests.

1. Apply project/task filters to both primary and comparison datasets; expose actual and effective totals without changing fragmentation semantics.
2. Link anomalies to an entry/date destination; return to the preserved report state. Validate missing/deleted target IDs.
3. Preserve period/expansion/focus on minute refresh. Cover month/leap boundaries and describe the existing comparison rule truthfully.

**Checks:** HISTORY, UI. **Exit:** displayed summaries, contributing entries, and comparison scope agree before and after a background refresh.

### R22 — Export and print the computed analytics report

**Depends:** R21. **Owns:** F11 exports. **Read/edit:** analytics report output/page/styles; add a small serializer only if needed.

1. Export from the same resolved report/filter snapshot shown on screen; include ranges, timezone, and actual/effective labels.
2. Escape CSV quotes/newlines and neutralize formula-leading text cells without corrupting numeric columns. Add focused serializer cases.
3. Provide print styling with totals/labels and no interactive controls. No separate reporting engine.

**Checks:** HISTORY plus serializer tests, UI, PACKAGE-GATE if new module. **Exit:** exported/printed numbers match the visible report, including filtered and multiplied examples.

### R23 — Present coherent sync freshness and cadence

**Depends:** R04. **Owns:** F12 initial scope. **Read/edit:** sync outcomes/settings, background schedule, popup/Options status renderers, diagnostics/error policy.

1. Present active provider, local pending count, last successful exchange, review count, and next retry; use a coherent existing snapshot or a small read helper.
2. Display the effective whole-minute background cadence and idle delay. Do not change scheduler timing or introduce health caching in this card.
3. Add injected-provider request counts for idle/dirty/forced cycles to substantiate documentation. Cover offline, auth failure, conflict, and backoff presentation.

**Checks:** SYNC, `test/background-schedule.test.js`, UI. **Exit:** statuses cannot confuse locally saved work with remote success and documented request counts match the tested provider paths.

### R24 — Bound reconciliation presentation and expose partial results

**Depends:** R01. **Owns:** F14, reconciliation UI source-test replacements. **Read/edit:** reconciliation page/model/UI-state and tests.

1. Paginate each rendered group (initial page size 50) and add search/filter over the loaded report. Keep full report accounting visible.
2. Preview bulk counts, preserve equal-time unresolved conflicts and preconditions, then show completed/pending/failed outcomes with a fresh report before retry.
3. Export quarantined locations/reasons locally with escaped data. Replace identifier/phrase source tests with actual rendered-control checks for Google and an API provider.

**Checks:** PROVIDER, `test/reconcile-ui-state.test.js`, `test/reconciliation-actions.test.js`, UI. **Exit:** a large synthetic report renders a bounded first page and partial resolution preserves the user's position and unresolved work.

### R25 — Clarify provider setup and resumable migration UI

**Depends:** R09/R24. **Owns:** F15 initial scope, S04 keep decision. **Read/edit:** Options provider setup controller/page, storage migration state/progress, provider/browser tests.

1. Align labels for preparation, testing, local initialization, remote adoption, migration, and resume; show active and prepared identities independently.
2. Display verified source/target counts and disagreements before activation. Reopen Options during an interrupted migration and recover from persisted state.
3. Keep direct setup/recovery available without Google credentials; preserve existing provider facades and ownership checks.

**Checks:** PROVIDER, BACKUP, UI. **Exit:** setup/resume clearly identifies the real active backend and never repeats a completed write because of page closure.

### R26 — Add section-local draft indicators and validation

**Depends:** R25. **Owns:** F16. **Read/edit:** Options draft tracking/HTML/CSS, settings normalization and tests.

1. Expose dirty-section state, explicit discard, and input-associated errors using existing draft revision tracking.
2. Handle externally changed saved values while a draft exists; leave typed values intact and show a deliberate reload/discard choice.
3. Keep secret replacement separate from normal refresh and status next to its action. Test an unrelated slow action finishing after new typing.

**Checks:** BACKUP, `test/options-settings.test.js`, `test/provider-setup-controller.test.js`, UI. **Exit:** no action completion silently discards or falsely acknowledges a newer draft.

### R27 — Improve usage freshness and replace source-shape tests

**Depends:** R01. **Owns:** F17 initial scope, usage test-audit rows. **Read/edit:** usage service/page, popup usage rendering, USAGE tests.

1. Standardize used/remaining/reset/stale labels and update visible countdowns locally. Keep clear-data, consent, and host-permission revocation distinct.
2. Capture real service requests and durable writes using synthetic token markers; retain manifest permission assertions and body-size/revoke-race tests. Remove only source assertions whose boundary is now covered.
3. Reproduce two-context manual refresh ordering. If older responses overwrite newer snapshots, add the smallest generation/claim correction with its regression; otherwise record that no new claim mechanism is needed.

**Checks:** USAGE, UI. **Exit:** all surfaces agree on freshness/consent and secret markers never enter durable state or diagnostics. No new endpoint or data collection.

### R28 — Consolidate theme policy and verify responsive access

**Depends:** R20/R26/R27. **Owns:** F18, S06, theme test-audit row. **Read/edit:** themes.js/CSS, page styles/HTML, themes/window tests and smoke.

1. Remove redundant palette declarations only after distinguishing required fallback values from page layout variables.
2. Replace incidental CSS spelling/label assertions with a small computed-style/focus sample; keep legacy preference aliases and fallback behavior.
3. Check narrow windows, 200% zoom, high contrast, long labels, icon labels, and reduced motion where relevant. Fix concrete unreachable/clipped controls, not a visual redesign.

**Checks:** `test/themes.test.js`, `test/window-resize.test.js`, UI. **Exit:** all existing actions remain reachable and readable in the tested layouts with keyboard focus intact.

### R29 — Improve bounded local diagnostics and error consistency

**Depends:** R23/R26. **Owns:** F19, S07 touched-path cleanup. **Read/edit:** diagnostics/error registry, background reporting, Options diagnostics, associated tests.

1. Deduplicate recurring same-cause failures across layers while preserving distinct codes/phases; add a bounded occurrence count rather than unbounded history.
2. Add safe version/provider/freshness context and section-specific recovery navigation. Do not copy raw error messages, URLs, credentials, or entry content.
3. Replace generic error wrappers only where the shared constructor preserves the domain metadata. Keep Tempo progress intact.

**Checks:** `test/diagnostics.test.js`, `test/error-registry.test.js`, `test/coded-error.test.js`, SYNC, UI. **Exit:** a repeated offline loop produces compact actionable diagnostics and distinct failures remain distinguishable.

### R30 — Test real HTTP contracts and packaged asset closure

**Depends:** R01/R05. **Owns:** F22 import closure, F20 shared HTTP coverage, API prose-test replacement. **Split required:** complete R30a and R30b in separate sessions; both are independent after prerequisites.

- **R30a:** Read/edit package tests/preparation. Check emitted HTML module/style references and JavaScript imports resolve within the prepared extension. Keep an independent package boundary and missing-import negative fixture; do not execute fixture code. Checks: PACKAGE, JS, PACKAGE-GATE. Exit: missing assets/imports fail and ordinary tracked modules pass.
- **R30b:** Read/edit `server/http-contract.mjs`, backend integration suites, `docs/remote-api-v1.md`. Map already-tested routing/auth/schema/error behavior, add only missing shared cases against disposable engines, then remove redundant Markdown regex cases. Preserve known safe-error shape and real rollback tests. Checks: JS, MYSQL, D1. Exit: both engines satisfy added executable cases; missing engines leave `needs-validation`, not permission to delete protective coverage without a replacement.

### R31 — Execute D1 schema assertions instead of matching SQL text

**Depends:** R30b. **Owns:** D1 scaffold test-audit row. **Read/edit:** D1 migration/scaffold/integration tests and local harness.

1. Apply the actual migration to local D1; assert initial metadata and version/guard constraints through database behavior.
2. Remove exact SQL-spelling assertions only after the executable tests cover them. Retain a focused placeholder/no-real-secret configuration check.
3. Do not change production schema to satisfy a test assumption; investigate a mismatch against the documented contract.

**Checks:** D1, JS. **Exit:** a broken constraint fails even if matching SQL text remains, while harmless formatting does not fail the test.

### R32 — Correct migration-test claims and constrain test harness growth

**Depends:** R01. **Owns:** S08/S09, fixture/registration/harness audit rows. **Read/edit:** DB test group, storage migration/remote provider tests, browser smoke lifecycle.

1. Rename fixture seeding as import compatibility or exercise the actual supported old schema upgrade. Keep the existing real v3→v5 upgrade test.
2. Remove duplicate provider Cartesian-product assertions; map actual migration-direction tests before adding any missing case. Keep separate interrupted/ownership/version schedules.
3. Add deadlines to unbounded harness waits and document fake IndexedDB limits. Separate a browser scenario only if it materially improves the changed test; do not rewrite the harness.

**Checks:** DB, PROVIDER, JS; UI if browser harness changes. **Exit:** every named migration claim maps to executed behavior and a broken barrier terminates with useful diagnostics.

### R33 — Document and verify backend recovery procedures

**Depends:** R05/R30b/R31. **Owns:** remaining initial F20. **Split required:** R33a and R33b are separate sessions.

- **R33a:** Read MySQL README/schema/integration harness. Document a backup→disposable restore→contract verification drill, token replacement, and an explicit ordered schema-upgrade procedure using current tools. Execute only in a positively identified disposable schema. Checks: PHP, MYSQL, DOC. Exit: actual drill result and precise prerequisite/limitation recorded; no general migration framework or multi-user auth.
- **R33b:** Read D1 README/migrations/local integration harness. Document and exercise the corresponding local disposable restore/check procedure; distinguish local validation from untested remote recovery and current platform features. Verify external operational commands against official documentation before updating them. Checks: D1, DOC. Exit: repeatable local drill with honest remote-operation limits; no deployment or remote database mutation.

### R34 — Measure performance and decide conditional simplifications

**Depends:** R19/R21/R24. **Owns:** F21 measurement, S05 decision, F12 health-cache decision. **Read:** `docs/scaling.md`, DB interval queries, sync preflight, auth session store, existing Firefox harness.

1. Create a reproducible disposable-profile benchmark for 10k/50k/100k entries, including old weeks, dense overlaps, idle/dirty/forced sync, reconciliation, backup, and migration. Use synthetic providers; distinguish simulated network timings from real services.
2. Record cursor visits, operation duration, memory when measurable, and request counts. Mark unavailable metrics rather than inventing estimates. Preserve the fixture seed and exact reproduction command.
3. Write results and the highest-value bounded optimization, or evidence that no optimization is needed. Do not implement archives/delta APIs or auth/health changes here. Add a conditional child card only for a measured bottleneck.

**Checks:** benchmark reproduction, DB/HISTORY for any harness logic, DOC; JS if scripts change. **Exit:** a repository-local benchmark artifact/procedure and evidence-based decision. No synthetic pass claim for unrun Firefox measurements.

**Conditional child card:**

- **R34a:** Repeat the Firefox benchmark on a representative profile and define a user-facing calendar-read budget. If the displayed-week interval query exceeds that budget, prototype one bounded calendar-query improvement (such as a compatible selective index/query) with DB/HISTORY regression coverage. Preserve complete-history sync, conflict, backup, and migration semantics; otherwise record that no optimization is justified. Checks: benchmark reproduction, DB/HISTORY, JS, DOC. Do not start this child card from R34.

### R35 — Resolve conditional work and audit coverage of every finding

**Depends:** all eligible R01–R34 cards, including child cards, have outcomes. **Owns:** conditional register and final F/S mapping. **Read/edit:** this document and evidence produced by prior cards.

1. Match every finding checkbox, simplification, and test-audit row to an actual card result. Leave deferred implementation unchecked.
2. For each conditional trigger below, record met/not met and evidence. If met, add a bounded child card with concrete paths/tests; implement it in a later session before final acceptance. Do not quietly convert optional proposals into required scope or claim they were delivered.
3. Record blockers/needs-validation cards explicitly; final acceptance stays pending while any required implementation or gate is unfinished.

**Checks:** DOC. **Exit:** no finding, test deletion, conditional item, or prerequisite is unaccounted for.

### R36 — Final verification and handoff

**Depends:** R35 plus all required/triggered child work done. **Owns:** final delivery evidence.

1. Review the aggregate work against the protected contracts, user-facing documentation, and package contents. Verify original unrelated work remains intact.
2. Run `npm test`, `npm run lint`, `npm run test:browser`, PHP/MYSQL, D1, and package build/asset checks relevant to implemented changes; run the dependency audit if dependencies changed or release preparation is requested. Do not call signing/publishing.
3. Record final counts/commands, remaining deliberate optional deferrals, and limitations. A missing required real-browser/backend check keeps this card `needs-validation`; it is not a successful completion.

**Exit:** every implemented slice has its required evidence and the final report distinguishes delivered features from conditional proposals.

## Conditional register

These remain in the findings sections for completeness. Their evaluation is required; implementation is conditional. Use `not-triggered` with evidence, `triggered` plus a child-card ID, or `unresolved`. They are not complete features unless implemented and validated.

| Proposal | Trigger / default decision | Owner |
| --- | --- | --- |
| Notifications and automatic reminders (F07) | Explicit reminder requirement beyond actionable inline warnings. Automatic timer stopping remains out of scope. | R38 |
| Split-at-time, broader multi-action undo (F08) | Demonstrated correction workflow not served by manual entry, delete undo, and merge preview. | R39 |
| Project+task Tempo mapping (F05) | Reproduced collision between identical task labels requiring different issues; write a backward-compatible mapping migration first. | R37 |
| Explicit DST occurrence selector (F10) | User needs to save a specific repeated-hour occurrence; initial scope supplies accurate rejection/correction guidance. | R20/R35 |
| Multiple saved backend destinations (F15) | Repeated switching requirement not met by existing preparation/migration. | R25/R35 |
| Shared usage refresh claim (F17) | Actual two-context ordering test exposes stale overwrite/redundant work requiring it. | R27 |
| Auth readonly snapshot helper (S05) | R34 measures meaningful write contention and a coherent readonly operation is simpler. | R34/R35 |
| Provider health cache (F12) | R34 demonstrates material cost and defines binding/error invalidation tests before caching. | R34/R35 |
| Streaming backups (F03), delta APIs, archives, workers, virtualization (F21) | A reproduced size/performance limit with measurements and a compatible recovery design. These need dedicated design/implementation child cards. | R34/R35 |
| Dual-token rotation and schema framework (F20) | Demonstrated rotation availability requirement or an actual next schema migration; no identity platform. | R33/R35 |
| Further provider/editor abstractions (S03/S04) | Concrete duplicated policy defect and a smaller shared interface; otherwise retain current boundaries. | R18/R25 |

## R35 audit result

R35 reconciles the current checkboxes and audit rows against the ledger and
handoffs. A checked item below has executable or documented evidence in its
listed card; an unchecked item is deliberately deferred, conditional, or
blocked. No unchecked finding was promoted during this audit.

### Finding-to-card map

| Finding | Evidence outcome | Remaining unchecked scope |
| --- | --- | --- |
| F01 | R03 allocation/rounding and R13 preview complete | None |
| F02 | R08 model and R09 local/offline wiring complete | None |
| F03 | R10 preview, conflict report, and transactional restore complete | None |
| F04 | R11 ledger, R12 dispatch, R13 resend UI, R14 recovery, and the F04 follow-up complete | Same-profile ledger scope remains; cross-device idempotency is not provided |
| F05 | R13 preview/mapping, R14 cancellation/recovery, and the explicit F05 follow-up complete | No remote cross-device duplicate identity is provided |
| F06 | R06 investigation and R07 retention policy implementation complete | None |
| F07 | R15 actionable stale/competing timer warnings and the explicit F07 follow-up complete | OS-level notification display remains unclaimed; reminders remain opt-in |
| F08 | R16 direct entry, R17 deletion undo, R18 merge/duplicate preview, and the explicit F08 follow-up complete | Split-at-time remains evaluated and deferred; undo is bounded to the latest page action |
| F09 | R19 bounded history filters/navigation complete | None |
| F10 | R20 keyboard editing, time explanations, and DST guidance complete | None |
| F11 | R21 filters/navigation/refresh preservation and R22 export/print complete | None |
| F12 | R23 sync freshness/cadence implementation complete | Health caching remains deliberately deferred |
| F13 | R04 implementation, tests, and targeted Firefox reproduction complete | None |
| F14 | R24 bounded reconciliation and partial-result UI complete | None |
| F15 | R25 setup/migration language and recovery UI complete | Multiple saved destinations remain conditional |
| F16 | R26 draft indicators, conflict messaging, and validation complete | None |
| F17 | R27 shared presentation, generation fencing, and consent boundaries complete | None |
| F18 | R28 rendered theme/responsive accessibility checks complete | None |
| F19 | R29 bounded diagnostics implementation complete | No additional F19 scope remains |
| F20 | R05 PHP default/configuration regression, R30b shared-engine contract, and R33a/R33b recovery procedures complete | No initial F20 checkbox remains incomplete; dual-token rotation and generic migration framework remain deliberately deferred |
| F21 | R34 benchmark and R34a budget complete | Production optimization and architecture-change proposals remain unchecked |
| F22 | R01 package/documentation repair and R30a reference closure complete | None |

### Simplification and test-audit map

| Scope | Outcome and owner |
| --- | --- |
| S01/S02 and their action-runner audit rows | R02 consolidated generic runner coverage, removed only the identified no-behavior/duplicate cases, and added real browser replacement coverage. |
| S03 | R18 reviewed shared editor mechanics and retained page-local orchestration because the policies differ; no abstraction was claimed. |
| S04 | R25 retained thin provider adapters; no concrete defect justified a second provider framework. |
| S05 | R34/R34a did not measure meaningful contention; the readonly auth helper remains conditional and unimplemented. |
| S06 | R28 consolidated authoritative theme behavior while retaining necessary fallback/layout declarations and replacing incidental CSS assertions with Firefox rendering checks. |
| S07 | R29 applied the shared coded-error constructor only where domain metadata was preserved; no broad wrapper rewrite was justified. |
| S08/S09 | R32 corrected the fixture claim, removed duplicate registration-only Cartesian assertions, bounded harness waits, and documented fake IndexedDB limits; no general test framework was added. |
| S10 | R01 clarified the active plan and preserved historical plan deletions; no overlapping plan was created. |
| Removed/replaced `options-storage-ui`, action-render ownership/lifecycle, Popup usage source-shape, remote Markdown regex, reconciliation UI source-shape, and incidental theme cases | R02, R27, R30b, R24, and R28 each recorded the replacement or retained neighboring contract coverage in its handoff. |
| ChatGPT fixture-redaction source row | R27 retained the existing narrow redaction assertion; the planned repository-wide scanner/replacement was not introduced and remains an explicitly uncompleted audit follow-up. |
| Kept policy/security/race/transport cases | R01–R34 handoffs retain these cases; no independent race, wire/storage, security, rollback, or real-engine test was removed by R35. |
| D1 SQL-spelling audit row | R31 replaced the exact migration-text assertions with local D1 behavior checks for metadata, default versioning, and rejected invalid constraints; the placeholder/no-secret configuration check remains. |
| Migration fixture/registration audit rows | R32 corrected the fixture wording and kept registry coverage in `remote-provider.test.js`; the real v3→v5 upgrade remains in `db-dirty-migration.test.js`. |

### Conditional register outcome

| Proposal | R35 outcome | Evidence |
| --- | --- | --- |
| Notifications/reminders | implemented by explicit follow-up | F07 is opt-in, revision-deduplicated, and never stops or edits timers; OS-level notification display remains unclaimed. |
| Split-at-time/broader undo | partially implemented by explicit follow-up | F08 adds bounded edit undo and records the split-at-time evaluation; no demonstrated need requires automatic interval surgery or a multi-action undo stack. |
| Project+task Tempo mapping | implemented by explicit follow-up | F05 adds collision-aware project+task mappings while retaining compatible task-only mappings for non-colliding tasks. |
| Explicit DST occurrence selector | not-triggered | R20 provides correction/offset guidance and rejects nonexistent times; no requirement to choose a repeated occurrence was established. |
| Multiple backend destinations | not-triggered | R25 handles active/prepared migration and no repeated switching requirement was demonstrated. |
| Shared usage refresh claim | triggered and resolved by R27 | R27's two-context ordering test required generation fencing; the correction was implemented and validated, so no child card remains. |
| Auth readonly snapshot helper | not-triggered | R34/R34a measured history/snapshot work, not meaningful auth-session write contention. |
| Provider health cache | not-triggered | No live provider health cost or invalidation evidence was measured. |
| Streaming backup/delta/archive/worker/virtualization | not-triggered | The 100k Calendar read stayed below the provisional 1,500 ms budget; backup stayed below 128 MiB, and no compatible recovery design exists for architecture changes. |
| Dual-token rotation/schema framework | not-triggered | No practical rotation-downtime requirement or second schema version was present. |
| Further provider/editor abstractions | not-triggered | R18/R25 found no concrete duplicated policy defect requiring a smaller shared abstraction. |

### Blockers and acceptance state

R04 is `done`: its targeted Firefox alarm stop/start reproduction now runs
against a disposable local HTTPS provider with every extension UI page closed
while each alarm fires. R23, R29, R30b, R31, R33a, R33b, and R36 are complete
after their required local/disposable checks passed. The F04 and F05/F07/F08
explicit follow-ups are also recorded below; their profile-local, opt-in, and
unavailable-live-service limitations remain explicit. These states are
outcomes, not passes.
R34/R34a's memory metric is unavailable and provider request counts are
synthetic by design. No OS-level notification display test or cross-device
Tempo idempotency test has been claimed.

## Session ledger
Complete the next eligible unfinished step in docs/current-functionality-session-runbook.md.

Read the startup protocol, settled defaults, session ledger, and latest handoff. Resume any partially completed step first; otherwise select the next step whose dependencies are complete. Treat child cards as separate steps.

Read the selected step’s referenced findings in docs/current-functionality-improvement-plan.md and inspect the current code. Complete only that step, including implementation, required tests, and documentation. Preserve unrelated work.

Before finishing:
- Update the ledger and only the finding checkboxes actually completed.
- Append a self-contained handoff recording changes, decisions, exact validation results, and remaining limitations.
- Identify the next eligible step and its first concrete action.

If blocked, record the precise blocker and leave the step incomplete. Never mark missing validation as passed.

Stop after this one step. Do not begin the next step, commit, push, or deploy.
All implementation is initially pending. Update this table in place; use the handoff log for details. Dependencies and scope are in the cards, not implied by numeric order alone. For R30/R33, use child rows as the executable units.

| ID | State | Evidence / next action |
| --- | --- | --- |
| R01 | done | Added four tracked package paths, corrected README claims, and passed PACKAGE/JS/PACKAGE-GATE checks. |
| R02 | done | Removed the documented duplication and trivial popup outputs; focused tests, full JS/lint checks, and browser smoke passed, including real local-first start/render and draft preservation. |
| R03 | done | F01 allocation and per-entry rounding implemented; focused UTC/Lisbon/Lord Howe tests, full JS/lint gates, and Firefox confirmation smoke passed. Complete preview remains for R13. |
| R04 | done | Added a smoke-only disposable HTTPS provider and real Firefox one-shot alarm scenario; stop then start imports were observed with UI closed and the background-owned icon transitioned inactive then active. Focused icon/schedule tests and full JS/browser gates passed. |
| R05 | done | Normalized the validated optional `cors_origins` default, added omitted/empty/malformed configuration coverage while retaining allowed/denied coverage, documented the accepted shapes, and passed PHP and DOC checks. |
| R06 | done | Reproduced post-purge clean/dirty, new-ID, and old-backup outcomes for all providers; recorded the no-new-wire-shape tombstone-retention/stale-profile contract and passed SYNC, PROVIDER, JS, and DOC checks. |
| R07 | done | Retained tombstones, blocked automatic recovery for missing previously synchronized/backup records and dirty edits against tombstones, explicit Reconcile clearing, updated retention/old-client documentation, and provider-parity regression coverage. |
| R08 | done | Implemented schema-v1 portable entry normalization for dirty local work, preserved tombstones and secret exclusion, added direct model-level restore/export coverage, and left Options network-preflight wiring for R09. |
| R09 | done | Removed backup network preflight, added shared local-lock coordination and post-restore sync handling, exposed recovery controls in first-run setup, added offline/conflict/lock browser coverage, and updated backup documentation. |
| R10 | done | Added restore preview/report lists, transactional conflict recomputation, safe text rendering, entries-only restore, pending-sync preservation, and truthful 128 MiB limitation wording. |
| R11 | done | Added the versioned local Tempo submission ledger with atomic claims, explicit outcome transitions/resend review, restart recovery to unknown, changed-allocation review, and backup exclusion. |
| R12 | done | Routed background Tempo messages through validated durable claims; recorded acknowledged/rejected/unknown chunk outcomes; added concurrent-handler, restart-recovery, XHR, and malformed-response coverage. R13 still owns the preview/resend UI. |
| R13 | done | Replaced Tempo prompts with an editable daily-allocation preview, ledger-state selection and explicit resend controls, mapping validation/preservation, snapshot revalidation, and browser coverage. R14 still owns cancellation/recovery. |
| R14 | done | Added operation-scoped Tempo cancellation between chunks, explicit current-request progress, durable partial-upload recovery, account/mapping revalidation, cancellation controls, and focused/browser coverage. Same-profile and pre-ledger limitations remain documented. |
| R15 | done | Implemented actionable stale/competing active-timer warnings using the existing 8-hour analytics threshold, guarded Edit/Stop actions, overnight/two-timer tests, and browser coverage. |
| R16 | done | Added atomic local completed-entry creation, reused the calendar editor, preserved active timers, and added ENTRY/UI coverage. |
| R17 | done | Added guarded one-deletion undo in Popup and Calendar with tombstone identity checks, explicit unavailable recovery, and ENTRY/SYNC/UI coverage. |
| R18 | done | Added shared merge/duplicate previews with guarded Popup and Calendar confirmation, stale-revision coverage, and page-local orchestration review. |
| R19 | done | Added bounded Popup history date/filter controls, distinct period/filtered totals, focus preservation, and loaded-value autocomplete. |
| R20 | done | Added keyboard calendar editor access, Escape/focus restoration, actual/effective/timezone explanations, actionable DST errors, and preserved active-timer movement policy. |
| R21 | done | Added shared project/task filters, actual/effective totals, anomaly-to-calendar navigation with stale-target guards, and period/expansion/scroll/focus preservation across refresh. |
| R22 | done | Added filtered report CSV export with safe text escaping/formula neutralization, actual/effective labels, browser timezone/ranges, and print styling without interactive controls. |
| R23 | done | Added shared sync freshness/cadence presentation, persisted successful-exchange status, injected-provider request-count coverage, README claims, and Popup/Options Firefox assertions; focused, full JS, lint, package, and browser gates passed. |
| R24 | done | Added bounded reconciliation group pagination/search, bulk previews, review-position preservation, quarantine location export, and completed/pending/failed outcome reporting with refreshed comparison. |
| R25 | done | Clarified active/prepared provider language, persisted verified migration previews with source/target counts and disagreements, rendered resumable state after reopening Options, and kept local initialization, remote adoption, token rotation, and local backup recovery distinct. |
| R26 | done | Added section-local unsaved indicators and discard actions, preserved drafts across external refreshes with explicit messaging, added field-associated settings errors, and separated token clearing from normal settings refresh. |
| R27 | done | Unified Usage and Popup used/remaining/reset/countdown/stale presentation, refreshed countdowns locally, retained last successful snapshots on failure, added cross-context generation fencing, and kept consent/clear/revoke paths distinct. |
| R28 | done | Consolidated shared theme behavior, added reduced-motion and long-label access fixes, replaced CSS-string checks with rendered Firefox checks, and passed all R28 validation. |
| R29 | done | Added cross-layer bounded diagnostic deduplication with occurrence counts, safe support context, direct recovery navigation, and sync freshness context; named, full JS, package, extension-lint, and Firefox gates passed. |
| R30a | done | Added independent prepared-package reference resolution for manifest, HTML, CSS, and JavaScript references plus a missing-module negative fixture that does not execute fixture code. |
| R30b | done | Added executable shared HTTP contract coverage and standardized MySQL/D1 authentication errors; local D1 and disposable MySQL 8.4 integration now pass, including the shared HTTP contract after normalizing malformed JSON errors to `INVALID_REQUEST`. |
| R31 | done | Applied the migration to local D1, asserted initial metadata/default version behavior and invalid metadata/version/mutation-guard rejection through database behavior, retained the placeholder/no-secret check, and removed only the covered SQL-spelling assertions. |
| R32 | done | Corrected the v2 fixture claim, removed the duplicate migration-direction registration assertion, bounded harness waits, and documented fake IndexedDB limits. |
| R33a | done | Documented and exercised disposable MySQL schema/data restore, restored-endpoint contract verification, synthetic token replacement/per-device recovery, and the ordered forward-only schema procedure; no second migration exists to execute yet. |
| R33b | done | Documented and exercised local D1 migration/export/import recovery, migration-list verification, sentinel data/config recovery, and the restored local HTTP contract; remote recovery remains explicitly untested. |
| R34 | done | Firefox benchmark artifact and report completed for 10k/50k/100k profiles; local UI/snapshot measurements are recorded, unavailable memory and simulated provider requests remain explicit, and no storage-architecture change was justified. R34a is conditional on a repeated representative-profile budget breach. |
| R34a | done | Repeated the Firefox benchmark with fresh isolated profiles, set a provisional 1,500 ms displayed-week Calendar read budget at 100k entries, and found both 100k runs below budget; no production optimization is justified. |
| R35 | done | Audited all finding checkboxes, simplification decisions, test-audit rows, conditional triggers, and blockers against the card handoffs; deferred and unvalidated work remains explicitly incomplete. |
| R36 | done | Final aggregate review completed; the later F04 follow-up also verified the default-unsent marker and current Tempo API boundary without changing R36's validation claims. |
| R37 | done | Completed the explicitly requested F05 slice: compatible project+task Tempo mappings for real task-label collisions, with focused collision/mapping validation and preserved task-only mappings. |
| R38 | done | Completed the explicitly requested F07 slice: opt-in stale-timer notifications, bounded per-revision deduplication, click-through to the popup, and no automatic timer mutation. |
| R39 | done | Completed the explicitly requested F08 correction slice: conflict-safe one-action undo for popup/calendar edits and deletions; evaluated split-at-time and deferred it because the demonstrated workflow is covered without automatic interval surgery. |

## Decision log

Prepared defaults are recorded above. Append only decisions needed by later sessions. Each entry must include card ID, date, concrete choice, alternatives rejected, compatibility impact, and tests that enforce the choice. R06's deletion-retention decision belongs here before R07 starts.

### R06 — 2026-09-12 — Deletion retention and stale-profile contract

Concrete choice: retain the existing tombstone records indefinitely in remote storage and on local profiles; do not extend the 14-day purge window or introduce a new wire/schema shape. A remote tombstone remains authoritative for a clean local copy. A dirty edit to an entry represented by a remote tombstone is a conflict and must not overwrite the tombstone automatically. When a previously synchronized local entry is absent from a current snapshot, the client must not take the append path; it must hold the record for explicit reconciliation or rebootstrap. Only a genuinely new local entry with no prior synchronization evidence remains eligible for automatic append. An old-backup restore is unproven provenance and must receive the same explicit treatment before it can write to an absent remote ID.

Alternatives rejected: merely lengthening 14 days postpones the same loss; a stale-profile-only gate cannot distinguish a legitimate new unsent ID without retaining some deletion evidence; a new compact tombstone marker or API/schema field would require a multi-provider rollout and would not protect clients that still purge full tombstones. The existing full tombstone is the smallest compatible evidence available now.

Compatibility impact: Google Sheets currently uses row/fingerprint references and reports `REMOTE_ROW_STALE` when a retained precondition no longer matches; MySQL and Cloudflare D1 use versioned references and report `REMOTE_ENTRY_MISSING` or `REMOTE_VERSION_STALE` for a missing/stale precondition. After a purge, all three providers expose no reference in the snapshot, so the shared sync code currently appends a dirty old copy; the policy requires R07 to block that path. Older clients that still purge after 14 days may already have erased evidence; newer clients cannot promise to recover a deletion that is historically absent. Such profiles require explicit user-directed reconciliation/rebootstrap, with no automatic inference from remote absence.

Tests that enforce the choice: `test/tombstone-policy-investigation.test.js` runs a controlled two-profile scenario for `google-sheets`, `mysql`, and `cloudflare-d1`, covering A's retained tombstone, B's clean and dirty old copies, a previously synchronized ID missing from the snapshot, a new unsent ID, and an old-backup restore. R07 converts the investigation into regression coverage for the settled policy; the original pre-policy outcomes are preserved in the R06 handoff.

### R08 — 2026-09-12 — Schema-v1 portable backup model

Concrete choice: retain backup schema version 1 and normalize every exported entry to canonical persisted fields with `dirty: false`, empty `last_sync_at`, and empty `sync_error`. The normalization is applied to a coherent readonly local snapshot and to the serializer boundary, so a dirty live entry is copied without changing its local dirty state. Tombstones remain entries in the portable copy. Restore continues to merge by ID, leaves differing existing entries unchanged as conflicts, and marks newly imported IDs dirty for later synchronization; the local-only recovery marker is not exported.

Alternatives rejected: retaining the dirty-entry export rejection would make offline work impossible to preserve; exporting live sync metadata would make a portable copy claim remote provenance it cannot prove; changing the format version would provide no benefit while the existing v1 parser remains compatible with canonical entries.

Compatibility impact: Existing canonical v1 backups remain readable, and malformed or duplicate entries remain invalid. The model layer now captures unsynchronized changes without a network call, while Options still performs its existing successful-sync preflight until R09 wires offline export and restore into the page flow. No credentials, provider endpoints, leases, diagnostics, or recovery markers enter the backup.

Tests that enforce the choice: `test/backup.test.js` covers active entries, tombstones, dirty source normalization without live-state mutation, v1 round-trip, conflict-preserving/idempotent restore, duplicate IDs, malformed records, and size bounds. `test/options-settings.test.js` continues to cover the secret/settings exclusion list.

### R10 — 2026-09-12 — Restore preview and complete local report

Concrete choice: show a local preview before restore with additions, identical entries, conflicts, and non-secret setting changes. Default selected settings to the changes found in the backup, while keeping appearance preferences as a separate opt-in choice; clearing the settings checkbox provides an entries-only restore. Existing conflicts are never overwritten.

Alternatives rejected: do not add chunked import or a new backup format for the 128 MiB boundary; the UI and README now state that larger files require a smaller backup because chunked import and an alternate recovery procedure are not supported. Do not render entry text as HTML; readable project/task labels and field values use DOM text nodes so backup content cannot create markup or expose secrets.

Compatibility impact: the schema-v1 backup format and existing secret-setting exclusion remain unchanged. Restore summary objects now retain added and identical entry details, setting changes, and full conflict field differences for the local report. The final transaction recomputes each ID against current IndexedDB state after the user preview, so edits made while the preview is open remain local conflicts.

Tests that enforce the choice: `test/backup.test.js` covers preview categorization, setting changes, entries-only restore, idempotent restore, and a newer local edit after preview. `scripts/browser-runtime-smoke.mjs` covers first-run preview/report rendering, pending synchronization, and hostile entry text rendered without `img` or `script` elements.

### R11 — 2026-09-12 — Tempo submission ledger model

Concrete choice: store version-1 Tempo allocation attempts as a local settings record identified by the fixed Tempo destination, canonical entry fingerprint, local civil date, allocated integer seconds, issue ID, and author account. A claim is persisted as `pending` before any future dispatch; terminal outcomes are `acknowledged`, `rejected` (a known safe-to-retry response), or `unknown` (including no response). A pending claim is converted to `unknown` by the explicit restart-recovery operation, never replayed automatically.

Alternatives rejected: do not use entry ID alone, because date splits, changed allocations, issue IDs, and authors must not collide; do not overwrite an acknowledgement when resending, because explicit resend appends a new claim and preserves the old evidence; do not store the ledger in backups or diagnostics, because it is local submission history rather than portable time data or a safe diagnostic field.

Compatibility impact: this card adds only a local settings key and a focused runtime module; no Tempo request path or provider contract changes yet. Untracked allocation history is reported as `unknown-history` and requires review, so pre-ledger work is never mislabeled as unsent. A same-day changed allocation requires review before a new claim, while different civil-day allocations remain independently identifiable. Tokens and worklog descriptions are not accepted by the ledger identity or record shape.

Tests that enforce the choice: `test/tempo-submission-ledger.test.js` covers versioned identity validation, concurrent claim exclusion, pending/acknowledged/rejected/unknown transitions, explicit resend, changed-allocation review, restart recovery, and backup exclusion. The temporary-index package gate includes `extension/src/tempo-submission-ledger.js` in the prepared Firefox source.

### R12 — 2026-09-12 — Background Tempo claims and outcome boundary

Concrete choice: keep the calendar responsible for preparing and confirming the displayed operation, but make the background runtime-message handler the only dispatch boundary. It validates the exact calendar sender and every allocation before claiming, stores an internal entry fingerprint only in the local ledger, sends a wire payload without that metadata, and records each dispatched chunk as `acknowledged`, `rejected`, or `unknown` before the upload result can permit another attempt. Startup recovery runs once for the background handler and converts leftover pending claims to `unknown`; it is not repeated per request, so an active concurrent upload cannot be mistaken for a restarted one.

Alternatives rejected: do not let the calendar call Tempo directly; that would lose privileged host-permission behavior and duplicate the claim policy. Do not claim only after the request or infer success from a response body; either ordering permits duplicate work or cannot distinguish a lost response. Do not automatically replay unknown or acknowledged allocations. The current broad calendar confirmation is treated as explicit review for untracked or changed allocations until R13 provides the required per-allocation preview and resend controls.

Compatibility impact: the existing Tempo endpoint, authorization header, issue grouping, 50-worklog chunking, and calendar runtime-message name remain unchanged. The prepared model now carries an internal fingerprint that is stripped at the wire boundary. Known HTTP rejection remains retryable through the ledger; timeout, request failure, and an unreadable response body do not silently replay. No live Tempo request or remote capability claim was made.

Tests that enforce the choice: `test/tempo-upload-handler.test.js` invokes the background handler seam with sender/payload validation, privileged XHR success, denial, concurrent claims, startup pending recovery, known rejection/retry, timeout/lost response, and malformed response-body coverage. `test/tempo.test.js` verifies fingerprint preparation, wire metadata stripping through the bulk sender, the calendar/background boundary, and the privileged XHR adapter. The temporary-index package gate includes both new runtime modules.

### R13 — 2026-09-12 — Tempo mapping and submission preview

Concrete choice: replace sequential mapping prompts and the single confirmation string with one bounded calendar dialog containing task/project context, editable numeric issue mappings, daily allocation rows, seconds/hours, skipped-timer information, and local ledger state. New/untracked and changed allocations default to explicit review selection; acknowledged and unknown records are opt-in resends; known rejections remain selected as safe retries. Mapping edits are saved only after validation, and the preview retains typed invalid values so correction does not discard work.

Alternatives rejected: do not silently treat every allocation without a ledger record as “never sent”; the UI labels it untracked/review and requires selection. Do not make the page trust a stale preview; the controller compares the captured entry fingerprint/revision snapshot and rereads ledger eligibility immediately before sending. Do not introduce project+task mapping migration before a real collision is reproduced; current task-only storage remains unchanged.

Compatibility impact: the existing task-only setting key, daily allocation policy, background message name, Tempo wire payload, and privileged dispatch boundary remain unchanged. The dialog is page-local and uses ordinary form/table controls; no new framework or persisted preview state was added. The combined F04 default-unsent checkbox remains incomplete because this profile has no persisted feature-start marker that can distinguish pre-ledger history from a newly created untracked allocation; R14/R35 must retain that limitation or settle a compatible marker.

Tests that enforce the choice: `test/tempo-controller.test.js` covers preview row data, mapping correction and re-preparation, selected-row dispatch, and stale-snapshot rejection. `scripts/browser-runtime-smoke.mjs` opens the real dialog, checks both daily rows and untracked status, verifies an invalid mapping remains typed with an inline error, then selects and sends the rows through a stubbed runtime message. TEMPO regressions continue to cover R03 allocation totals and day selection.

## Handoff log

Copy this template for each completed or interrupted card:

```text
Session ID / date:
State: done | in-progress | needs-validation | blocked | not-applicable
Starting revision and relevant pre-existing worktree state:
Findings/subtasks actually completed:
Files changed (include new/untracked runtime files):
Behavior and compatibility decisions:
Tests added/replaced/removed; replacement coverage for each removal:
Commands and exact outcomes (distinguish baseline failures/skips):
Package validation and temporary-index procedure, if applicable:
Unfinished work / precise blocker / conditional decisions:
Next eligible session:
First concrete next action (path/function/test):
```

### R01 — 2026-09-12

Session ID / date: R01 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: `3a1f13f77a66478f527a3044f4a79a72a765cdf8`; pre-existing deletions of `docs/code-improvement-plan.md` and `docs/software-simplicity-improvement-plan.md` and untracked `docs/subscription-product-gaps.md` and `personal-time-logger-mysql-hardening-plan.md` were preserved.
Findings/subtasks actually completed: Repaired the package expectation for the four already-tracked modules (`options/provider-setup-controller.js`, `src/coded-error.js`, `src/remote-versioned-mutations.js`, and `src/sync-config.js`); corrected README release, backup-preflight, provider-list, active-timer-drag, and provider-specific idle request/cadence claims; clarified the Git-tracked packaging boundary.
Files changed (include new/untracked runtime files): `README.md`, `test/package.test.js`, and this plan. No runtime files were added.
Behavior and compatibility decisions: The package test remains an independent explicit expected list in sorted output order; the packager was not changed. README now describes the existing behavior: backups require a successful sync preflight, running timers cannot be calendar-dragged, all three first-run providers are available, alarms are minute-granular, and API-provider idle cycles normally perform health plus change-token requests.
Tests added/replaced/removed; replacement coverage for each removal: No tests were removed or added; four existing tracked runtime files were added to the package expectation.
Commands and exact outcomes (distinguish baseline failures/skips): Baseline `node --experimental-global-webcrypto --test test/package.test.js test/create-update-site.test.js`: `test/create-update-site.test.js` passed and `test/package.test.js` failed. Final `node --experimental-global-webcrypto --test test/package.test.js test/create-update-site.test.js`: 2 tests passed, 0 failed. `npm test`: 410 tests passed, 0 failed, 106 suites. `npm run lint:js`: passed. `npm run lint:extension`: passed with 0 errors, 0 notices, 0 warnings. `git diff --check`: passed.
Package validation and temporary-index procedure, if applicable: No temporary index was needed because no new runtime files were introduced. The prepared `web-ext-artifacts/lint-source` contained 81 files; relative JavaScript, HTML, and CSS references were inspected and all resolved.
Unfinished work / precise blocker / conditional decisions: F22's independent packaged import/asset-closure test remains for R30a; no browser, backend, or release-build validation was required by R01. Existing oversized-backup alternate-recovery wording remains for R10.
Next eligible session: R02.
First concrete next action (path/function/test): Run the ACTION baseline command from the plan, then inspect the named action-runner, popup, and browser-smoke paths before removing only the documented duplicate cases.

### R02 — 2026-09-12

Session ID / date: R02 / 2026-09-12
State: needs-validation
Starting revision and relevant pre-existing worktree state: `3a1f13f77a66478f527a3044f4a79a72a765cdf8` plus the completed R01 work; R01's preserved deletions and untracked documents were left untouched.
Findings/subtasks actually completed: Removed the unused `googleSettings` no-behavior assertion; moved generic action error/finalizer ordering coverage into `action-runner.test.js`; removed the redundant `options-action-lifecycle.test.js` and `action-render-ownership.test.js`; simplified popup active state by removing `iconActive` and `elapsedTimerState`; added browser smoke coverage for a real popup start while `sync_lock` blocks background sync, committed IndexedDB/rendered state before release, and unsaved draft preservation across an elapsed tick. Updated the ACTION test catalog path.
Files changed (include new/untracked runtime files): `extension/src/popup-active-state.js`, `extension/popup/popup.js`, `scripts/browser-runtime-smoke.mjs`, `test/action-runner.test.js`, `test/options-storage-ui.test.js`, `test/popup-render-state.test.js`, deleted `test/options-action-lifecycle.test.js` and `test/action-render-ownership.test.js`, and this plan.
Behavior and compatibility decisions: Local timer creation remains committed and rendered before background synchronization succeeds; the smoke blocks the real `sync_lock` only around the start action and releases it before continuing. Elapsed ticking updates only the visible elapsed field, so an unsaved editor description remains intact. Generic `runAction` semantics have one unit-test owner; page-specific behavior belongs to browser smoke.
Tests added/replaced/removed; replacement coverage for each removal: Added one generic `runAction` error/finalizer-order test to `test/action-runner.test.js`; removed two redundant generic lifecycle files and one unused-settings assertion. The deleted fake local-mutation scenario is replaced by the new `exercisePopupTimer` browser scenario; the deleted Options lifecycle cases are covered by the consolidated runner test.
Commands and exact outcomes (distinguish baseline failures/skips): Baseline ACTION command with five files: 5 tests passed, 0 failed. Baseline `npm run test:browser`: unavailable because `geckodriver` is not installed. Final focused ACTION command with three remaining files: 3 tests passed, 0 failed. `npm test`: 406 tests passed, 0 failed, 104 suites. `npm run lint:js`: passed. `node --check scripts/browser-runtime-smoke.mjs`: passed. `git diff --check`: passed. Final `npm run test:browser`: unavailable with `Error: geckodriver is unavailable. Set GECKODRIVER_BIN or install it before running browser smoke.`
Package validation and temporary-index procedure, if applicable: Not applicable; no packaged runtime file was added and R02 has no PACKAGE-GATE requirement.
Unfinished work / precise blocker / conditional decisions: The browser smoke has not executed, so Firefox validation of local-first popup rendering, sync blocking, and draft preservation is unverified. Required environment: Firefox, `geckodriver`, and `zip`; rerun `npm run test:browser`. Do not mark R02 done until that UI gate passes or a precise browser limitation is accepted as `needs-validation`.
Next eligible session: Resume R02 validation before starting R03.
First concrete next action (path/function/test): Provide/install `geckodriver` and Firefox (or set `GECKODRIVER_BIN`/`FIREFOX_BINARY`), then run `npm run test:browser` against the updated `scripts/browser-runtime-smoke.mjs`.

### R02 validation — 2026-09-12

Session ID / date: R02 validation / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: The R02 implementation and documentation changes were present; R01's preserved deletions and untracked documents remained untouched.
Findings/subtasks actually completed: Completed the R02 UI gate. No additional finding checkbox was changed because R02 owns S01/S02 and test-audit rows, which do not have finding checkboxes.
Files changed (include new/untracked runtime files): This plan only; no runtime or test files changed during validation.
Behavior and compatibility decisions: The existing browser smoke now validates the actual popup start path while background synchronization is lock-blocked, observes the committed local entry and rendered active state before releasing the lock, and verifies an unsaved description survives an elapsed tick.
Tests added/replaced/removed; replacement coverage for each removal: No additional test changes; the R02 replacements documented above were exercised by the browser gate.
Commands and exact outcomes (distinguish baseline failures/skips): `npm run test:browser`: passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, analytics, calendar render, provider-aware settings, options save, and cross-context lock.` The previously recorded focused ACTION tests (3 passed, 0 failed), `npm test` (406 passed, 0 failed, 104 suites), `npm run lint:js`, `node --check scripts/browser-runtime-smoke.mjs`, and `git diff --check` remain passing.
Package validation and temporary-index procedure, if applicable: Not applicable; no packaged runtime file was added and R02 has no PACKAGE-GATE requirement.
Unfinished work / precise blocker / conditional decisions: R02 is complete. The wider plan still has unimplemented cards and R30a remains responsible for the deeper package import-closure check.
Next eligible session: R03.
First concrete next action (path/function/test): Run the TEMPO baseline command `node --experimental-global-webcrypto --test test/tempo.test.js test/tempo-day-selection.test.js test/time-allocation.test.js`, then inspect the existing allocation functions and tests before adding R03's UTC-boundary, selected-day, multiplier/fractional-second, week-clipping, and DST cases.

### R03 — 2026-09-12

Session ID / date: R03 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: The worktree included completed R01/R02 changes, R01/R02 plan handoffs, the pre-existing deletions of `docs/code-improvement-plan.md` and `docs/software-simplicity-improvement-plan.md`, and untracked `docs/subscription-product-gaps.md` and `personal-time-logger-mysql-hardening-plan.md`; all were preserved.
Findings/subtasks actually completed: Completed F01's clip-before-split allocation and deterministic integer rounding items. Each completed entry is clipped to the displayed period, split over intersecting local civil days, rounded once per entry using floor plus descending fractional remainders/date-order ties, and filtered by selected days afterward. Added regressions for local-midnight crossing, selected-day consistency, week clipping, stored multiplied/fractional seconds, empty selection coverage, and DST-length days. Updated the interim confirmation and documentation. The F01 complete-preview checkbox remains unchecked for R13.
Files changed (include new/untracked runtime files): `extension/src/time-allocation.js`, `extension/src/tempo.js`, `extension/calendar/tempo-controller.js`, `scripts/browser-runtime-smoke.mjs`, `test/tempo.test.js`, `docs/time-model.md`, `README.md`, and this plan. No new runtime module was added.
Behavior and compatibility decisions: The settled daily policy is authoritative: weekly integer targets are computed per entry before selection filtering; zero-second daily allocations are omitted; local civil-day boundaries use calendar arithmetic, preserving 23-hour and 24.5/25-hour elapsed days. The confirmation reports daily worklog allocations and explains local-midnight splitting/rounding. The controller accepts an optional confirmation function solely to make the browser smoke deterministic; production wiring continues to use `window.confirm`. No Tempo ledger, mapping preview, resend state, or network behavior was added.
Tests added/replaced/removed; replacement coverage for each removal: Added focused Tempo preparation and civil-day regressions in `test/tempo.test.js`; no tests were removed. The Firefox smoke now creates a real local midnight-crossing entry and exercises the browser-loaded Tempo controller with network/permission stubs, capturing the confirmation without contacting Tempo.
Commands and exact outcomes (distinguish baseline failures/skips): Baseline `node --experimental-global-webcrypto --test test/tempo.test.js test/tempo-day-selection.test.js test/time-allocation.test.js`: 3 tests passed, 0 failed. Final `TZ=UTC node --experimental-global-webcrypto --test test/tempo.test.js test/tempo-day-selection.test.js test/time-allocation.test.js`: 3 passed, 0 failed; `TZ=Europe/Lisbon ...` with the same command: 3 passed, 0 failed; `TZ=Australia/Lord_Howe ...` with the same command: 3 passed, 0 failed. `npm run test:browser`: passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, analytics, calendar render, provider-aware settings, options save, and cross-context lock.` `npm test`: 409 tests passed, 0 failed, 105 suites. `npm run lint:js`: passed. `npm run lint:extension`: passed with 0 errors, 0 notices, 0 warnings. `node --check scripts/browser-runtime-smoke.mjs`: passed. `git diff --check`: passed.
Package validation and temporary-index procedure, if applicable: Not applicable; R03 added no runtime module and has no PACKAGE-GATE requirement. Extension lint prepared the normal `web-ext-artifacts/lint-source`; no package files were changed.
Unfinished work / precise blocker / conditional decisions: F01's detailed allocation/mapping/submission preview is intentionally unfinished and owned by R13 after R12. F04 submission tracking must wait for the R11/R12 ledger cards. No browser test sends live data to Tempo.
Next eligible session: R04, R05, or R06; each depends only on R01, and R04 is first by card order.
First concrete next action (path/function/test): Start R04 by running its named toolbar/SYNC baseline tests, then inspect `extension/background/background.js`, `extension/src/events.js`, `icon.js`, and the browser smoke path for the alarm-driven remote stop/start scenario.

### R04 — 2026-09-12

Session ID / date: R04 / 2026-09-12
State: needs-validation
Starting revision and relevant pre-existing worktree state: The worktree included completed R01–R03 changes, the pre-existing deletions of `docs/code-improvement-plan.md` and `docs/software-simplicity-improvement-plan.md`, and untracked `docs/subscription-product-gaps.md` and `personal-time-logger-mysql-hardening-plan.md`; all unrelated work was preserved.
Findings/subtasks actually completed: Implemented F13's background-owned refresh after the alarm lifecycle, coalesced overlapping active-entry reads so a superseded result is discarded, and contained entry-event/startup/requested-sync refresh failures through diagnostic-safe handling. Added focused stale-read and read-failure regressions. The F13 remote stop/start alarm reproduction checkbox remains unchecked.
Files changed (include new/untracked runtime files): `extension/background/background.js`, `extension/src/icon.js`, `test/icon.test.js`, and this plan. No new runtime module was added.
Behavior and compatibility decisions: The alarm lifecycle now refreshes the toolbar after scheduling completes, including when sync fails. A newer refresh request causes an in-flight read result to be ignored and a fresh read to run. Toolbar read failures are recorded as bounded background diagnostics without producing an unhandled rejection. Existing BroadcastChannel ownership remains unchanged; no popup participation or new event system was introduced.
Tests added/replaced/removed; replacement coverage for each removal: Added two `test/icon.test.js` cases covering superseded reads and observable read failures; no tests were removed. Existing icon failure-deduplication coverage remains.
Commands and exact outcomes (distinguish baseline failures/skips): Baseline `node --experimental-global-webcrypto --test test/icon.test.js test/background-schedule.test.js`: 2 test files passed, 0 failed. Baseline SYNC command covering seven named files: 7 test files passed, 0 failed. Final `node --experimental-global-webcrypto --test test/icon.test.js test/background-schedule.test.js`: 2 test files passed, 0 failed. Final `npm test`: 411 tests passed, 0 failed, 105 suites. `npm run lint:js`: passed. `npm run test:browser`: passed the existing smoke suite — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, analytics, calendar render, provider-aware settings, options save, and cross-context lock.` `git diff --check`: passed.
Package validation and temporary-index procedure, if applicable: Not applicable; no runtime module was added and R04 has no PACKAGE-GATE requirement.
Unfinished work / precise blocker / conditional decisions: The targeted Firefox scenario required by F13 step 1 did not run. The current browser smoke cannot deterministically inject a remote provider change into the background alarm path or observe the browser action icon after all extension UI pages are closed, and no production service may be used for validation. Therefore R04 remains `needs-validation`; no missing browser evidence was marked passed.
Next eligible session: Resume R04 validation; R05 and R06 are dependency-independent but R04 is the unfinished card being resumed.
First concrete next action (path/function/test): Add a deterministic background-alarm browser seam or disposable remote-provider test endpoint that can deliver a stop then start while UI pages are closed, then run `npm run test:browser` with assertions for the alarm-imported state and toolbar icon transitions.

### R05 — 2026-09-12

Session ID / date: R05 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: The worktree contained the completed R01–R03 changes and the R04 implementation with its required Firefox alarm-path evidence still missing; the historical plan deletions and untracked `docs/subscription-product-gaps.md` and `personal-time-logger-mysql-hardening-plan.md` were preserved, as were all unrelated source and test edits. The user explicitly authorized skipping R04, so its ledger state remains `needs-validation`.
Findings/subtasks actually completed: Completed only F20's omitted-origin-default item owned by R05. `Config` now stores the validated default `cors_origins` list, so omitted configuration and explicit `[]` use the same safe empty-list semantics. Added regression cases for omitted origins, explicit empty origins, malformed Firefox-origin configuration, and malformed origin-list values; retained the existing allowed and denied origin cases.
Files changed (include new/untracked runtime files): `server/mysql-api/src/Config.php`, `server/mysql-api/tests/config_test.php`, `server/mysql-api/README.md`, and this plan. No server token, schema, authentication, or origin-allowance policy was broadened.
Behavior and compatibility decisions: The constructor retains optional `cors_origins`; it normalizes the validated fallback into the readonly configuration rather than making the key required. Exact configured web-origin matching and the existing UUID-limited Firefox-origin rule are unchanged. The README now states that omitted `cors_origins` is equivalent to `[]`.
Tests added/replaced/removed; replacement coverage for each removal: Added focused configuration assertions; no tests were removed or replaced.
Commands and exact outcomes (distinguish baseline failures/skips): Baseline `php server/mysql-api/tests/config_test.php`: passed (`Config CORS checks passed.`). Baseline `php server/mysql-api/tests/validator_test.php`: passed (`validator tests passed`). Baseline `php -l server/mysql-api/src/Config.php`: passed (`No syntax errors detected`). Final `php server/mysql-api/tests/config_test.php`: passed (`Config CORS checks passed.`); final `php server/mysql-api/tests/validator_test.php`: passed (`validator tests passed`); final `php -l server/mysql-api/src/Config.php`: passed; final `php -l server/mysql-api/tests/config_test.php`: passed. Final `git diff --check`: passed. Relative README links to `sql/001_initial_schema.sql`, `config.example.php`, and `tests/README.md` were checked and all target files exist. No PHP warning or TypeError occurred in the omitted-origin case.
Package validation and temporary-index procedure, if applicable: Not applicable; R05 changes no extension package files.
Unfinished work / precise blocker / conditional decisions: The remaining F20 operational-support items are outside R05: backup restoration, token replacement, schema-upgrade procedure, and disposable-server coverage remain unchecked for later R33 cards. R04 remains `needs-validation` because its targeted Firefox remote stop/start alarm reproduction was not run; this is an explicit user-authorized skip, not a passed validation. No real MySQL integration, browser, full JavaScript suite, deployment, or release validation was claimed for R05.
Next eligible session: R06 — Reproduce deletion resurrection and settle a compatible policy.
First concrete next action (path/function/test): Run the R06 SYNC/PROVIDER baseline command, then inspect `extension/src/sync.js` purge/push/pull behavior, provider cleanup implementations, and the backup/migration paths before building the synthetic two-profile scenarios.

### R06 — 2026-09-12

Session ID / date: R06 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`; completed R01–R05 changes and the R04 implementation were present. R04 remains `needs-validation` because its targeted Firefox alarm reproduction is missing, and the user explicitly authorized skipping it. The historical plan deletions, untracked product-gap/MySQL-plan documents, and all unrelated source/test edits were preserved.
Findings/subtasks actually completed: Completed all three R06-owned F06 investigation items. Added deterministic two-profile evidence for A's expired tombstone purge, B's clean old copy, B's offline edit, a genuinely new unsent ID, and an old-backup restore across Google Sheets, MySQL, and Cloudflare D1 contract doubles. Recorded the decision to retain existing tombstones without a new wire/schema shape and require explicit handling for previously synchronized or unproven-provenance records that are absent remotely.
Files changed (include new/untracked runtime files): `test/tombstone-policy-investigation.test.js` and this plan. No production sync, provider, backup, API, or schema behavior was changed.
Behavior and compatibility decisions: The investigation confirms that after the current 14-day purge all providers present no remote reference, so shared `pushDirtyEntries` appends a dirty old copy; a clean old copy remains local, while new unsent IDs also append. R07 must retain existing tombstones, treat a remote tombstone as authoritative, block dirty edits against it, and distinguish genuinely new unsent entries from previously synchronized or old-backup records before any append. Older clients that already purged evidence remain an explicit unrecoverable-history limitation.
Tests added/replaced/removed; replacement coverage for each removal: Added one investigation test; no tests were removed or replaced. The test uses deterministic provider contract doubles rather than live services. It was first used to record the pre-policy outcome and was then converted during R07 to enforce the settled policy.
Commands and exact outcomes (distinguish baseline failures/skips): Baseline SYNC command covering 7 files: 7 passed, 0 failed. Baseline PROVIDER command covering 7 files: 7 passed, 0 failed. Initial new-test attempt failed with `TypeError: remoteProvider.updateEntries is not a function`; the test double was corrected before final validation. Final focused SYNC command covering 8 files including `test/tombstone-policy-investigation.test.js`: 8 passed, 0 failed; its report was `google-sheets: A purge removed tombstone; B clean retained old copy; B offline edit appended; new unsent appended; old backup appended | mysql: A purge removed tombstone; B clean retained old copy; B offline edit appended; new unsent appended; old backup appended | cloudflare-d1: A purge removed tombstone; B clean retained old copy; B offline edit appended; new unsent appended; old backup appended`. Final PROVIDER command: 7 passed, 0 failed. `npm test`: 412 tests passed, 0 failed, 106 suites. `npm run lint:js`: passed. `git diff --check`: passed. No browser, PHP/MySQL integration, D1 integration, deployment, or live-provider validation was claimed.
Package validation and temporary-index procedure, if applicable: Not applicable; only a test and documentation were added, with no extension package changes.
Unfinished work / precise blocker / conditional decisions: F06 is investigated but not implemented; R07 owns the production retention/conflict/recovery change. The decision deliberately does not promise recovery when an older client has already erased the tombstone. R07 does not need backend/schema child cards for this decision because it retains the existing tombstone shape; if implementation evidence contradicts that, split provider-specific children before changing a backend contract.
Next eligible session: R07 — Implement the settled deletion-retention policy.
First concrete next action (path/function/test): Run the R07 SYNC, PROVIDER, and BACKUP baselines, then update `extension/src/sync.js` and the investigation tests so retained tombstones and missing previously synchronized IDs cannot enter the automatic append path.

### R07 — 2026-09-12

Session ID / date: R07 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`; completed R01–R06 changes and the R04 implementation were present. R04 remains `needs-validation` because its targeted Firefox alarm reproduction is missing, and the user explicitly authorized skipping it. The historical plan deletions, untracked product-gap/MySQL-plan documents, and all unrelated source/test edits were preserved.
Findings/subtasks actually completed: Completed R07's F06 implementation. Existing tombstones are retained; a dirty live edit cannot overwrite a retained remote tombstone automatically; a previously synchronized local ID missing from a snapshot and an old-backup restore are blocked from automatic append; genuinely new unsent IDs retain append behavior; explicit Reconcile choices clear the recovery hold. No F06 investigation checkbox was changed because R06 had already completed those checkboxes.
Files changed (include new/untracked runtime files): `extension/src/setting-keys.js`, `extension/src/sync.js`, `extension/src/backup.js`, `extension/src/reconcile.js`, `test/tombstone-policy-investigation.test.js`, `test/reconciliation-actions.test.js`, `README.md`, `docs/architecture.md`, and this plan. No provider API, wire format, or backend schema was changed.
Behavior and compatibility decisions: Retention uses the existing full tombstone shape indefinitely, preserving provider compatibility. Sync records a local recovery-required marker and diagnostic while blocking stale or unproven-provenance append candidates. Backup restore records newly added IDs as pending recovery evidence without exporting that local-only setting. Keep Local for an absent remote entry explicitly clears its prior synchronization evidence and pending marker, authorizing a deliberate append on a later sync; Keep Remote and Delete Everywhere also clear the marker. Older clients that already purged evidence remain unrecoverable by remote-absence inference.
Tests added/replaced/removed; replacement coverage for each removal: Converted `test/tombstone-policy-investigation.test.js` from observation to provider-parity regression coverage; it now uses one deleted ID across both profiles and checks retained tombstones, clean import, dirty-tombstone blocking, missing-synchronized-ID blocking, new-unsent append, and old-backup blocking for Google Sheets, MySQL, and Cloudflare D1 contract doubles. Added the explicit missing-ID Reconcile recovery test in `test/reconciliation-actions.test.js`. No tests were removed.
Commands and exact outcomes (distinguish baseline failures/skips): Final focused SYNC command covering 8 files: 8 passed, 0 failed. Final PROVIDER command covering 7 files: 7 passed, 0 failed. Final BACKUP command covering 4 files: 4 passed, 0 failed. `npm test`: 413 tests passed, 0 failed, 106 suites (the only subsequent code edit was removal of an unused constant; the affected reconciliation/tombstone tests were rerun afterward). `npm run lint:js`: passed after the final code edit. Focused `node --experimental-global-webcrypto --test test/reconciliation-actions.test.js test/tombstone-policy-investigation.test.js`: 2 passed, 0 failed. `git diff --check`: passed. No browser, PHP/MySQL integration, D1 integration, live-provider, deployment, or package validation was claimed.
Package validation and temporary-index procedure, if applicable: Not applicable; R07 changed existing extension modules and tests but did not add a runtime module or change packaging/build behavior.
Unfinished work / precise blocker / conditional decisions: R07 is complete. The policy cannot recover deletion history already erased by an older client or an old backup; those cases remain explicit user-directed reconciliation/rebootstrap work. R04 remains `needs-validation` by explicit user-authorized skip, not by a passed Firefox validation.
Next eligible session: R08 — Make backups and restore usable without synchronization.
First concrete next action (path/function/test): Run the R08 BACKUP baseline command, then inspect `extension/src/backup.js`, the local snapshot functions in `extension/src/db.js`, `extension/options/options-settings.js`, `test/backup.test.js`, and legacy backup fixtures before changing export preflight or restore semantics.

### R08 — 2026-09-12

Session ID / date: R08 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`; completed R01–R07 changes were present. R04 remains `needs-validation` because its targeted Firefox alarm reproduction is missing, and the user explicitly authorized skipping it. The historical plan deletions, untracked product-gap/MySQL-plan documents, and all unrelated source/test edits were preserved.
Findings/subtasks actually completed: Completed R08's F02 model/export work. Schema-v1 portable serialization now canonicalizes entries and clears transport bookkeeping for dirty local records without mutating live state. The F02 pending-state representation checkbox was completed; F02's offline Options access, local restore wiring, and conflict-preview items remain for R09/R10.
Files changed (include new/untracked runtime files): `extension/src/backup.js`, `test/backup.test.js`, and this plan. Existing R07 files and unrelated work were not altered by R08. No new runtime module, provider API, wire format, or database schema was added.
Behavior and compatibility decisions: `readPortableBackupSnapshot` and `serializeBackup` retain schema version 1 and emit canonical entries with `dirty: false`, empty `last_sync_at`, and empty `sync_error`; active entries, tombstones, and dirty source entries are all captured from one coherent readonly snapshot. Restore still merges by ID, leaves differing existing records unchanged as conflicts, and makes newly added IDs dirty. The existing parser remains strict for malformed/duplicate/noncanonical dirty backup records while canonical v1 backups remain readable. Secret settings remain excluded. Options still performs successful-sync preflight by design until R09.
Tests added/replaced/removed; replacement coverage for each removal: Expanded `test/backup.test.js` to cover active entries, tombstones, dirty-source normalization and live-state preservation, v1 round-trip, conflict-preserving/idempotent restore, duplicate IDs, malformed records, and size bounds. No tests were removed.
Commands and exact outcomes (distinguish baseline failures/skips): Baseline BACKUP command (`node --experimental-global-webcrypto --test test/backup.test.js test/options-settings.test.js test/atomic-entries.test.js test/storage-migration.test.js`): 4 passed, 0 failed. Final same BACKUP command: 4 passed, 0 failed. Final `npm test`: 414 tests passed, 0 failed, 106 suites. Final `npm run lint:js`: passed. Final `git diff --check`: passed. No browser, PHP/MySQL integration, D1 integration, live-provider, package, deployment, or network validation was claimed.
Package validation and temporary-index procedure, if applicable: Not applicable; R08 changed an existing extension module and test but did not add a runtime module or alter packaging/build behavior.
Unfinished work / precise blocker / conditional decisions: R08 is complete. Export and restore controls still require the existing successful-sync preflight in Options; removing that prerequisite and making the controls available to offline/unconfigured users is R09. The 128 MiB limit and its still-inaccurate alternate-recovery wording remain for R10's documentation/preview card.
Next eligible session: R09 — Wire offline backup/restore and first-run access.
First concrete next action (path/function/test): Run the R09 BACKUP/PROVIDER baseline and inspect `extension/options/options.js`, the backup controls in `extension/options/options.html`, local migration/exclusion helpers, and the browser smoke setup before removing only the remote preflight and adding offline first-run coverage.

### R09 — 2026-09-12

Session ID / date: R09 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`; completed R01–R08 changes were present. R04 remains `needs-validation` because its targeted Firefox alarm reproduction is missing, and the user explicitly authorized skipping it. The historical plan deletions, untracked product-gap/MySQL-plan documents, and all unrelated source/test edits were preserved.
Findings/subtasks actually completed: Completed the remaining F02 items owned by R09: local export without provider availability, atomic conflict-preserving restore without remote preflight, first-run recovery access, and separate local-restore versus follow-up-sync status. All four F02 checkboxes are now complete.
Files changed (include new/untracked runtime files): `extension/options/options.js`, `extension/options/options.html`, `extension/options/options.css`, `scripts/browser-runtime-smoke.mjs`, `README.md`, and this plan. Existing R01–R08 changes and unrelated work were preserved. No provider API, wire format, database schema, or runtime dependency was added.
Behavior and compatibility decisions: Export and restore claim the shared `sync_lock` only around local IndexedDB work, preventing overlap with sync or migration while keeping network calls outside the local transaction/lease. Export captures the local v1 snapshot directly. Restore commits locally first, preserves differing IDs as conflicts, then attempts one follow-up sync; a failed sync leaves the local result committed and reports synchronization as pending. The first-run setup exposes local backup controls before any backend is established.
Tests added/replaced/removed; replacement coverage for each removal: Added browser-smoke coverage for first-run backup controls, dirty local export, simulated migration-lock contention, concurrent conflict preservation, restored-new-entry dirtiness, and failed follow-up synchronization. No tests were removed.
Commands and exact outcomes (distinguish baseline failures/skips): Baseline BACKUP command (`node --experimental-global-webcrypto --test test/backup.test.js test/options-settings.test.js test/atomic-entries.test.js test/storage-migration.test.js`): 4 passed, 0 failed. Baseline PROVIDER command (`node --experimental-global-webcrypto --test test/remote-provider.test.js test/remote-cloudflare-d1.test.js test/remote-versioned-mutations.test.js test/storage-migration.test.js test/reconciliation-intent.test.js test/reconcile.test.js test/provider-setup-controller.test.js`): 7 passed, 0 failed. Final BACKUP command: 4 passed, 0 failed. Final PROVIDER command: 7 passed, 0 failed. Final `npm test`: 414 tests passed, 0 failed, 106 suites. Final `npm run lint:js`: passed. Final `node --check scripts/browser-runtime-smoke.mjs`: passed. Final `npm run test:browser`: passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, and cross-context lock.` Final `git diff --check`: passed.
Package validation and temporary-index procedure, if applicable: Not applicable; R09 changed existing Options files and the existing smoke script but did not add a runtime module or alter packaging/build behavior. The browser smoke did prepare and load the extension package as part of its normal validation.
Unfinished work / precise blocker / conditional decisions: R09 is complete. R10 still owns preview/report completeness and the 128 MiB oversized-backup recovery wording. No live backend or production service was used; browser validation used the local extension and a deliberately unavailable backend for the pending-sync path. R04 remains `needs-validation` by explicit user-authorized skip.
Next eligible session: R10 — Add restore preview and complete conflict reporting.
First concrete next action (path/function/test): Run the R10 BACKUP baseline and inspect the backup model and Options restore flow before adding a preview that recomputes conflicts transactionally and preserves the complete report when follow-up sync fails.

### R10 — 2026-09-12

Session ID / date: R10 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: The worktree already contained the completed R01–R09 slices, the explicitly user-authorized R04 `needs-validation` state, the historical plan deletions, untracked product-gap/MySQL-plan documents, and unrelated source/test edits. Those changes were preserved; R10 touched only the backup, Options, browser-smoke, README, and plan paths described below.

Findings/subtasks actually completed: Completed all four F03 checkboxes. Backup restore now previews additions, identical entries, conflicts with field differences, and allowed setting changes; the settings choice can be cleared for entries-only restore and appearance remains separate. The final local report retains added/identical/conflict details and setting changes when follow-up sync is pending. Commit-time conflict decisions are recomputed inside the existing local transaction. The 128 MiB limitation now accurately states that chunked import and alternate recovery are unsupported.

Files changed for R10: `extension/src/backup.js`, `extension/options/options.js`, `extension/options/options.html`, `extension/options/options.css`, `test/backup.test.js`, `scripts/browser-runtime-smoke.mjs`, `README.md`, and this plan. No provider API, wire format, schema, secret setting, or chunked import implementation was added.

Behavior and compatibility decisions: Schema-v1 backups remain unchanged and secret settings remain excluded. Preview and report content is created with DOM text nodes, so project/task/field values containing markup are displayed literally. A preview releases its local lock while the user decides; restore reacquires the lock and recomputes current conflicts transactionally, preserving newer local edits. The report lists every added and identical entry, every changed selected setting, and every conflict detail. A backup with no selected settings restores entries only.

Tests added/replaced/removed; replacement coverage for each removal: Added model coverage for preview categories, settings changes, entries-only restore, and a newer local edit after preview. Extended browser smoke coverage for preview/report counts, pending synchronization, complete conflict text, and hostile text with zero generated `img`/`script` elements. No tests were removed or replaced.

Commands and exact outcomes (distinguish baseline failures/skips): Baseline `node --experimental-global-webcrypto --test test/backup.test.js test/options-settings.test.js test/atomic-entries.test.js test/storage-migration.test.js`: 4 passed, 0 failed. Final same focused command: 4 passed, 0 failed. Final `npm test`: 74 test files passed, 0 failed. Final `npm run lint:js`: passed. Final `node --check scripts/browser-runtime-smoke.mjs`: passed. The first browser attempt was not validation because the sandbox denied loopback with `listen EPERM` on `127.0.0.1`; the elevated retry initially exposed and then corrected a stale smoke assertion expecting the old transient status. Final elevated `npm run test:browser`: passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, and cross-context lock.` Final `git diff --check`: passed.

Package validation and temporary-index procedure, if applicable: No new runtime module or packaging boundary was added, so no temporary-index/package-gate procedure was needed. The browser smoke loaded the prepared extension as part of its successful validation.

Unfinished work / precise blocker / conditional decisions: R10 is complete. Chunked import remains intentionally out of scope; files over 128 MiB require a smaller backup. No live backend or production service was used. R04 remains `needs-validation` because the targeted Firefox remote stop/start alarm reproduction was explicitly authorized to be skipped; this is not counted as passed validation.

Next eligible session: R11 — Implement the Tempo submission ledger model.
First concrete next action (path/function/test): Run the R11 TEMPO and BACKUP baseline commands, then inspect `extension/src/tempo.js`, `extension/calendar/tempo-controller.js`, `extension/background/background.js`, `extension/src/setting-keys.js`, and DB mutation helpers before adding the versioned local submission-ledger model without wiring network calls.

### R11 — 2026-09-12

Session ID / date: R11 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: The worktree already contained completed R01–R10 changes, the explicitly user-authorized R04 `needs-validation` state, historical plan deletions, untracked product-gap/MySQL-plan documents, and unrelated source/test edits. Those changes were preserved. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, ledger, findings, and handoff log.

Findings/subtasks actually completed: Completed only the first F04 persistence checkbox owned by R11. Added a version-1 local Tempo submission ledger keyed by fixed destination, entry fingerprint, local date, allocated seconds, issue ID, and author. It persists pending claims atomically, records acknowledged/rejected/unknown outcomes, blocks duplicate pending/acknowledged/unknown claims, permits known-rejection retry, preserves prior acknowledgement evidence on explicit resend, requires review for untracked history and changed same-day allocations, and exposes pending-after-restart recovery to unknown. No F04 dispatch, UI, cross-tab upload coordination, or remote API behavior was implemented.

Files changed for R11: `extension/src/tempo-submission-ledger.js` (new runtime module), `extension/src/setting-keys.js`, `extension/src/error-codes.js`, `extension/src/error-registry.js`, `test/tempo-submission-ledger.test.js` (new focused suite), `test/package.test.js`, `docs/architecture.md`, and this plan. The ledger setting is not in the portable backup setting list, and no token, description, request body, or diagnostic content is accepted by the model.

Behavior and compatibility decisions: A missing identity has `unknown-history` and requires explicit review; it is never labeled “never sent.” A changed same-day allocation requires review and creates a separate claim when approved. Different civil-day allocations have independent identities. Pending claims are not automatically replayed; `recoverPendingTempoClaims` changes them to `unknown`. Resending an acknowledged or unknown allocation appends a new pending record rather than overwriting the old outcome. The new error code has explicit registry guidance.

Tests added/replaced/removed; replacement coverage for each removal: Added four focused ledger tests covering versioned identity, concurrent claim exclusion, pending/acknowledged/rejected/unknown transitions, explicit resend, changed-allocation review, restart recovery, and backup exclusion. Added the new module to the package allow-list. No tests were removed or replaced.

Commands and exact outcomes (distinguish baseline failures/skips): Baseline TEMPO `node --experimental-global-webcrypto --test test/tempo.test.js test/tempo-day-selection.test.js test/time-allocation.test.js`: 3 passed, 0 failed. Baseline BACKUP `node --experimental-global-webcrypto --test test/backup.test.js test/options-settings.test.js test/atomic-entries.test.js test/storage-migration.test.js`: 4 passed, 0 failed. Final focused combined ledger/TEMPO/BACKUP command covering 8 files: 8 passed, 0 failed. Final temporary-index `npm test`: 75 test files passed, 0 failed. Final temporary-index `npm run lint:js`: passed. Final temporary-index `git diff --check`: passed. Final temporary-index package gate `node --experimental-global-webcrypto --test test/package.test.js test/create-update-site.test.js`: 2 passed, 0 failed. Final temporary-index `npm run lint:extension`: passed with 0 errors, 0 notices, and 0 warnings; its update-check warning was environmental. The ordinary worktree `npm test` package case was not counted as a final pass because the intentionally untracked new runtime module is omitted from the real-index package; the temporary index at `/tmp/ptl-package-check.95fNjJ` admitted only `extension/src/tempo-submission-ledger.js` and produced the passing package/full-gate results. No browser, live Tempo, backend, deployment, or network validation was required or claimed for this model-only card.

Package validation and temporary-index procedure, if applicable: Used a copied index and separate object directory under `/tmp/ptl-package-check.95fNjJ`; ran `git add -- extension/src/tempo-submission-ledger.js` only inside that temporary environment. The real index remained unchanged, and ordinary `git status --short` still shows the new module untracked.

Unfinished work / precise blocker / conditional decisions: R11 is complete. The ledger is persistence-only; it is not yet called by Tempo dispatch, so existing sends still have the prior duplicate behavior until R12. R04 remains `needs-validation` because its targeted Firefox alarm scenario was explicitly skipped and is not counted as passed. R12 must decide how its real background upload path maps response outcomes and persists each chunk.

Next eligible session: R12 — Make background Tempo dispatch use durable claims.
First concrete next action (path/function/test): Run the R12 TEMPO, ledger, and UI/browser baselines, then inspect `extension/background/background.js`, `extension/src/tempo.js`, `extension/calendar/tempo-controller.js`, and the ledger API before routing each validated worklog chunk through durable claims.

### R12 — 2026-09-12

Session ID / date: R12 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Starting revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The worktree already contained the completed R01–R11 slices, the explicitly user-authorized R04 `needs-validation` state, historical plan deletions, untracked product-gap/MySQL-plan documents, and unrelated source/test edits. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, session ledger, referenced findings, and latest handoff. All unrelated changes were preserved.

Findings/subtasks actually completed: Completed only R12's F04 background-dispatch work. The exact calendar sender and complete allocation payload are validated before any claim. The background runtime-message handler routes each chunk through atomic ledger claims, sends only claimable allocations, and records each dispatched chunk as `acknowledged`, `rejected`, or `unknown` before another retry can proceed. Concurrent handler calls cannot dispatch the same allocation. Startup recovery runs once per background handler instance and converts leftover pending claims to `unknown`, so an active concurrent upload is not mistaken for a restart. Updated only the F04 checkboxes for background coordination and per-chunk acknowledged/unknown progress; F04 preview/resend and remote capability items remain unchecked for R13/R35.

Files changed for R12: `extension/background/background.js`, `extension/src/tempo-upload-handler.js` (new), `extension/src/tempo.js`, `test/tempo-upload-handler.test.js` (new), `test/tempo.test.js`, `test/package.test.js`, `docs/architecture.md`, and this plan. The internal entry fingerprint is attached to prepared allocations for ledger identity and is stripped from the Tempo wire body. No Tempo endpoint, authorization header, provider contract, database schema, or live remote data was changed.

Behavior and compatibility decisions: The calendar remains the preparation/confirmation context, while the background handler is the sole privileged Tempo dispatch boundary. Known HTTP rejection remains retryable; timeout, request failure, and unreadable response body become `unknown` and are never automatically replayed. The existing broad calendar confirmation is treated as explicit review for untracked or changed allocations until R13 supplies per-allocation preview and resend controls. Startup recovery is not performed on every upload, avoiding a race where a second tab could resolve an in-flight claim as a restart.

Tests added/replaced/removed; replacement coverage for each removal: Added `test/tempo-upload-handler.test.js` coverage for sender/payload validation before claims, privileged XHR success, concurrent claims, startup recovery, known denial and retry, timeout/lost request, and malformed response body. Updated `test/tempo.test.js` for internal fingerprint preparation, wire metadata stripping, and the new background-handler boundary; no tests were removed.

Commands and exact outcomes (distinguish baseline failures/skips): Final focused `node --experimental-global-webcrypto --test test/tempo-upload-handler.test.js test/tempo.test.js test/tempo-submission-ledger.test.js`: 3 test files passed, 0 failed. Final temporary-index `npm test`: 76 test files passed, 0 failed. Final `npm run lint:js`: passed. Final temporary-index `npm run lint:extension`: passed with 0 errors, 0 notices, and 0 warnings; `web-ext` printed its environmental update-check warning only. Final temporary-index package gate `node --experimental-global-webcrypto --test test/package.test.js test/create-update-site.test.js`: 2 test files passed, 0 failed. Final `npm run test:browser`: passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, and cross-context lock.` Final `git diff --check`: passed. No live Tempo, backend integration, deployment, or network write was performed or claimed.

Package validation and temporary-index procedure, if applicable: Because both `extension/src/tempo-submission-ledger.js` and the new `extension/src/tempo-upload-handler.js` are intentionally untracked until handoff, full/package gates used copied indexes and separate object directories under `/tmp/ptl-r12-full.0zT8Sc` and `/tmp/ptl-r12-package.AAAjSL`; only those two runtime files were staged in each temporary index. The real Git index was not changed. The package allow-list now includes the handler beside the ledger.

Unfinished work / precise blocker / conditional decisions: R12 is complete. R13 still owns the inline Tempo mapping/submission preview, default-unsent filtering, explicit resend controls, and completion of F01/F04/F05 UI behavior. R04 remains `needs-validation` because the targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization; it is not counted as passed. No remote Tempo capability verification was performed; that remains conditional R35 work.

Next eligible session: R13 — Build one Tempo mapping and submission preview.
First concrete next action (path/function/test): Run the R13 TEMPO/UI baselines, then inspect `extension/calendar/tempo-controller.js`, `extension/calendar/calendar.html`, `extension/calendar/calendar.css`, and the ledger read APIs before replacing sequential mapping prompts with one editable preview that preserves typed values and marks acknowledged/changed/unknown allocations for explicit review.

### R13 — 2026-09-12

Session ID / date: R13 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Starting revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The worktree already contained completed R01–R12 changes, the explicitly user-authorized R04 `needs-validation` state, historical plan deletions, untracked product-gap/MySQL-plan documents, untracked R11/R12 Tempo runtime files, and unrelated source/test edits. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, session ledger, referenced findings, and latest R12 handoff. All unrelated changes were preserved.

Findings/subtasks actually completed: Completed R13's F01 confirmation-preview checkbox and the first two F05 checkboxes. Replaced sequential Tempo mapping prompts and the one-line confirmation with a single editable dialog showing task/project, day, issue, seconds, hours, skipped timers, and ledger state. Added row selection for untracked, changed, acknowledged, unknown, and rejected allocations; acknowledged/unknown rows require explicit resend selection, while known rejections are selected as safe retries. Invalid mapping text remains in the form with an inline error. The controller saves corrected task-only mappings, re-prepares allocations, compares the captured entry snapshot before dispatch, and rereads ledger eligibility immediately before sending. F05 project+task collision investigation and cancellation remain unchecked. The combined F04 default-unsent checkbox remains unchecked because pre-ledger history cannot yet be distinguished from newly created untracked work without a persisted feature-start marker.

Files changed for R13: `extension/calendar/tempo-controller.js`, `extension/calendar/calendar.html`, `extension/calendar/calendar.css`, `extension/src/tempo-upload-handler.js`, `test/tempo-controller.test.js` (new), `scripts/browser-runtime-smoke.mjs`, and this plan. The handler now accepts the controller's explicit resend marker while continuing to strip internal metadata from the Tempo wire body. No new runtime module, provider contract, database schema, or live remote data was added.

Behavior and compatibility decisions: The preview is page-local and uses existing task-only mappings, ledger identity, daily allocation rounding, and background runtime messaging. Untracked/changed allocations are labeled for review rather than “never sent.” A stale entry snapshot aborts before network dispatch, and a claim that becomes ineligible during the preview is rejected before dispatch. The preview remains bounded by a scrollable table; skipped running, excluded-day, and zero-second allocations are summarized. The current task-only mapping is retained because project+task collisions have not been reproduced.

Tests added/replaced/removed; replacement coverage for each removal: Added `test/tempo-controller.test.js` for preview row presentation, mapping correction/re-preparation, selected-row dispatch, and stale-snapshot rejection. Extended `scripts/browser-runtime-smoke.mjs` to exercise the real dialog, daily rows, untracked statuses, invalid mapping preservation, and selected send. No tests were removed or replaced.

Commands and exact outcomes (distinguish baseline failures/skips): Baseline TEMPO `node --experimental-global-webcrypto --test test/tempo.test.js test/tempo-day-selection.test.js test/time-allocation.test.js`: 3 test files passed, 0 failed. Final focused `node --experimental-global-webcrypto --test test/tempo-controller.test.js test/tempo.test.js test/tempo-day-selection.test.js test/time-allocation.test.js`: 4 test files passed, 0 failed. Final temporary-index `npm test`: 77 test files passed, 0 failed. Final `npm run lint:js`: passed. Final `node --check scripts/browser-runtime-smoke.mjs`: passed. The first ordinary `npm run test:browser` attempt was not counted: the prepared package omitted the intentionally untracked R11 ledger module imported by the R13 controller, and the calendar page remained `not started`. A temporary-index browser attempt then failed with sandbox `listen EPERM` on `127.0.0.1`; the subsequent elevated attempt timed out because the smoke exposed retained native custom validity after its intentional invalid mapping. After clearing validity on input and dispatching the corresponding input event, final elevated temporary-index `npm run test:browser` passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, and cross-context lock.` Final temporary-index `npm run lint:extension`: passed with 0 errors, 0 notices, and 0 warnings; `web-ext` printed its environmental update-check warning only. Final temporary-index package gate `node --experimental-global-webcrypto --test test/package.test.js test/create-update-site.test.js`: 2 test files passed, 0 failed. Final `git diff --check`: passed. No live Tempo, backend integration, deployment, or network write was performed or claimed.

Package validation and temporary-index procedure, if applicable: Browser, full-test, extension-lint, and package gates used copied indexes and separate object directories under `/tmp/ptl-r13-browser.JCZVWe` (final browser validation), `/tmp/ptl-r13-full.NKKcy1`, and `/tmp/ptl-r13-package.mLEXSP`; each temporary index admitted only the existing untracked runtime dependencies `extension/src/tempo-submission-ledger.js` and `extension/src/tempo-upload-handler.js`. The real Git index remained unchanged. The browser/package result validates the current working-tree UI with those dependencies present; the ordinary package omission remains a staging-state limitation, not a release claim.

Unfinished work / precise blocker / conditional decisions: R13 is complete. R14 owns cancellation between chunks, partial-upload reopening, acknowledged/rejected/unknown recovery presentation, and closure/account/mapping recovery cases. F04's combined default-unsent/pre-ledger distinction remains incomplete as documented above. R04 remains `needs-validation` because the targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization; it is not counted as passed. No remote Tempo capability verification was performed; that remains conditional R35 work.

Next eligible session: R14 — Finish Tempo cancellation and recovery flow.
First concrete next action (path/function/test): Run the R14 TEMPO/UI baselines, then inspect `extension/calendar/tempo-controller.js`, `extension/src/tempo.js`, `extension/src/tempo-upload-handler.js`, the ledger read APIs, and current browser smoke before adding cancellation between chunks and honest recovery for acknowledged, rejected, and unknown outcomes.

### R14 — 2026-09-12

Session ID / date: R14 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Starting revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The worktree already contained the completed R01–R13 slices, the explicitly user-authorized R04 `needs-validation` state, historical plan deletions, untracked product-gap/MySQL-plan documents, untracked R11/R12 Tempo runtime modules, and unrelated source/test edits. The requested `docs/current-functionality-session-runbook.md` remains absent; this canonical improvement plan supplied the startup protocol, settled defaults, ledger, findings, and latest R13 handoff. All unrelated changes were preserved and the real Git index was not changed.

Findings/subtasks actually completed: Completed only R14's F05 cancellation/recovery checkbox. Tempo uploads now carry a page-generated operation ID. A calendar cancel request marks that operation in the background; the current privileged XHR is allowed to finish and records its acknowledged/rejected/unknown outcome, while no later chunk is claimed or sent. Cancellation progress reports acknowledged worklog count, request count, and the current request outcome. The calendar exposes a cancel-upload control during dispatch. Reopening the preview reads durable acknowledged, rejected, and unknown ledger states, so completed work is not presented as rolled back and unknown work is never replayed automatically. The F04 default-unsent/pre-ledger checkbox remains unchecked because this profile has no persisted feature-start marker that can distinguish pre-ledger history from newly untracked work. The F04 remote-capability checkbox and F05 project+task collision checkbox remain unchecked.

Files changed for R14: `extension/src/tempo.js`, `extension/src/tempo-upload-handler.js`, `extension/background/background.js`, `extension/calendar/tempo-controller.js`, `extension/calendar/calendar.js`, `extension/calendar/calendar.html`, `extension/calendar/calendar.css`, `extension/src/error-codes.js`, `extension/src/error-registry.js`, `test/tempo.test.js`, `test/tempo-upload-handler.test.js`, `test/tempo-controller.test.js`, `scripts/browser-runtime-smoke.mjs`, `README.md`, `docs/architecture.md`, and this plan. No provider contract, database schema, Tempo endpoint, or remote data was changed.

Behavior and compatibility decisions: Cancellation is cooperative and chunk-boundary based; it never aborts the current XHR or guesses whether a lost request was accepted. A cancellation arriving after a claim but before dispatch records that claim as rejected because no request was sent. Background cancellation messages require the exact calendar sender and a non-empty operation ID. The operation cancellation set is cleared when the upload handler returns. Account and task-mapping settings are reread after preview confirmation; a change aborts before dispatch and requires a fresh review. Same-profile recovery is durable through the local ledger, but different profiles/devices still cannot detect remote duplicates. Work created before the ledger existed remains untracked history requiring explicit review. The browser smoke verifies the cancel control is present and the controller unit test verifies operation signaling/cleanup; no automated test physically closes Firefox during an in-flight XHR or performs a background-process restart.

Tests added/replaced/removed; replacement coverage for each removal: Added a 51-worklog cancellation-between-chunks test proving the first 50 acknowledged allocations remain acknowledged and the second chunk is not requested. Added handler coverage for operation cancellation, per-chunk ledger persistence, lost-response recovery through a new handler instance, and no automatic replay of unknown work. Added controller coverage for account/mapping revalidation, operation-ID cancellation signaling, and upload-state cleanup. Extended browser smoke to require the calendar cancellation control. No tests were removed or replaced.

Commands and exact outcomes (distinguish baseline failures/skips): R14 baseline `node --experimental-global-webcrypto --test test/tempo.test.js test/tempo-controller.test.js test/tempo-upload-handler.test.js test/tempo-submission-ledger.test.js test/tempo-day-selection.test.js test/time-allocation.test.js`: 6 test files passed, 0 failed. Final focused command with the same six files: 6 passed, 0 failed. Final `npm run lint:js`: passed. Final `node --check scripts/browser-runtime-smoke.mjs`: passed. Final `git diff --check`: passed. Final temporary-index `npm test`: 77 test files passed, 0 failed. Final elevated temporary-index `npm run test:browser`: passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, and cross-context lock.` Final temporary-index `npm run lint:extension`: passed with 0 errors, 0 notices, and 0 warnings; `web-ext` printed its environmental update-check warning only. No live Tempo, backend integration, deployment, or network write was performed or claimed.

Package validation and temporary-index procedure, if applicable: Full/package/browser/extension-lint gates used the copied index and separate object directory `/tmp/ptl-r14-full.vxLmDo`; only the existing untracked runtime dependencies `extension/src/tempo-submission-ledger.js` and `extension/src/tempo-upload-handler.js` were admitted in that temporary index. The real Git index remained unchanged. The elevated browser run was required because the sandbox cannot bind the smoke server to loopback; this is an environment constraint, not a product failure.

Unfinished work / precise blocker / conditional decisions: R14 is complete. The default-unsent distinction for pre-ledger history remains incomplete because no persisted feature-start marker exists; untracked history therefore stays explicitly review-only. The project+task mapping collision investigation and remote Tempo capability verification remain conditional R35 work. Physical browser/page-close and Firefox background-restart coverage during an in-flight upload remain unautomated, although the durable-handler reopen test covers the persisted ledger recovery path. R04 remains `needs-validation` because the targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization; it is not counted as passed.

Next eligible session: R15 — Add actionable stale/competing timer warnings.
First concrete next action (path/function/test): Run the R15 ENTRY/UI baselines, then inspect `extension/popup/popup.js`, the active/history renderers, `extension/src/entries.js`, and the existing stale-timer threshold/analytics tests before adding guarded Edit/Stop actions and competing-timer details without changing timer records automatically.

### R15 — 2026-09-12

Session ID / date: R15 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Starting revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The worktree already contained completed R01–R14 changes, the explicitly user-authorized R04 `needs-validation` state, historical plan deletions, untracked product-gap/MySQL-plan documents, untracked R11/R12 Tempo runtime modules, and unrelated source/test edits. The requested `docs/current-functionality-session-runbook.md` remains absent; this canonical improvement plan supplied the startup protocol, settled defaults, ledger, findings, and latest R14 handoff. All unrelated changes were preserved and the real Git index was not changed.

Findings/subtasks actually completed: Completed only the first two F07 checkboxes. The popup now reuses Analytics' `STALE_ACTIVE_SECONDS` eight-hour threshold to show an inline warning for unusually old active timers, with explicit Edit and Stop actions. When multiple active timers exist, every active record is listed with task, local start time, device ID, and independent guarded actions. Stop actions pass the displayed entry revision through the existing atomic mutation path; no timer is changed automatically. The F07 opt-in reminder/notification checkbox remains unchecked and no notification permission was added.

Files changed for R15: `extension/src/popup-active-state.js`, `extension/popup/popup.js`, `extension/popup/popup.css`, `scripts/browser-runtime-smoke.mjs`, `test/popup-render-state.test.js`, `README.md`, `docs/architecture.md`, and this plan. No entry schema, mutation contract, notification permission, or automatic-stop behavior was changed.

Behavior and compatibility decisions: The existing Analytics threshold is the single stale policy: a timer becomes actionable at eight hours, including an overnight timer. Warning rendering is derived from the active-entry read and does not write status or timestamps. Competing timers remain independently visible even when only the newest timer is shown in the primary active panel. The existing revision guard handles a stale warning action; if another context changes a timer first, the action reports the normal storage conflict and refreshes. Notification reminders and automatic stopping remain explicitly out of scope.

Tests added/replaced/removed; replacement coverage for each removal: Added popup active-state coverage for an overnight timer at the threshold and for two independent active records with device metadata, including assertions that warning calculation does not mutate the records. Extended browser smoke to create an overnight timer plus a competing timer, verify both warning action sets and start/device context, stop one timer, and verify the unrelated timer remains active. No tests were removed or replaced.

Commands and exact outcomes (distinguish baseline failures/skips): R15 baseline `node --experimental-global-webcrypto --test test/entries.test.js test/atomic-entries.test.js test/entry-form.test.js test/entry-editor.test.js test/time.test.js test/calendar-layout.test.js test/calendar-gesture-state.test.js`: 7 test files passed, 0 failed. Final focused `node --experimental-global-webcrypto --test test/popup-render-state.test.js test/entries.test.js test/atomic-entries.test.js test/entry-form.test.js test/entry-editor.test.js test/time.test.js test/calendar-layout.test.js test/calendar-gesture-state.test.js`: 8 test files passed, 0 failed. Final `npm run lint:js`: passed. Final `node --check scripts/browser-runtime-smoke.mjs`: passed. Final `git diff --check`: passed. The first browser attempt was not counted because its new post-stop assertion incorrectly expected the remaining non-stale timer to stay in the warning; after correcting that assertion, final elevated temporary-index `npm run test:browser` passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, and cross-context lock.` Final temporary-index `npm test`: 77 test files passed, 0 failed. Final temporary-index `npm run lint:extension`: passed with 0 errors, 0 notices, and 0 warnings; `web-ext` printed its environmental update-check warning only. No live provider, backend integration, deployment, or network write was performed or claimed.

Package validation and temporary-index procedure, if applicable: Browser, full-test, and extension-lint gates used the copied index and separate object directory `/tmp/ptl-r15-browser.kJfoRa`; only the existing untracked runtime dependencies `extension/src/tempo-submission-ledger.js` and `extension/src/tempo-upload-handler.js` were admitted in that temporary index. The real Git index remained unchanged. The elevated browser run was required because the sandbox cannot bind the smoke server to loopback; this is an environment constraint, not a product failure.

Unfinished work / precise blocker / conditional decisions: R15 is complete. F07's optional notification/reminder checkbox remains incomplete by settled default, with no blocker to the completed inline warning scope. R04 remains `needs-validation` because the targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization; it is not counted as passed. Existing pre-ledger Tempo history, remote Tempo capability verification, and other conditional work remain unchanged.

Next eligible session: R16 — Add a direct completed-entry flow.
First concrete next action (path/function/test): Run the R16 ENTRY/UI baselines, then inspect `extension/src/entries.js`, `extension/src/entry-editor.js`, `extension/src/entry-form.js`, `extension/calendar/calendar.js`, and their existing tests before adding a local completed-entry creation path that leaves any active timer unchanged.

### R16 — 2026-09-12

Session ID / date: R16 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, findings, ledger, and latest handoff. The worktree already contained completed R01–R15 slices, the explicitly user-authorized R04 `needs-validation` state, historical plan deletions, untracked product-gap/MySQL-plan documents, untracked R11/R12 Tempo runtime modules, and unrelated source/test edits. Those changes were preserved and the real Git index was not changed.

Findings/subtasks actually completed: Completed only the first F08 checkbox for direct completed-entry creation. Added an atomic local `createCompletedEntry` operation that accepts explicit start/end timestamps, applies existing normalization, device ID, timestamps, revision, dirty-state, and multiplier rules, and never starts/stops or rewrites another timer. Added the Calendar **Add completed entry** action using the shared editor; it hides edit-only actions, requires a completed interval, and commits locally before the normal background sync attempt. Added coverage for multiplier handling, zero-duration acceptance under the current contract, missing/reversed times, nonexistent/ambiguous local times, offline/local creation, and preservation of an active timer. F08 deletion undo, merge/duplicate preview, and split-at-time items remain unchecked.

Files changed for R16: `extension/src/entries.js`, `extension/calendar/calendar.js`, `extension/calendar/calendar.html`, `extension/calendar/calendar.css`, `test/entries.test.js`, `test/time.test.js`, `scripts/browser-runtime-smoke.mjs`, `README.md`, `docs/architecture.md`, and this plan. No new runtime module, entry schema, provider contract, remote API, or database schema was added.

Behavior and compatibility decisions: A completed entry requires nonempty valid start and end times and rejects reversed intervals. Equal start/end is accepted as the existing zero-duration contract permits it; the UI does not impose a new minimum. The existing local-time decoder rejects nonexistent and ambiguous civil times. The selected/global duration multiplier is applied through the existing normalization path. New entries receive the existing UUID/device/timestamp/revision shape, are dirty for later sync, and are committed with the existing atomic mutation helper. Calendar creation uses the existing editor and leaves active entries unchanged. Network availability is not required for the local commit; a subsequent sync may report provider setup or connectivity status independently.

Tests added/replaced/removed; replacement coverage for each removal: Added model-level IndexedDB regression coverage in `test/entries.test.js` and DST-local-time coverage in `test/time.test.js`. Extended the existing browser smoke with a real Calendar add-completed-entry scenario that creates a multiplied backfill and verifies its persisted effective duration, dirty state, and preservation of an active timer. No tests were removed or replaced.

Commands and exact outcomes (distinguish baseline failures/skips): R16 baseline `node --experimental-global-webcrypto --test test/entries.test.js test/atomic-entries.test.js test/entry-form.test.js test/entry-editor.test.js test/time.test.js test/calendar-layout.test.js test/calendar-gesture-state.test.js`: 7 test files passed, 0 failed. Final focused command with the same 7 files: 7 test files passed, 0 failed. Final `npm run lint:js`: passed. Final `node --check scripts/browser-runtime-smoke.mjs`: passed. Final `git diff --check`: passed. Final temporary-index `npm test`: 77 test files passed, 0 failed. Final temporary-index `npm run lint:extension`: passed with 0 errors, 0 notices, and 0 warnings; `web-ext` printed its environmental update-check warning only. Final elevated temporary-index `GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run test:browser`: passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, and cross-context lock.` The smoke command includes the direct Calendar completed-entry scenario; its summary string is unchanged and does not enumerate that scenario. Two earlier browser attempts were not counted: one raced the asynchronous editor opening, and one used the wrong multiplied-duration expectation; both were corrected before the final pass. No live provider, backend integration, deployment, or network write was performed or claimed.

Package validation and temporary-index procedure, if applicable: Full tests, extension lint, and browser smoke used the copied index and separate object directory `/tmp/ptl-r16-full.zHjyLc`; only the pre-existing untracked runtime dependencies `extension/src/tempo-submission-ledger.js` and `extension/src/tempo-upload-handler.js` were admitted with `git add --` inside that temporary environment. The real Git index remained unchanged. The browser run required elevation because the sandbox cannot bind the smoke server to loopback. `firefox-geckodriver` was already installed, but its executable was not on `PATH`; validation used the discovered `/usr/local/bin/geckodriver` explicitly.

Unfinished work / precise blocker / conditional decisions: R16 is complete. R17 remains eligible and owns only one recent deletion undo per page session; it must not be started in this session. R04 remains `needs-validation` because the targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization, not passed. F08's undo, merge/duplicate explanation/preview, and split-at-time evaluation remain incomplete. No live Tempo capability verification or backend integration validation was performed.

Next eligible session: R17 — Add guarded undo for deletion.
First concrete next action (path/function/test): Run the R17 ENTRY, SYNC, and UI baselines, then inspect the deletion mutation in `extension/src/entries.js`, popup/calendar deletion actions, and the existing calendar undo implementation before adding one page-session-scoped guarded tombstone undo.

### R17 — 2026-09-12

Session ID / date: R17 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, findings, ledger, and latest R16 handoff. The worktree already contained completed R01–R16 slices, the explicitly user-authorized R04 `needs-validation` state, historical plan deletions, untracked product-gap/MySQL-plan documents, untracked R11/R12 Tempo runtime modules, and unrelated source/test edits. Those changes were preserved and the real Git index was not changed.

Findings/subtasks actually completed: Completed only R17's F08 deletion-undo slice. Added `deletionUndoToken` and `undoDeletedEntry` in `extension/src/entries.js`; undo requires the exact entry ID, deletion timestamp, revision, and persisted fingerprint captured from the tombstone. A valid undo clears only that tombstone in a new dirty revision and emits the normal local-change event. A missing row, newer local/remote tombstone, replacement, or any identity/revision mismatch produces `UNDO_UNAVAILABLE` and never resurrects a different record. Popup and Calendar each expose one page-session-local **Undo deletion** action; Calendar reuses its existing single-action undo control, and both queue ordinary sync after a valid restoration. The broader F08 checkbox remains unchecked because merge/duplicate preview and split-at-time work are not part of R17.

Files changed for R17: `extension/src/error-codes.js`, `extension/src/error-registry.js`, `extension/src/entries.js`, `extension/popup/popup.html`, `extension/popup/popup.css`, `extension/popup/popup.js`, `extension/calendar/calendar.js`, `test/atomic-entries.test.js`, `scripts/browser-runtime-smoke.mjs`, `README.md`, `docs/architecture.md`, and this plan. No new runtime module, entry schema, provider contract, remote API, or database schema was added.

Behavior and compatibility decisions: Undo is deliberately bounded to the latest deletion in each page context; there is no global undo history or expiry timer. The tombstone identity includes the persisted fingerprint as well as ID, deletion timestamp, and revision, so an acknowledged deletion can be undone locally while a later local/remote decision cannot be overwritten. The mutation is compare-and-swap guarded and marks the restored record dirty for normal synchronization. If the record was physically purged or changed, the user receives explicit unavailable guidance instead of a blind resurrection. Existing move/resize Calendar undo remains available until a newer Calendar action replaces it; a Calendar deletion uses that same page-local single-action control.

Tests added/replaced/removed; replacement coverage for each removal: Added `test/atomic-entries.test.js` coverage for valid single-use undo, double undo, newer tombstone rejection, physical purge rejection, and acknowledged-deletion restoration. Added the stable error-code registry entry and its automatic registry coverage. Extended browser smoke with real Popup delete/undo and Calendar delete/undo scenarios, including preservation of an active Calendar entry. No tests were removed or replaced.

Commands and exact outcomes (distinguish baseline failures/skips): R17 baseline ENTRY `node --experimental-global-webcrypto --test test/entries.test.js test/atomic-entries.test.js test/entry-form.test.js test/entry-editor.test.js test/time.test.js test/calendar-layout.test.js test/calendar-gesture-state.test.js`: 7 test files passed, 0 failed. R17 baseline SYNC `node --experimental-global-webcrypto --test test/sync-maintenance.test.js test/sync-pull.test.js test/sync-acknowledgement.test.js test/sync-lease-fence.test.js test/sync-coalescing.test.js test/sync-config.test.js test/sync-cloudflare-recovery.test.js test/tombstone-policy-investigation.test.js`: 8 test files passed, 0 failed. Final focused `node --experimental-global-webcrypto --test test/atomic-entries.test.js test/entries.test.js test/error-registry.test.js`: 3 test files passed, 0 failed. Final ENTRY command: 7 test files passed, 0 failed. Final SYNC command: 8 test files passed, 0 failed. Final temporary-index `npm test`: 77 test files passed, 0 failed. Final `npm run lint:js`: passed. Final temporary-index `npm run lint:extension`: passed with 0 errors, 0 notices, and 0 warnings; `web-ext` printed its environmental update-check warning only. Final `node --check scripts/browser-runtime-smoke.mjs`: passed. Final `git diff --check`: passed. Final elevated temporary-index `GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run test:browser`: passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, and cross-context lock.` The current smoke also exercises Popup and Calendar deletion undo; its summary string is unchanged and does not enumerate those scenarios. No live provider, backend integration, deployment, or network write was performed or claimed.

Package validation and temporary-index procedure, if applicable: Full tests, extension lint, and browser smoke used the copied index and separate object directory `/tmp/ptl-r16-full.zHjyLc`; only the pre-existing untracked runtime dependencies `extension/src/tempo-submission-ledger.js` and `extension/src/tempo-upload-handler.js` were admitted with `git add --` inside that temporary environment. The real Git index remained unchanged. The browser run required elevation because the sandbox cannot bind the smoke server to loopback. `firefox-geckodriver` was already installed, but its executable was not on `PATH`; validation used `/usr/local/bin/geckodriver` explicitly.

Unfinished work / precise blocker / conditional decisions: R17 is complete. F08's broad undo checkbox remains incomplete until the later correction slices are complete; merge/duplicate explanation/preview and split-at-time evaluation were not changed. R04 remains `needs-validation` because its targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization, not passed. No live Tempo capability verification or backend integration validation was performed.

Next eligible session: R18 — Clarify merge/duplicate effects and review shared editor mechanics.
First concrete next action (path/function/test): Run the R18 ENTRY/UI baselines, then inspect both popup and Calendar editor flows, `extension/src/entry-form.js`, `extension/src/entry-editor.js`, and `docs/time-model.md` before adding a bounded merge/duplicate preview without changing their established storage semantics.

### R18 — 2026-09-12

Session ID / date: R18 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, findings, ledger, and latest R17 handoff. Completed R01–R17 changes, the explicitly user-authorized R04 `needs-validation` state, historical plan deletions, untracked product-gap/MySQL-plan documents, untracked R11/R12 Tempo runtime modules, and unrelated source/test edits were preserved; the real Git index was not changed.

Findings/subtasks actually completed: Completed only the third F08 checkbox, covering merge/duplicate consequences before commit. Added pure merge and duplicate previews for actual/effective duration, compacted gap or duplicate overlap, multiplier, status, and resulting interval. Popup and Calendar now confirm only after showing the preview, and confirmation rechecks captured target/source revisions. S03 was reviewed: shared editor markup and domain preview calculations reduce duplication, while save/delete/session orchestration remains page-local because selection, focus, rendering, and lifecycle rules differ; no generic page controller was introduced. F08's broader deletion-undo and split-at-time checkboxes remain unchecked.

Files changed for R18: `extension/src/entry-editor.js`, `extension/src/entry-editor.css`, `extension/src/entries.js`, `extension/popup/popup.js`, `extension/calendar/calendar.js`, `test/entry-editor.test.js`, `test/entries.test.js`, `test/atomic-entries.test.js`, `scripts/browser-runtime-smoke.mjs`, `README.md`, `docs/architecture.md`, and this plan. No entry schema, remote API, provider contract, or database schema changed.

Behavior and compatibility decisions: Merge retains the selected target's start, multiplier, and status, appends both actual elapsed durations into one contiguous interval, and tombstones the source on confirmation. The preview reports a gap in either source/target order because merge compacts the original separation. Duplicate keeps the original interval, explicitly overlaps the original, and preserves copied effective duration, multiplier, and status. Opening or cancelling a preview performs no mutation. Page-local pending state preserves each page's focus and selection ownership.

Tests added/replaced/removed; replacement coverage for each removal: Added model-level merge/duplicate preview assertions without mutation and an atomic stale target/source confirmation regression that leaves the source live. Extended Firefox smoke with Popup merge preview/confirmation and Calendar merge plus duplicate preview/confirmation, including source tombstoning and duplicate overlap. No tests were removed or replaced.

Commands and exact outcomes: R18 baseline and final ENTRY/UI `node --experimental-global-webcrypto --test test/entries.test.js test/atomic-entries.test.js test/entry-form.test.js test/entry-editor.test.js test/time.test.js test/calendar-layout.test.js test/calendar-gesture-state.test.js`: 7 test files passed, 0 failed. Final focused `node --experimental-global-webcrypto --test test/entries.test.js test/atomic-entries.test.js test/entry-form.test.js test/entry-editor.test.js`: 4 test files passed, 0 failed. Temporary-index `npm test`: 77 test files passed, 0 failed. `npm run lint:js`, `node --check scripts/browser-runtime-smoke.mjs`, and `git diff --check`: passed. Temporary-index `npm run lint:extension`: 0 errors, 0 notices, 0 warnings; only the environmental web-ext update-check warning was printed. Elevated temporary-index `GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run test:browser`: passed with the existing smoke summary; the smoke includes the new Popup merge and Calendar merge/duplicate scenarios. An earlier browser attempt failed because a future fixture was omitted by the bounded calendar query; moving it into the past and reloading the page fixed the fixture, and the final run passed. No live provider, backend integration, deployment, or network write was performed or claimed.

Package validation and temporary-index procedure: Full tests, extension lint, and browser smoke used copied index/object state under `/tmp/ptl-r16-full.zHjyLc`; only the pre-existing untracked `extension/src/tempo-submission-ledger.js` and `extension/src/tempo-upload-handler.js` were admitted there. The real Git index remained unchanged. Browser validation required elevation because the sandbox cannot bind the smoke server to loopback. `firefox-geckodriver` was installed but not on `PATH`; validation used `/usr/local/bin/geckodriver`.

Unfinished work / precise blocker / conditional decisions: R18 is complete. F08's broad undo checkbox remains incomplete because the bounded undo slice is narrower than the full wording; split-at-time remains unevaluated. R04 remains `needs-validation` because its targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization, not passed. No generic editor controller was extracted, and no live Tempo capability verification or backend integration validation was performed.

Next eligible session: R19 — Add bounded history filtering and date navigation.
First concrete next action (path/function/test): Run the R19 HISTORY/UI baselines, then inspect `extension/popup/popup.js`, `extension/src/popup-recent-groups.js`, and the bounded history query functions in `extension/src/db.js` before adding a labeled date/filter view that preserves the loaded-range boundary.

### R19 — 2026-09-12

Session ID / date: R19 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, findings, ledger, and latest R18 handoff. Completed R01–R18 changes, the explicitly user-authorized R04 `needs-validation` state, historical plan deletions, untracked product-gap/MySQL-plan documents, untracked R11/R12 Tempo runtime modules, and unrelated source/test edits were preserved; the real Git index was not changed.

Findings/subtasks actually completed: Completed all three F09 checkboxes. Popup history now supports a selected-week date jump, text/project/task/review filters, an explicit loaded-range label, separate period and filtered totals, focus restoration through rerenders, and Load more over the same bounded range. Project and task datalist suggestions are rebuilt from entries loaded for that range only. An empty selected week is reported distinctly. No all-history search, project registry, or new database index was introduced.

Files changed for R19: `extension/popup/popup.html`, `extension/popup/popup.css`, `extension/popup/popup.js`, `extension/src/popup-recent-groups.js`, `test/popup-recent-groups.test.js`, `scripts/browser-runtime-smoke.mjs`, `README.md`, `docs/architecture.md`, and this plan. Existing IndexedDB query functions and entry storage semantics were preserved.

Behavior and compatibility decisions: The normal view retains the current-week-to-older-weeks bounded history behavior and empty-current-week fallback. Jumping to a date selects its local week as the loaded range; Load more extends only toward older weeks from that selected week. Filters operate after the bounded query and cannot imply coverage outside the labeled range. Totals are calculated from the same effective-duration allocation used by grouped history. Focus is restored by control ID or entry/group identity after the list is rebuilt, while expanded group keys remain page-session-local. Suggestions are loaded values, not a separate project-management model.

Tests added/replaced/removed; replacement coverage for each removal: Added pure grouping-module tests for filter matching, loaded-field suggestions, and distinct bounded totals. Extended Firefox smoke with pagination, focused text filtering, project/review filtering, autocomplete values, an explicitly labeled empty date-jumped week, and preserved focus. No tests were removed or replaced.

Commands and exact outcomes: Focused HISTORY `node --experimental-global-webcrypto --test test/db.test.js test/popup-recent-groups.test.js test/analytics.test.js test/analytics-period.test.js test/time-allocation.test.js`: 5 test files passed, 0 failed. Final temporary-index `npm test`: 77 test files passed, 0 failed. Final `npm run lint:js`: passed. Final `node --check scripts/browser-runtime-smoke.mjs`: passed. Final `git diff --check`: passed. Final temporary-index `npm run lint:extension`: 0 errors, 0 notices, 0 warnings; web-ext printed only its environmental update-check warning. Final elevated temporary-index `GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run test:browser`: passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, and cross-context lock.` The smoke includes R19 pagination/filter/date-jump/autocomplete/focus scenarios. An earlier smoke attempt failed only because the test assigned a value without focusing the text input; the diagnostic showed filtering and totals were correct, the test setup was corrected, and the final run passed. No live provider, backend integration, deployment, or network write was performed or claimed.

Package validation and temporary-index procedure: Full tests, extension lint, and browser smoke used copied index/object state under `/tmp/ptl-r16-full.zHjyLc`; only the pre-existing untracked `extension/src/tempo-submission-ledger.js` and `extension/src/tempo-upload-handler.js` were admitted there. The real Git index remained unchanged. Browser validation required elevation because the sandbox cannot bind the smoke server to loopback. `firefox-geckodriver` was installed but not on `PATH`; validation used `/usr/local/bin/geckodriver`.

Unfinished work / precise blocker / conditional decisions: R19 is complete. R04 remains `needs-validation` because its targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization, not passed. F09 is complete; broader analytics filtering remains an independent F11 card. No full-history search, project registry, provider integration, or deployment was performed.

Next eligible session: R20 — Finish calendar keyboard editing and time explanations.
First concrete next action (path/function/test): Run the R20 ENTRY/UI baselines under the required timezone cases, then inspect `extension/calendar/calendar.js`, `extension/src/entry-form.js`, `extension/src/time.js`, and calendar layout tests before adding keyboard-equivalent editing and actual/effective time explanations without changing active-timer movement policy.

### R20 — 2026-09-12

Session ID / date: R20 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, findings, ledger, and latest R19 handoff. Completed R01–R19 changes, the explicitly user-authorized R04 `needs-validation` state, historical plan deletions, untracked product-gap/MySQL-plan documents, untracked R11/R12 Tempo runtime modules, and unrelated source/test edits were preserved; the real Git index was not changed.

Findings/subtasks actually completed: Completed all four F10 checkboxes. Calendar entries remain keyboard-selectable with Enter/Space, editable through ordinary start/end controls, cancellable with Escape, and focus returns to the selected entry after cancellation or rerender. The shared editor now exposes displayed timezone, actual duration, effective duration, multiplier, and a visual-tail explanation. Ambiguous and nonexistent local times produce actionable correction messages while rejection behavior remains unchanged. Active timers remain prohibited from pointer movement.

Files changed for R20: `extension/src/entry-editor.js`, `extension/src/entry-editor.css`, `extension/src/entry-form.js`, `extension/calendar/calendar.js`, `test/entry-editor.test.js`, `test/entry-form.test.js`, `scripts/browser-runtime-smoke.mjs`, `README.md`, `docs/architecture.md`, and this plan. No entry schema, gesture mutation, provider contract, or database schema changed.

Behavior and compatibility decisions: Keyboard editing uses the existing shared editor rather than recreating pointer gestures with arrow keys; changing start/end remains the accessible equivalent of moving/resizing. Escape closes the calendar editor and restores focus to the selected block after the local rerender. The time summary uses the browser's resolved timezone and distinguishes actual elapsed time from stored effective duration; multiplier-added tails remain visual. Ambiguous repeated-hour input is rejected with guidance to choose a different local time because no occurrence selector is introduced in this slice. Active-timer movement remains disabled.

Tests added/replaced/removed; replacement coverage for each removal: Extended shared editor mounting coverage for the time summary control. Added entry-form assertions for actionable nonexistent/ambiguous-time messages. Extended Firefox smoke with keyboard entry selection, time-summary content, Escape cancellation, and focus restoration. Lisbon and Lord Howe timezone runs exercised the ENTRY group. No tests were removed or replaced.

Commands and exact outcomes: `TZ=Europe/Lisbon node --experimental-global-webcrypto --test test/entries.test.js test/entry-form.test.js test/entry-editor.test.js test/time.test.js test/calendar-layout.test.js test/calendar-gesture-state.test.js`: 6 test files passed, 0 failed. `TZ=Australia/Lord_Howe node --experimental-global-webcrypto --test test/entries.test.js test/entry-form.test.js test/entry-editor.test.js test/time.test.js test/calendar-layout.test.js test/calendar-gesture-state.test.js`: 6 test files passed, 0 failed. Final `npm run lint:js`, `node --check scripts/browser-runtime-smoke.mjs`, and `git diff --check`: passed. Final temporary-index `npm test`: 77 test files passed, 0 failed. Final temporary-index `npm run lint:extension`: 0 errors, 0 notices, 0 warnings; web-ext printed only its environmental update-check warning. Final elevated temporary-index `GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run test:browser`: passed with the existing smoke summary; the smoke includes the R20 keyboard/time-summary/Escape scenario. No live provider, backend integration, deployment, or network write was performed or claimed.

Package validation and temporary-index procedure: Full tests, extension lint, and browser smoke used copied index/object state under `/tmp/ptl-r16-full.zHjyLc`; only the pre-existing untracked `extension/src/tempo-submission-ledger.js` and `extension/src/tempo-upload-handler.js` were admitted there. The real Git index remained unchanged. Browser validation required elevation because the sandbox cannot bind the smoke server to loopback. `firefox-geckodriver` was installed but not on `PATH`; validation used `/usr/local/bin/geckodriver`.

Unfinished work / precise blocker / conditional decisions: R20 is complete. The conditional F10 explicit DST occurrence selector remains not-triggered for the initial scope; ambiguous input is accurately rejected with correction guidance. R04 remains `needs-validation` because its targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization, not passed. No pointer-gesture recreation, provider integration, or deployment was performed.

Next eligible session: R36 — Perform final verification and handoff; final acceptance remains pending while required backend/browser validation is missing.
First concrete next action (path/function/test): Run the final relevant `npm test`, `npm run lint`, `npm run test:browser`, PHP/MYSQL, D1, and package/build checks from the implemented-card matrix, preserving explicit skips and the temporary-index procedure.

### R21 — 2026-09-12

Session ID / date: R21 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, findings, ledger, and latest R20 handoff. The large pre-existing dirty worktree, historical plan deletions, untracked product-gap/MySQL-plan documents, and untracked Tempo runtime modules were preserved; the real Git index was not changed.

Findings/subtasks actually completed: Completed the first, second, and fourth F11 checkboxes. Analytics now offers project and task filters sourced from the bounded current/comparison query and applies the same filters before building both datasets. The summary explicitly displays total actual elapsed time next to total effective time; fragmentation and anomaly metrics continue to use actual intervals. Anomaly rows expose an Open entry action with an entry ID and start-date Calendar destination. The model rejects missing or deleted targets, and Calendar validates query targets before opening an editor. Analytics preserves the selected period, filters, expanded project rows, scroll position, and focused control through minute and entry-change refreshes. Existing period coverage and new documentation make partial-period, short-month, and leap-day comparison rules visible and truthful. The F11 CSV/print checkbox remains incomplete for R22.

Files changed for R21: `extension/src/analytics.js`, `extension/analytics/analytics.js`, `extension/analytics/analytics.html`, `extension/analytics/analytics.css`, `extension/calendar/calendar.js`, `test/analytics.test.js`, `scripts/browser-runtime-smoke.mjs`, `README.md`, `docs/architecture.md`, and this plan. No entry schema, analytics persistence, provider contract, remote call, or database index changed.

Behavior and compatibility decisions: Filters use exact case-insensitive matching against loaded project/task values, with explicit missing-value options. The query remains bounded to the union of the selected and comparison periods, so a filter does not imply an all-history search. Actual elapsed seconds remain the physical-session source of truth; effective seconds remain multiplier-adjusted reporting time. Anomaly navigation carries `entry` and `date` query parameters to the existing Calendar page. Calendar opens the requested week and editor only when the visible non-deleted entry still exists; otherwise it reports that the target is unavailable. The report state is page-local and remains available when Calendar is opened as a separate extension page. Current-period comparisons use the same elapsed portion of the preceding period; complete prior periods use adjacent civil-calendar periods, with date clamping for shorter months and leap days.

Tests added/replaced/removed; replacement coverage for each removal: Added model coverage for case-insensitive project/task filtering, missing-project filtering, explicit actual totals, and missing/deleted anomaly targets. Extended Firefox smoke with an analytics anomaly fixture, filter controls, actual-total rendering, collapsed-row/focused-filter refresh preservation, and Calendar deep-link/editor opening. No tests were removed or replaced.

Commands and exact outcomes (distinguish baseline failures/skips): Baseline HISTORY `node --experimental-global-webcrypto --test test/db.test.js test/popup-recent-groups.test.js test/analytics.test.js test/analytics-period.test.js test/time-allocation.test.js`: 5 test files passed, 0 failed. Final focused analytics/calendar command `node --experimental-global-webcrypto --test test/analytics.test.js test/analytics-period.test.js test/calendar-layout.test.js`: 3 test files passed, 0 failed. Final temporary-index `npm test`: 77 tests passed, 0 failed. Final `npm run lint:js`, `node --check scripts/browser-runtime-smoke.mjs`, and `git diff --check`: passed. Final temporary-index `npm run lint:extension`: 0 errors, 0 notices, 0 warnings; `web-ext` printed its environmental update-check warning only. Final elevated temporary-index `GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run test:browser`: passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, and cross-context lock.`

Package validation and temporary-index procedure: Full tests, extension lint, and browser smoke used copied index/object state under `/tmp/ptl-r16-full.zHjyLc`; only the pre-existing untracked Tempo modules were admitted there. The real Git index remained unchanged. Browser validation required elevation because the sandbox cannot bind the smoke server to loopback. `firefox-geckodriver` was installed but not on `PATH`; validation used `/usr/local/bin/geckodriver`.

Unfinished work / precise blocker / conditional decisions: R21 is complete. F11 CSV export and print styling remain owned by R22 and were not started. R04 remains `needs-validation` because its targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization, not passed; this blocks R23, which depends on R04. No full-history search, provider integration, deployment, or network write was performed or claimed.

Next eligible session: R22 — Export and print the computed analytics report.
First concrete next action (path/function/test): Run the R22 HISTORY/serializer baseline, then inspect the current analytics report DOM and add a serializer that consumes the same filtered report snapshot, including timezone and actual/effective labels, before adding print-only styling.

### R22 — 2026-09-12

Session ID / date: R22 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, findings, ledger, and latest R21 handoff. Existing unrelated modifications, historical plan deletions, untracked product-gap/MySQL-plan documents, and untracked Tempo modules were preserved. The real Git index was not changed.

Findings/subtasks actually completed: Completed the remaining F11 CSV/print checkbox. Analytics now exports the already-computed filtered `latestReport`, including current/comparison ranges, browser timezone, project/task filters, actual/effective metric labels, project/task rows, descriptions, and anomalies. Text fields escape CSV quotes/newlines and neutralize formula-leading values; numeric columns remain numeric. Print styling retains report totals and labels while removing period/filter/action controls, anomaly actions, and other interactive UI from print output. Added package allow-list coverage for the new serializer module.

Files changed for R22: `extension/src/analytics-export.js`, `extension/analytics/analytics.js`, `extension/analytics/analytics.css`, `extension/analytics/analytics.html`, `test/analytics-export.test.js`, `test/package.test.js`, `scripts/browser-runtime-smoke.mjs`, `README.md`, `docs/architecture.md`, and this plan. No separate reporting engine, entry schema, provider contract, or remote call was added.

Behavior and compatibility decisions: Export consumes the same report object rendered on screen, so it cannot independently re-query entries or lose the active filter scope. It emits exact seconds for numeric duration fields while the page continues to display formatted durations. Formula neutralization applies only to text cells and prefixes a safe apostrophe; numeric values such as negative numbers are not rewritten as text. The printable view is CSS-only and does not create a second calculation path. The browser-local timezone is exported as resolved by `Intl.DateTimeFormat()`.

Tests added/replaced/removed; replacement coverage for each removal: Added serializer tests for metadata, multiplied actual/effective totals, CSV quoting/newlines, formula-prefix neutralization, numeric preservation, and omitted-overlap accounting. Added print-CSS assertions and browser smoke coverage for Export CSV and Print actions. Updated the package expected allow-list for `src/analytics-export.js`; no tests were removed or replaced.

Commands and exact outcomes (distinguish baseline failures/skips): Baseline `node --experimental-global-webcrypto --test test/analytics.test.js test/analytics-period.test.js test/package.test.js`: analytics and period files passed; `test/package.test.js` reproduced the known pre-existing failure because the real index omitted the untracked Tempo modules. Final focused `node --experimental-global-webcrypto --test test/analytics-export.test.js test/analytics.test.js test/analytics-period.test.js`: 3 test files passed, 0 failed. Final temporary-index `npm test`: 78 tests passed, 0 failed. Final temporary-index PACKAGE `node --experimental-global-webcrypto --test test/package.test.js test/create-update-site.test.js`: 2 test files passed, 0 failed. Final `npm run lint:js`, `node --check scripts/browser-runtime-smoke.mjs`, and `git diff --check`: passed. Final temporary-index `npm run lint:extension`: 0 errors, 0 notices, 0 warnings; `web-ext` printed its environmental update-check warning only. Final elevated temporary-index `GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run test:browser`: passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, and cross-context lock.`

Package validation and temporary-index procedure: Full tests, package checks, extension lint, and browser smoke used copied index/object state under `/tmp/ptl-r16-full.zHjyLc`; `extension/src/analytics-export.js` was explicitly admitted there, alongside the pre-existing untracked Tempo modules required by the package allow-list. The real Git index remained unchanged. Browser validation required elevation because the sandbox cannot bind the smoke server to loopback. `firefox-geckodriver` was installed but not on `PATH`; validation used `/usr/local/bin/geckodriver`.

Unfinished work / precise blocker / conditional decisions: R22 is complete. R23 is not eligible because it depends on R04, which remains `needs-validation`; the targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization, not passed. No live provider, backend integration, deployment, or network write was performed or claimed.

Next eligible session: R24 — Bound reconciliation presentation and expose partial results. R24 is eligible through completed R01 and does not depend on blocked R23.
First concrete next action (path/function/test): Run the R24 PROVIDER, reconciliation UI-state, and reconciliation-action baselines, then inspect the reconciliation page/model and current rendering limits before adding bounded group pagination, loaded-report filtering, and partial-result recovery.

### R24 — 2026-09-12

Session ID / date: R24 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, findings, ledger, and latest R22 handoff. The large pre-existing dirty worktree, historical plan deletions, untracked product-gap/MySQL-plan documents, untracked Tempo modules, and unrelated source/test edits were preserved; the real Git index was not changed.

Findings/subtasks actually completed: Completed all four F14 checkboxes. Reconciliation now paginates each rendered group at 50 items, searches the loaded report while retaining full-report accounting, preserves search/page/scroll/focus position across actions, previews bulk affected/equal-time-conflict/precondition counts, and reports completed/pending/failed outcomes after a fresh comparison. Quarantined records can be exported locally as escaped provider/location/reason metadata without including invalid payload content. Provider UI coverage checks rendered controls for Google and an API provider rather than relying on source phrases.

Files changed for R24: `extension/reconcile/reconcile.js`, `extension/reconcile/reconcile.html`, `extension/reconcile/reconcile.css`, `extension/options/options.html`, `extension/src/reconcile-ui-state.js`, `extension/src/reconcile-export.js`, `test/reconcile-ui-state.test.js`, `test/reconcile-export.test.js`, `test/reconciliation-provider-ui.test.js`, `test/package.test.js`, `scripts/browser-runtime-smoke.mjs`, `README.md`, `docs/architecture.md`, and this plan. No entry schema, provider contract, remote API, or database schema changed.

Behavior and compatibility decisions: Initial pages contain 50 records; search is scoped to the already-loaded comparison snapshot, while summary accounting remains full-report accounting. Equal timestamps with different fingerprints remain unresolved conflicts and are not ordered by provider ordering. Bulk actions retain revision/fingerprint/version preconditions. Partial execution is followed by a rescan and explicit completed/pending/failed counts, so retry starts from current unresolved work. Quarantine export is safe metadata only and neutralizes formula-leading text. The same reconciliation controls are present when the page is mounted inside Options.

Tests added/replaced/removed; replacement coverage for each removal: Added pure UI-state tests for bulk previews, outcome normalization, and bounded pagination including stale-page clamping. Added quarantine export tests for safe metadata, CSV escaping, and formula neutralization. Replaced provider source-phrase assertions with rendered-control checks for Google and an API provider. Extended browser smoke with 121-item pagination, loaded-report filtering, quarantine export, and provider-specific rendered controls. Updated the package allow-list for `src/reconcile-export.js`. No reconciliation behavior coverage was removed.

Commands and exact outcomes: Final focused `node --experimental-global-webcrypto --test test/reconcile-ui-state.test.js test/reconcile-export.test.js test/reconcile.test.js test/reconciliation-actions.test.js test/reconciliation-provider-ui.test.js`: 5 test files passed, 0 failed. Final temporary-index `npm test`: 79 tests passed, 0 failed. Final temporary-index PACKAGE `node --experimental-global-webcrypto --test test/package.test.js test/create-update-site.test.js`: 2 test files passed, 0 failed. Final temporary-index `npm run lint:extension`: 0 errors, 0 notices, 0 warnings; web-ext printed only its environmental update-check warning. Final `npm run lint:js`, `node --check scripts/browser-runtime-smoke.mjs`, and `git diff --check`: passed. Final elevated temporary-index `GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run test:browser`: passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, and cross-context lock.`

Package validation and temporary-index procedure: Full tests, package checks, extension lint, and browser smoke used copied index/object state under `/tmp/ptl-r16-full.zHjyLc`; `extension/src/reconcile-export.js` was admitted there alongside the pre-existing untracked Tempo modules and earlier analytics serializer. The real Git index remained unchanged. Browser validation required elevation because the sandbox cannot bind the smoke server to loopback. The installed `firefox-geckodriver` package does not put the executable on PATH; validation used `/usr/local/bin/geckodriver`.

Unfinished work / precise blocker / limitations: R24 is complete. R23 remains blocked by R04, whose targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization and therefore remains `needs-validation`, not passed. Browser coverage verifies rendered controls and local synthetic reconciliation state; no live Google/API provider, backend integration, deployment, or network write was performed or claimed. Search does not imply full-history loading, and the initial DOM bound is the 50-item page size.

Next eligible session: R25 — Clarify provider setup and resumable migration UI; its R09 and R24 dependencies are done, while R23 is unrelated. First concrete next action (path/function/test): Run the R25 PROVIDER, BACKUP, and UI baselines, then inspect `extension/options/provider-setup-controller.js`, `extension/options/options.js`, `extension/src/storage-migration.js`, and their persisted-state tests before changing setup/migration labels or resume presentation.

### R25 — 2026-09-12

Session ID / date: R25 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, findings, ledger, and latest R24 handoff. The large pre-existing dirty worktree, historical plan deletions, untracked product-gap/MySQL-plan documents, untracked Tempo modules, and unrelated source/test edits were preserved; the real Git index was not changed.

Findings/subtasks actually completed: Completed all four F15 checkboxes. Options now uses consistent preparation, testing, initialization, adoption, migration, and resume language. The active backend and prepared target are rendered independently. Storage migration persists a provider-neutral preview with verified source/target entry and shared-config counts plus disagreements before seeding/switching, and the preview remains available after reopening Options. Token replacement is described as credential-only, separate from dataset selection or migration. First-run setup keeps local backup recovery visible and documents all three providers; direct local initialization remains available without Google credentials, while remote adoption retains provider facades and ownership checks.

Files changed for R25: `extension/src/storage-migration.js`, `extension/options/options.html`, `extension/options/options.js`, `test/storage-migration.test.js`, `scripts/browser-runtime-smoke.mjs`, `README.md`, `docs/architecture.md`, and this plan. No remote wire contract, entry schema, database schema, or multi-destination registry was added.

Behavior and compatibility decisions: A migration preview is calculated from canonical provider-neutral entries/configuration and counts source-only, target-only, changed, and configuration disagreements without normalizing them away. The preview is persisted in the existing migration state before target seeding; progress callbacks render it, and a page reopened during an active phase can resume the same migration ID. The active backend changes only in the existing verified switch path. The existing single prepared target remains sufficient; multiple saved destinations were not introduced. Local initialization and adoption continue to use their dedicated storage-migration paths and do not contact Google.

Tests added/replaced/removed; replacement coverage for each removal: Added `migrationPreview` coverage for source/target counts and all disagreement categories. Extended Firefox smoke to assert active/prepared identity labels, consistent action labels, separate local/adoption actions, and a persisted migration preview rendered after an Options reload. Existing provider-controller, backup, storage-visibility, and provider-boundary coverage remained in place. No tests were removed or replaced.

Commands and exact outcomes (including known baseline limitations): Focused `node --experimental-global-webcrypto --test test/remote-provider.test.js test/provider-setup-controller.test.js test/storage-migration.test.js test/backup.test.js test/options-storage-ui.test.js`: 5 test files passed, 0 failed. Final `npm run lint:js`, `node --check scripts/browser-runtime-smoke.mjs`, and `git diff --check`: passed. Final temporary-index `node --experimental-global-webcrypto --test test/package.test.js test/create-update-site.test.js`: 2 test files passed, 0 failed. Final temporary-index `npm run lint:extension`: 0 errors, 0 notices, 0 warnings; web-ext printed only its environmental update-check warning. Final elevated temporary-index `GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run test:browser`: passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, and cross-context lock.`

The repository-wide `npm test` was also run without the temporary index and reported 458 tests with 457 passed and 1 failed: the known pre-existing `test/package.test.js` allow-list failure because the real Git index omits untracked `extension/src/analytics-export.js`, `extension/src/reconcile-export.js`, and Tempo modules. The same package suite passed with the prepared temporary index. Two intermediate browser smoke attempts failed only because newly added smoke assertions expected a static migration label and then placed the prepared-backend expectation in the wrong provider branch; both assertions were corrected, and no functional failure was counted from those attempts.

Package validation and temporary-index procedure: Package and extension-lint checks used copied index/object state under `/tmp/ptl-r16-full.zHjyLc`, with the pre-existing untracked Tempo modules and earlier analytics/reconciliation serializers admitted there. The real Git index remained unchanged. Browser validation required elevation because the sandbox cannot bind the smoke server to loopback. The installed `firefox-geckodriver` package is not on PATH; validation used `/usr/local/bin/geckodriver`.

Unfinished work / precise blocker / limitations: R25 is complete. R23 remains blocked by R04, whose targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization and remains `needs-validation`, not passed. R25 validates local model/UI behavior and synthetic persisted state; no live Google, MySQL, or Cloudflare backend, migration write, deployment, or network write was performed or claimed. A preview is available once the migration has read both datasets; entering a target alone does not contact a provider or fabricate counts.

Next eligible session: R26 — Add section-local draft indicators and validation; it depends on R25, now done. First concrete next action (path/function/test): Run the R26 BACKUP, `test/options-settings.test.js`, `test/provider-setup-controller.test.js`, and UI baselines, then inspect Options draft-revision tracking, section markup/CSS, and settings normalization before adding dirty-section indicators, explicit discard, and input-associated validation.

### R26 — 2026-09-12

Session ID / date: R26 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, findings, ledger, and latest R25 handoff. Existing unrelated modifications, historical plan deletions, untracked product-gap/MySQL-plan documents, untracked Tempo modules, and prior R20–R25 changes were preserved; the real Git index was not changed.

Findings/subtasks actually completed: Completed all four F16 checkboxes. Options now shows section-local unsaved indicators for General, Storage, Google Account, and Tempo, with explicit Discard actions that reload persisted values. Refreshes preserve typed dirty fields and identify an externally changed saved value instead of presenting the draft as current. General settings attach inline errors and `aria-invalid`/validity state to the affected input. API and Tempo token clearing are explicit actions separate from non-secret refresh and ordinary save; token replacement remains a deliberate save. Section messages stay with the relevant settings area.

Files changed for R26: `extension/options/options.js`, `extension/options/options.html`, `extension/options/options.css`, `scripts/browser-runtime-smoke.mjs`, `README.md`, `docs/architecture.md`, and this plan. No new state framework, settings schema, provider contract, or remote API was introduced.

Behavior and compatibility decisions: The existing per-field draft revision map remains the source of truth. A draft is dirty until its captured revision is acknowledged; an external refresh marks the section while leaving the input untouched. Discard acknowledges the current draft and invokes the existing refresh path to reload values. Inline errors replace the intrusive native validation bubble while retaining native validity state and focus. Clearing a MySQL, Cloudflare D1, or Tempo token writes an empty token locally and leaves backend selection/dataset state unchanged; users must deliberately replace the token before using that provider again.

Tests added/replaced/removed; replacement coverage for each removal: Extended Firefox smoke with section dirty/discard behavior, persisted-value reload, and provider secret-control labels. Existing normalization tests cover invalid multiplier, interval, and calendar-start values; provider-controller and backup tests remain green. No tests were removed or replaced. A direct browser assertion of the native validation bubble was not retained because Firefox exposes that bubble as a WebDriver command error; the inline error implementation is covered by code paths and focused normalization tests, while browser smoke validates the surrounding Options interaction.

Commands and exact outcomes: Focused `node --experimental-global-webcrypto --test test/backup.test.js test/options-settings.test.js test/provider-setup-controller.test.js test/storage-migration.test.js`: 4 test files passed, 0 failed. Final `npm run lint:js`, `node --check scripts/browser-runtime-smoke.mjs`, and `git diff --check`: passed. Final elevated temporary-index `GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run test:browser`: passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, and cross-context lock.`

The repository-wide `npm test` was not rerun after the final R26-only edits; the prior R25 run reported 458 tests with 457 passed and 1 known pre-existing package allow-list failure when using the real index. The temporary-index package suite and extension lint had passed during R25; R26 added no extension module or package allow-list path. No live provider, deployment, or network write was performed or claimed.

Unfinished work / precise blocker / limitations: R26 is complete. R23 remains blocked by R04, whose targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization and remains `needs-validation`, not passed. Cross-context external-change messaging is implemented through the existing refresh path but was not claimed as a live multi-window provider integration. Token clearing intentionally leaves the selected provider configured but unauthenticated until replacement.

Next eligible session: R27 — Improve usage freshness and replace source-shape tests; it depends on R01 and is independent of blocked R23. First concrete next action (path/function/test): Run the USAGE/UI baselines, then inspect `extension/usage/usage.js`, `extension/popup/popup.js`, `extension/src/chatgpt-usage-service.js`, usage state persistence, and existing source-shape tests before aligning freshness/countdown/consent presentation.

### R27 — 2026-09-12

Session ID / date: R27 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, findings, ledger, and latest R26 handoff. Existing unrelated modifications, historical plan deletions, untracked product-gap/MySQL-plan documents, untracked Tempo modules, and prior card changes were preserved; the real Git index was not changed.

Findings/subtasks actually completed: Completed all five F17 checkboxes. Added shared `usage-presentation.js` helpers so Usage and Popup agree on used/remaining labels, 5-hour/weekly names, reset countdowns, and stale age. Usage locally re-renders countdowns every 30 seconds without a request; Popup does the same while open. Failed requests retain the last successful snapshot and expose safe error state. Each refresh claims a new persisted generation before requesting, preventing an older context response from overwriting a newer snapshot. Clear snapshot/consent, host-permission revocation, and consent disable remain distinct. The private endpoint remains optional and explicitly documented.

Files changed for R27: `extension/src/usage-presentation.js`, `extension/src/chatgpt-usage-service.js`, `extension/usage/usage.js`, `extension/popup/popup.js`, `test/usage-presentation.test.js`, `test/chatgpt-usage-service.test.js`, `test/chatgpt-structure.test.js`, `test/package.test.js`, `scripts/browser-runtime-smoke.mjs`, `README.md`, `docs/architecture.md`, and this plan. No endpoint, account-data collection, permission broadening, or durable token storage was added.

Behavior and compatibility decisions: Usage presentation uses local wall-clock countdowns and keeps exact collection timestamps for age/stale status. The refresh generation increments atomically at claim time; the existing consent-generation invalidation still prevents delayed responses from restoring cleared data. Manual refresh continues to bypass the cooldown by explicit user action, while automatic/countdown rendering never performs a network request. The source-shape test for Popup rendering was removed because real Firefox smoke now checks both Usage and Popup controls; security-boundary source checks remain for endpoint and token isolation.

Tests added/replaced/removed; replacement coverage for each removal: Added shared presentation tests for labels, countdowns, and stale snapshots. Added a two-context out-of-order service test with synthetic JWT markers and durable shared settings to prove the newer response wins, plus last-successful-snapshot preservation on service failure. Replaced the Popup rendering source-shape test with Firefox smoke coverage that renders Usage and Popup from a synthetic persisted snapshot and checks used/remaining/reset/stale output. Existing manifest, bounded-body, permission, consent, revoke-race, and redaction checks remain. No security boundary test was removed.

Commands and exact outcomes: Baseline USAGE `node --experimental-global-webcrypto --test test/chatgpt-usage-service.test.js test/chatgpt-structure.test.js test/codex-usage.test.js test/bounded-json.test.js`: 4 test files passed, 0 failed. Final focused `node --experimental-global-webcrypto --test test/chatgpt-usage-service.test.js test/codex-usage.test.js test/chatgpt-structure.test.js test/bounded-json.test.js test/usage-presentation.test.js`: 5 test files passed, 0 failed. Final temporary-index `npm test`: 80 test files passed, 0 failed. Final temporary-index `npm run lint:extension`: 0 errors, 0 notices, 0 warnings; web-ext printed only its environmental update-check warning. Final `npm run lint:js`, `node --check scripts/browser-runtime-smoke.mjs`, and `git diff --check`: passed. Final elevated temporary-index `GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run test:browser`: passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, and cross-context lock.`

Package validation and temporary-index procedure: `extension/src/usage-presentation.js` was explicitly admitted to `/tmp/ptl-r16-full.zHjyLc` along with the earlier analytics/reconciliation serializers and pre-existing Tempo modules. Temporary full tests, package inclusion, extension lint, and browser smoke used that copied index/object state; the real Git index remained unchanged. The initial browser attempt failed at page readiness because the new module was not yet in the temporary package index; after explicit admission, the final browser run passed. Browser validation required elevation because the sandbox cannot bind the smoke server to loopback. The installed `firefox-geckodriver` package is not on PATH; validation used `/usr/local/bin/geckodriver`.

Unfinished work / precise blocker / limitations: R27 is complete. R23 remains blocked by R04, whose targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization and remains `needs-validation`, not passed. Usage browser checks use a synthetic local snapshot; no live ChatGPT request, endpoint stability, deployment, or network write was performed or claimed. Countdown refresh is page-local while the page is open; it does not schedule background network work.

Next eligible session: R28 — Consolidate theme policy and verify responsive access; R20, R26, and R27 are done. First concrete next action (path/function/test): Run `test/themes.test.js`, `test/window-resize.test.js`, and the UI smoke baseline, then inspect `extension/src/themes.js`, theme CSS, page styles/HTML, and window-resize behavior at narrow widths and 200% zoom before changing only concrete accessibility or clipping defects.

### R28 — 2026-09-12

Session ID / date: R28 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, findings, ledger, and latest R27 handoff. The large pre-existing dirty worktree, historical plan deletions, untracked product-gap/MySQL-plan documents, untracked Tempo modules, and prior R20–R27 changes were preserved; the real Git index was not changed.
Findings/subtasks actually completed: Completed all three F18 checkboxes. Shared theme CSS now honors `prefers-reduced-motion` by suppressing transitions/animations and restoring automatic scrolling. Options navigation wraps long labels at narrow widths without forcing a wider layout. Popup, Calendar, and Reconcile asynchronous status regions now use polite live-region semantics; elapsed-second output remains outside live announcements. Existing icon-only controls retain readable `aria-label` values. Theme fallbacks and legacy preference aliases were retained because page-level fallback tokens are required when shared styling or saved preferences cannot be read.
Files changed for R28: `extension/src/themes.css`, `extension/options/options.css`, `extension/popup/popup.html`, `extension/calendar/calendar.html`, `extension/reconcile/reconcile.html`, `test/themes.test.js`, `scripts/browser-runtime-smoke.mjs`, `README.md`, `docs/architecture.md`, and this plan. No palette was removed, no provider/API/schema contract changed, and no new runtime dependency was added.
Behavior and compatibility decisions: Page CSS keeps fallback and geometry values; the shared stylesheet owns selected palettes, high-contrast edges, focus outlines, and reduced-motion overrides. Incidental theme CSS-string assertions were removed from the unit test; browser smoke now checks rendered body color, high-contrast border width, computed focus outline, reduced-motion transition duration, icon labels, async status/live-region boundaries, narrow Popup overflow, long Options labels at simulated 200% CSS zoom, and visible Calendar toolbar reachability at a resized window. The browser check uses a Firefox reduced-motion preference and a CSS zoom test mode; it does not claim an OS-level accessibility audit or arbitrary display scaling coverage.
Tests added/replaced/removed; replacement coverage for each removal: `test/themes.test.js` keeps theme option, normalization, root-attribute, and shared-page loading coverage while removing CSS spelling/token regexes. `scripts/browser-runtime-smoke.mjs` provides the replacement computed-style/focus and responsive rendering checks. No security, provider, or entry behavior tests were removed.
Commands and exact outcomes: Baseline focused `node --experimental-global-webcrypto --test test/themes.test.js test/window-resize.test.js`: 2 test files passed, 0 failed. Final focused run: 2 test files passed, 0 failed. Final temporary-index `npm test`: 80 test files passed, 0 failed. Final temporary-index `npm run lint:extension`: 0 errors, 0 notices, 0 warnings; web-ext printed only its environmental update-check warning. Final `npm run lint:js`, `node --check scripts/browser-runtime-smoke.mjs`, and `git diff --check`: passed. Final elevated temporary-index `GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run test:browser`: passed — `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, and cross-context lock.` The smoke’s R28 checks passed within that run, including theme/focus/reduced-motion, narrow Popup, long-label/200% CSS zoom, and resized Calendar checks.
Package validation and temporary-index procedure: Full tests and extension lint used copied index/object state under `/tmp/ptl-r16-full.zHjyLc`; the real Git index remained unchanged. Browser validation required elevation because the sandbox cannot bind the smoke server to loopback. The installed `firefox-geckodriver` package is not on PATH; validation used `/usr/local/bin/geckodriver`.
Unfinished work / precise blocker / limitations: R28 is complete. Palette fallback declarations remain intentionally duplicated across page CSS because they are the fallback if the shared theme stylesheet or stored preference cannot load. The responsive check uses Firefox headless at measured CSS viewport sizes and simulated CSS zoom; manual high-contrast hardware/display and assistive-technology review remain outside this card. R23 remains blocked by R04, whose targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization and remains `needs-validation`, not passed. Consequently R29 is not eligible: its precise blocker is dependency R23, not a missing R29 implementation.
Next eligible session: R30a — Package import closure, because R29 is blocked by R23/R04 while R30a's R01/R05 dependencies are complete. First concrete next action (path/function/test): Run the R30a PACKAGE baseline and inspect package preparation plus `test/package.test.js` for an independent prepared-extension import/asset-closure check and a missing-import negative fixture; do not start R29 until R23 is unblocked.

### R30a — 2026-09-12

Session ID / date: R30a / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`; the existing large dirty worktree, prior card changes, historical plan deletions, untracked product-gap/MySQL-plan documents, and untracked runtime modules were preserved. The real Git index was not changed.
Findings/subtasks actually completed: Completed the F22 packaged-reference closure checkbox. Added an independent verifier in `test/package.test.js` that reads the prepared package and resolves manifest paths, HTML `src`/`href` references, CSS `url()` assets, and static/dynamic JavaScript imports. Added a negative fixture that removes `src/themes.js` from a prepared copy and asserts the verifier fails without importing or executing the fixture.
Files changed for R30a: `test/package.test.js` and this plan. No production runtime behavior or packager selection logic changed.
Behavior and compatibility decisions: The existing explicit expected-file allow-list remains authoritative for package membership; the closure verifier is a separate reference-resolution boundary and does not derive expected files from the packager. External URLs, fragments, data URLs, and non-file form actions are ignored as non-package references. The negative fixture mutates only a disposable prepared output and is removed during cleanup.
Tests added/replaced/removed; replacement coverage for each removal: Added one positive closure assertion to the existing package test and one missing-module negative test. Existing allow-list, untracked-file exclusion, release metadata, and deterministic-output tests remain unchanged.
Commands and exact outcomes: Baseline `node --experimental-global-webcrypto --test test/package.test.js test/create-update-site.test.js` had 1 pass and 1 failure: the known real-index package allow-list failure omitted five pre-existing untracked runtime modules (`analytics-export.js`, `reconcile-export.js`, `tempo-submission-ledger.js`, `tempo-upload-handler.js`, and `usage-presentation.js`). Final temporary-index `GIT_INDEX_FILE=/tmp/ptl-r16-full.zHjyLc/index GIT_OBJECT_DIRECTORY=/tmp/ptl-r16-full.zHjyLc/objects GIT_ALTERNATE_OBJECT_DIRECTORIES=/home/daniel/Desktop/addons/personal-time-logger/.git/objects node --experimental-global-webcrypto --test test/package.test.js test/create-update-site.test.js`: 2 test files passed, 0 failed. `git diff --check`: passed. The full JS/lint/browser gates were already passed for the unchanged runtime/package preparation paths in R28; R30a’s final package boundary was run with the prepared temporary index.
Package validation and temporary-index procedure: Used `/tmp/ptl-r16-full.zHjyLc/index` with its separate object directory and real Git objects, admitting only the exact pre-existing runtime files needed for the package test. The real Git index and worktree state were preserved; no `git add .`, commit, push, or deployment was performed.
Unfinished work / precise blocker / limitations: R30a is complete. This is static reference resolution, not execution of every module or a signed-XPI validation. R04 remains `needs-validation`; R23 and R29 remain blocked by that dependency. R30b is the next card and requires real disposable-backend HTTP coverage; skipped MySQL/D1 integrations must remain unpassed.
Next eligible session: R30b — Real shared HTTP contract. First concrete next action (path/function/test): Run the `server/http-contract.mjs`/provider contract baselines and read the MySQL integration README plus D1 test harness, then map the existing three shared HTTP cases before adding only missing disposable-engine coverage.

### R30b — 2026-09-12

Session ID / date: R30b / 2026-09-12
State: needs-validation
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`; the large dirty worktree, prior card changes, historical plan deletions, untracked product-gap/MySQL-plan documents, and unrelated runtime/test edits were preserved. No commit, push, deployment, or remote database mutation was performed.
Findings/subtasks actually completed: Replaced the weak shared Markdown route/error assertions with executable shared HTTP checks in `server/http-contract.mjs`: missing/invalid auth, unknown route, wrong method/content type, malformed JSON, unknown fields, health shape, canonical entry round-trip, idempotent append/change-token stability, stale update rejection, and delete preconditions. The local D1 integration invokes the shared contract on its own disposable Worker/database. Standardized MySQL invalid-token responses to the same public `AUTH_REQUIRED` code used by D1, avoiding validity disclosure. Removed `test/remote-api-contract.test.js`, whose prose regexes had no runtime boundary.
Files changed for R30b: `server/http-contract.mjs`, `server/cloudflare-d1/test/integration.test.mjs`, `server/mysql-api/public/index.php`, deleted `test/remote-api-contract.test.js`, and this plan.
Behavior and compatibility decisions: Shared contract assertions use only provider-neutral fields and codes; provider-specific health storage fields remain outside the shared assertion. The D1 shared-contract test gets an isolated local Worker because its mutation/change-token checks must not alter neighboring test state. The MySQL public API now returns `AUTH_REQUIRED` for both absent and invalid bearer credentials; no client wire or schema shape was otherwise changed.
Tests added/replaced/removed; replacement coverage for each removal: Added executable shared contract cases and retained existing D1 end-to-end mutation/rollback/race tests and MySQL PHP integration coverage. Removed the prose-only `test/remote-api-contract.test.js`; its route, field, auth, and error claims are now exercised by D1 HTTP calls and the documented MySQL endpoint command, while the MySQL real-engine check remains pending.
Commands and exact outcomes: `npm run test:cloudflare`: 7 pure/scaffold tests passed, then 4 local Worker integration tests passed, including the isolated shared HTTP contract. `bash server/mysql-api/tests/run.sh`: deterministic validator/config checks passed, but Session 1 MySQL integration was skipped because `pdo_mysql` is unavailable. `php -l server/mysql-api/public/index.php`: no syntax errors. The required MySQL endpoint contract against a disposable MySQL 8.4 engine could not be run; it is not counted as passed. `node --check server/http-contract.mjs` passed. Earlier R30a package and R28 JS/browser gates remain valid for their unchanged boundaries; final JS/package-wide gates for this R30b edit remain to be run after the next card boundary is settled.
Package/backend validation and limitations: No live or personal backend was contacted. D1 used Wrangler’s local disposable state. MySQL endpoint, concurrent transaction, rollback, and logging checks remain unvalidated in this environment because `pdo_mysql` and a positively identified disposable MySQL 8.4 schema are unavailable. The card therefore remains `needs-validation`, not done; F20’s shared HTTP checkbox remains unchecked.
Unfinished work / precise blocker: Exact blocker is missing `pdo_mysql` plus no verified disposable MySQL 8.4 endpoint/schema. Do not mark R30b or its F20 shared HTTP checkbox complete until `bash server/mysql-api/tests/run.sh` executes the integration path and `node server/http-contract.mjs BASE_URL TOKEN` runs against the configured disposable endpoint.
Next eligible session: R32 — Correct migration-test claims and constrain test harness growth; R31 is blocked by R30b, while R32 depends only on R01 and remains eligible. First concrete next action (path/function/test): Run the DB/PROVIDER/JS baselines, inspect `test/fixtures.test.js`, `test/db-dirty-migration.test.js`, provider migration tests, and browser smoke wait loops, then change only a misnamed fixture claim, duplicated migration assertion, or unbounded wait proven by that review.
### R32 — 2026-09-12

Session ID / date: R32 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, findings, ledger, and latest R30b handoff. The large pre-existing dirty worktree, prior card changes, historical plan deletions, untracked product-gap/MySQL-plan documents, and unrelated runtime/test edits were preserved. The real Git index was not changed.

Findings/subtasks actually completed: Completed the R32 fixture, registration, and harness-audit work mapped to S08/S09 and the related test-audit rows. Renamed the version-2 fixture test to describe its actual import-compatibility behavior; the real v3→v5 upgrade coverage remains in `test/db-dirty-migration.test.js`. Removed the duplicate provider registration Cartesian-product assertion from `test/storage-migration.test.js`; the provider registry remains covered by `test/remote-provider.test.js`, while migration, interruption, ownership, and version schedules remain in their focused suites. Added 1-second deadlines and diagnostic labels to the FIFO/paused-commit fake IndexedDB waits and the Tempo upload activation wait. Documented that fake IndexedDB is a focused test double rather than a complete browser implementation, with Firefox smoke reserved for browser-only IndexedDB and lifecycle semantics.

Files changed for R32: `test/fixtures.test.js`, `test/storage-migration.test.js`, `test/fake-indexeddb.test.js`, `test/tempo-controller.test.js`, `README.md`, and this plan. No production database schema, provider protocol, browser smoke scenario, or runtime dependency changed.

Behavior and compatibility decisions: The version-2 fixture remains useful as imported persisted data, but its name no longer claims that opening a real v2 database exercises an upgrade. The existing real v3→v5 migration test is retained. Registration coverage is kept in one owner and is not treated as migration-direction execution. Harness waits now fail after 1000 ms with a useful condition label instead of hanging indefinitely; this is a diagnostic bound, not a production timeout. Fake IndexedDB limits are documented without expanding the test double or claiming coverage of unsupported browser semantics.

Tests added/replaced/removed; replacement coverage for each removal: Renamed one misleading test; no behavior coverage was removed. Removed only the duplicate provider-registration Cartesian-product case; `test/remote-provider.test.js` retains the registry assertion and the focused migration/provider suites retain executable schedules. Added deadline coverage by exercising the existing FIFO, paused-commit, and Tempo activation waits; no browser scenario was added because the changed behavior is harness diagnostics rather than UI behavior.

Commands and exact outcomes: The final DB/PROVIDER focused command using the preserved temporary validation index `/tmp/ptl-r16-full.zHjyLc/index` and object directory `/tmp/ptl-r16-full.zHjyLc/objects` passed 15 test files with 0 failures: `node --experimental-global-webcrypto --test test/db.test.js test/db-dirty-migration.test.js test/db-open-lifecycle.test.js test/fake-indexeddb.test.js test/fixtures.test.js test/google-api-mock.test.js test/runtime-barriers.test.js test/remote-provider.test.js test/remote-cloudflare-d1.test.js test/remote-versioned-mutations.test.js test/storage-migration.test.js test/reconciliation-intent.test.js test/reconcile.test.js test/provider-setup-controller.test.js test/tempo-controller.test.js`. `npm run lint:js` passed. `git diff --check` passed. No full package/browser rerun was needed because no package or browser scenario changed; earlier R28/R30a package and Firefox gates remain evidence only for their own boundaries.

Unfinished work / precise blocker / limitations: R32 is complete. R04 remains needs-validation because the user-authorized Firefox alarm reproduction was skipped; R23 and R29 remain blocked by it. R30b remains needs-validation because `pdo_mysql` and a positively identified disposable MySQL 8.4 endpoint/schema are unavailable; therefore R31 and R33a/R33b are explicitly blocked and no related finding checkbox was changed. The fake IndexedDB is not evidence for arbitrary real-browser IndexedDB behavior, and the bounded waits do not prove every possible harness loop is bounded.

Next eligible session: R34 — Measure performance and decide conditional simplifications. First concrete next action (path/function/test): Run the R34 benchmark baseline, then inspect `docs/scaling.md`, DB interval queries, sync preflight, auth session store, and the existing Firefox harness before creating the reproducible disposable-profile benchmark artifact for 10k/50k/100k entries. Do not begin R31 or R33 while R30b remains needs-validation.

### R34 — 2026-09-12

Session ID / date: R34 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, findings, ledger, and latest R32 handoff. The large pre-existing dirty worktree, prior card changes, historical plan deletions, untracked product-gap/MySQL-plan documents, and unrelated runtime/test edits were preserved. The real Git index was not changed.

Findings/subtasks actually completed: Completed the first F21 benchmark checkbox only. Added `scripts/history-benchmark.mjs`, which creates a fresh temporary Firefox WebDriver profile per size, seeds the v5 IndexedDB store with the fixed `r34-history-v1` fixture, opens Popup and Calendar, measures current/old-week interval reads and history expansion, and exercises reconciliation, backup serialization, and migration digest/preview. It records cursor visits, durations, backup payload bytes, synthetic idle/dirty/forced request plans, and memory as `null` when Firefox exposes no supported metric. Added the repository-local result `docs/benchmarks/r34-history-benchmark.json` and expanded `docs/scaling.md` with the exact reproduction command, result table, limitations, and evidence-based decision. Added conditional child card R34a for a representative-profile calendar budget and possible bounded query follow-up; it was not started.

Files changed for R34: `scripts/history-benchmark.mjs`, `docs/benchmarks/r34-history-benchmark.json`, `docs/scaling.md`, and this plan. No production runtime, schema, provider protocol, archive, delta API, worker, authentication, or health-cache change was made.

Behavior and compatibility decisions: The seed spans 730 days and includes dense overlaps, a long-running entry crossing the displayed week, an active entry represented by the existing `status: "ok"` plus empty `end_at` contract, tombstones, and dirty entries. Each size ran in a separate temporary Firefox profile. The benchmark's sync request counts are explicitly simulated provider plans: idle 1 `change-token` request, dirty 3 requests (`read-snapshot`, `write-entry`, `change-token`), and forced 1 `read-snapshot`; no live service was contacted. No archive threshold or architecture simplification was inferred from one local machine. S05 readonly-session and F12 health-cache work remain deferred because this benchmark did not measure meaningful contention or real provider health cost.

Measured results from `docs/benchmarks/r34-history-benchmark.json`: 10,000 entries — seed 814 ms, Popup 8 ms / 108 cursor visits, Calendar 79 ms / 84 visits, reconciliation compare 131 ms, backup 263 ms and 5,720,906 bytes, migration 37 ms. 50,000 — seed 3,871 ms, Popup 26 ms / 534 visits, Calendar 535 ms / 414 visits, reconciliation 560 ms, backup 1,240 ms and 28,648,538 bytes, migration 252 ms. 100,000 — seed 7,869 ms, Popup 37 ms / 1,062 visits, Calendar 1,078 ms / 822 visits, reconciliation 1,118 ms, backup 2,621 ms and 57,408,076 bytes, migration 444 ms. Firefox exposed neither `measureUserAgentSpecificMemory` nor `performance.memory`, so peak memory is unavailable and recorded as `null`.

Tests added/replaced/removed; replacement coverage for each removal: Added the benchmark harness and no product tests were removed. The first trial caught an invalid synthetic `status: "running"`; it was corrected to the existing valid active-entry representation before the final run. The benchmark's direct database calls and real Firefox page opening cover the R34 harness boundary; the existing DB/HISTORY suites remain unchanged.

Commands and exact outcomes: Final benchmark command, run with loopback elevation, was `GECKODRIVER_BIN=/usr/local/bin/geckodriver node scripts/history-benchmark.mjs`. It wrote `docs/benchmarks/r34-history-benchmark.json` and printed: `10000: popup 8ms, calendar 79ms, reconciliation 131ms, backup 263ms, migration 37ms`; `50000: popup 26ms, calendar 535ms, reconciliation 560ms, backup 1240ms, migration 252ms`; `100000: popup 37ms, calendar 1078ms, reconciliation 1118ms, backup 2621ms, migration 444ms`. Final temporary-index `npm test`: 79 test files passed, 0 failed. Final `npm run lint:js`: passed. Final `node --check scripts/history-benchmark.mjs`: passed. Final `git diff --check`: passed. The temporary validation index/object procedure used `/tmp/ptl-r16-full.zHjyLc/index` and `/tmp/ptl-r16-full.zHjyLc/objects`; the real Git index was unchanged.

Unfinished work / precise blocker / limitations: F21's user-facing budget, production optimization, and architecture-change checkboxes remain unchecked because this single-machine run does not establish a release-wide budget, memory metric, or live-provider payload/latency result. R34 is complete because the required reproducible Firefox artifact, measurements, limitations, and evidence-based no-change decision are recorded. R34a is conditional and remains todo; it must first repeat the run on a representative profile and define a calendar-read budget before any query optimization. R04 remains needs-validation because the user-authorized Firefox alarm reproduction was skipped; R23 and R29 remain blocked by it. R30b remains needs-validation because `pdo_mysql` and a positively identified disposable MySQL 8.4 endpoint/schema are unavailable; R31 and R33a/R33b remain explicitly blocked.

Next eligible session: R34a — Repeat the Firefox benchmark on a representative profile and set the conditional calendar-read budget. First concrete next action (path/function/test): Run `GECKODRIVER_BIN=/usr/local/bin/geckodriver R34_SIZES=10000,50000,100000 node scripts/history-benchmark.mjs` on a representative profile, record the profile/browser context and an explicit user-facing budget, then decide whether the measured calendar query warrants the bounded follow-up. Do not begin R31 or R33 while R30b remains needs-validation.
### R35 — 2026-09-12

Session ID / date: R35 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, findings, ledger, and latest R34a handoff. The large pre-existing dirty worktree, historical plan deletions, untracked product-gap/MySQL-plan documents, unrelated source/test edits, and all prior card changes were preserved. The real Git index was not changed.

Findings/subtasks actually completed: Audited every F01–F22 checkbox against the owning card handoffs, every S01–S10 simplification against its decision/evidence, every test-audit removal/replacement/keep row against the recorded replacement, and every conditional-register trigger. Added the self-contained R35 audit section to this plan. No unchecked finding was promoted. The only additional finding status confirmed by this audit was F21's already-recorded second budget checkbox from R34a; production optimization and architecture-change checkboxes remain unchecked. Updated the ledger to retain explicit outcomes for R04, R23, R29, R30b, R31, R33a, and R33b rather than treating missing validation as success.

Files changed for R35: this plan only. No production code, tests, schema, provider contract, benchmark artifact, or package was changed.

Audit decisions: F01–F03, F06, F07 initial scope, F09–F11, F14–F18, F22, and the completed portions of F04/F05/F08/F20/F21 map to their done cards. F04's default-unsent historical marker and cross-device capability check remain unchecked; F05 project+task mapping, F07 reminders, F08 broader undo/split, F15 multiple destinations, F19, and F20 recovery/schema work remain deferred or unimplemented. F12 remains blocked by R04 and F13's alarm reproduction remains needs-validation. The conditional register marks notifications, split/broader undo, project+task mapping, explicit DST occurrence selection, multiple destinations, auth readonly snapshots, provider health caching, architecture-scale proposals, dual-token/schema framework, and further abstractions as not-triggered; the shared usage refresh trigger was triggered and resolved by R27's generation fencing. R34/R34a's 1,500 ms Calendar budget was met, so no child optimization card beyond the completed R34a is required.

Test-audit decisions: R02 owns the action-runner/no-behavior removals and their browser/unit replacements; R24 owns the reconciliation UI source-check replacement; R27 owns the usage source-shape replacement while retaining policy/security checks; R28 owns the incidental theme assertion replacement; R30b owns the Markdown API-regex replacement but remains needs-validation for MySQL; R31's D1 SQL-spelling row remains blocked and unmodified; R32 owns the migration fixture/registration wording and harness deadlines. Independent race, wire/storage, security, rollback, and real-engine tests remain retained.

Commands and exact outcomes: R35 is documentation-only. Final `git diff --check` passed after the audit edits. No application test rerun was required by the DOC gate; the prior card handoffs record the focused and full test results. The recorded blockers remain exact: R04's targeted Firefox alarm reproduction was user-authorized to be skipped; R30b's MySQL integration lacks `pdo_mysql` and a positively identified disposable MySQL 8.4 endpoint/schema. No remote service, database, deployment, commit, or push was performed.

Unfinished work / precise blocker / limitations: R35 is complete. Final acceptance is still pending under R36 because the plan contains required real-browser/backend validation gaps: R04 is `needs-validation`; R30b is `needs-validation`; R23/R29/R31/R33a/R33b are blocked by those dependencies. Deferred finding checkboxes, the pending ChatGPT fixture-redaction audit row, and conditional proposals remain deliberately unchecked. R34/R34a memory is unavailable and provider request counts are synthetic, not live-service evidence.

Next eligible session: R36 — Final verification and handoff. First concrete next action (path/function/test): Build the final implemented-card validation matrix, then run the relevant `npm test`, `npm run lint`, Firefox smoke, PHP/MYSQL, D1, and package/build checks without treating skipped backend/browser validation as passed. Do not begin any new feature work, commit, push, or deploy.
### R34a — 2026-09-12

Session ID / date: R34a / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` is absent; this canonical improvement plan supplied the startup protocol, settled defaults, findings, ledger, and latest R34 handoff. The large pre-existing dirty worktree, prior card changes, historical plan deletions, untracked product-gap/MySQL-plan documents, and unrelated runtime/test edits were preserved. The real Git index was not changed.

Findings/subtasks actually completed: Completed R34a by repeating the R34 Firefox benchmark with `R34_SIZES=10000,50000,100000` and fresh temporary profiles, defining a provisional 1,500 ms user-facing displayed-week Calendar read budget at 100,000 local entries, and comparing the repeat with the prior report. The F21 budget checkbox is now checked. The repeat report is `docs/benchmarks/r34a-history-benchmark.json`; `docs/scaling.md` records the budget, measurements, rationale, and decision. No production query/index optimization was started because both 100k Calendar reads were below budget.

Files changed for R34a: `docs/benchmarks/r34a-history-benchmark.json`, `docs/scaling.md`, and this plan. No production runtime, database schema, provider protocol, archive, delta API, worker, authentication, or health-cache change was made.

Behavior and compatibility decisions: The 1,500 ms budget is a provisional usability guardrail for the measured host/profile class, not a release SLA. The repeat used isolated temporary Firefox profiles and synthetic IndexedDB entries; it did not access or mutate a personal Firefox profile. The two 100k Calendar reads were 1,078 ms in R34 and 1,167 ms in R34a, so the measured threshold was not breached. The conditional optimization remains deferred, as do archives, delta APIs, workers, and virtualization. S05 readonly-session and F12 health-cache changes remain deferred because no meaningful contention or live-provider health cost was measured.

Tests added/replaced/removed; replacement coverage for each removal: No production tests were added or removed. R34a validation is the executable Firefox benchmark reproduction; it exercised Popup, Calendar, IndexedDB interval queries, history expansion, reconciliation, backup serialization, and migration digest/preview at all three sizes. Memory remains explicitly unavailable, and sync request counts remain explicitly simulated.

Commands and exact outcomes: `GECKODRIVER_BIN=/usr/local/bin/geckodriver R34_SIZES=10000,50000,100000 R34_OUTPUT=docs/benchmarks/r34a-history-benchmark.json node scripts/history-benchmark.mjs` completed for all three sizes and wrote the repeat report. It printed: `10000: popup 5ms, calendar 78ms, reconciliation 140ms, backup 266ms, migration 47ms`; `50000: popup 26ms, calendar 517ms, reconciliation 561ms, backup 1277ms, migration 253ms`; `100000: popup 39ms, calendar 1167ms, reconciliation 1230ms, backup 2728ms, migration 529ms`. The repeat report records 1/3/1 synthetic idle/dirty/forced request plans, null memory, and the fixed seed. No full test suite was rerun because R34a changed only documentation and generated benchmark evidence; the prior R34 JS/DB/HISTORY gates remain valid. `git diff --check` passed after the documentation update.

Unfinished work / precise blocker / limitations: R34a is complete. F21's production optimization and architecture-change checkboxes remain unchecked because the measured budget was not breached and live-provider/memory evidence is unavailable. The 1,500 ms budget must be revisited on representative deployment hardware/profile state before being treated as a release target. R04 remains needs-validation because the user-authorized Firefox alarm reproduction was skipped; R23 and R29 remain blocked by it. R30b remains needs-validation because `pdo_mysql` and a positively identified disposable MySQL 8.4 endpoint/schema are unavailable; R31 and R33a/R33b remain explicitly blocked.

Next eligible session: R35 — Audit coverage of every finding and conditional item. First concrete next action (path/function/test): Enumerate all finding checkboxes, simplification rows, test-audit removals, and blocked/needs-validation ledger entries, then map each to an R01–R34/R34a outcome without marking deferred work complete. Do not begin R31 or R33 while R30b remains needs-validation.

### R36 — 2026-09-12

Session ID / date: R36 / 2026-09-12
State: needs-validation
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` is absent, so `docs/current-functionality-improvement-plan.md` supplied the startup protocol, settled defaults, findings, ledger, work cards, and handoff history. The large dirty worktree, historical plan deletions, untracked product-gap/MySQL-plan documents, unrelated runtime/test edits, and all prior card changes were preserved. The real Git index was not changed; no commit, push, deployment, remote service, or remote database mutation was performed.

Findings/subtasks actually completed: Completed the R36 final review and evidence collection for all implemented cards. Reviewed the R35 finding-to-card map, simplification/test-audit map, conditional register, protected contracts, user-facing documentation, and package closure. No finding checkbox changed during R36: deferred, conditional, blocked, and needs-validation findings remain in their prior states.

Files changed for R36: this plan only. No production code, test, schema, provider, or package source was changed. The existing generated `web-ext-artifacts/` outputs were refreshed by the requested local lint/build checks and were not used to alter the real Git index.

Behavior and compatibility decisions: The aggregate implementation remains within the settled vanilla-JavaScript/local-first/provider-boundary contracts. The final report distinguishes the generic Firefox smoke pass from R04's missing targeted background-alarm stop/start reproduction after all UI pages are closed. It also distinguishes deterministic PHP/D1 and shared-contract evidence from the missing disposable MySQL engine run. The current PHP environment reports `pdo_mysql`, but no verified disposable MySQL 8.4 DSN/schema was available, so the MySQL integration was not treated as passed. No optional proposal (notifications, broader undo/split, project+task mapping, multiple destinations, health caching, architecture-scale storage changes, dual-token rotation, or further abstractions) was promoted.

Tests added/replaced/removed; replacement coverage for each removal: None. R36 is a verification/documentation card and made no source or test changes. The final package test continued to cover explicit package membership, prepared reference closure, missing-module negative coverage, deterministic output, and release metadata.

Commands and exact outcomes (distinguish baseline failures/skips):

- `GIT_INDEX_FILE=/tmp/ptl-r16-full.zHjyLc/index GIT_OBJECT_DIRECTORY=/tmp/ptl-r16-full.zHjyLc/objects GIT_ALTERNATE_OBJECT_DIRECTORIES=/home/daniel/Desktop/addons/personal-time-logger/.git/objects npm test`: passed, 79 test files, 0 failures, 79 tests, 0 skipped.
- `npm run lint`: passed. This ran ESLint and `web-ext lint`; the extension result was 0 errors, 0 notices, and 0 warnings. The environment-only web-ext update-check warning was printed and did not affect the exit status.
- `GIT_INDEX_FILE=/tmp/ptl-r16-full.zHjyLc/index GIT_OBJECT_DIRECTORY=/tmp/ptl-r16-full.zHjyLc/objects GIT_ALTERNATE_OBJECT_DIRECTORIES=/home/daniel/Desktop/addons/personal-time-logger/.git/objects GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run test:browser`: passed with `Browser runtime smoke passed: page readiness, local-first popup timer lifecycle/edit, draft preservation, offline first-run backup export/restore and lock handling, analytics, calendar render, provider-aware settings, options save, and cross-context lock.` This is general real-Firefox evidence; it does not satisfy the deliberately skipped R04 alarm-specific reproduction.
- `php server/mysql-api/tests/config_test.php`: passed (`Config CORS checks passed.`).
- `php server/mysql-api/tests/validator_test.php`: passed (`validator tests passed`).
- `php -l server/mysql-api/public/index.php`, `php -l server/mysql-api/src/Config.php`, and `php -l server/mysql-api/tests/config_test.php`: all passed with no syntax errors.
- `npm run test:cloudflare`: passed: 7 unit/scaffold tests and 4 local Worker+D1 integration tests, 0 failures.
- `bash server/mysql-api/tests/run.sh`: deterministic validator/config/session checks passed, but the MySQL integration was skipped because `PTL_TEST_MYSQL_DSN` and `PTL_TEST_MYSQL_ALLOW_RESET=1` were not configured for a disposable database. The runner explicitly directed the operator to use a disposable MySQL 8.4 database. This skip is not a pass.
- `GIT_INDEX_FILE=/tmp/ptl-r16-full.zHjyLc/index GIT_OBJECT_DIRECTORY=/tmp/ptl-r16-full.zHjyLc/objects GIT_ALTERNATE_OBJECT_DIRECTORIES=/home/daniel/Desktop/addons/personal-time-logger/.git/objects npm run build:xpi`: passed and produced `web-ext-artifacts/personal-time-logger-0.1.76.xpi`.
- `unzip -t web-ext-artifacts/personal-time-logger-0.1.76.xpi`: passed with no compressed-data errors. The archive contains 86 files, including `src/analytics-export.js`, `src/reconcile-export.js`, `src/tempo-submission-ledger.js`, `src/tempo-upload-handler.js`, and `src/usage-presentation.js`; `test/package.test.js` also passed in the temporary-index suite.
- `git diff --check`: passed. A Markdown relative-link check covered 6 documentation files and found 0 broken targets.

Package validation and temporary-index procedure, if applicable: Package tests, lint preparation, browser smoke, and XPI build used the established copied Git index `/tmp/ptl-r16-full.zHjyLc/index`, separate object directory `/tmp/ptl-r16-full.zHjyLc/objects`, and alternate real object directory `/home/daniel/Desktop/addons/personal-time-logger/.git/objects`. The explicit untracked runtime paths admitted for package validation were `extension/src/analytics-export.js`, `extension/src/reconcile-export.js`, `extension/src/tempo-submission-ledger.js`, `extension/src/tempo-upload-handler.js`, and `extension/src/usage-presentation.js`. The real Git index and unrelated worktree changes remained untouched.

Unfinished work / precise blocker / conditional decisions: R36 cannot be marked `done`. R04 remains `needs-validation` because its targeted Firefox background-alarm stop/start reproduction was skipped under the user's authorization; the generic browser smoke is not equivalent evidence. R30b remains `needs-validation` because, although `pdo_mysql` is present now, the MySQL runner had no verified disposable `PTL_TEST_MYSQL_DSN`/schema and therefore skipped the real HTTP contract. R23 and R29 remain blocked by R04; R31, R33a, and R33b remain blocked by R30b/R31. F12, F19, and the incomplete portions of F04/F05/F07/F08/F20/F21 remain unchecked or blocked as recorded. Memory and live-provider performance evidence remain unavailable, and no signing/publishing was attempted.

Next eligible session: Resume R36 validation; there is no new implementation card after this terminal verification card. First concrete next action (path/function/test): provision or identify a disposable MySQL 8.4 schema and run `PTL_TEST_MYSQL_DSN=... PTL_TEST_MYSQL_ALLOW_RESET=1 bash server/mysql-api/tests/run.sh`, then, if final acceptance still requires it, perform the authorized R04 alarm-path reproduction through `scripts/browser-runtime-smoke.mjs` or a deterministic background-alarm seam. Do not mark either result passed when the environment only skips it.

### R30b validation follow-up — 2026-09-12

Session ID / date: R30b-validation / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: The disposable MySQL 8.4 container `ptl-mysql-r36` was used on host port 3307 with the schema from `server/mysql-api/sql/001_initial_schema.sql`. Existing dirty worktree changes and the real Git index were preserved; no personal or production database was contacted.

Findings/subtasks actually completed: Re-ran the previously missing disposable-engine validation after the first attempt exposed a shared error-code mismatch. Updated `server/mysql-api/src/Http.php` so empty, malformed, and non-object JSON requests all use the provider-neutral `INVALID_REQUEST` code already required by the shared contract. The existing executable contract test then passed against MySQL.

Files changed: `server/mysql-api/src/Http.php` and this plan. No schema, token, deployment, or unrelated runtime behavior changed.

Commands and exact outcomes: `PTL_TEST_MYSQL_DSN='mysql:host=127.0.0.1;port=3307;dbname=personal_time_logger_test;charset=utf8mb4' PTL_TEST_MYSQL_USER='personal_time_logger_test' PTL_TEST_MYSQL_PASSWORD='test-password' PTL_TEST_MYSQL_ALLOW_RESET=1 bash server/mysql-api/tests/run.sh` passed deterministic validator/config checks, Session 1 MySQL integration, and `HTTP contract checks passed.` `php -l server/mysql-api/src/Http.php` passed with no syntax errors. `git diff --check` passed. The initial run before the source fix failed only at `server/http-contract.mjs:49` with actual `INVALID_JSON` versus expected `INVALID_REQUEST`; that mismatch is resolved.

Unfinished work / precise blocker / limitations: R30b is now done and F20's shared disposable-server HTTP checkbox is checked. R31 is the next eligible card; R33a and R33b remain blocked by R31. R04 remains `needs-validation` because its targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization. The MySQL container is disposable and must not be reused for personal or production data.

Next eligible session: R31 — Execute D1 schema assertions instead of matching SQL text. First concrete next action (path/function/test): read the D1 scaffold/migration/integration tests, run the R31 D1 baseline, and replace only SQL-spelling assertions covered by executable schema behavior. Do not begin R33a or R33b before R31 is complete.

### R33a — 2026-09-12

Session ID / date: R33a / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. R30b and R31 were complete before this card. The large dirty worktree, historical plan deletions, untracked product-gap/MySQL-plan documents, unrelated runtime/test edits, and the real Git index were preserved. All recovery work used the explicitly disposable MySQL 8.4 container `ptl-mysql-r36` on host port 3307; no personal or production database was contacted.

Findings/subtasks actually completed: Completed the remaining MySQL operational-support slice of F20. Added a documented distinction between extension JSON backups and server/schema SQL backups, a limited-user-safe disposable backup/restore drill, synthetic bearer-token replacement/per-device recovery instructions, and an ordered forward-only schema-upgrade procedure. Executed the backup/restore and token-rotation drill against a separately named disposable restore database, then verified the restored endpoint with the shared HTTP contract. No second schema migration exists, so the future upgrade procedure is documented but cannot be exercised against a real version transition yet.

Files changed for R33a: `server/mysql-api/tests/README.md` and this plan. The PHP `Http.php` contract normalization was completed in the preceding R30b validation follow-up; R33a did not alter production API behavior.

Behavior and compatibility decisions: `mysqldump --single-transaction --no-tablespaces` is the documented backup command because the restricted test user lacks `PROCESS` for tablespace metadata. Restore targets must be newly created disposable databases and use an administrative account for schema creation/import. The API config and bearer-token digest remain outside `public/` and outside SQL data backups. Token replacement intentionally invalidates the old token immediately; no dual-token or multi-user identity system was introduced. The current repository has only `001_initial_schema.sql`, so upgrades remain explicit, ordered, forward-only files rather than a generic migration framework.

Tests added/replaced/removed; replacement coverage for each removal: No application test was removed or added. The existing Session 1 MySQL integration and shared HTTP contract were used as the restored-endpoint regression boundary.

Commands and exact outcomes (distinguish baseline failures/skips): The final disposable drill used `mysqldump --protocol=tcp --host=127.0.0.1 --port=3307 --user=personal_time_logger_test --single-transaction --no-tablespaces personal_time_logger_test`, created `ptl_r33a_restore`, imported the SQL backup, and verified the sentinel entry (`R33a|Recovery|Disposable backup sentinel|1`) and `backup-value` config. Synthetic token rotation passed with old token statuses `200` before replacement and `401` after, and new token statuses `401` before replacement and `200` after. `PTL_TEST_HTTP_TOKEN=r33a-new-token node server/http-contract.mjs http://127.0.0.1:18768 r33a-new-token` passed. Final `PTL_TEST_MYSQL_DSN='mysql:host=127.0.0.1;port=3307;dbname=personal_time_logger_test;charset=utf8mb4' PTL_TEST_MYSQL_USER=personal_time_logger_test PTL_TEST_MYSQL_PASSWORD=test-password PTL_TEST_MYSQL_ALLOW_RESET=1 bash server/mysql-api/tests/run.sh` passed deterministic validator/config checks, Session 1 MySQL integration, and the shared HTTP contract. `php -l server/mysql-api/src/Http.php`, `php -l server/mysql-api/public/index.php`, `php -l server/mysql-api/src/Config.php`, and `git diff --check` all passed. The initial exploratory dump without `--no-tablespaces` emitted a non-fatal PROCESS-privilege warning; the final documented run was clean.

Package validation and temporary-index procedure, if applicable: Not applicable; R33a changed backend documentation only. Temporary restore databases, API processes, synthetic tokens, and SQL backup files were removed by the drill cleanup.

Unfinished work / precise blocker / conditional decisions: R33a is complete. F20's backup-restoration, token/per-device recovery, and MySQL schema-procedure checkboxes are now complete. The documented schema-upgrade sequence has no second migration to execute yet. R04 remains `needs-validation` because its targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization; R23 and R29 remain blocked by R04. No remote migration, deployment, signing, or publishing was performed.

Next eligible session: R36 — Resume final verification and handoff. First concrete next action (path/function/test): review the final ledger and run only the remaining R04 alarm-specific Firefox validation if it is to be supplied; otherwise preserve R04 as `needs-validation` and record that final acceptance cannot become `done`.

### R33b — 2026-09-12

Session ID / date: R33b / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`; R30b, R31, and R33a were complete or validated. The existing dirty worktree, untracked operational documents, and real Git index were preserved. The drill used only temporary local Wrangler state and never used `--remote`.

Findings/subtasks actually completed: Added a repeatable local D1 recovery procedure to `server/cloudflare-d1/README.md`, including temporary source/restore working directories, migration application, SQL export/import, migration-list verification, sentinel data/config comparison, local Worker health/HTTP verification, cleanup, and explicit limits on remote recovery/token operations.

Files changed for R33b: `server/cloudflare-d1/README.md` and this plan. No production Worker, migration, remote D1 database, or deployment was changed.

Behavior and compatibility decisions: The procedure uses Wrangler's local database for both export and import. Because the installed Wrangler 4.129.0 supports `--persist-to` for local migration/execute but not for `d1 export`, the documented drill uses separate temporary working directories and `--cwd` so each command resolves its own default `.wrangler/state`. `d1 migrations list` remains the migration-order check. Remote export/import, remote token rotation, Cloudflare retention, and Time Travel remain operator procedures and are not claimed as locally validated.

Tests added/replaced/removed; replacement coverage for each removal: No application test was removed or added. The existing local Worker/shared-contract test remains intact; the recovery drill adds operational evidence outside the test suite.

Commands and exact outcomes (distinguish baseline failures/skips): With Wrangler 4.129.0, the final disposable drill ran `d1 migrations apply DB --local`, inserted a synthetic sentinel entry/config, ran `d1 export DB --local --skip-confirmation --output /tmp/.../backup.sql`, imported it with `d1 execute DB --local --file /tmp/.../backup.sql --yes` into a separate temporary state, and ran `d1 migrations list DB --local`, which reported `No migrations to apply!`. Metadata, sentinel entry/config, and migration state matched the source. A local Worker started from the restored state, returned authenticated health, and `node server/http-contract.mjs http://127.0.0.1:18769 r33b-local-token` passed. The first exploratory attempt exposed two CLI/setup issues—`d1 export` rejects unsupported `--persist-to`, and the temporary Worker digest must match the synthetic token—then the corrected run passed. The official [Wrangler D1 command reference](https://developers.cloudflare.com/d1/wrangler-commands/) was checked for the supported local/remote/export/migration flags before updating the README.

Package validation and temporary-index procedure, if applicable: Not applicable; R33b changed backend documentation only. Temporary Wrangler configurations, local states, SQL backup, Worker, and synthetic token were removed after validation. No remote command was run.

Unfinished work / precise blocker / conditional decisions: R33b is complete. The D1 local recovery checkbox is covered as part of F20's completed backend recovery drill. Remote D1 recovery and production token rotation remain explicitly untested; the README directs operators to verify current Cloudflare behavior before remote operations. R04 remains `needs-validation`, so R23 and R29 remain blocked and R36 cannot be marked `done` solely from these local backend results.

Next eligible session: R36 — Resume final verification and handoff. First concrete next action (path/function/test): reconcile the completed R33a/R33b evidence with the final acceptance matrix and preserve the R04 alarm reproduction as `needs-validation` unless that exact Firefox scenario is run.

### R36 final validation follow-up — 2026-09-12

Session ID / date: R36-final-validation / 2026-09-12
State: needs-validation
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. R31, R33a, and R33b were completed before this final gate. The large dirty worktree, historical plan deletions, untracked operational documents and runtime/test files, and real Git index were preserved. No commit, push, deployment, signing, remote migration, or production database mutation was performed.

Findings/subtasks actually completed: Reconciled the completed R33a/R33b evidence with the final implementation matrix, protected contracts, user-facing documentation, package closure, and conditional/deferred findings. Confirmed that all executable cards and F20's initial operational-support checkboxes have evidence. No additional finding checkbox was changed during this final validation.

Files changed for this follow-up: this plan only. R33a added MySQL recovery/token/schema documentation, R33b added local D1 recovery documentation, and the prior R30b follow-up corrected provider-neutral malformed-JSON errors; no further production behavior changed in this gate.

Commands and exact outcomes: Final temporary-index `npm test` passed 79 test files with 0 failures and 0 skipped. Final temporary-index `npm run lint` passed JavaScript lint and extension `web-ext lint` with 0 errors, 0 notices, and 0 warnings; only the environmental web-ext update-check warning appeared. Elevated temporary-index `GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run test:browser` passed the existing real-Firefox smoke summary. `npm run test:cloudflare` passed 6 unit/scaffold tests and 5 local Worker+D1 integration tests, including the executable migration-constraint test. `PTL_TEST_MYSQL_DSN='mysql:host=127.0.0.1;port=3307;dbname=personal_time_logger_test;charset=utf8mb4' PTL_TEST_MYSQL_USER=personal_time_logger_test PTL_TEST_MYSQL_PASSWORD=test-password PTL_TEST_MYSQL_ALLOW_RESET=1 bash server/mysql-api/tests/run.sh` passed deterministic checks, Session 1 MySQL integration, and the shared HTTP contract. PHP lint for `server/mysql-api/src/Http.php`, `public/index.php`, and `src/Config.php` passed. `git diff --check` passed. The R33a disposable restore and token rotation passed, and the R33b local D1 export/import, migration-list, sentinel, and restored HTTP contract passed; those exact drill outcomes are recorded in their handoffs immediately above.

Unfinished work / precise blocker / conditional decisions: R36 remains `needs-validation`, not `done`, solely because R04's targeted Firefox background-alarm stop/start reproduction after UI pages close was explicitly skipped by user authorization. The generic Firefox smoke is not equivalent evidence. R23 and R29 remain blocked by R04. All executable backend recovery and schema/test-audit cards are complete. Remaining optional/deferred finding scope, unavailable benchmark memory/live-provider evidence, and the pending ChatGPT fixture-redaction audit remain deliberately unclaimed.

Next eligible session: Resume R36 only if the R04 gate is to be supplied; there is no further implementation card after R36. First concrete next action (path/function/test): run the exact R04 alarm-path reproduction through `scripts/browser-runtime-smoke.mjs` with a deterministic background-alarm seam or disposable provider endpoint, or retain the documented user-authorized `needs-validation` limitation. Do not mark final acceptance as done from the generic smoke alone.

### R31 — 2026-09-12

Session ID / date: R31 / 2026-09-12
State: done
Starting revision and relevant pre-existing worktree state: Revision `3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested `docs/current-functionality-session-runbook.md` remains absent; the canonical startup protocol, settled defaults, ledger, findings, and latest R30b validation handoff were read from `docs/current-functionality-improvement-plan.md`. The large dirty worktree, historical plan deletions, untracked product-gap/MySQL-plan documents, unrelated runtime/test edits, and prior card changes were preserved. The real Git index was not changed.

Findings/subtasks actually completed: Completed the R31 D1 test-audit card. The scaffold test now retains only the placeholder-only Worker configuration/DB-binding and no-secret assertion. The local integration harness applies the actual migration, queries the initial `app_meta` row, verifies the default `remote_version`, and proves that invalid `schema_version`, invalid `remote_version`, and null mutation-guard writes are rejected by the database. The D1 SQL-spelling assertions were removed only after executable behavior covered their contract.

Files changed for R31: `server/cloudflare-d1/test/scaffold.test.js`, `server/cloudflare-d1/test/integration.test.mjs`, and this plan. No production schema, Worker behavior, remote D1 database, or unrelated test was changed.

Behavior and compatibility decisions: The migration remains unchanged. Schema correctness is now established through the same local Wrangler/D1 database used by the integration harness rather than by regexes over migration text. Constraint error wording is not treated as the contract; the test requires the invalid write to fail and checks that the failure is a database constraint failure. The example Wrangler configuration remains placeholder-only and is still checked for absence of bearer tokens, digests, and other secret material.

Tests added/replaced/removed; replacement coverage for each removal: Removed only the six exact migration-text assertions for table names, metadata insertion, remote-version check syntax, and mutation-guard check syntax. Replaced them with one executable local-D1 integration test covering initial metadata, default versioning, and rejected invalid constraints. The existing placeholder/no-secret configuration test remains. No production tests or independent API/race/rollback cases were removed.

Commands and exact outcomes (distinguish baseline failures/skips): The non-elevated baseline `npm run test:cloudflare` could not start the local Worker because the restricted environment returned `listen EPERM: operation not permitted 127.0.0.1`; this was an environment limitation, not a test assertion result. Baseline `node --experimental-global-webcrypto --test server/cloudflare-d1/test/scaffold.test.js` passed its original scaffold check. Final elevated `npm run test:cloudflare` passed 6 unit/scaffold tests and 5 local Worker+D1 integration tests, 0 failures, 0 skipped, including `enforces migrated metadata, version, and mutation-guard constraints`. Final temporary-index `npm test` passed 79 test files, 0 failures, 0 skipped. Final `npm run lint:js` passed. Final `git diff --check` passed. No remote D1 command, deployment, or production database mutation was performed.

Package validation and temporary-index procedure, if applicable: No package source or runtime module changed, so PACKAGE-GATE was not applicable. The full JavaScript suite used the established temporary index/object procedure under `/tmp/ptl-r16-full.zHjyLc`; the real Git index remained unchanged.

Unfinished work / precise blocker / conditional decisions: R31 is complete and no finding checkbox changed; only the owned D1 SQL-spelling test-audit row was completed. R04 remains `needs-validation` because its targeted Firefox alarm stop/start reproduction was explicitly skipped by user authorization, so R23 and R29 remain blocked. R33a and R33b are now both eligible because R30b and R31 are done; neither was started in this session. R36 remains `needs-validation` solely because the R04 real-browser acceptance gap remains.

Next eligible session: R33a — Document and verify the disposable MySQL recovery procedure. First concrete next action (path/function/test): read `server/mysql-api/README.md`, `server/mysql-api/sql/001_initial_schema.sql`, `server/mysql-api/tests/README.md`, and the existing integration harness; then define the disposable backup-restore, token replacement, and ordered schema-upgrade drill before executing it only against a disposable MySQL 8.4 database. Do not begin R33b in the same session.

### R04 — 2026-09-12 — targeted Firefox validation

Session ID / date: R04-alarm-validation / 2026-09-12

State: done

Starting revision and relevant pre-existing worktree state: The existing dirty
worktree, historical plan deletions, untracked operational documents and
runtime modules, and the real Git index were preserved. No commit, push,
deployment, signing, production provider, or production database operation was
performed.

Findings/subtasks actually completed: Completed F13's remaining browser
reproduction checkbox and R04's three validation tasks. The browser smoke now
creates a disposable local HTTPS API using the existing MySQL provider contract,
adds the exact loopback port only to the temporary smoke manifest, and exposes
smoke-only background controls gated by the `example.invalid` update URL. The
test arms the real Firefox one-shot `SYNC_ALARM`, navigates the only extension
page to `about:blank` before the alarm fires, then verifies a remote stop import
sets the persisted entry completed and the background-owned toolbar inactive,
followed by a remote start import and active toolbar. The existing stale-read
coalescing and icon-failure tests remain in place and passed.

Files changed for R04: `extension/background/background.js`,
`scripts/browser-runtime-smoke.mjs`, and this plan. The production alarm
listener, shared BroadcastChannel event system, provider URL rules, and
normal release manifest permissions were not broadened. The test-only message
handlers are inert unless the prepared smoke manifest carries the exact
non-routable test update URL.

Behavior and compatibility decisions: The acceptance test uses a local
disposable HTTPS endpoint rather than a live provider. It returns a stable
baseline, stopped, and started snapshot phase; the Firefox smoke package grants
only that temporary loopback port and accepts its generated certificate only in
the test WebDriver session. The alarm event is delivered by Firefox's actual
`alarms` API and the background's existing `platform.onAlarm` listener. Toolbar
state is recorded only after the real `updateActiveIcon` call succeeds, so the
assertion does not treat a failed icon update as a pass.

Tests added/replaced/removed; replacement coverage for each removal: No
existing test was removed. Added the disposable-provider/real-alarm browser
scenario and retained the focused stale-read, read-failure, icon-failure, and
alarm-scheduling tests.

Commands and exact outcomes (distinguish baseline failures/skips):

- `node --experimental-global-webcrypto --test test/icon.test.js test/background-schedule.test.js`: 10 tests passed, 0 failed, 0 skipped.
- `npm run lint:js`: passed.
- `GIT_INDEX_FILE=/tmp/ptl-r16-full.zHjyLc/index GIT_OBJECT_DIRECTORY=/tmp/ptl-r16-full.zHjyLc/objects GIT_ALTERNATE_OBJECT_DIRECTORIES=/home/daniel/Desktop/addons/personal-time-logger/.git/objects npm test`: 79 test files passed, 0 failed, 0 skipped.
- `GIT_INDEX_FILE=/tmp/ptl-r16-full.zHjyLc/index GIT_OBJECT_DIRECTORY=/tmp/ptl-r16-full.zHjyLc/objects GIT_ALTERNATE_OBJECT_DIRECTORIES=/home/daniel/Desktop/addons/personal-time-logger/.git/objects GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run test:browser`: passed page readiness, local-first timer/edit, draft preservation, offline backup/restore and lock handling, analytics, calendar, provider-aware settings, options, cross-context lock, and the R04 closed-page alarm stop/start toolbar transitions.
- A plain `npm test` against the real Git index still fails the pre-existing package allow-list assertion because untracked runtime modules are intentionally omitted by `git ls-files`; this is why the documented temporary-index procedure was used. It is not an R04 assertion failure.
- `git diff --check`: passed after the R04 edits and handoff update.

Package validation and temporary-index procedure, if applicable: The browser
scenario and full suite used `/tmp/ptl-r16-full.zHjyLc/index` with separate
`objects` and the real repository objects as an alternate. The real Git index
was not changed. The temporary XPI was deleted with the smoke artifacts, and
the local HTTPS server, generated certificate, and test data were closed and
removed after the run.

Unfinished work / precise blocker / conditional decisions: R04 is complete.
F13 has no remaining unchecked item. R23 is now eligible but remains
unimplemented; R29 remains blocked by unfinished R23. R36 remains
`needs-validation` until the remaining required plan cards are completed and
its aggregate final gate is rerun. Optional/deferred findings and the known
unavailable memory/live-provider evidence remain deliberately unclaimed.

Next eligible session: R23 — Present coherent sync freshness and cadence.
First concrete next action (path/function/test): read F12 and inspect the
existing sync outcome, `background-schedule.js`, Popup status, Options status,
and diagnostics rendering, then define the smallest shared status snapshot and
focused SYNC/UI regression cases before changing any presentation.

### R23 — 2026-09-12

Session ID / date: R23 / 2026-09-12

State: done

Starting revision and relevant pre-existing worktree state: Revision
`3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested
`docs/current-functionality-session-runbook.md` is absent; this canonical plan
supplied the startup protocol, settled defaults, findings, ledger, and latest
handoff. The large dirty worktree, historical plan deletions, untracked
operational documents/runtime modules, and real Git index were preserved. No
commit, push, deployment, signing, live-provider request, or production
database operation was performed.

Findings/subtasks actually completed: Completed all four F12 checkboxes and
R23's three numbered tasks. Added a shared sync status reader that combines the
active provider, local pending count, review count, persisted last successful
exchange, next retry/check, effective alarm cadence, and current idle delay.
Successful sync cycles now persist the timestamp and `synced`/`needs review`
outcome without changing scheduler timing. Popup and Options render the same
status vocabulary, including the distinction between locally saved,
remotely synchronized, and needs review. Added an explicit provider-injection
seam used only by tests to count API-shaped idle, dirty, and forced cycles.
Measured counts are idle 2 (health plus change token), dirty 4 (health,
snapshot, write, and post-write marker), and forced 2 (health plus snapshot).
The requested health-cache consideration was completed as a deliberate defer:
no cache was introduced because R23 is presentation/measurement scope and
compatibility checks must remain after changes, recovery, and relevant
failures.

Files changed for R23: `extension/src/setting-keys.js`,
`extension/src/sync.js`, new `extension/src/sync-status.js`,
`extension/popup/popup.html`, `extension/popup/popup.js`,
`extension/popup/popup.css`, `extension/options/options.html`,
`extension/options/options.js`, `extension/options/options.css`,
`test/sync-status.test.js`, `test/sync-request-counts.test.js`,
`test/package.test.js`, `scripts/browser-runtime-smoke.mjs`, `README.md`,
and this plan. Existing production scheduler intervals and provider protocols
were not changed.

Tests added/replaced/removed; replacement coverage for each removal: Added
status aggregation/formatting tests, injected-provider request-count tests,
and a Firefox smoke scenario that seeds pending/review/freshness state and
checks Popup plus Options cadence text. No existing test was removed. The
package allow-list was extended for the new tracked runtime module.

Commands and exact outcomes (distinguish baseline failures/skips):

- `node --experimental-global-webcrypto --test test/background-schedule.test.js test/sync-status.test.js test/sync-request-counts.test.js test/sync-maintenance.test.js test/sync-pull.test.js test/sync-acknowledgement.test.js test/sync-lease-fence.test.js test/sync-coalescing.test.js test/sync-config.test.js test/sync-cloudflare-recovery.test.js test/tombstone-policy-investigation.test.js`: 11 tests passed, 0 failed, 0 skipped.
- Initial package validation exposed the expected missing allow-list entry for
  new `src/sync-status.js`; after adding that entry, `node
  --experimental-global-webcrypto --test test/package.test.js
  test/create-update-site.test.js`: 4 tests passed, 0 failed, 0 skipped.
- Temporary-index `npm test`: 81 test files passed, 0 failed, 0 skipped.
- Temporary-index `npm run lint:extension`: 0 errors, 0 notices, 0 warnings;
  web-ext printed only its environmental update-check warning.
- `npm run lint:js`, `node --check scripts/browser-runtime-smoke.mjs`, and
  `git diff --check`: passed.
- Elevated temporary-index `GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run
  test:browser`: passed Popup freshness, Options cadence, and all existing
  browser scenarios, including R04 closed-page alarm stop/start transitions.

Package/browser validation used the established copied index
`/tmp/ptl-r16-full.zHjyLc/index`, object directory
`/tmp/ptl-r16-full.zHjyLc/objects`, and alternate real object directory
`/home/daniel/Desktop/addons/personal-time-logger/.git/objects`. Only the new
explicit runtime/test paths were admitted to the temporary index; the real
Git index remained unchanged. Firefox required elevation because the smoke
server binds loopback. No live provider or backend was contacted.

Unfinished work / precise blocker / remaining limitations: R23 is complete.
Request counts are deterministic provider-boundary measurements, not live
latency or service-wide quotas. The UI reports a next retry/check deadline
from local backoff/scheduling state; it cannot predict a provider's external
availability. F19/R29 is now eligible but not started at the time this
handoff was written; R36 remains `needs-validation` until its aggregate final
gate is rerun after the remaining required cards.

Next eligible session: R29 — Improve bounded local diagnostics and error
consistency. First concrete action (path/function/test): read F19 and inspect
`extension/src/diagnostics.js`, `extension/src/error-registry.js`, background
diagnostic call sites, Options diagnostics rendering, and the named diagnostic
tests; then define the smallest privacy-safe cross-layer deduplication and
recovery-navigation regression cases before editing.

### R29 — 2026-09-12

Session ID / date: R29 / 2026-09-12

State: done

Starting revision and relevant pre-existing worktree state: Revision
`3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested
`docs/current-functionality-session-runbook.md` is absent; this canonical plan
supplied the startup protocol, settled defaults, findings, ledger, and latest
handoff. The large dirty worktree, historical plan deletions, untracked
operational documents/runtime modules, and real Git index were preserved. No
commit, push, deployment, signing, live-provider request, or production
database operation was performed.

Findings/subtasks actually completed: Completed all four F19 checkboxes and
R29's three numbered tasks. Diagnostic records now carry bounded occurrence
counts, extension version, sanitized provider, and sanitized freshness context.
Repeated same-code/same-cause failures in the same phase deduplicate across
sync/background subsystems while distinct phases and codes remain separate.
Options renders a local support summary with provider, last successful sync,
and current freshness state, plus the latest bounded records and section-local
links for General, Storage, Reconciliation, or Tempo recovery. Sync-generated
failure records include the persisted last-success freshness value when one is
available. The existing coded-error constructor already preserves domain
metadata, so no generic wrapper was replaced and Tempo progress behavior was
left intact.

Files changed for R29: `extension/src/diagnostics.js`,
`extension/src/sync.js`, `extension/options/options.js`,
`extension/options/options.html`, `extension/options/options.css`,
`test/diagnostics.test.js`, `scripts/browser-runtime-smoke.mjs`, and this
plan. No raw error message, URL, credential, or entry content is copied into
diagnostics; display uses `textContent` and stored fields are sanitized and
bounded.

Tests added/replaced/removed; replacement coverage for each removal: Extended
the diagnostic suite with occurrence-count, cross-layer deduplication,
distinct-phase, and safe-context cases. Extended Firefox smoke with a
quarantined-record navigation scenario. No existing test was removed. The
existing `test/error-registry.test.js` and `test/coded-error.test.js` continue
to enforce stable mappings, safe messages, and domain metadata preservation.

Commands and exact outcomes (distinguish baseline failures/skips):

- `node --experimental-global-webcrypto --test test/diagnostics.test.js test/error-registry.test.js test/coded-error.test.js test/sync-maintenance.test.js test/sync-pull.test.js test/sync-acknowledgement.test.js test/sync-lease-fence.test.js test/sync-coalescing.test.js test/sync-config.test.js test/sync-cloudflare-recovery.test.js test/tombstone-policy-investigation.test.js`: 11 tests passed, 0 failed, 0 skipped.
- Temporary-index `npm test`: 81 test files passed, 0 failed, 0 skipped.
- Temporary-index `npm run lint:extension`: 0 errors, 0 notices, 0 warnings;
  web-ext printed only its environmental update-check warning.
- Temporary-index `node --experimental-global-webcrypto --test
  test/package.test.js test/create-update-site.test.js`: 2 tests passed, 0
  failed, 0 skipped.
- `npm run lint:js`, `node --check scripts/browser-runtime-smoke.mjs`, and
  `git diff --check`: passed.
- Final elevated temporary-index `GECKODRIVER_BIN=/usr/local/bin/geckodriver
  npm run test:browser`: passed the R29 bounded diagnostics/navigation
  scenario and all existing browser scenarios, including R04 closed-page
  alarm stop/start toolbar transitions.

The Firefox/package/full-suite checks used the established copied index
`/tmp/ptl-r16-full.zHjyLc/index`, object directory
`/tmp/ptl-r16-full.zHjyLc/objects`, and alternate real object directory
`/home/daniel/Desktop/addons/personal-time-logger/.git/objects`. The real Git
index remained unchanged. Firefox required elevation because the smoke server
binds loopback. No live provider or backend was contacted.

Unfinished work / precise blocker / remaining limitations: R29 is complete.
The occurrence count is capped at `1,000,000`, and the ring remains capped at
50 records. Deduplication is intentionally limited to the latest record within
the existing 60-second window; older repetitions remain separate bounded
history. Recovery links navigate to local sections but do not execute remote
repair automatically. R36 remains `needs-validation` pending its aggregate
final review gate; optional/deferred finding scope and unavailable live-provider
evidence remain deliberately unclaimed.

Next eligible session: R36 — Final verification and handoff. First concrete
action (path/function/test): build the final implemented-card validation matrix
from this plan, then rerun the relevant aggregate JS/package/Firefox/PHP/
MYSQL/D1 checks while preserving explicit skips and the documented R36
limitations; do not treat a skipped backend or browser check as passed.

### R36 — 2026-09-13 — final aggregate verification

Session ID / date: R36-final-aggregate / 2026-09-13

State: done

Starting revision and relevant pre-existing worktree state: Revision
`3a1f13f77a66478f527a3044f4a79a72a765cdf8`. The requested
`docs/current-functionality-session-runbook.md` remains absent; this canonical
plan supplied the startup protocol, settled defaults, ledger, work cards, and
latest R29 handoff. The large dirty worktree, historical plan deletions,
untracked operational documents/runtime modules, and real Git index were
preserved. No commit, push, deployment, signing, or production operation was
performed.

Findings/subtasks actually completed: Completed R36's final aggregate review
and updated only the R36 ledger state. Reconciled R23 and R29 with the prior
R01–R35 evidence, protected contracts, user-facing documentation, conditional
register, package contents, and deliberate deferred/optional findings. No
additional finding checkbox was changed. R04's targeted alarm reproduction,
R23, and R29 are now complete; deferred proposals and unavailable
live-service/performance evidence remain explicitly unclaimed.

Files changed for this final session: this plan only. No production source,
test, schema, provider contract, or package source was changed. The existing
generated `web-ext-artifacts/` output was refreshed by final lint/build checks;
the real Git index remained unchanged.

Validation matrix and exact outcomes:

- Temporary-index `npm test`: 81 test files passed, 0 failed, 0 skipped.
- Temporary-index `npm run lint`: JavaScript lint passed; extension lint
  reported 0 errors, 0 notices, and 0 warnings. web-ext printed only its
  environmental update-check warning.
- Elevated temporary-index `GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run
  test:browser`: passed the complete Firefox smoke, including Popup/Options
  freshness, bounded diagnostics navigation, and R04 closed-page alarm
  stop/start toolbar transitions.
- `php server/mysql-api/tests/config_test.php`,
  `php server/mysql-api/tests/validator_test.php`, and PHP lint for
  `server/mysql-api/src/Http.php`, `public/index.php`, and `src/Config.php`:
  passed with no syntax errors.
- `npm run test:cloudflare`: passed 6 unit/scaffold tests and 5 local
  Worker+D1 integration tests, 0 failed, including migration constraints and
  the shared HTTP contract.
- Temporary-index `node --experimental-global-webcrypto --test
  test/package.test.js test/create-update-site.test.js`: 2 tests passed, 0
  failed, 0 skipped.
- Temporary-index `npm run build:xpi`: produced
  `web-ext-artifacts/personal-time-logger-0.1.76.xpi`; `unzip -t` passed with
  no compressed-data errors. The archive contains 87 files, including
  `src/sync-status.js`, `src/diagnostics.js`, Popup, and Options assets.
- `git diff --check`: passed.

MySQL qualification: the current environment has `pdo_mysql`, but Docker is
not accessible and the only local server is MariaDB 10.11, not MySQL 8.4. No
MariaDB result was substituted or claimed. The prior R30b handoff records the
exact disposable MySQL 8.4 schema/integration/shared-contract pass, and no
backend source changed in R23, R29, or this final session, so that evidence
remains the applicable backend result. A future backend retest must use a
positively identified disposable MySQL 8.4 endpoint and
`PTL_TEST_MYSQL_ALLOW_RESET=1`; never use a personal or production database.

Temporary-index/package procedure: aggregate JS, lint, package, browser, and
XPI checks used `/tmp/ptl-r16-full.zHjyLc/index`,
`/tmp/ptl-r16-full.zHjyLc/objects`, and alternate real objects at
`/home/daniel/Desktop/addons/personal-time-logger/.git/objects`. The real Git
index and unrelated worktree changes were not staged or altered. Firefox used
the required elevated loopback permission for its disposable local smoke
server.

Remaining limitations: the plan deliberately retains unchecked conditional or
optional proposals, including notifications, broader undo/split behavior,
project-plus-task Tempo mappings, multiple destinations, health caching,
architecture-scale storage changes, dual-token rotation, and further
abstractions. Benchmark memory and live-provider request/latency evidence are
unavailable. R36 is complete because every implemented slice has recorded
evidence and these limitations are explicit; this does not claim those
optional proposals or unavailable measurements.

Next eligible step: none; R36 is the terminal verification card. First
concrete follow-up action, only if separately authorized, is to review the
final report/package artifact for release handling. No release, signing,
publishing, commit, or deployment is authorized by this session.

### F04 follow-up — 2026-09-13 — default-unsent preview and API capability verification

Session ID / date: F04-follow-up / 2026-09-13

State: done

Starting revision and relevant pre-existing worktree state: The worktree already contained the completed R01–R36 changes, historical plan deletions, untracked operational/runtime files, and unrelated source/test edits. Those changes were preserved. The real Git index was not changed; no commit, push, deployment, signing, or remote write was performed.

Findings/subtasks actually completed: Completed both remaining F04 checkboxes. The Tempo preview now selects allocations created after a persisted local tracking epoch when they have no ledger outcome. Allocations created before that epoch remain `Untracked history · review`, so the feature does not falsely label pre-ledger work as never sent. Acknowledged and unknown outcomes remain explicit resends, changed same-day allocations remain review-only, and known rejections remain safe retries. Verified the current official Tempo API boundary: the public documentation exposes bulk/read worklogs and worklog-ID-based GET/PUT/DELETE operations, while the create contract does not provide this extension's local entry fingerprint as an idempotency key. No remote matching, update, or delete behavior was proposed or implemented; the same-profile ledger limitation remains explicit.

Files changed: `extension/src/setting-keys.js`, `extension/src/tempo-submission-ledger.js`, `extension/calendar/tempo-controller.js`, `test/tempo-submission-ledger.test.js`, `test/tempo-controller.test.js`, `scripts/browser-runtime-smoke.mjs`, `README.md`, and this plan. No provider wire payload or backend schema changed. The new tracking-epoch setting is local-only and remains excluded from portable backups.

Behavior and compatibility decisions: The epoch is created atomically on the first Tempo send attempt and is not included in exports. Only an entry with a valid `created_at` at or after that epoch is default-selected as unsent. Missing or pre-epoch timestamps fail closed to explicit review. Tempo worklog IDs are not stored because remote matching/update/delete would require a separate identity and reconciliation design; API capability verification alone does not establish cross-device duplicate prevention.

Tests added/updated: Added ledger coverage for post-epoch unsent versus pre-epoch review classification and preview-model coverage for default selection. Updated the real Firefox smoke fixture to establish the epoch before creating a Tempo entry and assert `Unsent · send` in the rendered preview. No tests were removed.

Exact validation results: Focused `node --experimental-global-webcrypto --test test/tempo.test.js test/tempo-day-selection.test.js test/time-allocation.test.js test/tempo-controller.test.js test/tempo-submission-ledger.test.js test/tempo-upload-handler.test.js`: 6 files passed, 0 failed. Targeted ESLint over the changed JavaScript/test files: passed. Temporary-index `node --experimental-global-webcrypto --test test/package.test.js test/create-update-site.test.js`: 2 tests passed, 0 failed, 0 skipped. Elevated temporary-index `GIT_INDEX_FILE=/tmp/ptl-r16-full.zHjyLc/index GIT_OBJECT_DIRECTORY=/tmp/ptl-r16-full.zHjyLc/objects GIT_ALTERNATE_OBJECT_DIRECTORIES=/home/daniel/Desktop/addons/personal-time-logger/.git/objects GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run test:browser`: passed, including the Tempo preview assertion and the existing R04 alarm smoke. `git diff --check`: passed. The ordinary `npm run lint:js` was not a valid final gate because it found the pre-existing untracked `extension/src/.package-test-untracked.js` fixture; the ordinary package test also omitted previously untracked runtime modules from the real Git index. Neither failure was counted as an F04 regression.

External verification: [Tempo's current public API documentation](https://tempo.apidocumentation.com/) lists `GET/POST /worklogs`, `GET /worklogs/{id}`, `PUT /worklogs/{id}`, and `DELETE /worklogs/{id}`. Tempo's [Cloud migration guidance](https://help.tempo.io/cloudmigration/latest/worklog-rest-apis-for-jira-cloud) documents paginated bulk reads and deleted-worklog retrieval. These endpoints operate on provider worklog IDs and do not make the extension's local fingerprint a safe idempotency key.

Remaining limitations: The tracking epoch is per local profile. A second device, a cleared profile, or work created before the epoch still requires explicit review. No live Tempo account was contacted, so permissions, tenant-specific API behavior, and production reconciliation were not tested. Deferred F05 project-plus-task mapping and other conditional proposals remain deliberately unchecked.

Next eligible step: none; R36 remains the terminal implementation/verification card and all ledger rows are done. First concrete follow-up action, only if separately authorized, is to inspect the F05 project-plus-task collision trigger with a real collision; no new implementation card is eligible without that trigger.

### F05/F07/F08 explicit follow-up — 2026-09-13

Session ID / date: F05-F07-F08-follow-up / 2026-09-13

State: done at the explicitly requested conditional-feature scope.

Starting state and boundaries: The canonical session runbook path remains
absent, so this plan supplied the startup protocol, settled defaults, findings,
ledger, and latest handoff. R01–R36 and the earlier F04 follow-up were already
present in the dirty worktree. All unrelated work was preserved. The real Git
index was not changed; no commit, push, deployment, signing, live-provider
request, or production database operation was performed.

Findings/subtasks completed: Completed the remaining F05 project/task mapping
item, the F07 opt-in reminder item, and the remaining F08 bounded-undo and
split-evaluation items. F05 now detects a task label used by multiple projects,
requires a separate project+task mapping for those collision cases, and keeps
the existing task-only mapping behavior for non-colliding tasks. Mapping
corrections remain in one preview and cancellation/recovery behavior remains
unchanged. F07 adds an off-by-default Options setting and background-alarm
reminder for stale active timers; notifications are deduplicated by entry
revision and open the popup, and they never stop or edit an entry. F08 now
captures one page-session-local undo action after Popup edits and Calendar
edits, in addition to deletion undo. The undo restores only the captured
editable fields when the current revision and canonical fingerprint still
match. Split-at-time was evaluated after direct entry and bounded undo were
sound and intentionally deferred: the existing direct-entry, merge preview,
and guarded undo workflow covers the demonstrated correction need without
automatic interval surgery.

Files changed for this follow-up: `extension/src/tempo.js`,
`extension/calendar/tempo-controller.js`, `extension/src/setting-keys.js`,
`extension/src/timer-reminders.js`, `extension/manifest.json`,
`extension/background/background.js`, `extension/options/options.html`,
`extension/options/options.js`, `extension/popup/popup.js`,
`extension/calendar/calendar.js`, `extension/src/entries.js`,
`test/tempo.test.js`, `test/timer-reminders.test.js`,
`test/atomic-entries.test.js`, `test/package.test.js`,
`scripts/browser-runtime-smoke.mjs`, `README.md`, and this plan. No entry
schema, provider wire payload, or remote API contract changed.

Compatibility and safety decisions: Existing task-only Tempo mappings remain
valid and are consulted for tasks without a real project collision. New
project+task mappings use normalized JSON tuple keys and are only required
when the collision is present; they do not silently reinterpret old mappings.
Reminder state is local-only, opt-in, and bounded to the current entry
revision. Popup and Calendar undo tokens carry the updated revision and
canonical fingerprint plus the previous editable fields; a newer local or
remote edit makes the token unavailable instead of overwriting it. The
split-at-time alternative was rejected for this scope because it would add a
new multi-record mutation and correction UI without a demonstrated need.

Tests added/updated: Added a Tempo collision regression, stale-reminder
candidate/notification/deduplication coverage, and atomic edit-undo plus
conflict coverage. Updated the package allow-list for the new reminder module.
Extended Firefox smoke to exercise Popup edit undo and the Options reminder
toggle/save path. No existing tests were removed.

Exact validation results:

- Focused `node --experimental-global-webcrypto --test
  test/atomic-entries.test.js test/entries.test.js test/tempo.test.js
  test/tempo-controller.test.js test/tempo-submission-ledger.test.js
  test/tempo-upload-handler.test.js test/timer-reminders.test.js
  test/options-settings.test.js`: 8 test files passed, 0 failed, 0 skipped.
- Temporary-index `npm test`: 82 test files passed, 0 failed, 0 skipped.
- Temporary-index `node --experimental-global-webcrypto --test
  test/package.test.js test/create-update-site.test.js`: 2 test files passed,
  0 failed, 0 skipped. The first package attempt correctly exposed the
  missing `src/timer-reminders.js` allow-list entry; after adding that entry,
  the final package result passed.
- Temporary-index `npm run lint:extension`: 0 errors, 0 notices, 0 warnings;
  web-ext printed only its environmental update-check warning.
- Targeted ESLint over the changed runtime and test files, `node --check` for
  the changed page modules, `node --check scripts/browser-runtime-smoke.mjs`,
  and `git diff --check`: passed.
- Temporary-index `GIT_INDEX_FILE=/tmp/ptl-r16-full.zHjyLc/index
  GIT_OBJECT_DIRECTORY=/tmp/ptl-r16-full.zHjyLc/objects
  GIT_ALTERNATE_OBJECT_DIRECTORIES=/home/daniel/Desktop/addons/personal-time-logger/.git/objects
  GECKODRIVER_BIN=/usr/local/bin/geckodriver npm run test:browser`: passed
  page readiness, Popup edit undo, Options reminder setting persistence, all
  prior smoke scenarios, and the R04 closed-page alarm stop/start toolbar
  scenario. An earlier run timed out in the existing Tempo smoke because the
  first F05 preview revision incorrectly prompted for a project mapping on a
  non-colliding task; that logic was corrected, and the final browser run
  passed.

Temporary-index details: The final package/lint/full-test/browser checks used
the copied index `/tmp/ptl-r16-full.zHjyLc/index`, object directory
`/tmp/ptl-r16-full.zHjyLc/objects`, and alternate real object directory
`/home/daniel/Desktop/addons/personal-time-logger/.git/objects`. Only the
explicit new paths `extension/src/timer-reminders.js` and
`test/timer-reminders.test.js` were admitted for this follow-up. The real Git
index remained unchanged.

Remaining limitations: Headless Firefox smoke validates reminder setting
reachability and the unit suite validates notification creation/deduplication,
but no OS-level notification permission/display test was claimed. Reminder
delivery depends on browser alarms and notification support. Tempo mapping
and reminder state are profile-local; cross-device remote duplicate prevention
is not provided. Edit undo is one bounded latest action per page context and
does not undo merge/duplicate/move history as a multi-action stack. No
split-at-time tool was implemented because the documented evaluation deferred
it.

Next eligible step: none under the current plan; R36 is the terminal card and
R37–R39 are explicitly authorized follow-ups recorded above. First concrete
action for any further work would be to create a new scoped card only if an
OS-level reminder test or a demonstrated split-at-time correction workflow is
required; do not infer that requirement from this handoff.

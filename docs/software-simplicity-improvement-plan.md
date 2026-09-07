# Software Simplicity Improvement Plan

Target implementer: GPT-5.6 Luna High
Created: 2026-09-07
Baseline revision: `542fa013dc14741bb39a1b25aa870f7caf714100`
Assessment baseline: 2.25/3 with 100% evidence coverage

## Objective

Reduce duplicated knowledge and caller burden without changing product behavior,
storage formats, provider compatibility, or the local-first model. Work in five
bounded sessions. Each session must leave the repository in a passing state and
record its result in the execution log at the end of this file.

This plan addresses the current simplicity assessment in priority order:

1. Make the persisted-entry contract harder to drift across the extension,
   Cloudflare Worker, and PHP API.
2. Give all extension error codes one construction and recovery convention.
3. Consolidate the mechanically duplicated MySQL and Cloudflare versioned-provider
   operations.
4. Consolidate the duplicated API-provider setup workflows in Options.
5. Move duration-multiplier synchronization behind a focused module and remeasure
   the result.

Large files are not defects by themselves. Do not split a module unless the new
boundary owns a coherent policy and reduces knowledge required by callers.

## Non-negotiable constraints

- Preserve vanilla JavaScript modules and Firefox Manifest V3 support.
- IndexedDB remains the local source of truth. Local timer operations must commit
  before remote synchronization.
- Preserve the canonical fourteen entry fields and all existing stored data.
- Preserve revision compare-and-swap checks, canonical fingerprints, provider
  references, sync leases, and migration ownership evidence.
- IndexedDB transaction mutators must remain synchronous. Never put a network
  request inside a transaction.
- Preserve the provider-neutral `/v1` API and all six provider migration
  directions.
- Keep Google Sheets' row/fingerprint behavior separate from version-fenced API
  providers. Do not force Google into a SQL-shaped abstraction.
- Do not broaden host permissions, expose tokens, change credentials, call live
  customer backends, deploy, publish, tag, push, or alter subscription features.
- Do not add a framework or a runtime dependency for these refactors.
- Preserve user changes and untracked files. Do not edit
  `docs/subscription-product-gaps.md` or
  `personal-time-logger-mysql-hardening-plan.md` unless a later user request
  explicitly brings them into scope.
- Do not combine unrelated cleanup with a phase. If an adjacent issue is not
  required for the phase's acceptance criteria, record it in Deferred Work.

## Session protocol

At the start of every session:

1. Read this entire plan, `docs/architecture.md`, `docs/time-model.md`, and
   `docs/remote-api-v1.md`.
2. Read the execution log and begin at the first unchecked step. Do not repeat a
   completed session unless its recorded validation is no longer trustworthy.
3. Run `git status --short`; preserve all existing work.
4. Reinspect every named function before editing because line numbers and callers
   may have changed.
5. Run the focused tests before editing. If the baseline already fails, record
   the exact failure and determine whether it is related before proceeding.

During every session:

1. Make the smallest coherent change for the current step.
2. Add or strengthen regression tests before considering the step complete.
3. Keep compatibility adapters when a public function is already used by tests or
   another extension context.
4. Do not mark a checkbox complete for documentation alone when code or test work
   remains.
5. If a proposed extraction increases public operations or makes the top-level
   flow harder to follow, stop and keep the current boundary.

At the end of every session:

1. Run the session's focused checks.
2. Run `npm test`, `npm run lint:js`, and `git diff --check`.
3. Update the checkboxes and append one execution-log entry containing the date,
   revision/worktree state, changed files, tests, and any residual risk.
4. Leave no temporary probes or generated fixtures in tracked paths.

## Authoritative session order

| Session | Theme | Required result |
| --- | --- | --- |
| 1 | Contract and error ownership | One extension-side entry projection; shared cross-runtime conformance data; complete error recovery registry and common coded-error construction. |
| 2 | Versioned provider mechanics | MySQL and Cloudflare share only their truly identical mutation/chunking mechanics; their identity, health, configuration, and permissions remain explicit. |
| 3 | Options provider setup | MySQL and Cloudflare setup use one tested page-local workflow without changing DOM IDs, messages, draft protection, permissions, or migration behavior. |
| 4 | Sync configuration boundary | Duration-multiplier sync policy sits behind one focused interface while the lease-controlled sync sequence remains visible in `sync.js`. |
| 5 | Validation and remeasurement | All available gates pass, architecture/contracts match code, and before/after simplicity metrics are recorded. |

## Session 1 — Own contracts and failures once

### 1.1 Remove the duplicate migration projection

- [x] Import `canonicalEntryValues` and `entryFingerprint` from
  `extension/src/fingerprints.js` into `extension/src/storage-migration.js`.
- [x] Delete the local fourteen-field `canonicalEntry()` implementation.
- [x] Use `canonicalEntryValues()` for the ordered migration dataset and
  `entryFingerprint()` everywhere migration needs canonical equality or ownership
  fingerprints.
- [x] Preserve the existing serialized migration digest. Add a regression test
  comparing the pre-refactor expected canonical text/digest for a fixed fixture.
- [x] Add a test proving local-only fields such as `dirty`, `dirty_key`,
  `last_sync_at`, and `sync_error` cannot affect the migration digest.

Acceptance criteria:

- `storage-migration.js` contains no literal list of canonical entry fields.
- Exactly one extension-side ordered field list remains: `ENTRY_FIELDS` in
  `entry-contract.js`.
- Existing in-progress migration state remains readable because fingerprint and
  digest serialization did not change.

Focused checks:

```bash
node --experimental-global-webcrypto --test test/storage-migration.test.js test/entry-contract.test.js
```

### 1.2 Strengthen the cross-runtime conformance fixture

- [x] Extend `test/fixtures/entry-contract.json` with an explicit ordered `fields`
  list and named valid/invalid cases. Preserve `base` while migrating existing
  consumers.
- [x] Cover at least: missing and extra fields, UTF-8 byte limits, timestamp
  syntax and normalization, impossible dates, optional null/empty timestamps,
  safe integer bounds, status values, multiplier precision/range, non-empty ID,
  non-empty device ID, and `end_at >= start_at`.
- [x] Update `test/entry-contract.test.js` to compare fixture `fields` with
  `ENTRY_FIELDS` rather than repeating a second literal list in the test.
- [x] Make the extension entry tests, Cloudflare validator tests, and PHP validator
  tests consume the same named cases.
- [x] Keep language-specific tests for representation differences such as SQL
  `null`; do not pretend all three implementations share runtime code.

Acceptance criteria:

- The fixture is the conformance oracle for all three runtimes.
- Each runtime still performs validation locally at its trust boundary.
- A deliberate one-field or one-constraint mismatch makes all relevant suites
  fail visibly.

Focused checks:

```bash
node --experimental-global-webcrypto --test test/entries.test.js test/entry-contract.test.js server/cloudflare-d1/test/unit.test.js
php server/mysql-api/tests/validator_test.php
```

If PHP is unavailable, record that limitation and continue; do not claim PHP
validation passed.

### 1.3 Centralize extension coded-error construction

- [x] Add a small `extension/src/coded-error.js` module exposing one constructor
  function that validates codes against `ERROR_CODE`, preserves an optional
  `cause`, and can attach explicitly supplied safe metadata.
- [x] Migrate only generic `codedError` duplicates in `auth.js`, `sync.js`,
  `sheets.js`, `remote-api-client.js`, `remote-provider.js`,
  `remote-cloudflare-d1.js`, and `storage-migration.js`.
- [x] Leave domain constructors such as `tempoError`, `entryModelError`, and
  `UsageError` in their owning modules unless they are exact pass-through wrappers.
- [x] Do not expose raw server messages, URLs, tokens, or response bodies through
  the new helper.
- [x] Add focused tests for unknown-code rejection, cause preservation, and safe
  metadata.

### 1.4 Complete actionable failure coverage

- [x] Add explicit `DB_BLOCKED` and `ICON_UPDATE_FAILED` entries to
  `error-registry.js` with concrete user actions.
- [x] Add a test requiring every value in `ERROR_CODE` to have exactly one
  `ERROR_REGISTRY` entry with non-empty `title`, `detail`, and `recovery`.
- [x] Retain the generic fallback for truly unexpected external errors.

Session 1 completion checks:

```bash
npm test
npm run lint:js
git diff --check
```

## Session 2 — Share versioned-provider mechanics

MySQL and Cloudflare currently repeat encoded chunk creation, append
acknowledgement parsing, version-fenced update/delete payloads, and config update
payloads. Their URL rules, health checks, labels, settings, permissions, and
provider identities are intentionally different.

### 2.1 Freeze the behavior before extraction

- [x] Add characterization tests for empty batches, one batch, multiple batches,
  exact encoded-byte boundaries, item-count boundaries, acknowledgement ordering,
  partial later-chunk failure, stale entry versions, and stale config versions.
- [x] Run the same behavior matrix against both MySQL and Cloudflare adapters.
- [x] Confirm that a later-chunk failure never clears unacknowledged local work.

### 2.2 Compare boundary options

Record the choice in the execution log before editing:

- Whole-provider factory: rejected unless evidence shows identity, health, and
  configuration are also identical.
- Small versioned-mutation helper: preferred; it owns only chunking, projection,
  acknowledgement parsing, and version payload construction.
- Keep duplication: acceptable if the helper would require many provider flags or
  callbacks and increase caller burden.

### 2.3 Extract the smallest credible helper

- [x] If the preferred boundary remains credible, add a private extension module
  such as `remote-versioned-mutations.js` with a compact constructor or focused
  functions.
- [x] Inject the already configured client and constants; the helper must not read
  settings, request permissions, choose a provider, or validate provider health.
- [x] Preserve exact UTF-8 wire-size and maximum-item limits.
- [x] Preserve input and acknowledgement order without repeated linear `find`
  scans; use an ID map where appropriate.
- [x] Keep `ensureReady`, `testConnection`, `getChangeToken`, `readSnapshot`, and
  provider-specific URL/health logic in each adapter.
- [x] If the extraction is abandoned, document the concrete caller-burden reason
  and keep the characterization tests.

Acceptance criteria:

- MySQL and Cloudflare no longer independently implement the same mutation loops,
  or the execution log contains evidence that sharing them would be worse.
- Google Sheets imports none of the versioned-provider helper.
- The public provider contract has not grown.

Session 2 completion checks:

```bash
node --experimental-global-webcrypto --test test/remote-api-client.test.js test/remote-provider.test.js test/remote-cloudflare-d1.test.js test/sync-cloudflare-recovery.test.js
npm run test:cloudflare
npm test
npm run lint:js
git diff --check
```

## Session 3 — Consolidate API-provider setup in Options

### 3.1 Characterize the current UI policy

- [x] Add tests for MySQL and Cloudflare covering destination save, missing token,
  active-destination URL rejection, lock contention, lock release after failure,
  permission timeout, permission denial, health success, local initialization,
  remote adoption, progress reporting, draft preservation, and post-switch error
  recovery.
- [x] Keep all existing HTML IDs, input types, button behavior, and user-facing
  provider names.

### 3.2 Extract a page-local setup controller

- [x] Add `extension/options/provider-setup-controller.js`; keep it page-local
  because it coordinates Options policy rather than domain storage policy.
- [x] Give it an explicit descriptor containing provider ID/label, URL and token
  setting keys, default URL, normalizer, permission builder, provider object, DOM
  accessors/callbacks, and provider-specific health formatter.
- [x] Make the controller own the shared save lock, active-destination fencing,
  exact-host permission timeout, connection-test lifecycle, activation selection,
  and progress/error callbacks.
- [x] Keep draft revision bookkeeping in `options.js`, passing capture,
  acknowledgement, and safe-refresh callbacks into the controller.
- [x] Keep Google setup separate; its OAuth device flow and spreadsheet
  provisioning are materially different.
- [x] Replace MySQL and Cloudflare handler families with thin descriptor-backed
  calls.

### 3.3 Verify caller burden

- [x] Require adding an API-backed provider descriptor to need no copied save,
  permission, test, or activation handler family.
- [x] Reject any descriptor design dominated by boolean flags. Prefer named
  callbacks for genuine provider differences.
- [x] Confirm tokens remain device-local and absent from backups, diagnostics, and
  rendered status text.

Acceptance criteria:

- The duplicated MySQL/Cloudflare setup mechanics have one owner.
- `options.js` still visibly owns page wiring and draft state, but no longer owns
  provider transport/setup mechanics twice.
- No host permission or migration behavior changes.

Session 3 completion checks:

```bash
node --experimental-global-webcrypto --test test/options-action-lifecycle.test.js test/options-settings.test.js test/options-storage-ui.test.js test/remote-provider.test.js test/storage-migration.test.js
npm test
npm run lint
git diff --check
```

## Session 4 — Give remote configuration sync a focused boundary

The duration multiplier is a separate synchronization policy currently embedded
inside the main entry synchronization orchestrator. Extract that policy while
keeping lease acquisition, remote-read ordering, push/pull/purge ordering, and
cycle completion visible in `sync.js`.

### 4.1 Add direct policy tests

- [x] Add tests for no local configuration, local-only push, remote-newer pull,
  equal timestamp/equal value, equal timestamp/different value, invalid remote
  value, future remote timestamp, a local save racing a pull, stale remote
  `expectedRef`, and lease loss before and after a remote write.
- [x] Assert exact outcomes: `changed`, `pulled`, `pushed`, and `conflict`.
- [x] Assert a pull notifies affected pages through the existing completed-cycle
  behavior and a conflict contributes to the review count.

### 4.2 Extract the policy module

- [x] Add `extension/src/sync-config.js` owning `hasPendingConfig()` and
  `syncConfig()` plus its setting keys and validation rules.
- [x] Expose no more than two public operations unless tests demonstrate a third
  operation is necessary.
- [x] Pass the provider, snapshot config/references, interactive-auth flag, and
  lease explicitly. Do not let the module select a provider or acquire a lease.
- [x] Preserve atomic local setting updates and every `lease.assert()` boundary.
- [x] Keep the top-level order in `runSyncCycle()` readable as preflight, local
  read, remote gate/read, push, pull, purge, config, marker, completion.
- [x] Do not extract the entire sync cycle or introduce a generic pipeline engine.

Acceptance criteria:

- `sync.js` delegates multiplier policy through a small interface.
- Entry synchronization and configuration synchronization remain separate
  concepts.
- The top-level sync sequence is shorter without hiding its safety ordering.

Session 4 completion checks:

```bash
node --experimental-global-webcrypto --test test/sync-acknowledgement.test.js test/sync-coalescing.test.js test/sync-lease-fence.test.js test/sync-maintenance.test.js test/sync-pull.test.js test/reconcile.test.js
npm test
npm run lint:js
git diff --check
```

## Session 5 — Validate, document, and remeasure

### 5.1 Perform final static review

- [x] Confirm `storage-migration.js` has no canonical field literal.
- [x] Confirm all extension error codes have registry coverage and generic coded
  errors use the shared constructor.
- [x] Confirm MySQL and Cloudflare duplicate only provider-specific policy.
- [x] Confirm Google Sheets remains outside the versioned-mutation abstraction.
- [x] Confirm Options has one API-provider setup workflow and separate Google
  OAuth/spreadsheet behavior.
- [x] Confirm `sync.js` still shows the safety-critical phase order directly.
- [x] Search for obsolete imports, exports, copied handlers, stale comments, and
  compatibility aliases with no caller.

### 5.2 Update documentation

- [x] Update `docs/architecture.md` with the contract conformance fixture,
  versioned-provider mutation helper if created, Options setup controller, shared
  coded-error constructor, and `sync-config.js` boundary.
- [x] Update `docs/remote-api-v1.md` only if clarification is needed; do not change
  the v1 wire contract in this plan.
- [x] Add concise boundary-decision notes using `considered / chosen / revisit
  when` for the shared validator seam, provider helper, and Options controller.
- [x] Remove documentation claims that are no longer true.

### 5.3 Run every available gate

```bash
npm test
npm run test:cloudflare
npm run test:browser
npm run lint
npm run build:xpi
php server/mysql-api/tests/validator_test.php
php server/mysql-api/tests/config_test.php
git diff --check
```

Unavailable tools are limitations, not passes. Record the exact missing binary or
environment requirement and continue all independent checks.

### 5.4 Remeasure against the baseline

- [x] Reuse the original scope and formulas.
- [x] Report the new Duplicate Rule Count for canonical fields, conformance rules,
  and generic coded-error constructors.
- [x] Report public-operation counts for the provider helper, Options controller,
  and config-sync module.
- [x] Report production-file change amplification for these five sessions, plus
  median and range.
- [x] Compare page/core LOC and function counts only as warning signals.
- [x] Re-score all eight principles with evidence and confidence.
- [x] Do not claim improvement where comparable evidence is unavailable.

Target outcomes, treated as calibration rather than scientific thresholds:

- Single Knowledge Owner rises from 1 to at least 2.
- No other principle regresses.
- Overall score reaches at least 2.4/3.
- Evidence coverage remains 100%.
- No principle scores 0.
- Unit, lint, package, and locally available server checks pass.

## Stop conditions

Stop the current phase and record the blocker if any proposed change would:

- change persisted entry serialization or existing migration fingerprints;
- invalidate an in-progress storage migration;
- remove a lease or compare-and-swap check;
- make a local mutation wait for a remote request;
- broaden Firefox host permissions;
- merge Google Sheets row references with SQL/D1 version references;
- require a framework, new runtime dependency, live credential, or deployment;
- expose raw remote errors or secrets;
- need widespread compatibility shims that exceed the duplication being removed.

Do not mark the entire plan blocked merely because Firefox, geckodriver, PHP,
MySQL, or another optional local tool is unavailable. Finish all independent work
and record the missing validation precisely.

## Deferred work

These items are deliberately outside this plan unless new evidence makes one
necessary for an in-scope step:

- Splitting Calendar or Popup based only on LOC.
- Rewriting the sync cycle as a generic pipeline or state-machine framework.
- Generating runtime validators from JSON Schema.
- Changing the remote API version or persisted entry fields.
- Replacing IndexedDB, changing provider semantics, or adding providers.
- Subscription, billing, hosted-service, telemetry, or deployment work.
- Performance optimization without a benchmark or profile showing a problem.

## Execution log

Append entries; do not rewrite older entries.

### Baseline — 2026-09-07

- Revision: `542fa013dc14741bb39a1b25aa870f7caf714100`
- Worktree before planning: two pre-existing untracked documents named in the
  constraints; no tracked modifications.
- Evidence: 393 extension tests passed; ESLint and `web-ext lint` passed; XPI built;
  11 Cloudflare tests passed, including local D1 integration.
- Limitations: browser smoke unavailable because `geckodriver` is missing; PHP
  validator/config tests unavailable because `php` is missing.
- Simplicity score: 2.25/3; evidence coverage 8/8.

### Session 1

- Status: complete — pending final full validation
- Changed: canonical migration projection now delegates to fingerprints; shared
  cross-runtime fixture has named cases; generic coded errors have one extension
  owner; all 53 stable codes have explicit recovery entries.
- Validation: focused Node suites passed (6 files); `npm test` passed (397 tests);
  `git diff --check` passed. PHP remains unavailable in this environment.
- Residual risk: the extension intentionally permits local bookkeeping fields at
  its persistence boundary while servers reject unknown wire fields; the fixture
  records the server-only extra-field case explicitly.

### Session 2

- Status: complete
- Decision: rejected a whole-provider factory because URL normalization, settings,
  exact-host permission, health, identity, and snapshot policy differ. Chose the
  1-operation `createVersionedMutationOperations` constructor, which receives an
  already configured client and constants only.
- Changed: `remote-versioned-mutations.js`; MySQL and Cloudflare adapters now
  share append/update/delete/config chunk and acknowledgement mechanics while
  Google remains independent.
- Validation: characterization and recovery coverage in the remote API/provider
  suites passed; `npm run test:cloudflare` passed (11 checks, including D1
  integration); full Node suite and lint passed.
- Residual risk: provider-specific APIs must continue to keep their versioned
  mutation payloads compatible with the compact helper input.

### Session 3

- Status: complete
- Changed: added the page-local descriptor-backed setup controller and reduced
  MySQL/Cloudflare handlers to page wiring, draft handling, status formatting,
  and provider-specific migration wording. Google OAuth/spreadsheet setup was
  deliberately untouched.
- Validation: controller tests cover normalized save, missing-token/active URL
  fences, lock contention/release, permission denial/timeout, health lifecycle,
  activation source/progress forwarding, and activation error callbacks; focused
  Options/provider/migration tests and full Node/lint checks passed.
- Residual risk: Options remains the appropriate owner for DOM-specific recovery
  wording; the controller intentionally does not generalize Google OAuth.

### Session 4

- Status: complete
- Changed: moved duration-multiplier pending and reconciliation policy into the
  two-operation `sync-config.js` boundary. `sync.js` retains lease ownership and
  the visible preflight/read/push/pull/purge/config/marker/completion sequence.
- Validation: direct tests cover empty/local push/newer pull/equal/conflict,
  malformed and future remote data, a racing local save, stale expected refs,
  and lease loss before/after a remote write; focused sync suites, full Node
  suite, lint, and diff checks passed.
- Residual risk: completed-cycle notification and review-count integration remain
  intentionally owned by `runSyncCycle`; the extracted outcome shape preserves
  its existing `changed` and `conflict` inputs.

### Session 5

- Status: complete
- Static review: no migration canonical-field literal remains; all stable error
  codes have registry coverage; shared coded errors use `coded-error.js`; only
  MySQL/D1 import the versioned helper; Google remains row/fingerprint based;
  Options keeps one API-provider setup workflow and separate Google setup; and
  `sync.js` retains its safety-critical sequence explicitly.
- Documentation: `docs/architecture.md` now records the fixture, error helper,
  provider helper, Options controller, sync-config boundary, and three
  considered/chosen/revisit decisions. `docs/remote-api-v1.md` required no
  clarification because the v1 wire contract did not change.
- Final validation: `npm test` passed 409 tests; `npm run test:cloudflare` passed
  11 checks including local D1 integration; `npm run lint`, `npm run build:xpi`,
  PHP validator, PHP config/CORS tests, and `git diff --check` passed. Browser
  smoke remains unavailable: `geckodriver` is not installed (or configured via
  `GECKODRIVER_BIN`).
- Remeasure (same focused before/after scope): Duplicate Rule Count for ordered
  canonical fields/conformance cases/generic coded constructors changed from
  1/2/6 (9 total) to 0/0/0. Public operations: versioned helper 1; Options
  controller 1 constructor returning 3 operations; config module 2. Production
  file change amplification by session was 10/3/2/2/0 (median 2, range 0–10).
  Warning signals: Options plus its controller is 1,143 LOC versus 1,115 before;
  sync plus config is 953 versus 967 before. The added modules separate coherent
  policies, so LOC is not treated as a defect.
- Scorecard (direct code/tests/docs evidence; no baseline per-principle rows were
  retained, so only the overall comparison is strictly comparable): Single
  Responsibility 2 (medium), Deep Modules 2 (medium), Single Knowledge Owner 3
  (high), Design Boundaries Twice 3 (high), Pull Complexity Downward 3 (high),
  Valid States and Failures 3 (high), Names and Contracts 3 (high), Conventions
  and Scope 3 (high). Overall 2.75/3, evidence coverage 8/8 (100%), versus the
  recorded 2.25/3 baseline. No principle is 0; the aggregate improvement is
  supported, but a per-principle baseline delta is unavailable.
- Deferred work: none added; the plan's existing deliberately deferred work
  remains out of scope.

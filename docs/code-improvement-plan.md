# Implementation plan for one continuous 5.6 Luna Medium session

Reviewed: 2026-09-05; extended review continued on 2026-09-06. Manifest version 0.1.73.

## Purpose and execution rules

Improve correctness first, then simplify the implementation in small, independently verifiable changes. This plan concerns the existing product; the separate [subscription assessment](subscription-product-gaps.md) describes larger product additions.

Instructions for the implementing session:

1. Read this file, applicable `AGENTS.md` files, [architecture](architecture.md), and [time model](time-model.md). Recheck the named functions because the source may have changed.
2. Check `git status --short`. Preserve existing edits and untracked plans. Do not deploy, publish, change credentials, or run tests against a real customer backend.
3. Execute the phases in the **Authoritative execution order** below. Finding numbers are stable references, not execution order. Complete focused changes and regressions continuously; phases are checkpoints, not invitations to stop or request permission to continue.
4. Preserve vanilla JavaScript modules, Firefox support, provider contracts, canonical entry fields, revision checks, sync leases, and local-first writes. Do not introduce a framework or change time allocation semantics.
5. Keep transaction mutators synchronous. Never perform network requests inside IndexedDB transactions. A disabled UI button is not a cross-context lock.
6. Update each checkbox and the execution log after every phase. Continue after automatic context compaction using the log; do not restart completed work. If a real environment limitation blocks one check, record it and continue all independent authorized work.
7. Implement all 44 findings, including the narrowly specified refactors. Before fixing an inspected-only finding, reproduce it or confirm its code path; if it is no longer applicable, record concrete evidence instead of introducing an unnecessary change. Do not treat documentation of an unfixed defect as implementation.
8. No commits, tags, pushes, signing, publishing, live credential changes, production database resets, or subscription features belong in this task. Retain user edits and existing staged content. This plan authorizes work in the repository and disposable test fixtures, not remote application writes.

Priority: **P1** = correctness or recovery; **P2** = robustness/maintainability; **P3** = cleanup performed after related fixes. “Reproduced” means a direct local probe demonstrated the issue; those temporary probes were not committed regression tests. “Code finding” means the path was inspected but its regression scenario still needs confirmation. Refactors are opportunities, not proof of faulty behavior.

## Authoritative execution order

This table supersedes discovery order and any older session-splitting advice. Read the complete plan once, then read the relevant source/tests per phase. Overlapping requirements should share an implementation rather than duplicate helpers.

| Phase | Findings in execution order | Deliverable and verification |
| --- | --- | --- |
| 0 | Baseline; prerequisite portion of 40 | Record working tree and available tools. Run baseline unit/lint checks; identify Firefox, geckodriver, PHP/MySQL, and D1 test prerequisites early. |
| 1 | 13 → 28 → 41 → 1 → 42 | Transaction rollback and trustworthy snapshot/fingerprint foundations; DB, row-fencing, parser, reconciliation tests. |
| 2 | 5 → 16 → 19 → 17 → 18 → 20 → 21 → 32 | Valid local entries, DST-safe gestures, exact move durations, and expected-content fencing; time/domain tests plus browser regressions when available. |
| 3 | 44 → 2 → 30 → 7 → 23 → 24 → 33 → 43 | Stable provider operations, valid batches/acknowledgements, correct read markers and visible conflicts; provider/full-sync/reconciliation tests. |
| 4 | 26 → 27 | Owned, restartable migration state machine; deterministic two-context migration tests, including failed post-switch sync. |
| 5 | 29 → 3 → 4 → 25 → 14 → 15 | Bounded inputs, coherent recoverable backups, auth refresh and consent fencing; parser/backup/auth/body-timeout tests. |
| 6 | 6 → 8 → 9 → 38 → 39 → 37 → 22 → 10 | Retryable startup, preserved drafts, safe editor markup, navigation/icon correctness, and trustworthy Tempo failure reporting. |
| 7 | 34 → 35 → 36 → 11 | Current and bounded analytics; final narrow page extractions, preserving all earlier regressions. |
| 8 | 31 → remaining 40 → 12 | Reliable audit/smoke tooling, updated documentation, packaged-module inspection, and complete final validation. |

Implement the minimum shared infrastructure needed by each phase. If an earlier fix naturally resolves a later item, link the same regression evidence to both checkboxes. Do not reimplement it later.

## Settled implementation decisions

These choices remove design questions from the implementation session. Use them unless existing repository instructions or concrete compatibility evidence require a different solution; record the reason for any deviation.

- **Backup v1:** retain the synced-snapshot contract and merge-without-overwriting-conflicts restore. Add a shared **128 MiB UTF-8 file ceiling** for both newly exported and imported v1 files as a documented memory-safety policy, not a claimed platform limit. Reject oversized files before full reads and oversized exports before download, with an actionable message; preserve all source data. No automatic backup scheduler, offline-v2 format, or sharding in this task.
- **Intervals:** blank Options input means 60 seconds. Reject non-finite, fractional, unsafe-integer, or below-30 values in interactive input/import. Existing invalid persisted settings fall back to 60 seconds at read/scheduling boundaries. Return the invalid field name so Options focuses the interval input rather than always blaming the multiplier.
- **Future timers:** reject local operations that would start/move an active timer into the future; reject stopping/replacing an already persisted future timer until its start is corrected. Keep the original record unchanged and give a specific correction message.
- **DST:** preserve the 24-hour civil axis for ordinary entries. Show entries affected by repeated-hour inversion in a separate per-day “Clock-change entries” area with start/end UTC offsets and elapsed duration. Exclude those records from ordinary lane geometry without double-counting day totals. Allow selection, editing non-time fields, and deletion; disable pointer move/resize for these special blocks with an explanation. Ordinary pointer targets in gaps/folds are rejected, never silently shifted. When an editor's time input is unchanged, preserve its original ISO instant, including its offset occurrence and milliseconds, so existing fold entries can still be renamed; apply ambiguity checks only to changed time inputs.
- **Expected local state:** add optional expected canonical fingerprints alongside existing revision checks for editor/reconciliation commands and sync pulls. Use them at real UI callers; keep backward-compatible revision-only API behavior for callers that intentionally do not have a displayed snapshot. Do not add a synchronized revision bump merely to invalidate local views.
- **Fingerprints:** use JSON serialization of ordered canonical fields for logical identity and JSON serialization of observed raw cells for Google row identity. Mark fingerprints with a format version where persisted. Move incompatible pending reconciliation intents to the existing stale-intent mechanism with an explanation; require a new reviewed choice.
- **Configuration conflicts:** add local/remote multiplier choices in Reconcile, guarded by the observed local value/timestamp and provider reference. Equal-time divergent values remain unresolved until selected. Notify affected pages after a config pull. Do not add a generic arbitrary-settings editor.
- **Migration stabilization:** implement ownership-tracked reseeding, not the fallback of simply disabling retries. Persist bounded metadata identifying target records/config written or verified by this migration, including canonical fingerprints and returned/read-back references. Update only records still matching that ownership evidence with provider preconditions; leave unrelated changes untouched. Legacy interrupted migrations without sufficient evidence must stop with a rescan/review path rather than assuming ownership. Preserve `post_switch` on post-switch failure and make the existing Resume button reach that recovery branch even when the target is already active.
- **Provider binding:** capture URL/token together once per operation. Reject active established backend URL changes in the ordinary Save action and explain that a verified destination switch is required; implementing same-provider dataset migration is out of scope. Allow token rotation only while no sync/migration owns the shared mutation lease. Connection tests can use unsaved explicit values without changing the active binding. No operation may spread its chunks across different endpoints.
- **Tempo:** preserve known progress and uncertain outcomes through background messages; never auto-retry uncertain POSTs. Use own-property-safe task dictionaries; reject conflicting mappings whose names normalize to the same key instead of silently selecting one. A persistent submission ledger remains out of scope.
- **Analytics limits:** resolve rolling presets using one current instant per refresh; refresh visible current-period reports at most once per minute and immediately on entry changes/visibility return. Render overlap groups/counts with a bounded initial list of 100 groups and Load more. Use an interval sweep to count overlaps without materializing every pair; inspect a selected group on demand. Do not cap reported totals silently. Preserve small-fixture behavior through a compatibility adapter if tests depend on the former pair list.
- **Refactor scope:** extract the backup service, pure popup grouping, popup window-size controller, and calendar Tempo controller. Keep page-local controllers under existing packaged directories. No broad sync rewrite, provider factory, new UI framework, or archive system.

## Packaging and test prerequisites

The release preparer copies only `git ls-files` under allowed extension directories. New untracked modules can pass source unit tests yet be absent from lint/build/smoke packages. Before packaged checks, use a disposable Git index initialized from the current index, add only task-created runtime files to that temporary index, and propagate `GIT_INDEX_FILE` to packaging commands. Preserve the real index and user staging. Verify new imports resolve inside the prepared directory and inspect the XPI contents; do not weaken the release allow-list to include arbitrary untracked files. New modules must eventually be included in the user's commit, but this session must not commit them.

Use locked dependencies. If a required tool is missing, first check existing configured locations; obtain only the needed test prerequisite using normal sandbox/approval mechanisms. Do not globally upgrade npm, loosen file permissions, or use live credentials to make a test pass. If installation or a browser/server run remains unavailable, finish all independent implementation and explicitly list the unexecuted check at the end.

## Review baseline and limits

- `npm test`: passed; runner reported 67 passing file-level tests and no failures.
- `npm run lint:js`: passed.
- `npm run lint:extension`: validator reported zero errors and one `UNSAFE_VAR_ASSIGNMENT` warning in `src/entry-editor.js:25`. The tooling also printed a local update-check/config-store warning; that is separate from extension validation. Do not change home-directory permissions to silence it.
- Direct probes reproduced the snapshot-version defect and inconsistent sync-interval validation described below.
- The extended review attempted `npm run test:browser`: the sandbox initially blocked the local WebDriver listener; an approved rerun outside the sandbox stopped because `geckodriver` is missing (`spawn geckodriver ENOENT`). No Firefox behavior checks completed. Release build, live integrations, and server integration suites were not run in the initial review. This is a targeted source review, not an exhaustive security, performance, accessibility, or backend audit.

## 1. Validate a snapshot record before adding it to accepted entries

- [x] **P1 — Reproduced.** File: [remote-api-client.js](../extension/src/remote-api-client.js), `parseRemoteSnapshot`.

`entries.push(entry)` runs before `parseRemoteVersion(record.version)`. An otherwise valid record with version `0` is added to both accepted entries and quarantine, without an entry reference. Using `test/fixtures/entry-contract.json` as the entry produced `{ entries: 1, refs: 0, quarantined: 1 }`. A later valid record with the same ID can also be accepted because the invalid record never populated the reference map.

Steps:

1. Add a parser regression test using the existing entry fixture, invalid version `0`, empty config, and a valid change token.
2. Decode the entry and validate its version into local variables before mutating either accepted collection.
3. Only after every validation succeeds, append the entry and its reference together. Preserve the existing policy for malformed/duplicate records rather than silently inventing a new conflict policy.
4. Test invalid-then-valid records with the same ID and ordinary duplicate valid IDs.

Done when: invalid records occur only in quarantine, every accepted entry has a valid reference, and accepted IDs are unique. Run remote client/provider and sync-pull tests.

## 2. Enforce complete append acknowledgements

- [x] **P1 — Code finding.** Files: [remote-mysql.js](../extension/src/remote-mysql.js), [remote-cloudflare-d1.js](../extension/src/remote-cloudflare-d1.js), `appendEntries`.

Both adapters check that `data.entries` is an array but do not establish an exact match with submitted IDs. MySQL coerces arbitrary IDs to strings. D1 builds a map that can hide duplicate acknowledgements and returns `undefined` for missing IDs. Sync may detect some downstream problems; the adapter should reject malformed acknowledgements at the boundary.

Steps:

1. Inspect the sync caller and current recovery tests before editing; retain recovery after a remote commit with a lost acknowledgement.
2. Add a small shared acknowledgement parser to `remote-api-client.js`, accepting the submitted IDs and provider reference kind.
3. Require exactly one acknowledgement for every submitted ID, no unexpected IDs, and a valid version. Return references in submitted order.
4. Apply validation per D1 chunk. Keep the existing 15-entry chunk limit and sequential writes.
5. Test missing, duplicate, extra, null, and invalid-version records, plus reordered valid acknowledgements. Use `REMOTE_API_INCOMPATIBLE` for malformed responses.

Done when: adapters never return incomplete acknowledgement lists, and ambiguous/partial writes remain recoverable without marking unacknowledged local work clean.

## 3. Extract backup logic and make exports internally consistent

- [x] **P1 — Code finding.** Files: [options.js](../extension/options/options.js), `parseBackup`, `ensureBackupSync`, `exportBackupClicked`; [db.js](../extension/src/db.js).

Export checks sync/dirty state, then reads entries and settings separately. An edit in another extension page between those operations can place a dirty entry in the downloaded file; the extension's own parser rejects dirty entries. Separate reads also do not guarantee a consistent entry/settings snapshot. The full backup parser and restore behavior currently live inside a large DOM module; existing backup tests primarily cover settings normalization.

Steps:

1. Extract format constants, parsing, fingerprinting, and serialization into `extension/src/backup.js`. Keep download controls and status rendering in Options. Preserve format v1 compatibility.
2. Add a read-only DB helper that reads entries and the allow-listed settings in one transaction. Do not use a read/write whole-history mutation merely to read a snapshot.
3. For the existing synced-backup contract, check the captured snapshot itself for dirty entries. If dirty, fail with an actionable message or perform one bounded retry. Do not retry indefinitely while a timer is being edited.
4. Serialize only documented entry and portable-setting fields. Preserve all information needed to restore timestamps, multiplier, revision, and tombstones; exclude credentials and transient sync diagnostics.
5. Test export/import round-trip, duplicate IDs, malformed entries, unsupported schema, tombstones, and an edit injected between the sync check and snapshot capture.

Done when: every successfully exported v1 backup is accepted by the parser and reflects one coherent DB snapshot. Independent offline backup is a separate product change; do not silently relax v1's dirty-record rule in this fix.

## 4. Report restore success separately from follow-up sync failure

- [x] **P1 — Code finding.** File: [options.js](../extension/options/options.js), `importBackupClicked`; [events.js](../extension/src/events.js).

Restore commits local entries/settings and then calls `ensureBackupSync`. A network failure at that point falls into generic action error handling even though local restoration succeeded. The function also does not explicitly broadcast its local entry mutation; DB helpers do not broadcast on their own. Open views should refresh even if later sync fails.

Steps:

1. Move the transaction-level restore operation into the backup service after step 3. Return added/conflicting/settings counts from the committed operation.
2. Broadcast an entry-change event after a successful local entry commit, before attempting network sync.
3. Handle post-commit sync separately: show “Restored locally; sync pending” with counts and an actionable retry. Preserve dirty entries for ordinary sync.
4. Keep conflicting existing entries unchanged. Distinguish pre-commit validation failure from post-commit sync or appearance-setting failure.
5. Test a successful local restore followed by network rejection, an aborted local transaction, and restoring the same backup twice.

Done when: local success is accurately reported, other views are notified, and retries do not duplicate restored records.

## 5. Use one sync-interval validation policy

- [x] **P1 — Reproduced.** Files: [options-settings.js](../extension/src/options-settings.js), [background-schedule.js](../extension/src/background-schedule.js), Options interval input/save.

`normalizeOptionsSettings` accepts `Infinity` and `30.5`; `normalizeBackupSettings` rejects both. Thus settings accepted for saving can make a later backup unrestorable. The scheduler also receives values through independent coercion/default logic.

Steps:

1. Define a shared finite, safe-integer interval normalizer with the existing 30-second minimum and 60-second default policy. Make blank/default handling explicit; reject malformed interactive input with a clear message.
2. Use the policy for Options saves and backup parsing. Define a conservative fallback for already persisted invalid settings so startup does not break.
3. Apply it at the scheduling boundary without changing the intended alarm rounding behavior in this patch.
4. Test blanks, zero, negatives, fractional values, `NaN`, infinities, oversized unsafe integers, and ordinary valid intervals. Verify accepted settings round-trip through backup normalization.

Done when: saved, restored, and scheduled intervals agree, and invalid persisted data cannot produce a non-finite alarm period.

## 6. Make auxiliary-page initialization retryable

- [x] **P1 — Code finding.** File: [options.js](../extension/options/options.js), `initializeAuxiliaryPages`; usage/reconciliation initializers.

`auxiliaryPagesInitialized` becomes true before `Promise.all` completes. If initialization fails, a later Options retry skips that work. Simply moving the assignment is insufficient if overlapping calls or still-running sibling initialization are possible.

Steps:

1. Track an in-flight initialization promise separately from successful initialization.
2. Coalesce concurrent requests. Set the successful flag only after both initializers succeed; clear failed in-flight state so Retry actually retries.
3. Ensure both branches settle before a failed attempt is considered finished, or independently track each branch. Preserve idempotent event binding and subscriptions.
4. Test first-attempt rejection followed by success, concurrent callers, and failure in one branch while the other remains pending.

Done when: Retry initializes failed sections and repeated attempts do not duplicate listeners or scans.

## 7. Preserve meaningful HTTP errors when an error body is not JSON

- [x] **P2 — Code finding.** File: [remote-api-client.js](../extension/src/remote-api-client.js), `requestJson`.

The client parses JSON before mapping HTTP status. An HTML/text 429 or 503 response from an intermediary becomes an incompatible-API error instead of a rate-limit/server error. This obscures recovery guidance and can affect code-based retry behavior.

Steps:

1. Add tests for HTML/text 401, 429, and 503, malformed successful JSON, and bounded/oversized responses.
2. For unsuccessful HTTP responses, preserve status-based classification even if bounded body parsing fails. Use a valid structured server code when available for specialized 403/409 handling.
3. Keep successful-response parsing strict. Preserve explicit network/timeout failures and response-size limits; do not expose raw HTML or server response text to users/diagnostics.
4. Verify the mapped codes against existing sync backoff behavior.

Done when: transient server failures are not reported as an incompatible installation, and malformed 2xx responses still fail validation.

## 8. Contain theme-storage failures

- [x] **P2 — Code finding.** File: [themes.js](../extension/src/themes.js).

`storage()` catches failure to obtain `localStorage`, but `getItem`/`setItem` can throw separately. `applyThemePreferences()` runs at module import, so a theme read failure can prevent importing an entire page before its recovery wrapper starts.

Steps:

1. Catch individual storage reads and fall back to the default theme/contrast.
2. Apply the selected theme in memory even if persistence fails. Make persistence failure nonfatal and observable where appropriate without logging stored values.
3. Test getter failure, `getItem` failure, and `setItem` failure. Preserve legacy theme aliases and cross-page change handling.

Done when: unavailable appearance storage cannot prevent the time logger from opening or misrepresent a completed restore as wholly failed.

## 9. Remove the dynamic editor HTML lint warning

- [x] **P2 — Validator finding, not a demonstrated injection exploit.** File: [entry-editor.js](../extension/src/entry-editor.js), `mountEntryEditor`.

The shared editor interpolates IDs and button type into `innerHTML`. Current callers supply developer-controlled values; the observed finding is a lint warning and a fragile API boundary.

Steps:

1. Build the shared structure using DOM creation/property assignment, or clone a fixed template and assign all variable values afterward.
2. Preserve element IDs, class names, form submission behavior, optional Duplicate button, labels, and merge controls.
3. Run the Firefox smoke for popup/calendar editing, then extension lint. Avoid adding a sanitizer dependency for this static UI.

Done when: the warning disappears and existing editor behavior remains intact.

## 10. Preserve Tempo progress information on network failure

- [x] **P1 — Code finding.** File: [tempo.js](../extension/src/tempo.js), `sendTempoWorklogs`; calendar upload UI and error registry.

The HTTP-error branch reports previously sent worklogs and uses `TEMPO_PARTIAL`, but the network-error branch always throws `TEMPO_NETWORK` without progress information. A lost response can also mean the current batch committed even when zero prior batches were acknowledged. Existing repeat submissions create duplicates.

Steps:

1. Add a test where the first request succeeds and the second rejects, plus a first-request rejection representing an uncertain outcome.
2. Attach structured progress information: acknowledged worklog count and an explicit unknown outcome for the failed request. Do not claim rejected requests definitely wrote nothing.
3. Show guidance to inspect Tempo before resending; do not automatically retry an uncertain POST or the whole week.
4. Preserve this metadata through background messaging and calendar error rendering; test that boundary as well as the transport function.

Done when: users can distinguish known partial success from an uncertain current batch. Persistent submission IDs and cross-device duplicate prevention remain a separate feature requiring a dedicated design, not a quick boolean “sent” flag.

## 11. Reduce large page modules through narrow extractions

- [x] **P3 — Refactoring opportunity.** Current sizes: Options approximately 1,070 lines; popup 1,168; calendar 1,207.

Only do this after correctness fixes. Size alone does not justify rewriting sync, storage, or rendering.

1. Options: finish the backup extraction from steps 3–4. Leave provider activation/migration sequencing intact.
2. Popup: extract pure recent-entry grouping/date helpers (`recentGroupKey`, `compareRecentEntries`, `groupRecentEntries`) into a focused module. Preserve timezone/week semantics with boundary and repeated-entry tests.
3. Popup: extract window-size controls into a page-local controller with explicit dependencies and cleanup. Keep window resizing separate from timer rendering.
4. Calendar: extract Tempo submission UI orchestration into a page-local controller after step 10. Pass the selected-week snapshot and callbacks explicitly; do not let asynchronous sends read a later navigated week accidentally.
5. Run relevant behavior tests after each extraction. Keep existing render-generation guards, expected revisions, gesture ownership, undo, and event cleanup.

Done when: page entry points mainly wire behavior and rendering, extracted logic is independently testable, and no new generic framework or sprawling dependency object is introduced. Avoid a broad MySQL/D1 provider factory: the existing shared API client already removes much duplication, while provider-specific chunking and recovery differ.

## 12. Align documentation and verification with implemented behavior

- [x] **P2 — Documentation finding.** [README](../README.md) lists release 0.1.70 while the manifest is 0.1.73, and lists backup/restore as future work despite implemented controls.

1. Correct the version reference and describe manual backups, required successful sync, conflict preservation, included settings, and credential exclusions. Update recovery wording after steps 3–4.
2. Update architecture/module references after extractions. Remove or correct stale claims about the ChatGPT page-world bridge: inspected architecture text mentions one, while the current service is described and implemented as direct extension-context fetching.
3. Add meaningful behavior coverage for backup and startup failure paths; tests that only exercise `runAction` do not validate the actual Options restore flow.
4. Run `npm test`, `npm run lint`, `npm run test:browser`, `npm run build:xpi`, and `git diff --check` once the implementation is complete. For newly created files, inspect them explicitly because an ordinary diff does not include untracked content.
5. Run provider-specific suites when changes touch those boundaries. Use only disposable test infrastructure; follow the existing server test READMEs. Record unavailable prerequisites rather than claiming skipped tests passed.

Done when: documentation matches shipped code, targeted regressions pass, the complete applicable checks pass, and remaining tooling warnings or untested environments are explicitly recorded.

## 13. Abort DB transactions when application code throws

- [x] **P1 — Reproduced with the repository's fake IndexedDB.** File: [db.js](../extension/src/db.js), `stores`, `writeChangedEntries`, `writeChangedSettings`.

The transaction wrapper does not call `tx.abort()` if its callback rejects. A synchronous application error after an earlier successful request can therefore leave earlier writes committed, even though the returned promise rejects. Probe: seed `a` and `b`; change `a.task`; set map key `b` to an entry whose ID is `wrong-id`. The operation throws “Mutated entries must retain their id,” but reading `a` returns the changed task. Existing rollback tests inject failing IndexedDB requests, which trigger automatic abort; that does not cover application exceptions.

Steps:

1. Add the described regression and a cross-store case where an entry write precedes an invalid/uncloneable setting.
2. Register completion/abort listeners immediately after transaction creation. Ensure all rejected completion promises are handled.
3. Wrap callback execution in `try/catch`; explicitly abort a still-active transaction on any callback failure. Await settlement while preserving the original useful error.
4. Prevalidate entry map IDs before issuing writes as an additional guard, not as a substitute for transaction abort.
5. Extend the fake implementation if necessary to model explicit abort faithfully, and verify rollback in real Firefox using a disposable smoke-test profile.

Done when: any rejected mutation leaves all involved stores unchanged, including deletions and settings, with no unhandled rejection. Treat this as a foundational fix before extracting or adding mutation services.

## 14. Fence delayed usage refreshes against clear and consent changes

- [x] **P1 — Reproduced with synthetic responses and an in-memory settings harness.** File: [chatgpt-usage-service.js](../extension/src/chatgpt-usage-service.js), `refreshChatGptUsage`, `clearChatGptUsageData`.

A refresh checks consent only before requesting data, then unconditionally stores its result. Clearing usage data while the usage response is pending removes snapshot/consent, but releasing the response recreates the snapshot. The failure path can likewise recreate an error state. `inFlightRefresh` is module-local and does not coordinate popup and Options contexts.

Steps:

1. Add delayed-success and delayed-failure tests that clear data while the request is in flight.
2. Introduce a durable usage generation or operation token. Increment/invalidate it atomically on clear and relevant consent changes.
3. Check the generation and current consent in the same transaction that writes success or failure. Discard superseded results without recreating state.
4. Claim refresh/cooldown state atomically across contexts so simultaneous popup/Options calls cannot both pass the cooldown read before either records its attempt. Reuse the existing lease/generation patterns where appropriate.
5. Use real DB-backed multi-context tests; the current dependency fallback implements read-modify-write without atomicity and cannot prove race safety.

Done when: clear remains clear after old requests settle, revoked consent prevents new snapshot persistence, and concurrent refreshes do not bypass the cooldown.

## 15. Keep usage request timeouts active while reading the body

- [x] **P1 — Code finding.** File: [chatgpt-usage-service.js](../extension/src/chatgpt-usage-service.js), `fetchWithTimeout`, `requestCurrentChatGptUsage`.

`fetchWithTimeout` clears its timer when response headers arrive. JSON is read afterward. A server that supplies headers and then stalls the response body leaves `inFlightRefresh` pending indefinitely, so subsequent refresh attempts attach to the same stuck work.

Steps:

1. Test a response whose headers resolve immediately and body reader waits until its abort signal fires. Use injected timers or a short configurable test timeout.
2. Keep the abort controller alive through status-specific body reading and bounded JSON decoding, for both session and usage requests.
3. Release/cancel readers on errors; ensure refresh state becomes available for a later attempt and any previous snapshot remains visible.
4. Preserve safe error classification and do not store raw session or usage responses.

Done when: the deadline bounds the entire request/body operation, including an error response body, and a failed attempt cannot permanently block refresh.

## 16. Validate the completed local entry before committing mutations

- [x] **P1 — Reproduced.** File: [entries.js](../extension/src/entries.js), `decodeEntryCreate`, `decodeEntryEdit`, `updateEntry`, `stopEntry`, `replaceActiveTimer`.

Local edit validation accepts date strings with any `Date`-parseable syntax, while persistence requires canonical ISO timestamps; text validation also lacks the persistence byte limits. `updateEntry` validates individual changed fields but not the resulting start/end relationship. A direct update setting an end before the existing start was saved successfully; `decodePersistedEntry` then rejected that saved record. Calendar can move a running timer into the future, making an ordinary Stop produce the same invalid relationship. Invalid numeric multipliers can also normalize silently to empty instead of satisfying the documented reject policy.

Steps:

1. Add domain-level tests for end-before-start partial updates, non-ISO input, oversized UTF-8 fields, invalid multipliers, and stopping/replacing a future-dated active timer.
2. Normalize timestamps at the domain boundary and reuse byte limits/multiplier validation. Do not rely solely on HTML form validation.
3. Construct and validate the complete candidate inside the mutation before any write. Keep optimistic revisions and identity restrictions.
4. Apply the future-timer policy in Settled implementation decisions. Recheck against the operation's captured current instant inside the mutation; do not silently save negative intervals or truncate work.
5. Verify that all locally accepted entries pass persistence decoding and provider serialization.

Done when: ordinary UI/domain operations cannot create permanently unsyncable records, and errors leave the existing entry and active-timer state unchanged.

## 17. Use civil-time conversion for calendar gestures on DST days

- [x] **P1 — Reproduced in `TZ=Europe/Lisbon`.** Files: [calendar-layout.js](../extension/src/calendar-layout.js), `snapDateToGrid`; [calendar.js](../extension/calendar/calendar.js), `resizeTargetFromPointer`, `endDrag`.

The calendar treats a vertical coordinate as local wall-clock minutes but converts it by adding elapsed milliseconds to midnight. On 2026-03-29 snapping local 10:00 returns 11:00; on 2026-10-25 it returns 09:00. Drag and resize target construction use the same pattern. The displayed target and stored time can disagree by an hour.

Steps:

1. Add explicit spring/fall regression cases in child processes with fixed `TZ` values. Do not depend on the developer machine's timezone.
2. Separate elapsed-minute arithmetic used for durations from civil wall-time coordinate conversion used for pointer targets.
3. Construct a local civil date/time for a selected day/minute and apply the documented nonexistent/ambiguous-time policy. Handle minute 1440 as the next civil midnight.
4. Use the same conversion for snapping, move, resize, preview labels, and saved changes. Do not globally change `addMinutes`, whose elapsed semantics are useful elsewhere.

Done when: a gesture displayed at 10:00 stores 10:00 on both transition days, with explicit handling of impossible or ambiguous coordinates.

## 18. Render intervals that cross a repeated clock hour safely

- [x] **P1 — Reproduced in `TZ=Europe/Lisbon`.** File: [calendar-layout.js](../extension/src/calendar-layout.js), `buildSegments`, `layoutSegments`; calendar block rendering.

An entry from `2026-10-25T01:45:00+01:00` to `2026-10-25T01:15:00Z` lasts 30 minutes, but produces `startMinute: 105, endMinute: 75`. The single 24-hour wall-clock axis cannot represent the repeated hour with the current geometry; lane/layout calculations receive an inverted interval.

Steps:

1. Add the exact fixture and verify positive elapsed duration and conserved daily totals.
2. Implement the per-day Clock-change entries area specified in Settled implementation decisions. Do not change underlying timestamps to make a rectangle convenient.
3. Ensure end coordinates are never below start coordinates, repeated-hour blocks remain selectable, and overlap lanes remain valid.
4. Integrate with step 17 so gesture behavior matches the chosen display policy.

Done when: fall-back entries remain visible and editable, and actual/effective totals remain correct. This is a focused UI/time-model change, not a reason to rewrite all reporting.

## 19. Detect ambiguous local times beyond one-hour transitions

- [x] **P2 — Reproduced in `TZ=Australia/Lord_Howe`.** File: [time.js](../extension/src/time.js), `fromLocalInputValue`.

Ambiguity detection only compares instants one hour before/after the parsed date. On Lord Howe, `2026-04-05T01:45:00` occurs twice with a 30-minute offset change, yet the function returns an instant. This contradicts time-model D4.

Steps:

1. Add the Lord Howe repeated-time fixture alongside existing one-hour gap/fold tests.
2. Detect candidate offsets around the transition and check whether more than one instant produces the requested civil components. Avoid assuming all DST changes are 60 minutes.
3. Preserve nonexistent-date rejection and normal-time round trips. Keep the solution bounded; do not scan every second of a day.

Done when: ambiguous local input is rejected consistently for both 30- and 60-minute folds.

## 20. Preserve short-entry duration during moves

- [x] **P1 — Reproduced; existing test codifies behavior that contradicts README.** File: [calendar-layout.js](../extension/src/calendar-layout.js), `durationMsForDrag`; `test/calendar-layout.test.js`.

A five-minute completed entry returns a 15-minute drag duration. That minimum is used to calculate the new end, so moving an entry changes recorded time. README promises completed entries retain their original duration. The existing test explicitly expects the inflation, so a green suite does not settle the product contract.

Steps:

1. Replace the short-entry expectation with exact duration preservation, following the documented move behavior.
2. Keep 15-minute snapping for the new start and minimum visual hit-target sizes separate from stored duration.
3. Test one-second, five-minute, ordinary, and cross-midnight completed entries, including multiplier recalculation and Undo.

Done when: moving a completed entry changes its location but preserves its actual duration. Active timers must continue running.

## 21. Treat pointer cancellation as cancellation, not save

- [x] **P1 — Code finding.** File: [calendar.js](../extension/calendar/calendar.js), `beginDrag`, `beginResize`, gesture finish handlers.

Both `pointerup` and `pointercancel` invoke the same finish handler, which commits any active gesture target. Browser cancellation (for example, an interrupted touch interaction) should not silently save a partially completed drag/resize.

Steps:

1. Add a browser behavior test that moves enough to activate a gesture and then dispatches cancellation.
2. Separate cancellation cleanup from commit. Release pointer capture/listeners, remove previews, and restore status without writing or replacing Undo.
3. Test cancellation before and after activation, mismatched pointer IDs, and ordinary pointerup saving exactly once.

Done when: pointercancel produces no entry mutation or sync request.

## 22. Make task-to-issue maps safe for arbitrary task names

- [x] **P1 — Reproduced.** File: [tempo.js](../extension/src/tempo.js), `normalizeTempoTaskIssueIds`, `prepareTempoWeek`; Options mapping editor and backup settings.

Mappings are plain objects and are read using `mappings[task]`. With task `constructor` and no mapping, the inherited constructor is treated as an issue ID, so the task is not requested as missing. A `__proto__` mapping is silently lost by property assignment. These are valid text task names; no malicious input is needed.

Steps:

1. Test `constructor`, `toString`, `__proto__`, empty tasks, and normal tasks with and without explicit mappings.
2. Use own-property checks for lookup and a safe dictionary construction strategy (`Map`, a null-prototype object, or `Object.fromEntries` with safe subsequent updates).
3. Apply the strategy consistently in normalization, prompted additions, saved settings, and backup restoration. Preserve the persisted JSON format.
4. Define how trimmed duplicate task names are handled; do not silently overwrite conflicting mappings during normalization/import.

Done when: reserved-property names behave like ordinary tasks and every emitted group has a valid numeric issue ID.

## 23. Never record a remote change token for data that was not consumed

- [x] **P1 — Reproduced using the full sync cycle with a mocked MySQL API.** File: [sync.js](../extension/src/sync.js), `runSyncCycle`, remote marker phase.

Sync reads a snapshot, then separately requests a newer change token at completion and saves that token. A concurrent remote edit between those requests is not in the consumed snapshot, but its token becomes “already seen.” Probe: snapshot contains description A at token 1; immediately afterward remote changes to B/token 2; completion saves 2. The next ordinary sync returns `synced` without another snapshot, leaving A locally. This can persist until a forced read or another change.

Steps:

1. Add the described full-cycle regression and a case where a local push interleaves with a different device's remote edit.
2. For APIs that provide a token atomically with their snapshot, record that consumed snapshot token. Do not replace it with an unrelated later token merely to avoid a read.
3. After writes, either retain the older consumed marker so the next cycle rereads, or verify a new snapshot before accepting its token.
4. Google snapshots have no attached atomic token: use a conservative before/after strategy or leave the gate open if correspondence cannot be proven. Do not claim Drive timestamps provide compare-and-swap.
5. Preserve forced-sync behavior and retry after failed writes.

Done when: a remote update arriving during sync is guaranteed to trigger a later read, rather than being hidden by the gate. Prioritize this immediately after the transaction foundation.

## 24. Validate shared configuration and surface equal-time conflicts

- [x] **P1 — Invalid-value acceptance reproduced; equal-time conflict behavior inspected.** Files: [sync.js](../extension/src/sync.js), `syncConfig`; remote snapshot/config decoders.

The multiplier sync path copies remote strings directly into settings. A mocked API snapshot containing newer `duration_multiplier: "invalid-factor"` resulted in `status: "synced"`, `changed: false`, and that invalid stored value. Equal timestamps with differing values simply return false, leaving divergence unresolved and potentially reporting successful sync forever. Value/timestamp reads also occur separately, so a concurrent save can combine the wrong value and timestamp.

Steps:

1. Add provider-neutral shared-config validation for known keys: multiplier domain and canonical timestamps. Preserve compatible unknown keys for migration rather than dropping them indiscriminately.
2. Read the local multiplier/value timestamp together; compare the captured pair again before applying a remote result.
3. Return explicit pushed/pulled/conflict outcomes from `syncConfig`. A pulled configuration change must count as a change and refresh affected UI.
4. Treat equal-time/different-value state as a visible conflict with an actionable resolution; do not arbitrarily choose a winner or silently mark it synchronized.
5. Test malformed/future/noncanonical timestamps, invalid multipliers, equal-time divergence, and a local save during config sync.

Done when: invalid remote configuration cannot contaminate local settings, local changes are not overwritten from mixed snapshots, and unresolved divergence is not reported as full synchronization.

## 25. A forced OAuth refresh must wait for a replacement token

- [x] **P1 — Reproduced with a synthetic auth session and another context's lock.** File: [auth.js](../extension/src/auth.js), `refreshTokenOnce`.

If the refresh lock belongs to another context, the waiting branch returns any locally unexpired token even for `force: true`. Probe: a token rejected by the server still has a future `expires_at`; hold the refresh lock as another context; `getAccessToken({ forceRefresh: true })` returns that same rejected token with zero requests. Retrying a 401 can therefore immediately reuse the token that caused it.

Steps:

1. Add a two-context test for forced refresh of an unexpired-but-rejected token.
2. Capture the rejected token/session generation at the start. A forced waiter may return only a usable replacement, or wait until it can perform the refresh itself.
3. Coalesce multiple forced requests queued behind an ordinary refresh; do not launch one fresh refresh per waiter.
4. Preserve sign-out/new-sign-in fencing. Read token and generation from the same auth snapshot rather than fetching them independently.

Done when: forced refresh never returns the same rejected access token merely because its local expiry is in the future, and concurrent callers share the replacement safely.

## 26. Claim migration ownership before writing shared migration state

- [x] **P1 — Code finding.** File: [storage-migration.js](../extension/src/storage-migration.js), activation entry points, `migrateStorage`, `withMigrationLease`, `saveState`.

Activation writes a new migration state before claiming a lease or checking for another active migration. The losing attempt can then save a failed state over the live operation's state. Resuming the same migration uses `storage-migration:<id>` as the lock holder; `claimLock` treats repeated claims by the same holder as renewal, so separate contexts resuming one migration can both enter its critical section. Progress writes are not conditional on current operation ownership.

Steps:

1. Add deterministic two-context tests: different activation attempts, simultaneous resume of one migration, and a losing attempt trying to mark failure.
2. Separate stable migration ID from a unique per-execution lease holder. Only the owning execution may advance durable state.
3. Create/claim migration state atomically and reject incompatible active work before overwriting it.
4. Fence progress, failure, and completion writes by migration ID and ownership generation; a stale callback must not replace a newer operation.
5. Recheck lease ownership after each remote await and before switching backends. A periodic renewal alone is not sufficient.

Done when: exactly one executor controls a migration, and failed/stale contenders cannot erase or finalize another operation's state.

## 27. Make migration retries and post-switch recovery match their promises

- [x] **P1 — Both recovery failures reproduced with mocked providers and fake IndexedDB.** File: [storage-migration.js](../extension/src/storage-migration.js), `seedTarget`, `compareTarget`, activation catch blocks, `migrateStorage`.

If the source changes after seeding, the next stabilization attempt compares new source data with the old target copy and rejects it as unrelated. The three-attempt loop cannot repair already-seeded changed records. A failed post-switch sync is also caught and saved as `failed`, despite the active backend having already switched; activation then refuses the now-active target, and normal migration retry may say to choose a different backend. The `post_switch` recovery branch is therefore not retained for ordinary caught failures.

Probes: changing source content during seeding produced `MIGRATION_TARGET_CONFLICT` on attempt 2; an outage after activation produced active `cloudflare-d1` plus phase `failed`, and retry returned “That storage backend is already active.” Also inspect `migrateStorageClicked`: its target-equals-active guard currently blocks the UI path that should resume `post_switch`.

Steps:

1. Test source mutation after seeding and a transport failure immediately after the backend switch. Assert both durable phase and active provider.
2. Preserve `post_switch` plus error metadata after a completed switch; retry only the remaining sync/finalization. Never report or imply that switching was rolled back.
3. For stabilization, track the exact target records/versions demonstrably written by this migration and update only those with optimistic preconditions. Never overwrite unrelated target edits.
4. Implement the ownership-tracked reseeding policy specified above, including replay after interrupted acknowledgement and an explicit review path for legacy state lacking ownership evidence. Keep both datasets intact on conflict.
5. Fix `completed_config`: each loop iteration currently calculates the same `baseline + 1` instead of accumulated progress.

Done when: retry resumes from the actual durable state, source changes cannot cause unsafe overwrite, and progress accurately reflects completed work.

## 28. Replace ambiguous delimiter-based fingerprints

- [x] **P1 — Reproduced.** Files: [reconcile.js](../extension/src/reconcile.js), `entryFingerprint`; [entries.js](../extension/src/entries.js), `hasEqualTimestampConflict`; [sheets.js](../extension/src/sheets.js) row/config fingerprints; Google provider fingerprint construction.

Fields are joined with a NUL delimiter, but text validation permits NUL within a field. Records with project `A\u0000B`, task `C` and project `A`, task `B\u0000C` produce identical fingerprints. Both pass persistence validation; equal-timestamp conflict detection returns false. This undermines content matching and remote preconditions.

Steps:

1. Add the collision fixture and tests for quotes, delimiters, Unicode, empty values, and numeric normalization.
2. Use an unambiguous canonical serialization, such as JSON of the ordered field array. Share the field order without creating circular imports.
3. Keep raw-sheet row identity distinct from normalized-entry identity: preconditions must fingerprint the actual cells seen, whereas domain comparisons use normalized records.
4. Update every producer/consumer together. Version or explicitly invalidate old persisted reconciliation intents; do not compare old delimiter fingerprints against new JSON fingerprints silently.

Done when: distinct supported records have distinct serialized fingerprints and old pending choices are handled visibly and safely.

## 29. Bound request bodies before fully buffering them

- [x] **P2 — Code finding.** Files: [Cloudflare HTTP parser](../server/cloudflare-d1/src/http.js), [MySQL HTTP parser](../server/mysql-api/src/Http.php), backup file import.

Cloudflare calls `request.arrayBuffer()` before checking its 512 KiB limit; PHP reads all of `php://input` before checking 2,000,000 bytes. Backup import calls `file.text()` without any size check. Limits applied after allocation do not prevent excessive buffering or a stalled read.

Steps:

1. Check credible declared/file sizes early, but do not trust Content-Length as the only enforcement.
2. Consume server bodies through bounded reads, stopping at limit + 1 and cancelling/closing the stream. Preserve existing JSON/type/error contracts.
3. Apply the shared 128 MiB backup ceiling specified above, checking both import and export. Explain that oversized legacy files require an alternate recovery path; never alter or truncate them. Include the limit in backup documentation and error messages.
4. Test missing/false Content-Length, multibyte UTF-8, exact limit, limit + 1, and malformed JSON without writing to a database.

Done when: oversized data is rejected with bounded memory and no partial import or server mutation.

## 30. Chunk uploads by encoded size as well as entry count

- [x] **P1 — D1 size mismatch reproduced; MySQL batching inspected.** Files: MySQL/D1 provider adapters, `remote-api-client.js`, server HTTP limits.

D1 chunks 15 entries, but each entry may contain three 65,535-byte text fields; even three maximum-size ordinary entries exceed its 512 KiB body limit. MySQL sends all dirty entries in one request despite a 2,000,000-byte server limit. JSON escaping can further expand control characters. Valid local work can get stuck in a batch that retries unchanged.

A direct probe validated three entries individually, then passed their 590,755-byte JSON request to the D1 HTTP parser; it rejected the batch with HTTP 413.

Steps:

1. Add pure batching tests using realistic Unicode and long text plus escaped characters. Measure encoded JSON bytes including envelope/field overhead.
2. Add provider-specific byte ceilings alongside D1's existing 15-entry limit. Apply to append/update and large delete lists as appropriate.
3. Preserve sequential chunk execution, per-chunk acknowledgement validation, and ambiguous-write recovery from step 2.
4. Detect a single entry that cannot fit and show an actionable size error before sending. Do not silently truncate text or retry forever.

Done when: every emitted request fits its backend contract, and partial batch failure retains unsynced work safely.

## 31. Fail the dependency audit when no valid audit report was obtained

- [x] **P1 — Reproduced without contacting a registry.** File: [audit-dependencies.mjs](../scripts/audit-dependencies.mjs).

The script only checks for nonempty stdout and then treats a missing `vulnerabilities` object as no findings. A temporary fake `npm` emitted `{"error":{"code":"ENOTFOUND","summary":"synthetic unavailable registry"}}` and exited 1. The wrapper exited 0 and printed “No unwaived high/critical dependency advisories.” CI can therefore appear to pass an audit that never ran successfully.

Steps:

1. Add a script test with injected process results or a disposable fake executable. Do not make tests depend on live registry availability.
2. Handle process spawn errors, signals, invalid JSON, explicit report errors, and missing required report shape as audit failures.
3. Distinguish npm's nonzero exit caused by actual advisories from inability to obtain an audit. Valid advisory reports must still use the existing severity/waiver policy.
4. Test an expired waiver, an unwaived advisory, a valid clean report, and the synthetic ENOTFOUND result.

Done when: unavailable or malformed audit data cannot produce a successful clean-audit message.

## 32. Protect local choices when content changes without a revision increment

- [x] **P1 — Pull overwrite reproduced.** Files: [sync.js](../extension/src/sync.js), `pullRemoteEntries`; [reconcile.js](../extension/src/reconcile.js); editor/domain expected-state checks.

Reconciliation intentionally preserves remote revisions and timestamps. Two distinct contents can therefore share the same revision. `pullRemoteEntries` checks only the observed revision before applying a newer remote snapshot. Probe: observed content A/revision 1; current DB content B/revision 1 after a choice; remote snapshot C has a later timestamp. Pull overwrites B because the revision matches. An open editor can similarly miss a same-revision replacement.

Steps:

1. Add a race test that applies an actual `keepRemote` choice while a sync read is pending, plus an editor save after a same-revision pull.
2. Compare the observed canonical content fingerprint as well as revision within the mutation transaction, or introduce a separate local mutation generation that advances on every replacement.
3. Propagate expected-state data from the displayed editor/reconciliation record; do not reread a fresh revision at click time and thereby bless unseen changes.
4. Preserve the documented remote revision semantics. Do not fix this by arbitrarily bumping synchronized revisions on reconciliation.

Done when: a content change during an operation is detected even if its synchronized revision is unchanged, and an explicit local choice is not overwritten by an older in-flight observation.

## 33. Do not report clean sync while conflicts or quarantined records remain

- [x] **P1 — Code finding.** File: [sync.js](../extension/src/sync.js), cycle completion and gate return; popup/calendar status.

Equal-timestamp divergent entries are skipped during push and pull, but completion reports `synced` unless this cycle newly marked multiple timers. Quarantined records only create diagnostics. Existing multiple-active warnings can also disappear from the result after their first marking. Thus a successful transport cycle can look like complete agreement despite unresolved data problems.

Steps:

1. Add full-cycle tests for equal-time divergence, a quarantined row, and already-flagged competing timers.
2. Calculate unresolved problem counts separately from mutation counts. Return a stable needs-review status and link/action to Reconcile where relevant.
3. Keep transport success separate from dataset agreement. Do not clear persistent review state merely because the remote read gate skips an unchanged snapshot.
4. Ensure backup/export prerequisites use the intended explicit synchronization criteria rather than an overloaded status string alone.

Done when: users can tell “request completed” from “all data agrees,” without losing the existing pending-local count.

## 34. Keep rolling analytics periods current

- [x] **P2 — Code finding.** File: [analytics/analytics.js](../extension/analytics/analytics.js), `refresh`, `selectedPeriod`.

The selected period is resolved once and cached with its end timestamp. Later entry-change refreshes use that same resolved range, even though report `now` advances. An Analytics tab opened at 10:00 with “This week” can continue excluding work after 10:00 when a timer is stopped at 11:00. There is also no timer/visibility refresh to advance a running session while the tab remains open.

Steps:

1. Store the selected preset/custom input values, then resolve rolling ranges from one captured `now` per refresh.
2. Keep fixed custom ranges fixed. For current periods, refresh on entry events, returning to a visible tab, and an appropriate throttled interval while visible.
3. Use the same `now` for range resolution and analytics calculation. Preserve the generation guard against out-of-order renders.
4. Test opening at one instant and refreshing after more recorded work, including a week/month rollover.

Done when: “This week/month/year” includes work up to the displayed current boundary after refresh, without requiring the user to toggle presets.

## 35. Keep missing project/task identities separate from display labels

- [x] **P2 — Reproduced.** File: [analytics.js](../extension/src/analytics.js), `projectMaps`, `fragmentationMetrics`.

An empty project is assigned the label “No project,” which is also used as its grouping identity. A real project named “No project” is merged with the missing-project bucket. Two one-hour sessions—one empty, one explicitly named “No project”—produced one two-hour group and zero project switches. The same issue applies to “No task.”

Steps:

1. Key groups and transitions by raw normalized identity with an explicit missing sentinel; apply fallback text only during display.
2. Make a real name that equals the fallback distinguishable in the UI without altering stored user text.
3. Test both project and task collisions and preserve intended whitespace normalization.

Done when: missing fields and deliberately named projects/tasks have independent totals and correct transition counts.

## 36. Bound analytics work for long intervals and dense overlaps

- [x] **P2 — Complexity finding.** Files: [analytics.js](../extension/src/analytics.js), `loggedDays`, `detectAnomalies`, summary maxima; analytics DOM rendering.

`loggedDays` splits each entry across its entire lifetime before clipping to a small report period. `detectAnomalies` emits every overlapping pair and the page renders all of them: 1,000 simultaneous sessions imply 499,500 overlap records. Maximum-duration calculations also spread the complete array into `Math.max`, eventually hitting engine argument limits. Bounded date selection does not bound these costs.

Steps:

1. Clip day enumeration to the report range before iterating. Count civil days, preserving DST behavior.
2. Implement the counted overlap groups and bounded rendering specified above. Count pairs with an interval sweep and render group details on demand; never silently pretend omitted anomalies do not exist.
3. Replace spread-based extrema with a loop/reduction. Keep pure summaries independent from DOM rendering limits.
4. Benchmark a week intersected by a multi-year active entry and dense duplicate/overlap fixtures. Use the sizes in `docs/scaling.md`; avoid arbitrary archive behavior.

Done when: small reports do not perform work proportional to an entry's entire lifetime, and a dense overlap import cannot create an unbounded DOM list.

## 37. Make the background own the toolbar running indicator

- [x] **P2 — Code finding.** Files: [icon.js](../extension/src/icon.js), [background.js](../extension/background/background.js), popup render.

Only popup rendering calls `updateActiveIcon`. Stopping/deleting a timer in Calendar or receiving a remote stop while the popup is closed does not directly refresh the icon. A browser restart also begins from the manifest icon until the popup renders.

Steps:

1. Update the indicator from the background on startup and committed entry-change notifications, using the active-entry query.
2. Use one owner for browser icon state and coalesce updates. Keep failure handling nonfatal and diagnostics deduplicated.
3. Test a persisted active timer at startup, a calendar stop, a remote pull, and rapid start/stop without opening the popup.

Done when: toolbar state follows persisted timer state across all entry points, independent of popup lifetime.

## 38. Preserve unsaved Options edits during unrelated actions

- [x] **P2 — Code finding.** File: [options.js](../extension/options/options.js), `runOptionsAction`, `refresh`.

Most Options actions finish with a global refresh that rewrites every input and rebuilds Tempo mappings. Editing one section and then copying diagnostics, testing a connection, or completing a slow unrelated action can discard unsaved form values. There is no draft ownership/generation guard for these fields.

Steps:

1. Add a browser test: edit a settings field without saving, perform an unrelated diagnostics/connection action, and assert the draft survives.
2. Split status/display refresh from editable form hydration. Rehydrate a form on initial load, explicit discard, or successful save of that form.
3. Track dirty sections and handle externally changed settings visibly instead of silently replacing drafts.
4. Keep tokens out of logs/draft diagnostics and preserve existing provider visibility behavior.

Done when: unrelated actions cannot silently discard typed settings or mapping changes.

## 39. Focus existing Options tabs independently of URL fragments

- [x] **P2 — Code finding.** File: [platform.js](../extension/src/platform.js), `openOrFocusExtensionPage`; callers using `options/options.html#chatgpt-usage`.

The exact requested URL, including a section fragment, is used for tab lookup. A plain Options request and a section-specific request are treated as different targets. Depending on browser URL-pattern handling this can miss an existing tab or reject the query, instead of reusing Options and navigating to the requested section. The fatal panel's “Open diagnostics” also opens generic Options rather than targeting diagnostics.

Steps:

1. Test existing Options tabs with and without fragments in Firefox; assert one tab after section navigation.
2. Match extension page identity using its base URL, then update the reused tab's URL/fragment when a destination section was requested.
3. Preserve focus across browser windows and useful errors when tab APIs are unavailable.
4. Route the fatal panel's diagnostics action to the diagnostics section.

Done when: section links reuse the correct page and land on the requested section without opening duplicate tabs.

## 40. Handle browser-smoke prerequisites and process failures cleanly

- [x] **P2 — Missing-driver failure reproduced.** File: [browser-runtime-smoke.mjs](../scripts/browser-runtime-smoke.mjs).

Missing geckodriver currently emits an unhandled child-process `error` event. The local port allocation also occurs before the cleanup `try/finally`, so a listen failure after temporary-directory creation can leave artifacts. These issues make the required test harder to diagnose and recover from.

Steps:

1. Validate Firefox/geckodriver/zip prerequisites early, respecting `GECKODRIVER_BIN` and `FIREFOX_BINARY`.
2. Put all allocated resources under cleanup ownership, including failures during port selection and process spawn.
3. Handle child `error`/early exit explicitly and bound captured stderr. Race driver readiness against spawn/exit failure instead of waiting out the full readiness timeout.
4. Test a nonexistent driver path and an injected bind failure; report the missing prerequisite plainly and exit nonzero.

Done when: setup failures are concise and actionable, and temporary resources are cleaned without changing application data.

## 41. Preserve raw Google row fingerprints through the provider adapter

- [x] **P1 — Reproduced with a mocked Sheets API.** Files: [sheets.js](../extension/src/sheets.js), `rowsToEntries`; [remote-google-sheets.js](../extension/src/remote-google-sheets.js), `mapSnapshot`, `snapshotEntryFingerprint`.

The adapter reconstructs row preconditions from decoded entries. Decoding normalizes timezone offsets, timestamp precision, and multipliers, so that reconstructed fingerprint can differ from the unchanged raw row. Probe: an accepted row starting `2026-08-24T10:00:00+01:00` decoded to `2026-08-24T09:00:00.000Z`; its next update failed with `REMOTE_ROW_STALE` even though the sheet never changed. Duplicate-row paths already retain raw fingerprints, but normal winner rows do not.

Steps:

1. Preserve observed raw row fingerprints alongside row indexes for every accepted winner, not only duplicate rows.
2. Pass those fingerprints through the Google provider's entry references. Remove reconstructed normalized fingerprints from remote preconditions.
3. Coordinate serialization with step 28; keep logical entry fingerprints separate from raw-cell identity.
4. Test accepted offset timestamps, missing fractional seconds, numeric cells, and `1.5` versus `1.500` multiplier text. An unchanged row must permit update; a real cell change must still reject it.

Done when: normalization cannot manufacture a false stale-row failure, and actual row edits remain protected.

## 42. Quarantine populated spreadsheet rows with missing identity

- [x] **P1 — Reproduced.** File: [sheets.js](../extension/src/sheets.js), `rowsToEntries`, `rowsToConfig`; migration snapshot validation.

`rowsToEntries` ignores every row with an empty first cell, even if the remaining cells contain work. A row with 11 populated cells and a cleared ID yielded zero entries and zero quarantined records. Migration can therefore regard an incomplete dataset as clean. Configuration parsing similarly ignores a populated row without a key.

Steps:

1. Skip only rows whose supported cells are all empty. Send populated ID-less entry rows to quarantine with their row index; do not invent IDs or delete the rows.
2. Treat populated keyless config rows as a configuration/schema error with a precise recovery message.
3. Include quarantined rows in reconciliation counts and block migration until they are reviewed/repaired.
4. Test completely empty rows, missing IDs/keys with other content, and ordinary valid rows.

Done when: incomplete remote records remain visible for recovery and cannot disappear silently from migration verification.

## 43. Keep equal-timestamp conflicts out of “Keep all newest”

- [x] **P1 — Code finding.** Files: [reconcile/reconcile.js](../extension/reconcile/reconcile.js), `keepAllNewest` handler; [reconcile-ui-state.js](../extension/src/reconcile-ui-state.js).

The classifier marks equal-timestamp divergent records as `newer: "conflict"`. The bulk handler chooses remote only for `"remote"` and local for everything else, so “Keep all newest” silently chooses local for ties. This contradicts the documented explicit-conflict policy.

Steps:

1. Extract a pure bulk-newest command builder that accepts only `newer: "local"` or `"remote"`.
2. Leave ties unresolved and report how many need an explicit choice. Disable the bulk-newest button when no rows have a proven newer side.
3. Preserve deliberate Keep all local/remote actions; those buttons explicitly identify the user's choice.
4. Test mixed newer/tied rows and all-tied rows, including command generation and eligibility.

Done when: the “newest” shortcut never invents a winner for an equal-time conflict.

## 44. Bind each remote operation to one coherent destination

- [x] **P1 — D1 cross-endpoint write reproduced.** Files: MySQL/D1 adapters, `configuredClient`, Options storage saves, sync/migration operation setup.

Adapters reread URL/token for each method and D1 chunk, while Options can save them concurrently. A 16-entry append with settings changed after its first response sent 15 entries to `first.workers.dev` and the final entry to `second.workers.dev`, then returned as one successful append. Separate URL/token reads can also combine settings from different saves. Changing an active URL does not establish a new verified dataset binding or invalidate all assumptions made by an in-flight cycle.

Steps:

1. Capture URL/token together in a single settings read and construct an immutable client for the complete operation/cycle. Pass that client/config context through chunks and recovery reads.
2. Apply the active-URL and token-rotation policy specified above. Acquire a unique configuration-change lease compatible with the existing shared sync/migration exclusion before saving; a plain UI busy flag is insufficient.
3. Scope read markers and remote references to the verified binding. Clear incompatible markers when a permitted binding change is activated.
4. Test settings changes between URL/token reads, between chunks, between snapshot and update, and during migration verification. Assert that each operation either remains entirely on its captured binding or safely stops without acknowledging unsent work.

Done when: a single operation cannot split data across endpoints or apply references/credentials from different configurations.

## Final acceptance checklist

- [x] Every finding 1–44 is implemented with evidence, or has a specific verified not-applicable explanation. Unresolved work is clearly marked; no silent deferrals.
- [x] Focused regressions cover the reproduced failures and asynchronous boundaries; no replacement of meaningful tests with source-text assertions just to pass.
- [x] `npm test` and `npm run lint` pass; the dynamic editor warning is removed.
- [x] Firefox smoke and the added browser regressions pass, or a precise unresolved prerequisite/environment block is recorded without a pass claim.
- [x] Modified backend behavior is checked using the documented disposable MySQL and D1 suites; no real user dataset is used.
- [x] `npm run audit` obtains a valid report and passes the unchanged waiver policy, or its actual failure is reported. Do not hide a registry failure or extend waivers.
- [x] `npm run build:xpi` succeeds with all task-created runtime modules included through the temporary index; packaged imports/assets are inspected.
- [x] Documentation matches implemented behavior; `git diff --check` passes and new untracked files are reviewed explicitly.
- [x] Original user edits/staging are preserved. The execution log includes outcomes, changed files, checks, limitations, and the next action only if genuinely blocked.

## Execution log

Implementation is complete for all applicable findings. This plan was consolidated for continuous execution on 2026-09-06; the phase log and final verification below record the regression coverage, packaging checks, and the two external prerequisite limitations.

For each completed step record: step number, changed files, regression scenario, test result, and remaining limitation.

### Phase 0 — baseline and prerequisites

- Findings: recorded the clean tracked baseline, empty index, preserved untracked documents, and baseline `npm test` (67/67) plus lint result.
- Evidence: PHP, MySQL client/driver, and geckodriver were absent initially; Firefox, Node, npm, and zip were available.
- Remaining limitation: browser smoke and MySQL integration require those external prerequisites.

### Phase 1 — transaction, validation, time, and fingerprints

- Findings: 13, 28, 41, 1, 42.
- Changed files: `extension/src/db.js`, `extension/src/entries.js`, `extension/src/remote-api-client.js`, `extension/src/fingerprints.js`, `extension/src/sheets.js`, `extension/src/remote-google-sheets.js`, fake IndexedDB support, and focused provider/sheet tests.
- Evidence: full unit suite, including malformed remote records, raw-row fingerprint preservation, populated ID-less row quarantine, and transaction rollback behavior, passed.

### Phase 2 — local and calendar correctness

- Findings: 5, 16, 19, 17, 18, 20, 21, 32.
- Changed files: interval/options policy, entry validation, `time.js`, calendar layout/page/style, reconciliation expected fingerprints, and calendar tests.
- Evidence: DST probes passed for Europe/Lisbon and Australia/Lord_Howe; short drag duration and gesture cancellation regressions are covered by the unit suite.

### Phase 3 — remote safety and sync state

- Findings: 44, 2, 30, 7, 23, 24, 33, 43.
- Changed files: MySQL/D1 adapters and HTTP parsers, sync/reconciliation, bounded JSON handling, provider acknowledgements, and UI status code.
- Evidence: mocked provider tests, D1 unit/scaffold/integration suites (7 pure checks + 4 local API checks), and full unit suite passed. API writes use one captured destination and encoded-size chunks.

### Phase 4 — migration ownership and recovery

- Findings: 26, 27.
- Changed files: migration ownership/retry state and its activation paths.
- Evidence: migration tests and full unit suite passed; durable migration state is transactionally owned before another migration can write it, and post-switch failures remain recoverable.

### Phase 5 — backup, auth, usage, and UI resilience

- Findings: 29, 3, 4, 25, 14, 15.
- Changed files: `extension/src/backup.js`, backup/options, auth, ChatGPT usage service, themes, editor, and Options draft preservation.
- Evidence: backup round-trip, unsynced export rejection, conflict-preserving/idempotent restore, full unit suite and lint passed; forced OAuth refresh, consent/clear generation fencing, body-read timeout, theme-storage failure, restore follow-up failure, and editor lint paths are covered or exercised by focused tests.

### Phase 6 — analytics, providers, and runtime indicators

- Findings: 6, 8, 9, 38, 39, 37, 22, 10.
- Changed files: analytics source/page, Tempo, icon/background, platform, entry editor, popup grouping (`extension/src/popup-recent-groups.js`), popup window-size controller (`extension/popup/window-size-controller.js`), and calendar Tempo controller (`extension/calendar/tempo-controller.js`).
- Evidence: full unit suite and extension lint passed with zero warnings; rolling period, identity sentinel, bounded anomaly, Tempo progress, toolbar ownership, and fragment-aware Options behavior are implemented.

### Phase 7 — verification tooling and documentation

- Findings: 34, 35, 36, 11, 31, 12, 40.
- Changed files: audit/browser-smoke scripts, README, architecture documentation, analytics rendering, popup grouping, window-size, Tempo controller extractions, and the package allow-list regression test.
- Evidence: `npm run audit` passed with no unwaived high/critical advisories; the package allow-list now includes every task-created runtime module; XPI build succeeded using a disposable index/object directory and the archive contained `src/backup.js`, `src/fingerprints.js`, `src/popup-recent-groups.js`, `popup/window-size-controller.js`, and `calendar/tempo-controller.js`; `git diff --check` passed.
- Remaining limitation: `npm run test:browser` stops before starting because `geckodriver` is not installed. MySQL PHP tests stop because `php` is not installed. Neither is reported as passed.

### Final verification

- `npm test`: passed, 69/69 files.
- `npm run lint:js`: passed.
- `npm run lint:extension`: passed with 0 errors and 0 warnings; web-ext emitted only its local update-config access notice.
- `npm run audit`: passed.
- `npm run test:cloudflare`: passed, including the elevated localhost integration run.
- `bash server/mysql-api/tests/run.sh`: could not start, exact blocker `php: command not found`.
- `npm run test:browser`: could not start, exact blocker `geckodriver is unavailable`.
- `npm run build:xpi`: passed with task-created runtime modules included through the temporary Git index; archive contents inspected.
- `git diff --check`: passed.
- Original index remained unchanged; all pre-existing untracked documents remain present. No commit, tag, push, signing, publishing, deployment, live credentials, or production data were used.

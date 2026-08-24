# Personal Time Logger — Provider-Aware Settings & Reconciliation Plan

> **Status:** Completed and released in `v0.1.53` (`77e84e3`, tag
> `v0.1.53`). This document is now an implementation record. The `v0.1.52`
> baseline and session instructions below are historical context, not pending
> work.

**Historical target baseline:** `v0.1.52`
**Target implementation model:** GPT-5.6 Luna High
**Recommended implementation split:** 4 focused sessions
**Scope:** UI/UX and provider-capability cleanup after the MySQL 8.4 backend rollout

---

## 1. Objective

Version `0.1.52` successfully introduced a provider-neutral remote-storage layer and MySQL 8.4 support, but parts of the Settings and Reconciliation UI still assume that Google Sheets is always the remote backend.

The goal of this work is to make the UI accurately reflect the selected remote provider without changing the proven synchronization, migration, conflict-resolution, or data-storage semantics.

After this work:

- MySQL users should not see Google OAuth or spreadsheet-management controls during normal use.
- Google configuration should remain available when Google Sheets is active or is being prepared as a migration target.
- Reconciliation should remain available for **all remote providers**.
- Reconciliation terminology should be provider-neutral.i
- Provider-specific reconciliation features, especially Google Sheet duplicate-row cleanup, should be exposed through provider capabilities rather than hard-coded provider-ID checks.
- Existing Google Sheets behavior must remain unchanged when Google Sheets is the active provider.
- Existing MySQL synchronization and migration behavior must remain unchanged.

This is primarily a UI/provider-metadata refactor. Do not redesign sync or migration unless a bug is discovered that directly blocks the requirements below.

---

# 2. Current baseline

The implementation should begin from the current `v0.1.52` / `main` state after the MySQL backend rollout.

Relevant existing architecture:

```text
Firefox UI
    |
    v
IndexedDB
    |
    v
sync.js / reconcile.js
    |
    v
remote-provider.js
    |
    +-- remote-google-sheets.js
    |
    +-- remote-mysql.js
```

Important existing behavior to preserve:

- IndexedDB remains the local source of truth.
- `REMOTE_BACKEND` selects the active remote provider.
- Legacy/missing backend settings default to Google Sheets.
- Migration does not switch the active provider until verification succeeds.
- Google Sheets and MySQL implement the same remote-provider operations.
- Reconciliation already reads the **active provider** through the provider abstraction.
- Google snapshots may contain duplicate physical rows.
- MySQL snapshots return `duplicates: []` because the relational schema/API prevent duplicate IDs under normal operation.
- Reconciliation actions use optimistic checks and forced sync after a choice.
- MySQL credentials/API token remain device-local.
- Google OAuth state must not be deleted merely because MySQL becomes active.

---

# 3. UX decisions to implement

## 3.1 Google configuration visibility

The existing top-level sections:

```text
Storage
Google Account
Spreadsheet
```

should become context-sensitive.

### Display rules

| Active backend | Backend being prepared | Google Account | Spreadsheet |
|---|---|---:|---:|
| Google Sheets | Google Sheets | Show | Show |
| Google Sheets | MySQL | Show | Show |
| MySQL | MySQL | Hide | Hide |
| MySQL | Google Sheets | Show | Show |

The rationale:

- If Google Sheets is active, Google configuration is operationally relevant.
- If MySQL is active and MySQL is the selected target/prepared backend, Google configuration is irrelevant to normal use and should not clutter Settings.
- If MySQL is active but the user selects Google Sheets as the backend to prepare, Google configuration must reappear so the user can authenticate/configure the reverse-migration target.
- Selecting a target must **not** change the active backend.
- Hiding the controls must **not** clear OAuth credentials, tokens, spreadsheet ID, or other Google state.

The same visibility rule must apply to:

1. the Settings navigation links; and
2. the corresponding Settings sections.

Do not leave a navigation link visible when its section is hidden.

---

## 3.2 Storage remains the controlling section

The `Storage` section remains permanently visible.

It should clearly show:

- active remote backend;
- backend being prepared;
- migration state;
- provider-specific configuration for the selected preparation target where applicable.

Do not duplicate full Google OAuth/spreadsheet management inside Storage in this change unless doing so is trivial and demonstrably cleaner.

For this release, conditional visibility of the existing Google sections is sufficient.

A future structural consolidation of all provider configuration under Storage may be considered separately.

---

## 3.3 Reconciliation stays

Keep:

```text
Reconcile Local and Remote
```

Reconciliation is now a generic local-vs-active-remote diagnostic and conflict-resolution tool.

It must work for both:

- Google Sheets
- MySQL 8.4

Do not hide reconciliation simply because MySQL is active.

---

## 3.4 Reconciliation terminology becomes provider-neutral

Remove generic UI assumptions that the remote side is always a spreadsheet.

Recommended terminology:

| Current wording | Replacement |
|---|---|
| `Rows in the spreadsheet` | `Remote records` |
| `Distinct entries in the spreadsheet` | `Remote entries` |
| `Duplicate spreadsheet rows` | provider-specific duplicate label |
| `Only in the spreadsheet` | `Only in remote storage` |
| `Keep spreadsheet` | `Keep remote` |
| `Upload to spreadsheet` | `Push to remote` |
| `Every local entry exists in the spreadsheet.` | `Every local entry exists in remote storage.` |
| `Every spreadsheet row exists on this device.` | `Every remote entry exists on this device.` |
| `Nothing differs between this device and the spreadsheet.` | `Nothing differs between this device and remote storage.` |
| `Comparing this device with the spreadsheet...` | `Comparing this device with remote storage...` |
| `This device and the spreadsheet agree on every entry.` | `This device and remote storage agree on every entry.` |

Where useful, show the actual provider label:

```text
Remote — MySQL 8.4
```

or:

```text
Remote — Google Sheets
```

For the differences table, use:

```text
Field | This device | Remote — MySQL 8.4
```

or:

```text
Field | This device | Remote — Google Sheets
```

Do not make downstream code infer provider names from IDs if the provider object already has a label.

---

# 4. Provider capability model

Do not scatter checks such as:

```js
if (provider.id === "google-sheets") {
    ...
}
```

through the reconciliation UI.

Instead, extend provider metadata with explicit capabilities.

Recommended shape:

```js
export const googleSheetsProvider = Object.freeze({
  id: "google-sheets",
  label: "Google Sheets",

  capabilities: Object.freeze({
    duplicateRemoteRecords: true
  }),

  ...
});
```

```js
export const mysqlProvider = Object.freeze({
  id: "mysql",
  label: "MySQL 8.4",

  capabilities: Object.freeze({
    duplicateRemoteRecords: false
  }),

  ...
});
```

If a general helper is useful, add one centrally, for example:

```js
export function getRemoteProviderCapabilities(provider) {
  return {
    duplicateRemoteRecords:
      provider?.capabilities?.duplicateRemoteRecords === true
  };
}
```

Keep the capability surface minimal. Do not invent a large generic capability framework for hypothetical future providers.

---

# 5. Duplicate-record behavior

Google Sheets supports reconciliation of duplicate physical rows because the same entry ID can exist in more than one spreadsheet row.

MySQL should not expose this UI because:

- the MySQL schema/API use unique entry identity;
- snapshots already return `duplicates: []`;
- row-index language is meaningless for MySQL;
- duplicate-row deletion is a Google-specific repair operation.

When the active provider has:

```js
capabilities.duplicateRemoteRecords === false
```

the UI should:

- hide the duplicate summary metric;
- hide the duplicate-record section;
- omit duplicate-row action controls;
- avoid rendering Google row-index language.

When the active provider supports duplicates:

- preserve the existing Google duplicate-row behavior;
- preserve deletion confirmation;
- preserve optimistic/fingerprint checks;
- preserve existing tests.

Do not remove duplicate handling from the reconciliation data model unless there is a strong reason. It is acceptable for the generic report to continue exposing:

```js
duplicates: []
duplicateRowCount: 0
```

for providers that cannot have duplicates.

The capability controls presentation, not the correctness of the underlying report.

---

# 6. Non-goals

Do **not**:

- alter the MySQL API schema;
- change MySQL authentication;
- change Google OAuth flows;
- change migration digest semantics;
- change the active-backend persistence model;
- implement dual-write;
- delete Google credentials after migration;
- delete the old Google spreadsheet;
- replace IndexedDB;
- redesign conflict resolution;
- redesign the options page visually beyond what is needed for provider-aware behavior;
- add a generalized plugin/provider system.

Keep this release narrow.

---

# 7. Cross-session invariants

Every Luna High session must preserve all of these:

1. Google-only legacy installations still behave exactly as before.
2. Missing `REMOTE_BACKEND` still means Google Sheets.
3. Selecting a preparation target does not switch the active backend.
4. Hiding Google UI never deletes Google settings or authentication state.
5. MySQL users can still reverse-migrate to Google Sheets.
6. Reconciliation always works against the **active** backend, not the preparation target.
7. Reconciliation remains read-only until the user explicitly chooses a resolution or presses Sync.
8. Existing reconciliation optimistic-concurrency checks remain intact.
9. Google duplicate-row cleanup remains available when Google is active.
10. MySQL never shows spreadsheet-row-specific repair controls.
11. No secrets appear in logs, diagnostics, rendered HTML, test snapshots, or committed fixtures.
12. Existing MySQL `null` normalization remains untouched.
13. All automated tests must pass after every session.

---

# Session 1 — Make Settings provider-aware

## Goal

Make Google-specific Settings sections and navigation appear only when Google is operationally relevant.

## Primary files

Likely files:

```text
extension/options/options.html
extension/options/options.js
extension/options/options.css
extension/src/remote-provider.js
tests/*options*.test.*
```

Inspect the repository first and use the actual current test filenames.

---

## Step 1.1 — Define the visibility rule as a pure function

Do not embed all logic directly into DOM mutations.

Add a small pure function, preferably in a module that can be unit tested.

Example concept:

```js
export function storageUiState({
  activeProviderId,
  targetProviderId
}) {
  const googleRelevant =
    activeProviderId === REMOTE_PROVIDER_ID.GOOGLE_SHEETS
    || targetProviderId === REMOTE_PROVIDER_ID.GOOGLE_SHEETS;

  return {
    showGoogleAccount: googleRelevant,
    showSpreadsheet: googleRelevant
  };
}
```

The exact location may be:

```text
extension/src/options-storage-ui.js
```

or an existing options-state module if there is already a suitable home.

Prefer a pure helper over testing large DOM code for every state combination.

---

## Step 1.2 — Give Google navigation links stable selectors

The current navigation links should have stable identifiers or data attributes so their visibility can be controlled without fragile selector logic.

Example:

```html
<a id="googleAccountNav" href="#google-account">Google Account</a>
<a id="spreadsheetNav" href="#spreadsheet">Spreadsheet</a>
```

Or:

```html
<a data-provider-section="google" ...>
```

Use the simplest convention consistent with the repository.

---

## Step 1.3 — Apply visibility to both navigation and sections

Update the existing storage renderer.

The effective state comes from:

```text
active backend
+
currently selected backend-to-prepare
```

Do not use only the active backend.

Expected behavior:

### Active Google / target Google

```text
Storage        visible
Google Account visible
Spreadsheet    visible
```

### Active Google / target MySQL

```text
Storage        visible
Google Account visible
Spreadsheet    visible
MySQL fields   visible
```

Google remains visible because it is still the active backend.

### Active MySQL / target MySQL

```text
Storage        visible
Google Account hidden
Spreadsheet    hidden
MySQL fields   visible
```

### Active MySQL / target Google

```text
Storage        visible
Google Account visible
Spreadsheet    visible
MySQL fields   hidden
```

---

## Step 1.4 — Update visibility immediately when target changes

The existing backend-to-prepare selector should rerender provider-specific UI immediately.

Do not require page reload.

When a MySQL-active user changes:

```text
Backend to prepare:
MySQL -> Google Sheets
```

the Google Account and Spreadsheet sections/navigation should appear immediately.

When switched back:

```text
Google Sheets -> MySQL
```

they should disappear immediately.

No settings should be persisted solely because the user changed the target selector unless that is already intended behavior.

---

## Step 1.5 — Handle active navigation state safely

If the current URL hash points to a section that becomes hidden, do not leave Settings in a confusing state.

Example:

```text
#google-account
```

while Google becomes irrelevant.

Preferred behavior:

- route/focus back to `#storage`; or
- ensure the active navigation state selects Storage.

Do not leave a hidden section as the active navigation item.

Test this explicitly.

---

## Step 1.6 — Preserve Google state

Add regression coverage proving that hiding Google sections does **not** mutate:

- OAuth client ID;
- OAuth client secret;
- access/refresh tokens;
- spreadsheet ID/binding;
- any Google-specific settings.

This UI change must be presentation-only.

---

## Step 1.7 — Tests

At minimum, add tests for the four-state matrix:

```text
active google / target google
active google / target mysql
active mysql  / target mysql
active mysql  / target google
```

Also test:

- target selector updates visibility without reload;
- hidden navigation links are hidden too;
- selecting Google as target from MySQL reveals Google setup;
- selecting MySQL again hides Google setup;
- Google settings remain unchanged.

Run:

```bash
npm test
npm run lint
```

Run any focused options tests before the full suite.

---

## Session 1 acceptance criteria

Session 1 is complete only when:

- MySQL-active/MySQL-target Settings contain no visible Google Account or Spreadsheet navigation/sections.
- Reverse-migration preparation exposes Google setup again.
- Google-active users experience no regression.
- No Google state is deleted.
- all relevant tests pass;
- full `npm test` passes;
- lint passes.

Suggested commit:

```text
feat: make storage settings provider-aware
```

---

# Session 2 — Add provider capabilities and neutralize reconciliation

## Goal

Make Reconciliation genuinely provider-neutral while preserving Google-specific duplicate repair behind provider metadata.

## Primary files

Likely:

```text
extension/src/remote-provider.js
extension/src/remote-google-sheets.js
extension/src/remote-mysql.js
extension/src/reconcile.js
extension/reconcile/reconcile.js
extension/options/options.html
tests/*reconcile*.test.*
tests/*remote-provider*.test.*
```

Inspect actual test names first.

---

## Step 2.1 — Add the minimal provider capability

Add:

```js
capabilities: Object.freeze({
  duplicateRemoteRecords: true
})
```

to Google Sheets.

Add:

```js
capabilities: Object.freeze({
  duplicateRemoteRecords: false
})
```

to MySQL.

If provider objects are validated anywhere, update validation accordingly.

Do not make this capability mandatory for old test doubles unless doing so improves clarity. A safe default is:

```text
false
```

for an absent capability.

---

## Step 2.2 — Include active-provider presentation metadata in reconciliation

`loadReconciliation()` currently knows which provider it is reading.

Return enough metadata for the UI to render correctly without performing another provider lookup.

Recommended report additions:

```js
{
  provider: {
    id: remoteProvider.id,
    label: remoteProvider.label,
    capabilities: {
      duplicateRemoteRecords: ...
    }
  },
  ...
}
```

Or an equivalent immutable/simple structure.

Do **not** return the provider object itself if that would expose functions into UI state unnecessarily.

Keep the report serializable/testable.

---

## Step 2.3 — Replace spreadsheet-specific static labels

Update HTML/static text so the generic structure no longer says Spreadsheet.

Recommended summary:

```text
Entries on this device
Remote records
Remote entries
Identical on both sides
Divergences
```

The duplicate metric should be dynamically shown only when supported.

Do not call MySQL database rows “spreadsheet rows.”

---

## Step 2.4 — Dynamically label the remote side

Render provider context visibly near the reconciliation heading or summary.

Example:

```text
Remote backend: MySQL 8.4
```

or:

```text
Comparing this device with MySQL 8.4
```

For difference tables:

```text
Field | This device | Remote — MySQL 8.4
```

For Google:

```text
Field | This device | Remote — Google Sheets
```

Escape/render using DOM `textContent`, not HTML interpolation.

---

## Step 2.5 — Neutralize action labels

Change:

```text
Keep spreadsheet
Upload to spreadsheet
Import from spreadsheet
```

to:

```text
Keep remote
Push to remote
Import from remote
```

For destructive generic actions, use similarly neutral wording.

Do not change the underlying actions:

```js
keepLocal()
keepRemote()
deleteEverywhere()
```

Those are already appropriately provider-neutral.

---

## Step 2.6 — Neutralize status and empty-state copy

Search the full reconciliation UI for:

```text
spreadsheet
sheet
row
rows
```

Classify every occurrence.

There are two categories:

### Generic remote concepts

Replace with provider-neutral wording.

### Google duplicate physical-row repair

Keep row-specific terminology, but render it only when the provider capability says duplicate physical remote records are supported.

Examples that should become generic:

```text
Nothing differs between this device and the spreadsheet.
```

becomes:

```text
Nothing differs between this device and remote storage.
```

Example that may remain Google-specific inside the capability-gated duplicate section:

```text
Delete 2 extra rows
```

because these really are Google Sheet rows.

---

## Step 2.7 — Hide duplicate UI for MySQL

When:

```js
report.provider.capabilities.duplicateRemoteRecords === false
```

hide:

- duplicate summary row;
- duplicate section;
- duplicate bulk-delete control.

Do not merely show:

```text
Duplicate rows: 0
```

for MySQL.

It is an implementation concept that is irrelevant to that provider.

For Google, preserve all current functionality.

---

## Step 2.8 — Guard duplicate actions

Presentation hiding is not sufficient.

Ensure a provider that does not support duplicate-record repair cannot accidentally invoke the duplicate-row UI action path.

The underlying generic `deleteDuplicateRows()` can remain provider-neutral if it already acts on opaque refs.

However, the UI should only make the action reachable when:

```text
capability == true
AND
report contains duplicates
```

Avoid adding provider-ID checks.

---

## Step 2.9 — Update error wording where appropriate

The reconciliation core may still throw messages such as:

```text
Spreadsheet row changed since reconciliation
Spreadsheet row appeared since reconciliation
```

Change generic optimistic-concurrency messages to:

```text
Remote entry changed since reconciliation
Remote entry appeared since reconciliation
```

unless a message specifically comes from a Google Sheets implementation and genuinely refers to a physical row.

Do not change error codes solely for wording cleanup.

Stable error codes are more important than human-readable text.

---

## Step 2.10 — Tests

Add/adjust tests proving:

### MySQL-style provider

- report identifies MySQL provider;
- reconciliation compares local and remote correctly;
- different/local-only/remote-only actions remain available;
- duplicate metric/section is hidden;
- no visible generic reconciliation copy says `spreadsheet`;
- forced sync still follows resolution;
- optimistic checks still work.

### Google provider

- provider label is Google Sheets;
- duplicate metric is visible;
- duplicate section is visible when duplicates exist;
- duplicate deletion still uses opaque refs/current concurrency checks;
- existing row repair behavior is unchanged.

### Generic provider contract

- absence of `duplicateRemoteRecords` is handled safely;
- unknown/future provider labels display through `provider.label`.

Run:

```bash
npm test
npm run lint
```

---

## Session 2 acceptance criteria

Session 2 is complete only when:

- Reconciliation works with MySQL and Google.
- Generic reconciliation UI no longer assumes a spreadsheet.
- Active provider is clearly identified.
- MySQL shows no duplicate-row UI.
- Google duplicate repair is unchanged.
- No provider-ID branch is used where capability metadata is the right abstraction.
- full tests pass;
- lint passes.

Suggested commit:

```text
refactor: make reconciliation provider-aware
```

---

# Session 3 — UX regression tests, edge cases, and cleanup

## Goal

Exercise combinations that are easy to miss when Settings target selection, active backend, migration state, and reconciliation are all interacting.

This session should primarily test and harden. Avoid introducing new scope.

---

## Step 3.1 — Search for remaining stale terminology

Search extension code, HTML, tests, README, and user-visible diagnostics for case-insensitive occurrences of:

```text
spreadsheet
sheet
rows in
Google Account
Google Sheets
```

Do not blindly replace everything.

Classify each occurrence as:

1. truly Google-specific — keep it;
2. generic remote-storage UX — neutralize it;
3. test fixture/internal implementation name — normally keep it;
4. documentation that now needs clarification.

Examples that should remain:

- Spreadsheet provisioning.
- Spreadsheet ID.
- Google OAuth.
- Google-specific duplicate row repair.
- `sheets.js`.
- Google provider implementation tests.

Examples that should become generic:

- reconciliation status messages;
- reconciliation difference headings;
- remote-only/local-only descriptions that apply to all providers.

---

## Step 3.2 — Test migration-target UI interaction

Simulate:

### MySQL active

1. Open Settings.
2. Confirm Google sections hidden.
3. Select Google Sheets as target.
4. Confirm Google sections appear.
5. Configure/authenticate as needed in mocked tests.
6. Change target back to MySQL.
7. Confirm Google sections hide.
8. Confirm active backend remains MySQL throughout.

### Google active

1. Open Settings.
2. Confirm Google sections visible.
3. Select MySQL target.
4. Confirm MySQL setup appears.
5. Confirm Google sections remain visible because Google is still active.
6. Confirm active backend remains Google until migration completes.

---

## Step 3.3 — Test post-migration rerender

Where practical, cover:

```text
active Google -> migration completes -> active MySQL
```

Expected Settings state immediately after refresh/rerender:

- active label becomes MySQL 8.4;
- if target is now MySQL, Google sections/navigation hide;
- MySQL fields remain available;
- Reconciliation uses MySQL label/capabilities.

And reverse:

```text
active MySQL -> migration completes -> active Google
```

Expected:

- Google sections/navigation visible;
- Spreadsheet section visible;
- Reconciliation identifies Google Sheets;
- duplicate capability is enabled.

Do not create a second migration engine in tests. Reuse existing migration test helpers/state transitions.

---

## Step 3.4 — Test URL hash/navigation edge cases

Cases:

```text
options.html#google-account
options.html#spreadsheet
```

with MySQL active and MySQL target.

Expected:

- hidden Google section does not remain the apparent current section;
- Settings falls back to Storage or another visible section;
- keyboard navigation remains sensible;
- no JavaScript error occurs.

Also test switching target to Google while already on Settings.

---

## Step 3.5 — Accessibility check

Verify:

- hidden nav links are actually hidden/unavailable to keyboard navigation;
- hidden sections are not focus targets;
- status text still uses appropriate live regions;
- changing provider target does not unexpectedly steal focus;
- provider labels are readable text;
- buttons retain meaningful accessible names.

Avoid unnecessary ARIA if native HTML behavior is sufficient.

---

## Step 3.6 — Reconciliation state edge cases

Test:

### No divergences, MySQL

Expected:

```text
This device and remote storage agree on every entry.
```

No duplicate section.

### Divergence, MySQL

Expected:

- `Keep this device`
- `Keep remote`
- provider label shows MySQL
- no spreadsheet wording

### Local-only, MySQL

Expected:

```text
Push to remote
```

### Remote-only, MySQL

Expected:

```text
Import from remote
```

### Duplicate rows, Google

Expected:

- duplicate UI visible;
- exact row repair controls still work;
- deletion confirmation remains explicit;
- Google provider label visible.

### Remote changed after scan

Expected:

- optimistic-concurrency error remains;
- generic message refers to remote entry;
- user is told/rescan path remains available.

---

## Step 3.7 — Documentation

Update README or relevant user documentation only where needed.

Document:

- Settings hides provider-specific controls that are not relevant to the active/prepared backend.
- Reconciliation always compares local IndexedDB with the active remote backend.
- Google duplicate-row repair appears only for Google Sheets.
- Choosing a backend to prepare is not the same as switching the active backend.

Do not over-document implementation internals.

---

## Step 3.8 — Full validation

Run:

```bash
npm test
npm run test:browser
npm run lint
npm run build:xpi
git diff --check
```

If repository scripts contain additional release checks, run them too.

Inspect browser/runtime smoke test specifically with MySQL active.

---

## Session 3 acceptance criteria

Session 3 is complete only when:

- no stale generic spreadsheet language remains in reconciliation;
- state-transition tests cover active/target combinations;
- hidden-section URL hashes behave correctly;
- accessibility regressions are addressed;
- migration completion produces the correct Settings state;
- documentation reflects the provider-aware UX;
- full automated validation passes.

Suggested commit:

```text
test: harden provider-aware settings and reconciliation
```

---

# Session 4 — Release review and `0.1.53`

## Goal

Perform a release-focused review and ship the provider-aware UI cleanup without modifying unrelated behavior.

---

## Step 4.1 — Review the complete diff

Review all changes since `v0.1.52`.

Specifically look for accidental changes to:

```text
sync.js
storage-migration.js
remote-mysql.js request/auth behavior
sheets.js
entry serialization
database schema
manifest host permissions
```

None of these should change materially for this feature unless a directly related bug was found.

If they changed, justify each change.

---

## Step 4.2 — Verify provider contract consistency

For each provider ensure:

```text
id
label
capabilities
ensureReady
getChangeToken
readSnapshot
appendEntries
updateEntries
deleteEntries
updateConfig
```

remain consistent with the existing abstraction.

Capability metadata must not affect synchronization semantics.

---

## Step 4.3 — Manual Firefox acceptance matrix

Run a real Firefox smoke pass.

### Case A — MySQL active

Confirm:

- Storage says `MySQL 8.4`.
- MySQL API fields function.
- Google Account hidden.
- Spreadsheet hidden.
- Their navigation links hidden.
- Reconciliation visible.
- Reconciliation says MySQL 8.4.
- No duplicate-row section.
- Rescan works.
- Sync Now works.
- normal time logging still syncs.

### Case B — MySQL active, Google selected as target

Confirm:

- Google Account appears.
- Spreadsheet appears.
- navigation links appear.
- active backend still says MySQL.
- normal sync still uses MySQL.
- Reconciliation still compares against MySQL, not the target Google provider.

This distinction is critical.

### Case C — Google active, MySQL selected as target

Confirm:

- Google Account remains visible.
- Spreadsheet remains visible.
- MySQL fields appear.
- normal sync still uses Google.
- Reconciliation still compares against Google.

### Case D — Google active, Google target

Confirm legacy behavior is unchanged.

---

## Step 4.4 — Manual reconciliation acceptance

With MySQL active:

1. Create/edit an entry locally.
2. force sync;
3. reconcile;
4. confirm equality;
5. create a controlled divergence using a test profile or API-safe test fixture;
6. verify Keep Local / Keep Remote behavior;
7. verify no spreadsheet terminology is visible.

With Google active/test profile:

1. verify ordinary reconciliation;
2. if feasible, create a deliberate duplicate Sheet row;
3. confirm duplicate-row repair appears and works;
4. confirm the duplicate UI disappears again when MySQL is active.

Do not corrupt production data to manufacture a duplicate. Use a test spreadsheet/profile.

---

## Step 4.5 — Security/privacy regression review

Confirm this UI work did not:

- expose the MySQL bearer token;
- expose Google OAuth tokens;
- add secrets to logs;
- put MySQL token into Firefox Sync;
- request broader host permissions;
- alter Google OAuth storage;
- alter CORS/API behavior.

Inspect built XPI contents for accidental secrets or local test artifacts.

---

## Step 4.6 — Version and release notes

If all checks pass, increment extension version from:

```text
0.1.52
```

to:

```text
0.1.53
```

Suggested release notes:

```text
- Hide Google-specific settings when MySQL is the active/prepared backend.
- Show Google setup automatically when Google Sheets is active or selected as a migration target.
- Make Local/Remote reconciliation provider-neutral.
- Show the active remote backend in reconciliation.
- Hide Google Sheet duplicate-row repair when the active backend does not support duplicate remote records.
```

Do not claim changes to storage correctness or migration unless there were actual fixes.

---

## Step 4.7 — Final validation

Run from a clean working tree/reproducible state:

```bash
npm test
npm run test:browser
npm run lint
npm run build:xpi
git diff --check
```

Also run any Firefox extension linter/release check currently used by the repository.

Inspect the generated XPI.

---

## Step 4.8 — Commit/tag only after validation

Suggested final commit if version bump/release metadata are separate:

```text
chore: release provider-aware settings UI
```

Suggested tag:

```text
v0.1.53
```

Do not push/tag until all validation passes.

---

# 8. Expected final UX

## MySQL active, MySQL target

Settings navigation:

```text
Appearance
Storage
ChatGPT Usage
Reconciliation
Tempo
Diagnostics
```

Google-specific navigation is absent.

Storage:

```text
Active remote backend
MySQL 8.4

Backend to prepare
MySQL 8.4

HTTPS API base URL
...
API token
...
Test connection
```

Reconciliation:

```text
Reconcile Local and Remote

Remote backend: MySQL 8.4

Entries on this device    215
Remote entries            215
Identical on both sides   215
Divergences                 0
```

No duplicate spreadsheet-row section.

---

## MySQL active, Google target

Settings navigation:

```text
Appearance
Storage
Google Account
Spreadsheet
ChatGPT Usage
Reconciliation
Tempo
Diagnostics
```

Storage still says:

```text
Active remote backend
MySQL 8.4
```

Normal sync and reconciliation still use MySQL until migration succeeds.

Google controls are visible only so Google can be prepared as the target.

---

## Google active, MySQL target

Both providers' relevant setup is visible:

- Google Account / Spreadsheet because Google is still active.
- MySQL target fields because MySQL is being prepared.

Reconciliation still compares against Google Sheets.

---

# 9. Key architectural distinction Luna must preserve

There are three different concepts:

```text
LOCAL STORE
IndexedDB

ACTIVE REMOTE BACKEND
The provider normal sync/reconciliation currently uses

PREPARATION/MIGRATION TARGET
The provider the user is configuring before a possible switch
```

Never conflate the last two.

In particular:

```text
Selecting "Google Sheets" as Backend to prepare
```

must **not** make reconciliation read Google when MySQL is still active.

Likewise:

```text
Selecting "MySQL 8.4" as Backend to prepare
```

must **not** make normal sync use MySQL while Google is still active.

Only verified migration changes `REMOTE_BACKEND`.

---

# 10. Suggested test matrix

| Active | Target | Google UI | MySQL UI | Reconcile provider | Duplicate repair |
|---|---|---|---|---|---|
| Google | Google | Visible | Hidden | Google Sheets | Available |
| Google | MySQL | Visible | Visible | Google Sheets | Available |
| MySQL | MySQL | Hidden | Visible | MySQL 8.4 | Hidden |
| MySQL | Google | Visible | Hidden | MySQL 8.4 | Hidden |

This matrix should exist in automated tests in some form.

---

# 11. Luna High session handoff rules

At the start of every session:

1. Read this plan.
2. Inspect the current git status and recent commits.
3. Read the implementation left by the previous session.
4. Run the focused tests relevant to the files about to be changed.
5. Do not assume the repository is exactly at `v0.1.52` if previous sessions already committed work.
6. Preserve unrelated local/untracked files.
7. Do not commit secrets.
8. Do not modify production API credentials.
9. Keep commits narrow and descriptive.
10. End with:
   - summary of changes;
   - tests run;
   - test results;
   - commit SHA;
   - any remaining risk/blocker;
   - explicit instructions for the next session.

If a session discovers that the existing architecture differs from this plan, adapt to the repository rather than forcing the proposed file structure. Preserve the behavioral requirements and invariants.

---

# 12. Definition of done

This entire plan is complete when all of the following are true:

- [x] MySQL-active/MySQL-target users do not see Google Account.
- [x] MySQL-active/MySQL-target users do not see Spreadsheet.
- [x] Hidden sections also disappear from navigation.
- [x] Google configuration reappears when Google is active.
- [x] Google configuration reappears when Google is selected as migration target.
- [x] Hiding Google UI never erases Google state.
- [x] Reconciliation remains available for MySQL.
- [x] Reconciliation remains available for Google Sheets.
- [x] Reconciliation identifies the active provider.
- [x] Generic reconciliation copy no longer refers to the spreadsheet.
- [x] MySQL does not show duplicate-row repair UI.
- [x] Google still supports duplicate-row repair.
- [x] Provider capabilities, not scattered provider-ID branches, control provider-specific reconciliation UI.
- [x] Reconciliation always uses the active provider, never merely the target provider.
- [x] Migration behavior is unchanged.
- [x] Sync behavior is unchanged.
- [x] Google legacy behavior is unchanged.
- [x] MySQL sync behavior is unchanged.
- [x] `npm test` passes.
- [x] `npm run test:browser` passes.
- [x] `npm run lint` passes.
- [x] XPI build passes.
- [x] Firefox extension lint/release checks pass.
- [x] `git diff --check` passes.
- [x] XPI contains no secrets/test artifacts.
- [x] Version `0.1.53` is ready to release.

---

# 13. Recommended session order

```text
Session 1
Provider-aware Settings visibility and navigation

        ↓

Session 2
Provider capabilities + provider-neutral Reconciliation

        ↓

Session 3
Edge cases, UX regression tests, documentation, full validation

        ↓

Session 4
Manual acceptance, security/release review, version 0.1.53
```

Do not collapse Sessions 1 and 2 unless the change proves substantially smaller than expected. Separating them makes regressions easier to localize and keeps each Luna High context focused.

---

# 14. Final expected result

After this release, the extension should feel as though Google Sheets and MySQL were designed as peer remote-storage providers from the start.

Google-specific controls remain available when they are relevant, but disappear during ordinary MySQL use.

Reconciliation becomes a permanent provider-neutral safety and recovery tool:

```text
IndexedDB on this device
        ↕
active remote backend
```

with provider-specific repair actions shown only when the active provider actually supports them.

## 15. Implementation record

This plan was completed on 2026-08-24. The implementation is committed on
`main` and tagged `v0.1.53`; the final release commit is `77e84e3`.

Final validation passed: 67 automated tests, Firefox browser smoke, JavaScript
lint, Firefox extension lint with zero errors, XPI build, and `git diff --check`.
The extension lint output retains one pre-existing warning about dynamic
`innerHTML` in `src/entry-editor.js`; it is unrelated to this plan.

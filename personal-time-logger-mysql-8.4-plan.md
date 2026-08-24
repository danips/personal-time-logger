# Personal Time Logger — MySQL 8.4 Remote Storage Backend Plan

> **Archive status:** Completed and superseded by the shipped `v0.1.53` release.
> This document preserves the design and implementation plan used for the
> MySQL rollout; its session instructions are historical, not pending work.

## Purpose

This document is an implementation plan intended to be executed in **five sequential GPT-5.6 Luna High coding sessions** against:

- Repository: `danips/personal-time-logger`
- Baseline branch: `main`
- Baseline inspected commit: `f164d824c0c199036f3440461e46dc7ac64804f9` (`Refresh ChatGPT usage when popup opens`)
- Extension version at inspection: `0.1.51`

The goal is to add a selectable remote data-storage backend while retaining the extension's current local-first design, and to support a safe, verified migration of existing data between remote backends.

The first two remote backends will be:

1. **Google Sheets** — existing implementation, preserved as the default for backwards compatibility.
2. **MySQL 8.4** — accessed through an authenticated HTTPS API hosted alongside the MySQL database.

---

# 1. Architectural decision: do not replace IndexedDB

The existing extension writes timer changes to IndexedDB first and synchronizes them remotely afterward. Keep that architecture.

The user-facing choice should therefore be called **Remote storage backend** (or **Sync backend**), not local storage backend.

```text
Firefox extension
      |
      +--> IndexedDB: timelogger_db         <-- always local, always used
      |
      +--> sync/reconcile engine
                  |
                  +--> Google Sheets provider --> Google Sheets / Drive APIs
                  |
                  +--> MySQL provider --------> HTTPS API --> MySQL 8.4
```

### Non-negotiable constraints

- Timer start/stop/edit/delete operations continue to succeed locally while offline.
- IndexedDB remains the local source used by popup/calendar UI.
- Do **not** connect a Firefox extension directly to TCP port 3306.
- Do **not** put a MySQL host/user/password in the extension.
- The browser only receives an HTTPS API URL and an API credential/token.
- The MySQL database credential remains on the server.
- Preserve the current entry identity, revision, timestamp, deletion, reconciliation, and conflict rules.
- Google Sheets remains functional throughout the refactor.
- Default existing installations to Google Sheets without requiring a migration.
- Do not dual-write to Google and MySQL during ordinary operation. Exactly one remote provider is active on a device.

---

# 2. Current data contract that must remain stable

The current canonical remote entry has these fields, in this order in Google Sheets:

```text
id
project
task
description
start_at
end_at
duration_seconds
status
created_at
updated_at
deleted_at
device_id
revision
multiply
```

Local-only IndexedDB bookkeeping such as the following must **not** become part of the cross-provider data model:

```text
dirty
last_sync_at
sync_error
dirty_key
```

The provider boundary should accept and return the same normalized persisted entry object that `entries.js` already validates.

### Shared remote configuration

The existing remote config currently contains values such as `duration_multiplier` and the application marker. MySQL must support the same shared-config concept so provider switching does not silently lose shared settings.

---

# 3. Target provider abstraction

The current `sync.js` and `reconcile.js` call `sheets.js` directly. Replace that coupling with a provider contract.

Suggested modules:

```text
extension/src/remote-provider.js
extension/src/remote-google-sheets.js
extension/src/remote-mysql.js              # added in Session 3
extension/src/storage-migration.js         # added in Session 4
```

Keep `sheets.js` as the Google API implementation; the Google provider adapter can wrap it rather than rewriting it immediately.

## 3.1 Provider identity

Use stable IDs, not labels:

```js
"google-sheets"
"mysql"
```

Persist the active ID in a new device-local setting, for example:

```text
remote_backend
```

Missing/legacy value must decode to `google-sheets`.

## 3.2 Generic snapshot

Do not expose spreadsheet row numbers to generic sync code. Replace the semantic use of `rowMap` with generic opaque remote references.

Suggested shape:

```js
{
  entries: [],
  entryRefs: Map<entryId, opaqueRef>,
  duplicates: [],
  quarantined: [],
  config: {},
  configRefs: Map<configKey, opaqueRef>,
  changeToken: ""
}
```

Examples of opaque refs:

```js
// Google provider
{
  kind: "google-sheet-row",
  rowIndex: 42,
  fingerprint: "..."
}

// MySQL provider
{
  kind: "mysql-row",
  version: 17
}
```

Generic sync/reconcile code must never inspect provider-specific fields inside an opaque ref.

## 3.3 Suggested provider operations

Exact names can change, but all required semantics must exist:

```js
provider.id
provider.label

provider.ensureReady(options)
provider.getChangeToken(options)
provider.readSnapshot(options)

provider.appendEntries(entries, options)
provider.updateEntries(updates, options)
provider.deleteEntries(preconditions, options)
provider.updateConfig(key, value, updatedAt, options)

provider.tryRecoverMissingRemote?.(error, options)
provider.describeBinding?.()
```

Where:

```js
updates = [
  { entry, expectedRef }
]

preconditions = [
  { id, expectedRef }
]
```

The provider owns optimistic concurrency verification.

### Provider semantics that must be uniform

- `appendEntries` is idempotent or recoverably verifiable.
- `updateEntries` refuses a stale expected remote version/ref.
- `deleteEntries` refuses a stale expected remote version/ref.
- `readSnapshot` returns normalized valid entries and identifies invalid/quarantined records.
- Every provider can supply a cheap change token when available; if not, sync performs a full read.
- Provider failures are mapped onto stable extension error codes and diagnostics.

---

# 4. MySQL 8.4 server architecture

## 4.1 Required server component

The extension must call a small HTTPS JSON API. The API then talks to MySQL 8.4.

Recommended first implementation for ordinary shared hosting:

- **PHP 8.2+**
- PDO MySQL
- no framework
- no Composer/runtime dependencies unless the hosting makes them clearly beneficial

If the hosting does not support PHP 8.2+, implement the same HTTP contract in Node.js or Python. Only the server implementation in **Session 2** should change; the extension-provider and migration design should remain the same.

Suggested repository location:

```text
server/mysql-api/
  README.md
  public/
    index.php
  src/
    ...
  sql/
    001_initial_schema.sql
  config.example.php   # or equivalent; contains no secrets
```

The deployable server must not accidentally be included in the Firefox XPI.

## 4.2 Suggested database schema

Use InnoDB and `utf8mb4`.

### `time_entries`

The table carries all 14 canonical fields plus a **server-only optimistic-concurrency version**.

Recommended logical shape:

```sql
CREATE TABLE time_entries (
    id                VARCHAR(64)  NOT NULL,
    project           TEXT         NOT NULL,
    task              TEXT         NOT NULL,
    description       TEXT         NOT NULL,
    start_at          VARCHAR(32)  NOT NULL,
    end_at            VARCHAR(32)  NULL,
    duration_seconds  BIGINT UNSIGNED NOT NULL,
    status            VARCHAR(32)  NOT NULL,
    created_at        VARCHAR(32)  NOT NULL,
    updated_at        VARCHAR(32)  NOT NULL,
    deleted_at        VARCHAR(32)  NULL,
    device_id         VARCHAR(128) NOT NULL,
    revision          BIGINT UNSIGNED NOT NULL,
    multiply          DECIMAL(6,3) NULL,
    remote_version    BIGINT UNSIGNED NOT NULL DEFAULT 1,
    PRIMARY KEY (id),
    INDEX idx_start_at (start_at),
    INDEX idx_updated_at (updated_at),
    INDEX idx_deleted_at (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### Why preserve ISO timestamps as text in v1?

The extension currently exchanges ISO-8601 strings and compares some timestamps as strings. Keeping normalized ISO UTC values at the HTTP boundary avoids introducing timezone/precision conversion changes during the backend refactor. The server must validate the timestamps and normalize empty `end_at` / `deleted_at` to `NULL` internally, then return `""` at the API boundary.

A later schema migration may move timestamps to `DATETIME(3)` after round-trip compatibility is independently proven.

### `config`

```sql
CREATE TABLE config (
    `key`           VARCHAR(128) NOT NULL,
    `value`         TEXT NOT NULL,
    updated_at      VARCHAR(32) NOT NULL,
    remote_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### `app_meta`

Use one metadata row to expose a cheap global change token.

```sql
CREATE TABLE app_meta (
    id             TINYINT UNSIGNED NOT NULL,
    schema_version INT UNSIGNED NOT NULL,
    change_seq     BIGINT UNSIGNED NOT NULL,
    updated_at     VARCHAR(32) NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

Initialize `id = 1`, `schema_version = 1`, and `change_seq = 1`.

Every successful entry/config mutation must increment `change_seq` in the **same MySQL transaction** as the mutation.

## 4.3 Authentication and transport

For v1 use a single long random personal API token.

Requirements:

- HTTPS only in production.
- `Authorization: Bearer <token>`.
- At least 256 bits of entropy.
- Never put the token in a URL/query string.
- Store only a token hash server-side where practical, or keep the secret in server configuration outside the public web root.
- MySQL credentials exist only in server configuration.
- API token in the extension is device-local and is not copied to Firefox Sync.
- Do not log the Authorization header.
- Do not log raw time-entry payloads by default.
- CORS must allow the extension request origin/required methods/headers.
- Use PDO prepared statements for all user-derived values.
- The DB user should have only the permissions required by the API after schema installation.

## 4.4 HTTP API contract

Suggested endpoints:

```text
GET  /v1/health
GET  /v1/change-token
GET  /v1/snapshot
POST /v1/entries/append
POST /v1/entries/update
POST /v1/entries/delete
POST /v1/config/update
```

### `GET /v1/health`

Returns authenticated service/schema compatibility information.

Example:

```json
{
  "ok": true,
  "service": "personal-time-logger",
  "apiVersion": 1,
  "schemaVersion": 1,
  "mysql": "8.4"
}
```

Do not expose credentials or unnecessary server details.

### `GET /v1/change-token`

```json
{
  "changeToken": "1234"
}
```

### `GET /v1/snapshot`

Return canonical entry fields plus an opaque version alongside each record, for example:

```json
{
  "changeToken": "1234",
  "entries": [
    {
      "entry": { "id": "...", "project": "..." },
      "version": 7
    }
  ],
  "config": [
    {
      "key": "duration_multiplier",
      "value": "1.5",
      "updated_at": "...",
      "version": 2
    }
  ]
}
```

The API must return all 14 canonical entry fields even when values are empty.

### Append semantics

`POST /v1/entries/append` takes one or many entries.

For each ID:

- absent ID: insert it;
- same ID + identical canonical data: treat as already successful and return the existing version;
- same ID + different canonical data: return HTTP 409 with a stable conflict code.

This is required so an interrupted request can safely be retried.

### Update semantics

Each update contains:

```json
{
  "entry": { "id": "..." },
  "expectedVersion": 7
}
```

Perform the update with a version fence, equivalent to:

```sql
... WHERE id = ? AND remote_version = ?
```

Increment `remote_version` on success. Zero affected rows is a stale-write conflict and must become HTTP 409.

### Delete semantics

Physical delete is used only for entries whose tombstone retention has expired, matching current Sheets purge behavior.

Delete requires `id` + `expectedVersion`. A stale version is HTTP 409.

### Config update semantics

Use the same optimistic version concept for config rows. An insert must detect a concurrent same-key insert; an update must require the expected version.

## 4.5 Stable API error shape

Use an explicit structure such as:

```json
{
  "error": {
    "code": "REMOTE_VERSION_STALE",
    "message": "The remote entry changed before this update could be applied."
  }
}
```

Never make the extension parse English text to decide the failure class.

Suggested status mapping:

```text
400  validation/schema request error
401  missing/invalid API token
403  token lacks access / origin denied
404  API route or app resource absent
409  stale remote version / append conflict
429  rate limit
500  internal server error
503  database temporarily unavailable
```

---

# 5. Migration model

A backend switch must be a **verified migration**, not merely a change to `remote_backend` followed by a normal sync.

## 5.1 Safety rules

- Current source provider stays active until target verification succeeds.
- Never delete or clear the source provider as part of migration.
- Do not mark migration complete from HTTP success alone; re-read and verify the target.
- Migration must be idempotent and resumable after an interruption.
- A partially seeded target is not considered active.
- A divergent non-empty target must block migration rather than be silently merged.
- A target that exactly contains already-seeded rows from a previous attempt is valid for resume.
- Preserve deleted tombstones that are still inside the current retention period.
- Preserve the active/running timer entry exactly like any other entry.
- Preserve remote config.
- Do not transfer local-only fields.

## 5.2 Persisted migration state machine

Suggested local setting:

```text
storage_migration_state
```

Suggested states:

```text
idle
validating_target
syncing_source
snapshotting_source
seeding_target
verifying_target
checking_source_stability
switching
complete
failed
```

Persist at least:

```text
migration_id
source_provider
target_provider
state
started_at
source_change_token or source_digest
source_entry_count
source_digest
target_digest
last_error_code
```

Do not persist credentials in the migration record.

## 5.3 Migration algorithm

1. **Validate target configuration**
   - Test HTTPS/API permission.
   - Authenticate.
   - Verify API version and DB schema version.

2. **Keep source active and force a source sync**
   - Run a forced source sync.
   - Resolve local dirty data against the existing source first.

3. **Refuse unsafe source state**
   - Block if there are quarantined remote rows.
   - Block if there is an unsupported remote schema.
   - Block unresolved reconciliation conflicts that make the canonical source ambiguous.

4. **Read a fresh canonical source snapshot**
   - Capture canonical entries + config.
   - Compute a deterministic digest over canonical sorted data.
   - Capture source change token if available.

5. **Preflight target**
   - Empty target: proceed.
   - Target equals source: verification may complete immediately.
   - Target contains only records already written by this same migration attempt: resume.
   - Otherwise block; do not silently merge unrelated target data.

6. **Seed target idempotently**
   - Batch when sensible.
   - Write canonical entry fields only.
   - Write canonical config.
   - Record progress after each confirmed batch if batching is used.

7. **Read target snapshot and verify**
   - Same set of IDs.
   - Same canonical fingerprints/digest.
   - Same retained tombstones.
   - Same shared config values/timestamps.

8. **Check that source did not change while copying**
   - Prefer provider change token when reliable.
   - If no cheap token is available, re-read and compare canonical digest.
   - Force source sync once more so local edits made during migration are included.
   - If source changed, repeat snapshot -> seed -> verify rather than switching prematurely.
   - Use a bounded retry count; if the source keeps changing, ask the user to temporarily stop editing/close other devices and retry.

9. **Atomically activate target locally**
   - Change `remote_backend` only after successful target verification and source stability check.
   - Clear/reset provider-specific remote read marker/change token/backoff state.
   - Clear stale reconciliation intents that refer to the old remote snapshot.
   - Do not artificially change `updated_at` or `revision` merely because the backend changed.

10. **Run a forced sync against the newly active target**
    - Confirm ordinary sync reaches a clean state.

11. **Mark migration complete**
    - Keep old provider configuration so the user can migrate back later.
    - Show source/target/count/verification result in Options.

## 5.4 Multiple devices

V1 should not attempt cross-provider dual-write or automatic fleet coordination.

The migration UI/documentation must explicitly instruct the user to:

1. update the extension on every device first;
2. close or stop using the other devices while the migration runs;
3. migrate on one device;
4. configure/test the MySQL API on each remaining device;
5. switch/migrate those devices before normal multi-device use resumes.

Otherwise one device can continue writing Google Sheets while another writes MySQL, producing two legitimate but divergent histories.

A future enhancement could add explicit backend-generation coordination, but it is outside these five sessions.

---

# 6. UI design

Replace the mental model of “Spreadsheet settings” with a higher-level **Storage** section.

Suggested navigation:

```text
Appearance
Storage
Google Account
ChatGPT Usage
Reconciliation
Tempo
Diagnostics
```

The Storage panel should show:

```text
Remote storage backend
  ( ) Google Sheets
  ( ) MySQL 8.4

Active backend: Google Sheets
Status: Connected
```

Do not immediately switch when a radio/select value changes. Treat it as a **target configuration** until validation/migration completes.

## Google-specific panel

Keep existing:

- OAuth controls
- spreadsheet link/ID
- reconnect
- connect compatible spreadsheet
- create replacement

These controls can be shown only when Google is the active/selected target provider.

## MySQL-specific panel

Suggested fields/actions:

```text
API base URL       https://time.example.com/
API token          ••••••••••••••••
[Test connection]

API version        1
DB schema version  1
Status              Connected
```

Actions:

```text
Save MySQL settings
Test connection
Migrate data and switch to MySQL
```

If MySQL is active, offer:

```text
Migrate data and switch to Google Sheets
```

### Required warning before migration

Explain that:

- source remains untouched;
- migration verifies the target before switching;
- other devices should be closed during migration;
- the user can migrate back later.

---

# 7. Firefox host permission strategy

Fetching the MySQL HTTPS API from the extension requires host permission.

Preferred for this personal deployment:

- once the real API origin is known, add the **exact HTTPS origin** to `optional_host_permissions`;
- ask Firefox for that origin only when the user clicks **Test connection** / **Connect**.

Example conceptually:

```json
"optional_host_permissions": [
  "https://chatgpt.com/*",
  "https://api.tempo.io/*",
  "https://time.example.com/*"
]
```

If the extension must support arbitrary user-entered API hosts, a broader optional HTTPS host pattern may be necessary. Do that only deliberately because it increases permission scope and AMO/privacy-review impact.

Do not add plain HTTP production permission. A localhost-only development exception can exist in test/dev configuration if genuinely needed.

---

# 8. New settings

Add names centrally in `setting-keys.js`.

Suggested keys:

```text
REMOTE_BACKEND
REMOTE_CHANGE_TOKENS             # preferably map keyed by provider ID
MYSQL_API_BASE_URL
MYSQL_API_TOKEN
MYSQL_API_STATUS                 # optional non-secret cached status
STORAGE_MIGRATION_STATE
```

Keep current Google keys for backward compatibility.

### Secret handling

- `MYSQL_API_TOKEN`: device-local only.
- never add it to diagnostics exports.
- never print it to console.
- never write it into README examples.
- never put it in the release artifact.

---

# 9. Five GPT-5.6 Luna High implementation sessions

Each session below is intended to be usable as a standalone handoff prompt after the preceding session has been merged/committed.

General rule for **every** session:

> Start by reading this plan and the current repository state. Inspect `git status` and recent commits. Preserve all previously implemented behavior unless this plan explicitly changes it. Add/modify tests together with production code. Do not commit credentials, tokens, database passwords, generated artifacts, or deployment secrets. Run the focused tests while iterating, then run the full project validation before finishing the session.

Current project commands at the inspected baseline:

```bash
npm test
npm run test:browser
npm run lint
npm run build:xpi
```

---

## Session 1 — Extract a provider-neutral remote sync layer, with Google behavior unchanged

### Goal

Make Google Sheets one implementation of a generic remote-provider contract **without adding MySQL yet**. At the end of this session, a legacy installation and a new installation must behave exactly as before with Google Sheets.

### Read first

At minimum inspect:

```text
extension/src/db.js
extension/src/entries.js
extension/src/sheets.js
extension/src/sync.js
extension/src/reconcile.js
extension/src/setting-keys.js
extension/options/options.js
extension/options/options.html

test/sheets.test.js
test/provisioning.test.js
test/append-idempotency.test.js
test/remote-row-fencing.test.js
test/sync-*.test.js
test/reconcile*.test.js
test/reconciliation-*.test.js
```

### Implementation steps

1. Add provider IDs/constants and a registry/factory in a new provider-neutral module.
2. Add `SETTING_KEY.REMOTE_BACKEND`.
3. Decode missing/legacy backend value as `google-sheets`.
4. Add a Google provider adapter that wraps `sheets.js`.
5. Define one generic remote snapshot shape using opaque `entryRefs` and `configRefs`.
6. Move spreadsheet row-index/fingerprint knowledge behind the Google provider.
7. Refactor `sync.js` so it obtains the active provider and calls provider methods rather than importing Sheets mutations directly.
8. Refactor `reconcile.js` the same way. No reconciliation action should import a Google-specific remote mutation after this session unless it is in the Google adapter itself.
9. Replace Google-specific “remote modified time” assumptions in generic sync code with a provider `changeToken` concept.
10. Preserve Google provisioning/recovery semantics through the adapter:
    - automatic find/create;
    - safe replacement behavior;
    - exact header validation;
    - Drive modified-time gate;
    - duplicate row handling;
    - row fencing.
11. Preserve current append ambiguity recovery.
12. Keep the current sync lock/lease behavior unchanged.
13. Keep all existing error codes working. Add provider-neutral errors only where required.
14. Add architecture comments only where they explain non-obvious provider boundaries; avoid unnecessary rewrites.

### Tests to add/update

Add explicit tests for:

- missing backend setting -> `google-sheets`;
- unknown backend ID -> safe explicit error, not fallback to an unintended backend;
- provider selection/registry;
- Google snapshot refs mapping to row/fingerprint preconditions;
- sync code does not need to inspect Sheets row refs;
- reconciliation uses the selected provider;
- existing Google append/update/delete/config/provisioning behavior remains unchanged.

Keep all existing tests passing, especially:

```text
append-idempotency
provisioning
remote-row-fencing
sync acknowledgement/coalescing/lease/maintenance/pull
reconciliation actions/intents
```

### Exit criteria

- No change to the user-visible Google workflow.
- Existing installations need no action.
- `google-sheets` is the active default.
- `sync.js` and reconciliation logic operate through provider-neutral APIs.
- Opaque refs are established so a DB row version can replace a Sheets row number in another provider.
- Full test/lint suite passes.

### Suggested commit

```text
refactor: abstract remote storage provider
```

---

## Session 2 — Implement the MySQL 8.4 HTTPS API and database schema

### Goal

Create a small secure API that implements the remote-storage semantics independently of the extension UI. By the end of this session, it must be possible to exercise the API using HTTP integration tests/curl without changing the active extension backend.

### Assumption to confirm before coding

Default implementation assumption: **the hosting supports PHP 8.2+ with PDO MySQL**.

If the hosting instead supports Node.js or Python, keep the API contract/schema/concurrency behavior in this plan and implement it in that available runtime.

### Implementation steps

1. Add `server/mysql-api/` with a deployment README.
2. Add `sql/001_initial_schema.sql` for `time_entries`, `config`, and `app_meta`.
3. Use InnoDB + `utf8mb4`.
4. Add server configuration loading that keeps secrets outside source control/public web root.
5. Add a safe example config containing placeholders only.
6. Implement bearer-token authentication.
7. Implement strict JSON parsing and response helpers.
8. Implement CORS/preflight handling required by a Firefox extension request using `Authorization` and `Content-Type`.
9. Implement canonical entry validation matching the extension's persisted 14-field contract.
10. Implement:
    - `GET /v1/health`
    - `GET /v1/change-token`
    - `GET /v1/snapshot`
    - `POST /v1/entries/append`
    - `POST /v1/entries/update`
    - `POST /v1/entries/delete`
    - `POST /v1/config/update`
11. Implement `remote_version` optimistic concurrency.
12. Increment global `change_seq` in the same transaction as every successful mutation.
13. Make append idempotent:
    - same ID + same canonical data -> success;
    - same ID + different canonical data -> 409 conflict.
14. Use prepared statements for every data value.
15. Use transactions for multi-entry mutations.
16. Validate all lengths/numeric ranges/timestamps/status/multiply values server-side rather than trusting the extension.
17. Return a stable machine-readable error code in every application error.
18. Ensure internal PDO/SQL errors are not leaked to clients.
19. Add deployment notes for:
    - creating DB tables;
    - creating/restricting DB user;
    - generating API token;
    - putting config outside web root;
    - enabling HTTPS;
    - testing endpoints.
20. Add a note that DB credentials never belong in Firefox.

### Server tests

Provide automated tests where the hosting/runtime permits them, plus deterministic integration instructions. Cover at least:

- health with valid token;
- 401 without token;
- malformed JSON;
- valid append;
- idempotent repeat append;
- conflicting append;
- snapshot round trip of every canonical field;
- update at expected version;
- stale update -> 409;
- delete at expected version;
- stale delete -> 409;
- config insert/update/stale update;
- `change_seq` increments only on successful mutations;
- multi-row mutation rolls back atomically on failure;
- SQL injection payload treated only as data;
- `NULL` DB timestamps round-trip as extension `""` values;
- token never appears in error/log output.

### Exit criteria

- A clean MySQL 8.4 database can be initialized from the SQL script.
- All endpoints work over HTTPS behind one stable base URL.
- API is independently testable.
- No extension change is required to keep Google working.
- No real secret exists in Git.

### Suggested commit

```text
feat: add MySQL remote storage API
```

---

## Session 3 — Add the MySQL extension provider and Storage settings UI

### Goal

Make the extension capable of talking to the Session 2 API and selecting MySQL as a provider in code, but do not yet allow an unsafe blind switch of existing production data. Add connection configuration/testing and provider-aware UI.

### Read first

In addition to Session 1 provider code, inspect:

```text
extension/manifest.json
extension/options/options.html
extension/options/options.js
extension/options/options.css
extension/src/platform.js
extension/src/diagnostics.js
extension/src/error-codes.js
extension/src/error-registry.js
extension/src/options-settings.js
PRIVACY.md
```

### Implementation steps

1. Add settings:
    - `MYSQL_API_BASE_URL`
    - `MYSQL_API_TOKEN`
    - provider-specific change-token state as designed in Session 1.
2. Add `extension/src/remote-mysql.js`.
3. Normalize API base URL:
    - HTTPS in production;
    - no embedded username/password;
    - strip unsafe fragments/query as appropriate;
    - deterministic trailing-slash handling.
4. Implement a timeout-capable API fetch helper.
5. Send bearer token only in `Authorization`.
6. Map API/network responses onto stable extension errors:
    - offline;
    - timeout/network;
    - auth required/expired;
    - permission;
    - 409 remote stale/conflict;
    - 429 rate limit;
    - schema/API incompatibility;
    - generic server failure.
7. Implement MySQL provider methods from Session 1:
    - ensure/test ready;
    - change token;
    - snapshot;
    - append;
    - update with expected version;
    - delete with expected version;
    - config update.
8. Decode all returned entries again through the extension's existing persisted-entry validator. Never trust the server merely because it is “ours”.
9. Convert API versions to opaque provider refs.
10. Add diagnostics that identify subsystem/provider and error code but redact URL credentials, token, payload contents, and DB details.
11. Add an Options **Storage** section.
12. Show active remote backend clearly.
13. Add MySQL fields:
    - HTTPS API base URL;
    - API token;
    - Test connection;
    - Save settings.
14. Do not switch an existing Google installation simply because the user selects `MySQL` in the form.
15. Keep target/draft provider selection separate from active `REMOTE_BACKEND` until Session 4 migration succeeds.
16. Make Google/Spreadsheet controls conditional and understandable under the new Storage model.
17. Preserve Google Account controls because Google remains a supported provider.
18. Add runtime host-permission flow for the actual HTTPS API origin.
19. Prefer an exact hosting origin in `optional_host_permissions` once it is known. Do not add a wildcard host permission casually.
20. Update privacy text for the new optional personal HTTPS storage API and token handling.

### Tests to add

Cover at least:

- base URL validation/normalization;
- no token -> local configuration error before request;
- Authorization header is correct;
- token never appears in thrown/logged error;
- API schema/version mismatch;
- snapshot decoding;
- opaque MySQL version refs;
- idempotent append response;
- stale update/delete mapping;
- 401/403/409/429/5xx mapping;
- timeout and offline mapping;
- change-token support;
- config sync;
- optional host permission granted/denied flows;
- Options rendering for Google vs MySQL;
- legacy users still see Google active;
- Google tests remain green.

### Manual smoke test

Against a test MySQL 8.4 deployment:

1. configure API URL/token;
2. grant exact host permission;
3. Test connection;
4. use a disposable profile/database;
5. activate MySQL only through a developer/test path if needed;
6. start/stop/edit/delete a disposable timer;
7. force sync;
8. inspect DB rows;
9. modify through a second test client/provider instance and confirm conflict/pull semantics.

Do not use real historical data yet; Session 4 implements verified migration.

### Exit criteria

- MySQL provider passes contract tests.
- Connection status is visible and useful.
- Google remains default and unaffected.
- No unsafe “flip backend” action exists for production data yet.
- Full validation passes.

### Suggested commit

```text
feat: add MySQL remote provider and storage settings
```

---

## Session 4 — Implement resumable migration and safe provider switching

### Goal

Add the user-visible operation that transfers the complete canonical dataset from the active provider to a target provider, verifies it, and only then switches the active backend.

The same engine should support **Google Sheets -> MySQL** and, where practical, **MySQL -> Google Sheets** so rollback is an ordinary migration rather than bespoke recovery code.

### Implementation steps

1. Add `extension/src/storage-migration.js`.
2. Add `SETTING_KEY.STORAGE_MIGRATION_STATE`.
3. Use a unique `migration_id` and persisted state machine.
4. Ensure only one migration runs at a time.
5. Coordinate with ordinary sync so a migration and background/manual sync cannot concurrently mutate the remote provider under different assumptions.
6. Validate target before touching it.
7. Force source sync first.
8. Refuse migration on unsafe source state:
    - quarantined rows;
    - unsupported schema;
    - unresolved reconciliation state that prevents defining one canonical result.
9. Build a canonical provider-neutral dataset:
    - every retained entry including tombstones;
    - canonical remote config;
    - deterministic sort;
    - deterministic digest/fingerprints.
10. Capture a source stability token/digest.
11. Read target before writing.
12. Permit:
    - empty target;
    - already-identical target;
    - partial data proven to belong to this resumable migration.
13. Block unexplained divergent target content instead of auto-merging it.
14. Seed target in deterministic idempotent batches.
15. Persist progress only after confirmed batch success.
16. Re-read the complete target after seeding.
17. Verify source and target canonical digests/config exactly.
18. Force a final source sync and check source stability.
19. If source changed, repeat copy/verify from the new source state rather than switching.
20. Bound stabilization retries. If data keeps changing, return an actionable “close other devices/stop editing temporarily” result.
21. Atomically update active provider only after verification.
22. Reset provider-specific remote read/change-token/backoff markers safely.
23. Clear or invalidate reconciliation intents tied to the old remote snapshot.
24. Run a forced sync against the new provider.
25. Mark migration complete only after that sync succeeds.
26. Keep old provider data and configuration untouched.
27. Add Options controls:
    - `Migrate data and switch to MySQL` when Google is active;
    - `Migrate data and switch to Google Sheets` when MySQL is active and Google is ready.
28. Show migration phases/progress without exposing sensitive record content.
29. On page reload/restart, detect incomplete migration and offer/resume safely.
30. Add explicit multiple-device warning before migration.

### Verification digest

Use one provider-neutral canonical serializer. At minimum include all 14 remote entry fields in stable field order and all shared config key/value/updated_at tuples sorted by key.

Do not include:

```text
dirty
last_sync_at
sync_error
provider row number
provider remote_version
change token
```

The digest exists to prove semantic equality, not physical storage equality.

### Tests to add

Migration tests are critical. Cover at least:

1. empty Google source -> empty MySQL target;
2. normal historical dataset -> MySQL;
3. config values transferred;
4. running timer transferred;
5. non-expired tombstones transferred;
6. partial target write + network failure + resume;
7. repeated migrate action is idempotent;
8. source changes during target write -> no premature switch;
9. local edit occurs during migration -> stabilization/retry includes it;
10. target already identical -> safe switch;
11. unrelated non-empty divergent target -> blocked;
12. stale target version -> retry/explicit failure, no switch;
13. authentication expires mid-migration -> state persists, source remains active;
14. extension/page restart during migration -> resume safely;
15. quarantined source record -> blocked;
16. unresolved reconciliation conflict -> blocked;
17. backend setting changes only after verification;
18. post-switch forced sync succeeds;
19. source remains unchanged after success;
20. reverse MySQL -> Google migration;
21. rollback after a MySQL connectivity problem by migrating back when source is available;
22. no secret is persisted inside migration state.

### Manual acceptance test with real historical data

Only after automated tests pass:

1. back up/export the current Google Sheet independently;
2. ensure MySQL target DB is empty/tested;
3. close the extension on other devices;
4. force Google sync and reconcile until clean;
5. run `Migrate data and switch to MySQL`;
6. verify UI reports entry/config counts and successful digest verification;
7. inspect sample entries in MySQL, including old records, multiplied records, deleted tombstones, and current-week records;
8. create a new timer on MySQL backend and confirm multi-device sync after other devices are switched;
9. keep the old Google Sheet unchanged as a rollback archive.

### Exit criteria

- No backend can become active before verified migration.
- Interrupted migration resumes safely.
- Historical data transfers without changing canonical values/revisions.
- Reverse migration works or is explicitly documented if a provider-specific limitation makes it impossible.
- Multiple-device split-brain risk is clearly communicated.
- Full validation passes.

### Suggested commit

```text
feat: add verified remote backend migration
```

---

## Session 5 — End-to-end hardening, security review, documentation, and release readiness

### Goal

Treat the feature as release code: validate both providers, migration, packaging, privacy, failure recovery, and real MySQL 8.4 interoperability.

### Implementation/review steps

1. Run the entire automated extension test suite.
2. Run browser runtime smoke tests.
3. Run lint.
4. Build the XPI and inspect the archive contents.
5. Ensure `server/`, SQL files, local config, `.env`, DB dumps, API token, and deployment files are **not** accidentally packaged into the extension unless intentionally required.
6. Run MySQL API automated/integration tests against an actual MySQL 8.4 instance.
7. Exercise Google Sheets regression flows with the same extension build.
8. Exercise both provider flows:
    - create;
    - stop;
    - edit;
    - delete/tombstone;
    - merge;
    - background sync;
    - manual forced sync;
    - remote pull;
    - config sync;
    - reconciliation;
    - deletion purge;
    - offline/backoff recovery.
9. Test two Firefox profiles/devices against one MySQL backend.
10. Test simultaneous edits to the same entry and confirm existing newest/revision/conflict behavior remains deterministic.
11. Test stale-version fencing under intentional races.
12. Test API request timeout, 401, 403, 409, 429, 500, 503, malformed JSON, and unavailable DB.
13. Verify no failure can silently mark an unsent entry clean.
14. Verify no failed migration can silently activate the target.
15. Verify change-token optimization never causes a necessary read to be skipped.
16. Review every diagnostic/log path for secrets and raw user time-entry content.
17. Review API logs/config for token and DB-password exposure.
18. Review CORS to ensure it is no broader than required.
19. Review SQL for prepared statements and transactional correctness.
20. Review DB user privileges for least privilege.
21. Update `README.md`:
    - local-first architecture;
    - remote backend selection;
    - Google setup;
    - MySQL API/server setup;
    - MySQL extension setup;
    - migration instructions;
    - multiple-device procedure;
    - rollback/reverse migration;
    - backup advice.
22. Update `PRIVACY.md`:
    - data sent to configured personal API;
    - API token storage;
    - MySQL credentials remain server-side;
    - optional host permission;
    - what diagnostics exclude.
23. Update manifest description only if appropriate.
24. Ensure AMO data-transmission declarations remain accurate for the new endpoint behavior.
25. Add a concise server upgrade procedure for future API/schema versions.
26. Add schema version checks so an incompatible future DB fails closed with an actionable error.
27. Document database backup/restore commands generically without embedding production credentials.
28. Add final manual release checklist.
29. Increment extension version only when the branch is release-ready, following the repository's existing release process.

### Final release acceptance matrix

| Scenario | Google Sheets | MySQL 8.4 |
|---|---:|---:|
| Fresh install | Pass | Pass after API config |
| Existing Google install upgrade | Pass with no action | N/A until selected |
| Start/stop/edit/delete offline | Pass locally | Pass locally |
| Background sync | Pass | Pass |
| Manual forced sync | Pass | Pass |
| Config sync | Pass | Pass |
| Reconciliation | Pass | Pass |
| Concurrent stale write protection | Pass | Pass |
| Tombstone purge | Pass | Pass |
| Provider change-token optimization | Pass | Pass |
| Google -> MySQL migration | Source | Verified target |
| MySQL -> Google migration | Verified target | Source |
| Interrupted migration recovery | Pass | Pass |
| Secret redaction | Pass | Pass |
| Two-device sync | Pass | Pass |

### Final commands

At minimum:

```bash
npm test
npm run test:browser
npm run lint
npm run build:xpi
```

Plus the server-side test/integration commands established in Session 2.

### Suggested commit

```text
docs: finalize MySQL backend release support
```

If Session 5 contains code hardening, use a code-oriented commit first and documentation/release metadata in a separate commit where practical.

---

# 10. Cross-session invariants to protect

Every Luna High session should explicitly check these before declaring success.

## Data integrity

- IDs never change during migration.
- `created_at` never changes merely because data moved providers.
- `updated_at` never changes merely because data moved providers.
- `revision` never increments merely because data moved providers.
- `duration_seconds` and `multiply` round-trip exactly.
- running entries remain running.
- retained deletion tombstones remain retained.
- no local-only sync bookkeeping crosses the provider boundary.

## Concurrency

- A stale remote snapshot cannot overwrite a newer remote value without the existing explicit reconciliation semantics.
- MySQL `remote_version` is a transport/concurrency field, not an entry revision replacement.
- Sync lease/coalescing remains effective across popup/calendar/background contexts.
- Migration and ordinary remote sync cannot run against inconsistent provider assumptions.

## Security

Never persist or expose:

```text
MySQL host password
MySQL user password
raw API bearer token in diagnostics
Authorization header
Google refresh/access token in migration state
raw database exception/stack trace to browser
```

## Backwards compatibility

- `REMOTE_BACKEND` missing => Google Sheets.
- Existing spreadsheet binding remains valid.
- Existing IndexedDB schema/data is not reset.
- No mandatory migration on extension upgrade.
- Google users who never configure MySQL should see no regression.

---

# 11. Decisions intentionally deferred

Do **not** expand these five sessions unless implementation reveals a hard requirement:

- direct MySQL protocol from the browser;
- simultaneous active multi-backend replication/dual-write;
- arbitrary SQL queries from the extension;
- multi-user accounts/roles in the API;
- public SaaS authentication;
- automatic cross-device backend-generation coordination;
- automated deletion of the previous backend after migration;
- changing the canonical 14-field entry model;
- replacing IndexedDB with MySQL;
- introducing a large frontend framework/build system solely for this feature.

---

# 12. One question to answer before Session 2

**Which server-side runtime does the hosting with MySQL 8.4 provide?**

The plan assumes **PHP 8.2+ with PDO MySQL**, because that is the most deployable choice on ordinary shared hosting. If the hosting provides Node.js or Python instead, keep the API contract and all extension/migration sessions unchanged and substitute that runtime only for the server implementation.

Also provide the eventual HTTPS API origin before Session 3 so the Firefox optional host permission can be scoped as narrowly as possible, for example:

```text
https://time-api.example.com/
```

---

# 13. Recommended implementation order summary

```text
Session 1
  Make current Google remote storage provider-neutral.
          |
          v
Session 2
  Build/test HTTPS API + MySQL 8.4 schema independently.
          |
          v
Session 3
  Add MySQL provider + connection/settings UI.
          |
          v
Session 4
  Add verified resumable provider-to-provider migration.
          |
          v
Session 5
  Integration, races, security, docs, privacy, release validation.
```

This order deliberately postpones real-data migration until both the provider abstraction and MySQL transport have isolated tests. That keeps the highest-risk operation—moving historical data—out of the architecture-refactor sessions and makes rollback straightforward.

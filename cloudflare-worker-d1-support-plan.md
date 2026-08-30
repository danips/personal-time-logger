# Personal Time Logger — User-Owned Cloudflare Worker + D1 Support Plan

**Target implementer:** GPT-5.6 Luna Medium

**Execution style:** complete one phase at a time; do not skip tests or acceptance checks

**Target result:** Cloudflare Worker + D1 is a third, independently configurable remote provider alongside Google Sheets and MySQL 8.4
**Plan date:** 2026-08-30

---

## 1. Feasibility and chosen product shape

This is doable without changing the local-first model.

The extension already routes remote storage through the provider contract in
`extension/src/remote-provider.js`. The new backend should therefore be:

```text
Firefox extension
    |
    | HTTPS + device-local Bearer token
    v
User-owned Cloudflare Worker
    |
    | D1 binding
    v
User-owned D1 database
```

Use these decisions unless the repository owner explicitly changes them:

1. Provider ID: `cloudflare-d1`.
2. Display name: `Cloudflare Worker + D1`.
3. Every user deploys an isolated Worker and D1 database in their own Cloudflare
   account. This is not a central multi-tenant service.
4. The Worker implements the existing Personal Time Logger `/v1` HTTPS API
   contract. Do not invent a second sync algorithm.
5. IndexedDB remains the local source of truth.
6. The extension stores the Worker URL and raw bearer token only in that Firefox
   profile. Never put the token in Firefox Sync, backups, diagnostics, URLs, or
   logs.
7. The Worker stores only the SHA-256 digest of the bearer token as a Cloudflare
   secret.
8. Version 1 supports the free `workers.dev` hostname. A one-click deployment
   button and arbitrary custom domains are follow-up work, not release blockers.
9. Users may start from local data, adopt an existing D1 dataset, or migrate to
   and from any other registered provider using the existing verified migration
   workflow.
10. Do not remove or weaken Google Sheets or MySQL support.

### Why the free plan is suitable

As of this plan date, Cloudflare documents the following relevant free limits:

- Workers: 100,000 requests per day and 10 ms CPU per invocation.
- D1: 5 million rows read per day and 100,000 rows written per day.
- D1 Free: 500 MB per database, 10 databases per account, and 50 D1 queries per
  Worker invocation.
- D1 `batch()` statements execute as a transaction and the whole batch rolls
  back when a statement fails.

These limits are ample for ordinary personal time tracking, but they are not a
service guarantee. Keep the provider's change-token gate, idle sync backoff, and
small mutation chunks. Do not claim that Cloudflare will always keep these exact
limits or that every workload is guaranteed to remain free.

Primary references:

- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 database API and transactional batch behavior](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 getting started](https://developers.cloudflare.com/d1/get-started/)

---

## 2. Scope

### Required for completion

- A deployable Worker and D1 schema under `server/cloudflare-d1/`.
- Bearer authentication, CORS, strict validation, stable JSON errors, request
  timeouts on the client, and no secret leakage.
- API-compatible health, change-token, snapshot, entry mutation, and config
  mutation routes.
- Atomic per-request D1 mutations with optimistic `remote_version` fencing.
- A `cloudflare-d1` extension provider with its own URL, token, remote refs, and
  change-token setting.
- First-run setup and normal Storage settings for Cloudflare D1.
- Verified migrations among Google Sheets, MySQL, and Cloudflare D1.
- Unit, contract, local D1 integration, migration, UI, and regression tests.
- End-user deployment, token rotation, backup, restore, update, and troubleshooting
  documentation.
- All repository maintenance gates passing.

### Explicitly out of scope for version 1

- A hosted/shared service operated by this repository owner.
- Cloudflare Access, OAuth, user accounts, billing, subscriptions, or team sharing.
- One Worker serving multiple unrelated users or tenants.
- A web administration UI.
- Automatic Worker deployment from inside the Firefox extension.
- A `Deploy to Cloudflare` button.
- D1 read replication.
- Delta/incremental snapshot endpoints.
- Custom domains. Keep the API URL abstraction compatible with them, but only
  request the narrow `https://*.workers.dev/*` optional permission in this release.

---

## 3. Repository rules and invariants

Preserve all of these throughout implementation:

1. Starting, stopping, editing, and deleting timers always commit to IndexedDB
   before remote sync.
2. `revision` is the entry's application revision. `remote_version` is only the
   remote compare-and-swap fence. Never merge the two concepts.
3. The canonical entry has exactly the 14 fields in `SHEET_HEADERS`.
4. `end_at`, `deleted_at`, and `multiply` are nullable in SQL and normalize to an
   empty string in the extension.
5. Same-ID/same-content append is idempotent. Same-ID/different-content append is
   `REMOTE_APPEND_CONFLICT`.
6. Update, delete, and existing-config mutation require a matching positive
   remote version.
7. A successful physical mutation bumps `app_meta.change_seq` once per HTTP
   request, not once per row. A normal idempotent/no-op request does not bump it.
8. A snapshot's entries, config, and change token come from one D1 transaction.
9. Failed multi-item mutations commit no entry/config changes and do not bump the
   token.
10. API responses and diagnostics never contain the bearer token, its digest,
    raw D1 errors, SQL, stack traces, or configured URL.
11. Reject unknown JSON keys, invalid types, duplicate IDs, oversized batches,
    unsafe timestamps, invalid multipliers, and unsupported routes.
12. Migration never changes the active provider until source and target digests
    match and the source is rechecked.
13. Provider-specific code stays out of generic sync and reconciliation modules.
14. Keep the extension as native JavaScript modules with no runtime framework.
15. Do not modify or delete unrelated work. In particular,
    `personal-time-logger-mysql-hardening-plan.md` already existed as an untracked
    user file when this plan was written.

---

## 4. Target file map

The final implementation should be close to this layout:

```text
server/cloudflare-d1/
  README.md
  package.json
  package-lock.json
  wrangler.example.jsonc
  migrations/
    0001_initial.sql
  src/
    index.js
    auth.js
    cors.js
    errors.js
    http.js
    repository.js
    validator.js
  test/
    unit.test.js
    integration.test.mjs
    support/
      local-worker.mjs

extension/src/
  remote-api-client.js        # extracted provider-neutral HTTPS contract code
  remote-cloudflare-d1.js     # new provider adapter
  remote-mysql.js             # retained, using shared client primitives
  remote-provider.js
  storage-migration.js
  setting-keys.js
  sync.js
  error-codes.js
  error-registry.js
  options-storage-ui.js

extension/options/
  options.html
  options.js
  options.css                 # only if existing styles are insufficient

test/
  remote-api-client.test.js
  remote-cloudflare-d1.test.js
  remote-provider.test.js
  storage-migration.test.js
  options-storage-ui.test.js
  provisioning.test.js        # extend only if it remains the best home
```

Names may vary slightly, but do not collapse the Worker server into the extension
adapter or duplicate the whole MySQL client.

---

## 5. Execution protocol for Luna Medium

For every phase below:

1. Read every named file before editing it.
2. Run the phase's baseline tests before making changes.
3. Make the smallest coherent patch.
4. Run the focused tests.
5. Run `git diff --check`.
6. Review `git diff -- <files changed in this phase>` for secrets, accidental
   unrelated edits, and stale provider-specific wording.
7. Check off the phase only after its acceptance checks pass.
8. If an API or browser behavior differs from an assumption, verify it in the
   official Cloudflare or Mozilla documentation and update this plan/README. Do
   not guess around security or transaction behavior.

Do not bump the extension version, create a release tag, deploy to a real account,
or commit on behalf of the user unless separately requested.

---

# Phase 0 — Baseline and contract freeze

## Goal

Record the working baseline and freeze the existing provider/API contract before
refactoring.

## Steps

- [ ] Run:

  ```bash
  git status --short
  npm test
  npm run test:browser
  npm run lint
  git diff --check
  ```

- [ ] Read completely:

  ```text
  docs/architecture.md
  extension/src/remote-provider.js
  extension/src/remote-mysql.js
  extension/src/remote-google-sheets.js
  extension/src/sync.js
  extension/src/storage-migration.js
  extension/src/setting-keys.js
  extension/src/error-codes.js
  extension/src/error-registry.js
  extension/options/options.html
  extension/options/options.js
  server/mysql-api/README.md
  server/mysql-api/src/Api.php
  server/mysql-api/src/Validator.php
  server/mysql-api/sql/001_initial_schema.sql
  test/remote-provider.test.js
  test/storage-migration.test.js
  test/reconciliation-provider-ui.test.js
  ```

- [ ] Add contract fixtures/tests before refactoring. The frozen contract is:

  ```text
  GET  /v1/health
  GET  /v1/change-token
  GET  /v1/snapshot
  POST /v1/entries/append
  POST /v1/entries/update
  POST /v1/entries/delete
  POST /v1/config/update
  ```

- [ ] Freeze the success and error JSON shapes currently consumed by
  `remote-mysql.js`.
- [ ] Freeze the provider interface required by `test/remote-provider.test.js`.
- [ ] Add a short API contract table to `docs/architecture.md` or a new
  `docs/remote-api-v1.md`. Make that document provider-neutral; MySQL and D1 both
  implement it.

## Acceptance checks

- [ ] Existing tests still pass before functional changes.
- [ ] There is one written provider-neutral API v1 contract.
- [ ] No production behavior changed in this phase.

---

# Phase 1 — Extract the provider-neutral HTTPS API client

## Goal

Reuse safe URL, permission, fetch, JSON, error, and snapshot parsing logic without
making D1 pretend to be MySQL.

## Steps

- [ ] Create `extension/src/remote-api-client.js` by extracting only genuinely
  shared pieces from `remote-mysql.js`:

  - HTTPS base-URL parsing and normalization;
  - exact optional-host permission calculation;
  - 30-second abort timeout;
  - online and fetch availability checks;
  - bearer header construction;
  - JSON parsing and top-level object validation;
  - HTTP status/server-code mapping;
  - canonical 14-field serialization;
  - nullable-field normalization;
  - snapshot parsing parameterized by remote-ref kinds;
  - positive remote-version parsing;
  - `/v1` route client methods.

- [ ] Keep provider wording out of the shared module. It should accept values such
  as:

  ```js
  {
    providerLabel,
    missingConfigCode,
    invalidConfigCode,
    entryRefKind,
    configRefKind,
    validateHealth
  }
  ```

- [ ] Never interpolate the URL or token into an error message.
- [ ] Keep the raw server `error.message` ignored. Map only recognized status and
  stable server error codes.
- [ ] Refactor `remote-mysql.js` to use the shared module while preserving:

  - `REMOTE_PROVIDER_ID.MYSQL === "mysql"`;
  - current settings;
  - current MySQL health validation;
  - current remote-ref shapes or an explicitly tested compatible replacement;
  - every existing test.

- [ ] Add `test/remote-api-client.test.js` for malformed JSON, non-object JSON,
  timeout, offline, missing permission, permission request, bearer-only auth,
  unsafe URL forms, server-code mapping, nullable fields, and secret-safe errors.

## Acceptance checks

- [ ] `npm test` passes.
- [ ] MySQL behavior is unchanged.
- [ ] `remote-api-client.js` contains no D1 or MySQL database logic.
- [ ] `remote-mysql.js` contains no copied generic fetch implementation.

---

# Phase 2 — Scaffold the Cloudflare Worker and D1 schema

## Goal

Create a self-contained, reproducible server package that a user can deploy with
Wrangler.

## Steps

- [ ] Create `server/cloudflare-d1/package.json` with Node 20+ and a pinned
  Wrangler development dependency. Commit its lockfile.
- [ ] Add scripts with unambiguous local/remote names, for example:

  ```json
  {
    "test": "node --test test/unit.test.js",
    "test:integration": "node test/integration.test.mjs",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "db:migrate:local": "wrangler d1 migrations apply DB --local",
    "db:migrate:remote": "wrangler d1 migrations apply DB --remote"
  }
  ```

  Adjust the exact Wrangler database argument only after validating it locally.

- [ ] Add `wrangler.example.jsonc`, not a real account-bound config. It must show:

  - a module Worker entry point;
  - a current compatibility date;
  - a D1 binding named `DB`;
  - a clearly marked database name and `database_id` placeholder;
  - migrations directory;
  - no token or token digest.

- [ ] Ignore the user's copied account-specific `wrangler.jsonc` only if it could
  contain account-specific values. Do not ignore the example.
- [ ] Create `migrations/0001_initial.sql` with:

  ```text
  time_entries
  config
  app_meta
  mutation_guard
  ```

- [ ] Use SQLite/D1 types and constraints deliberately:

  - IDs/text fields: `TEXT NOT NULL` with length checks matching the API validator;
  - optional `end_at`, `deleted_at`, `multiply`: nullable;
  - duration/revision/remote version/change sequence: non-negative or positive
    `INTEGER` checks as appropriate;
  - primary keys on entry ID, config key, and singleton app metadata ID;
  - `remote_version INTEGER NOT NULL DEFAULT 1 CHECK (remote_version >= 1)`;
  - exact indexes that current access patterns need (`start_at`, `updated_at`,
    `deleted_at`); do not add speculative indexes;
  - a singleton `app_meta` row with schema version 1 and initial change token 1;
  - `mutation_guard` must contain a `NOT NULL` constrained value. It exists only
    to make a failed compare-and-swap statement abort the surrounding D1 batch.

- [ ] Make migration 0001 safe for a fresh database. Do not silently rewrite an
  incompatible existing schema.
- [ ] Apply the migration locally twice and confirm Wrangler reports it as already
  applied rather than recreating data.

## Acceptance checks

- [ ] A fresh local D1 database can be created and migrated from documented
  commands.
- [ ] No real Cloudflare account ID, database ID, URL, token, or digest is tracked.
- [ ] `app_meta` has exactly one initialized row.
- [ ] The schema can represent every canonical extension field without lossy
  conversions.

---

# Phase 3 — Implement the Worker API securely

## Goal

Implement API v1 on D1 with strict boundaries and the same externally observable
correctness guarantees as the MySQL API.

## 3.1 Routing and HTTP boundary

- [ ] In `src/index.js`, parse with `new URL(request.url)` and dispatch on exact
  method/path pairs only.
- [ ] Return JSON with `Content-Type: application/json; charset=utf-8` and
  `Cache-Control: no-store`.
- [ ] Return a stable JSON 404 for unknown paths and 405 for known paths with the
  wrong method.
- [ ] Limit mutation request bodies to a small documented byte size, for example
  512 KiB, before JSON parsing.
- [ ] Require JSON content type for POST routes.
- [ ] Reject malformed JSON, arrays at the top level, and unknown keys.
- [ ] Set a uniform error shape:

  ```json
  {
    "error": {
      "code": "REMOTE_VERSION_STALE",
      "message": "The remote record changed before the operation completed."
    }
  }
  ```

- [ ] The public message must be owned by the Worker, not copied from D1 errors.

## 3.2 Authentication

- [ ] Require `Authorization: Bearer <token>` on every `/v1` GET and POST route.
  OPTIONS is the only exception.
- [ ] Read `env.PTL_API_TOKEN_SHA256`; never accept the digest in a normal variable
  committed to Wrangler config.
- [ ] Hash the supplied raw token with Web Crypto SHA-256 and compare decoded bytes
  using a constant-work loop. Reject malformed configured digests.
- [ ] Use one generic 401 response for a missing, malformed, or incorrect token.
- [ ] Never log the Authorization header, raw token, digest, or request body.

## 3.3 CORS for Firefox extension origins

- [ ] Accept `Origin` only when it is a syntactically valid `moz-extension://`
  origin with no credentials, path, query, or fragment.
- [ ] Echo the validated origin in `Access-Control-Allow-Origin`; never use `*`.
- [ ] Add `Vary: Origin`.
- [ ] Handle OPTIONS without bearer auth but only for a valid extension origin,
  requested method, and requested headers.
- [ ] Allow only `GET`, `POST`, `OPTIONS`, `Authorization`, and `Content-Type`.
- [ ] Permit requests with no Origin for CLI health checks, but bearer auth still
  applies. Do not emit a wildcard CORS header for them.
- [ ] Reject ordinary web origins with `403 ORIGIN_NOT_ALLOWED`.

## 3.4 Validation

- [ ] Port the behavior—not PHP syntax—of `server/mysql-api/src/Validator.php`.
- [ ] Validate all 14 canonical fields and reject local-only fields such as
  `dirty`, `last_sync_at`, and `sync_error`.
- [ ] Keep timestamp normalization and supported status/multiplier rules aligned
  with `extension/src/entries.js`.
- [ ] Reject duplicate IDs within one request.
- [ ] Set one uniform server batch maximum of 15 entries. This keeps guard,
  mutation, metadata, and result statements comfortably below the D1 Free limit
  of 50 queries per Worker invocation.
- [ ] Validate `expectedVersion` as a positive safe integer.
- [ ] Do not coerce arbitrary strings/numbers into valid values unless the existing
  API contract explicitly does so.

## 3.5 Health, token, and snapshot reads

- [ ] Return health shaped as:

  ```json
  {
    "ok": true,
    "service": "personal-time-logger",
    "apiVersion": 1,
    "schemaVersion": 1,
    "storage": "cloudflare-d1"
  }
  ```

- [ ] `/v1/change-token` returns `changeToken` as a decimal string.
- [ ] `/v1/snapshot` uses one `env.DB.batch()` containing the entries query, config
  query, and metadata query. Do not issue three independent D1 calls.
- [ ] Sort entries and config by primary key for deterministic tests/digests.
- [ ] Return each entry/config record with its positive `version`.
- [ ] Return nullable optional values as JSON `null`; the extension adapter owns
  empty-string normalization.

## 3.6 Atomic mutation pattern

Cloudflare documents `DB.batch()` as transactional and rollback-on-failure. Use
that primitive for each mutation request.

- [ ] Before building a mutation batch, do a provider-owned preflight read that
  produces precise domain errors for already-stale input.
- [ ] Still put a guard statement inside the mutation batch. The preflight alone
  is not a compare-and-swap because another device can write between calls.
- [ ] A guard should deliberately violate `mutation_guard.value NOT NULL` when its
  expected row/version/canonical-content predicate is false. A matching predicate
  inserts zero rows and succeeds. Example concept, with bound values only:

  ```sql
  INSERT INTO mutation_guard(value)
  SELECT NULL
  WHERE NOT EXISTS (
    SELECT 1 FROM time_entries WHERE id = ? AND remote_version = ?
  );
  ```

- [ ] Never interpolate entry data into SQL. Use prepared statements and `.bind()`.
- [ ] Sort mutation items by ID before building statements. Restore caller order
  in responses where required.
- [ ] Append behavior:

  1. Preflight each requested ID.
  2. Existing identical rows are idempotent.
  3. Existing different rows return `409 REMOTE_APPEND_CONFLICT`.
  4. Use conflict-safe inserts for missing rows.
  5. In the same D1 batch, guard that every resulting row is canonically identical
     to the request. This closes the preflight race.
  6. Bump `change_seq` once if the normal preflight found at least one missing row.
  7. Select all resulting ID/version pairs in one final statement and restore
     request order.
  8. A rare concurrent identical append may cause an unnecessary token bump; that
     is safe because the token is an invalidation marker. It must never cause a
     missed bump or data loss.

- [ ] Update behavior:

  1. Preflight that every row exists and matches `expectedVersion`.
  2. Put an in-batch existence/version guard immediately before each update.
  3. Update all canonical fields and increment `remote_version` by exactly one.
  4. Bump `change_seq` once after all updates.

- [ ] Delete behavior:

  1. Preflight that every row exists and matches `expectedVersion`.
  2. Guard every row/version inside the batch.
  3. Delete every row.
  4. Bump `change_seq` once.

- [ ] Config behavior:

  1. Missing key without `expectedVersion` inserts at version 1.
  2. Existing key requires the matching `expectedVersion`.
  3. Identical value/timestamp with matching version is a no-op and does not bump.
  4. Changed config increments its remote version and bumps `change_seq` once.
  5. An in-batch guard closes every preflight race.

- [ ] Catch an expected guard constraint failure and return the stable conflict
  code appropriate to the operation. Unexpected D1 failures return a sanitized
  `500 API_ERROR`.
- [ ] Do not implement manual `BEGIN`/`COMMIT` calls around separate D1 requests.

## Acceptance checks

- [ ] Every route works against local D1.
- [ ] Snapshot reads are transactionally consistent.
- [ ] A stale item in a multi-item mutation rolls back all items and the token.
- [ ] Successful physical requests bump the token once.
- [ ] Normal idempotent/no-op requests do not bump it.
- [ ] Concurrent same-version updates cannot both succeed.
- [ ] No test response or captured log contains a test token/digest/raw SQL error.

---

# Phase 4 — Test the Worker before connecting the extension

## Goal

Prove the server contract and D1 semantics independently of Firefox.

## Steps

- [ ] Unit-test pure auth, CORS, route, HTTP, and validator functions with Node's
  built-in test runner.
- [ ] Build a deterministic local-D1 integration harness. It must:

  - use a temporary local persistence directory;
  - apply the real migration;
  - start the real Worker locally;
  - wait for readiness without a fixed long sleep;
  - choose an unused local port;
  - capture output while redacting secrets;
  - stop the Worker in `finally`, including after a failed assertion;
  - never touch a remote Cloudflare account.

- [ ] Cover at least:

  ```text
  health compatibility
  missing/wrong bearer token
  valid and invalid Origin handling
  OPTIONS preflight
  empty snapshot
  append one and append batch
  append idempotency and conflict
  update success and stale conflict
  delete success and stale conflict
  config insert/update/no-op/conflict
  one change-token bump per request
  rollback of mixed valid/stale batches
  nullable field round trip
  special Unicode and long-but-valid text
  malformed/oversized JSON
  unknown fields
  duplicate IDs
  batch size 15 accepted and 16 rejected
  unknown route and wrong method
  two concurrent writes using the same expected version
  consistent snapshot during a competing write
  ```

- [ ] Add a root command such as `npm run test:cloudflare` that runs both Worker
  unit and integration tests. Do not silently include a test that requires a real
  login in `npm test`.

## Acceptance checks

- [ ] Worker tests pass from a clean checkout after the documented install step.
- [ ] Tests do not require network access after dependencies are installed.
- [ ] Tests do not use a developer's real D1 database.
- [ ] A deliberately broken guard/transaction test fails for the expected reason.

---

# Phase 5 — Add the Cloudflare D1 extension provider

## Goal

Connect the proven Worker API to the existing provider boundary.

## Steps

- [ ] Add setting keys:

  ```text
  CLOUDFLARE_D1_API_BASE_URL
  CLOUDFLARE_D1_API_TOKEN
  CLOUDFLARE_D1_REMOTE_CHANGE_TOKEN
  ```

- [ ] Add stable error codes for missing/invalid D1 configuration if the shared
  generic codes cannot express the correct recovery text. Do not reuse
  `MYSQL_CONFIG_*` for D1.
- [ ] Make generic API errors/provider recovery messages provider-neutral where
  they currently say only Google or MySQL, especially `API_TIMEOUT`,
  `API_NETWORK`, `API_ERROR`, `RATE_LIMIT`, `OFFLINE`, `BACKOFF`,
  `REMOTE_AUTH_REQUIRED`, and `REMOTE_ORIGIN_NOT_ALLOWED`.
- [ ] Create `extension/src/remote-cloudflare-d1.js` using the shared API client.
- [ ] Normalize production URLs to HTTPS, without credentials, query, or fragment.
- [ ] For version 1, validate that the host is `workers.dev` or a subdomain of it.
  Keep URL parsing factored so custom domains can be enabled later.
- [ ] Request only the exact configured origin at runtime, derived from the base
  URL, even though the manifest declares the containing workers.dev wildcard.
- [ ] Validate D1 health's `service`, API/schema versions, and
  `storage === "cloudflare-d1"`.
- [ ] Use opaque refs distinct from MySQL:

  ```js
  { kind: "cloudflare-d1-row", version: 1 }
  { kind: "cloudflare-d1-config-row", version: 1 }
  ```

- [ ] Implement the full provider contract:

  ```text
  ensureReady
  testConnection
  getChangeToken
  readSnapshot
  appendEntries
  updateEntries
  deleteEntries
  updateConfig
  ensureAppMarker
  ```

- [ ] Set `duplicateRemoteRecords: false`.
- [ ] Chunk append/update/delete requests internally at 15 records. Preserve input
  order for returned append refs.
- [ ] Treat a later-chunk failure explicitly. Do not report that the full operation
  succeeded. Earlier successful chunks are safe to retry because append is
  idempotent and sync rereads remote versions.
- [ ] Add focused recovery tests proving that after a chunk 2 failure:

  - no local record is falsely acknowledged;
  - the next forced sync rereads the remote snapshot;
  - already-appended records are accepted idempotently;
  - already-updated canonical matches are reconciled rather than overwritten;
  - remaining dirty entries eventually complete.

- [ ] Register in `remote-provider.js`:

  ```js
  REMOTE_PROVIDER_ID.CLOUDFLARE_D1 = "cloudflare-d1"
  ```

- [ ] Update registered-provider and contract tests to expect all three providers.
- [ ] Add `https://*.workers.dev/*` to `optional_host_permissions` in the manifest.
  Do not add `<all_urls>` or a broad `https://*/*` permission.
- [ ] Ensure the release allow-list and runtime smoke test include the new source
  module automatically or update their explicit lists.

## Acceptance checks

- [ ] All three providers satisfy the same generic contract test.
- [ ] The D1 token is sent only in the Authorization header.
- [ ] The D1 adapter accepts nullable SQL fields and returns canonical extension
  entries.
- [ ] Unknown/incompatible health responses do not switch providers.
- [ ] Permission denial is distinguishable from Worker CORS rejection.
- [ ] Multi-chunk retry tests pass.

---

# Phase 6 — Generalize provider tokens and storage migration

## Goal

Remove two-provider/MySQL-only assumptions so every migration direction is safe.

## Steps

- [ ] Replace the hard-coded change-token choice in `sync.js` with one audited
  function or provider property:

  ```text
  google-sheets  -> REMOTE_CHANGE_TOKEN (legacy compatibility)
  mysql          -> MYSQL_REMOTE_CHANGE_TOKEN
  cloudflare-d1  -> CLOUDFLARE_D1_REMOTE_CHANGE_TOKEN
  ```

- [ ] Clear all provider token keys during backend switch, full reseed, explicit
  reset, and relevant test setup. Never let one backend consume another backend's
  token.
- [ ] Change `storage-migration.js` provider validation to use registered provider
  IDs rather than a literal Google/MySQL array.
- [ ] Replace MySQL-specific internal names/messages with provider-neutral ones:

  ```text
  assertLocalCompatibleWithRemote
  activateProviderFromLocal(targetProviderId)
  activateProviderFromRemote(targetProviderId)
  ```

- [ ] Thin MySQL wrapper exports may remain temporarily if that makes the refactor
  safer, but new UI code should call provider-neutral functions.
- [ ] Use `provider.label` in progress and errors instead of ternaries such as
  `target === MYSQL ? "MySQL 8.4" : "Google Sheets"`.
- [ ] Keep migration state resumable with any valid source/target ID.
- [ ] Keep `MIGRATION_BATCH_SIZE` provider-neutral. Providers may internally
  chunk to a smaller transport maximum; do not lower Google/MySQL performance
  merely because D1 has a smaller invocation limit.
- [ ] Ensure direct-from-local setup and adopt-existing-remote setup work for both
  MySQL and D1.
- [ ] Replace MySQL-specific error text inside migration digest/verification paths.
- [ ] Add table-driven tests for every different-provider direction:

  ```text
  Google -> MySQL
  Google -> D1
  MySQL  -> Google
  MySQL  -> D1
  D1     -> Google
  D1     -> MySQL
  ```

- [ ] For each direct setup mode, test empty local data, non-empty local data,
  compatible existing remote data, unrelated target records, invalid target
  records, local change during verification, and resume after `post_switch`.

## Acceptance checks

- [ ] No provider switch occurs before digest verification.
- [ ] Source data is never deleted.
- [ ] All six migration directions are covered and pass.
- [ ] Existing MySQL first-run and migration tests still pass.
- [ ] Generic sync/reconcile modules do not import D1/MySQL/Sheets transport
  implementations directly.

---

# Phase 7 — Add first-run and Storage UI

## Goal

Let a nontechnical extension user enter the two values produced by the deployment
guide and safely activate D1.

## Steps

- [ ] Add `Cloudflare Worker + D1` to the first-run provider choices.
- [ ] Add it to the Storage preparation target select.
- [ ] Add a D1 settings panel with:

  ```text
  Worker URL        type=url
  API token         type=password, autocomplete=off, spellcheck=false
  Test connection
  Save D1 settings
  Use D1 directly
  Use existing D1 data
  ```

- [ ] State next to the token field that it stays only in this browser profile.
- [ ] Link to `server/cloudflare-d1/README.md` only in repository documentation;
  the shipped extension UI should link to a stable hosted setup guide if one
  exists. Do not place a local filesystem path in the extension UI.
- [ ] Follow the existing safe host-permission flow:

  1. normalize URL;
  2. request the exact Worker origin from a direct user click;
  3. time out a browser permission request that never resolves;
  4. call health without allowing the provider to trigger a second prompt;
  5. save only after validation succeeds, or clearly distinguish Save from Test.

- [ ] Test connection status should show service/API/schema/storage only. Never
  echo the URL, token, database ID, Cloudflare account ID, or raw response.
- [ ] Replace MySQL-only rendering functions with provider-aware rendering. Avoid
  adding a third chain of scattered ternaries.
- [ ] Make `renderActiveBackendLabel` call the registered provider label.
- [ ] `storageUiState` must still show Google account/spreadsheet panels only when
  Google is active or the selected migration target.
- [ ] MySQL fields are visible only when MySQL is selected; D1 fields only when D1
  is selected.
- [ ] Migration button text and progress use the target provider label.
- [ ] Extend backup behavior:

  - include the D1 base URL only if non-secret provider URLs are intentionally
    backed up today;
  - never include the D1 API token;
  - importing a backup must never silently switch the active backend or claim it
    is established without a verified connection/migration.

- [ ] Add tests for the full active-provider × selected-target visibility matrix.
- [ ] Add DOM/static tests for first-run controls, Storage controls, password input,
  event bindings, and manifest permission.
- [ ] Update accessibility labels, status live regions, keyboard behavior, and
  responsive layout using existing Options patterns.

## Acceptance checks

- [ ] A new profile can choose D1 without touching Google or MySQL.
- [ ] A current Google/MySQL profile can prepare D1 without changing active sync.
- [ ] Merely selecting D1 never switches the active provider.
- [ ] Canceling host permission changes no settings/backend state.
- [ ] Test failure changes no active backend.
- [ ] Tokens do not appear in backup export tests or diagnostics.

---

# Phase 8 — Deployment and operations documentation

## Goal

Make self-hosting achievable by following one linear README without hidden
Cloudflare knowledge.

## Steps

- [ ] Write `server/cloudflare-d1/README.md` for a user starting with only a free
  Cloudflare account and Node 20+.
- [ ] Verify every command against the pinned Wrangler version.
- [ ] Document this exact flow, adjusting flags only when verified:

  1. Install dependencies with `npm ci` inside `server/cloudflare-d1`.
  2. Authenticate with `npx wrangler login`.
  3. Create a D1 database, for example
     `npx wrangler d1 create personal-time-logger`.
  4. Copy `wrangler.example.jsonc` to the local config and paste only the returned
     database ID in the marked location.
  5. Apply migrations with the explicitly remote migration command.
  6. Generate a 32-byte random bearer token locally.
  7. Compute its SHA-256 hex digest locally.
  8. Store only the digest with
     `npx wrangler secret put PTL_API_TOKEN_SHA256`.
  9. Keep the raw token in a password manager; it cannot be recovered from the
     Worker.
  10. Deploy with `npm run deploy`.
  11. Copy the resulting HTTPS `workers.dev` URL.
  12. Test `/v1/health` with curl and the raw bearer token.
  13. Enter the URL/raw token in extension Options, click Test connection, then
      choose local seeding or existing D1 adoption.

- [ ] Commands that handle the raw token must avoid shell history where practical.
  Offer a safe interactive method and warn users not to paste secrets into issue
  reports or screenshots.
- [ ] Explain the difference between:

  - local Wrangler D1 data;
  - the remote production D1 database;
  - the raw extension token;
  - the Worker secret containing only its digest;
  - the database ID, which is configuration but not the bearer credential.

- [ ] Add upgrade instructions:

  1. back up/export D1;
  2. pull the new code;
  3. `npm ci`;
  4. inspect/list pending migrations;
  5. apply migrations remotely;
  6. deploy Worker;
  7. test health and sync.

- [ ] Add token rotation instructions. A safe rotation is:

  1. stop editing timers briefly;
  2. generate a new raw token/digest;
  3. update the Worker secret and deploy if Wrangler requires it;
  4. update/test every device promptly;
  5. expect devices with the old token to receive 401 until updated.

  Do not promise zero-downtime rotation unless the implementation deliberately
  supports two digests.

- [ ] Add backup/restore instructions using official Wrangler D1 export/import or
  Time Travel commands verified for the pinned version. Clearly warn that restore
  replaces remote state and must not be run casually while devices are syncing.
- [ ] Document the free limits with a link and “subject to change” wording.
- [ ] Add troubleshooting for:

  ```text
  401 invalid token
  403 origin rejected
  Firefox host permission denied
  404 wrong Worker URL/deployment
  incompatible API/schema health
  D1 migration not applied
  free limit exhausted until 00:00 UTC
  Worker CPU/query limit
  unrelated existing target data
  lost raw token
  local Wrangler database mistaken for production
  ```

- [ ] Update root `README.md`, `docs/architecture.md`, `PRIVACY.md`, and release
  notes/documentation as appropriate:

  - list three remote providers;
  - explain user-owned Worker/D1 data flow;
  - state what leaves the browser for D1 sync;
  - state where URL/token are stored;
  - state that Cloudflare receives requests/data when this provider is chosen;
  - update first-run/migration descriptions;
  - avoid claiming Google/MySQL are required.

## Acceptance checks

- [ ] A second person can deploy from the README without repository-owner help.
- [ ] No instruction can accidentally apply a local migration when it says remote,
  or vice versa.
- [ ] No tracked example contains a usable credential.
- [ ] Privacy wording covers Cloudflare D1 accurately.

---

# Phase 9 — Full regression, security review, and release readiness

## Goal

Prove the combined extension/server change is safe to hand off.

## Steps

- [ ] Run the full gates:

  ```bash
  npm test
  npm run test:cloudflare
  npm run test:browser
  npm run lint
  npm run build:xpi
  git diff --check
  git status --short
  ```

- [ ] Run the MySQL API test suite too:

  ```bash
  bash server/mysql-api/tests/run.sh
  ```

- [ ] Inspect the built XPI/source manifest and confirm:

  - new D1 extension modules are packaged;
  - Worker source, Wrangler config, migrations, tests, and README are not packaged
    in the extension;
  - no token, digest, database ID, account ID, or developer URL is packaged;
  - the only new host declaration is the optional workers.dev wildcard.

- [ ] Search tracked changes for common secret patterns and the exact synthetic
  test tokens. Do not print environment secrets while searching.
- [ ] Manually test in a fresh Firefox profile against a disposable Cloudflare
  account/database:

  ```text
  first-run D1 from empty local
  first-run D1 seeded from local entries
  adopt existing D1 on a second Firefox profile
  start/stop/edit/delete sync
  config multiplier sync
  two-device conflicting edit and reconcile
  expired tombstone cleanup
  forced offline and recovery
  denied/revoked host permission
  wrong/rotated token
  Google -> D1 -> Google verified migration
  MySQL -> D1 -> MySQL verified migration
  browser restart and background sync
  ```

- [ ] During manual tests, inspect Worker logs only with synthetic entries and
  confirm normal code does not log bodies/auth headers.
- [ ] Review all user-visible strings for stale “Google only” or “MySQL only”
  language.
- [ ] Review every provider switch/reset path for D1 token-key clearing.
- [ ] Review all error paths for active-provider preservation.

## Final acceptance criteria

The work is complete only when all statements below are true:

- [ ] Cloudflare D1 is a registered third provider, not an alias for MySQL.
- [ ] A user can deploy the Worker and D1 on a free Cloudflare account from the
  documented CLI steps.
- [ ] The Worker passes independent local D1 integration tests.
- [ ] Authentication and CORS reject unauthorized callers without leaking secrets.
- [ ] Snapshots are consistent and mutation requests are atomic.
- [ ] Optimistic version races return stable conflicts and never partially commit
  an HTTP batch.
- [ ] Adapter chunking respects the D1 Free query ceiling and recovers safely after
  partial multi-request progress.
- [ ] New and existing users can configure D1 without changing active storage until
  setup/migration verification succeeds.
- [ ] All six cross-provider migration directions work.
- [ ] Google Sheets and MySQL regression tests still pass.
- [ ] Backups and diagnostics exclude every API token.
- [ ] The XPI contains no server/deployment files or secrets.
- [ ] All automated gates pass and the manual matrix has been recorded.

---

## 6. Stop conditions and escalation rules

Stop and ask the repository owner before proceeding if any of these occurs:

1. Supporting arbitrary custom Worker domains would require a broad optional host
   permission such as `https://*/*`.
2. Current D1 behavior no longer guarantees rollback for `DB.batch()`.
3. The guard constraint technique cannot be proven by a local integration test.
4. The existing generic sync cannot safely recover from a successfully committed
   earlier D1 chunk followed by a later chunk failure.
5. AMO policy requires materially broader disclosure or permission changes than
   the narrow workers.dev permission and existing data-transmission declaration.
6. A required migration direction would overwrite unrelated target records.
7. Completing the work would require deploying to, billing, or deleting resources
   in a real Cloudflare account without explicit authorization.

When stopped, report the exact failing test, relevant official documentation,
the smallest safe options, and the recommended choice. Do not weaken an invariant
just to finish the checklist.

---

## 7. Optional follow-ups after version 1

Do not mix these into the initial implementation unless requested:

- A reviewed `Deploy to Cloudflare` button/template.
- Custom-domain support with an explicit permission/product decision.
- Two-digest overlap for zero-downtime token rotation.
- Incremental change feed to reduce full-snapshot D1 rows read.
- Per-device tokens and revocation records.
- Automated encrypted scheduled exports.
- A schema-version migration beyond v1.
- Usage telemetry shown locally from D1 result metadata, with no central reporting.

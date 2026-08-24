# Personal Time Logger — MySQL 8.4 Completion Report

Date: 2026-08-24

> **Historical release report:** This records the MySQL backend rollout in
> `v0.1.52`. The follow-up provider-aware Settings and Reconciliation cleanup
> shipped in `v0.1.53`; see [`RELEASE_NOTES.md`](RELEASE_NOTES.md) and the
> provider-aware plan for that later release.

## Outcome

The MySQL 8.4 remote-storage backend was implemented, deployed, tested, migrated, and activated successfully.

The active device now uses:

- MySQL 8.4
- PHP 8.5 API runtime
- PDO MySQL
- HTTPS API: `https://time-api.cordoceo.com`
- API/schema version: 1/1

The Google Sheets data was migrated successfully. The MySQL database contains 215 entries, 1 shared configuration row, and schema version 1. The old Google Spreadsheet remains untouched as a backup.

## Implemented plan sections

### Provider-neutral remote storage

- Added stable provider IDs for Google Sheets and MySQL.
- Refactored synchronization and reconciliation behind provider adapters.
- Preserved Google Sheets as the default for legacy installations.
- Preserved opaque provider references and optimistic concurrency behavior.

### MySQL API

- Added `server/mysql-api/` with PHP API sources, SQL schema, deployment README, authentication, validation, CORS handling, and prepared SQL statements.
- Added authenticated endpoints for health, change tokens, snapshots, entry append/update/delete, and shared configuration updates.
- Added server-side `remote_version` fencing and idempotent append behavior.
- Added MySQL 8.4 schema tables: `time_entries`, `config`, and `app_meta`.

### Firefox MySQL provider and UI

- Added MySQL API URL/token settings.
- Added exact optional host-permission flow.
- Added API version/schema compatibility checks.
- Added API error mapping, timeout handling, offline handling, and token redaction.
- Added Storage UI showing the active backend and migration state.

### Verified migration

- Added resumable, provider-neutral migration state.
- Migration verifies canonical entries and shared configuration before switching.
- Migration preserves the source backend until verification succeeds.
- Migration supports reverse migration in the provider-neutral design.
- Migration blocks unsafe or invalid target data instead of silently merging it.
- Migration completed successfully from Google Sheets to MySQL.

## Important compatibility fix

The deployed API returned nullable JSON values for optional entry fields such as `deleted_at`, while the extension model uses empty strings. The MySQL provider now normalizes `null` values for `end_at`, `deleted_at`, and `multiply` before validation. This fixed the misleading error:

```text
MIGRATION_TARGET_CONFLICT: The target has invalid or duplicate records...
```

The records were valid; they were being rejected because of the API null representation.

## Validation

All of the following passed:

- 65 automated test files
- JavaScript lint
- Firefox browser runtime smoke test
- Firefox extension lint with zero errors
- XPI build
- PHP syntax/API validation
- `git diff --check`
- Real API health check against PHP 8.5/MySQL 8.4
- Real Google Sheets → MySQL migration

Firefox extension release artifact:

```text
personal-time-logger-0.1.52.xpi

The current release is `0.1.53` (`v0.1.53`). Its XPI adds provider-aware
Settings visibility, active-provider reconciliation labels, capability-gated
Google duplicate-row repair, and the corresponding regression coverage without
changing MySQL synchronization or migration semantics.
```

## Release and Git state

- Release commit: `28f75a2 fix: normalize nullable MySQL entry fields`
- Release tag: `v0.1.52`
- `main` was pushed to GitHub.
- The original rollout plan was an untracked handoff document at the time of
  this report; it is now retained in the repository as an archived plan.

Earlier implementation commits include the provider abstraction, API, MySQL provider, migration engine, authorization fixes, local-field filtering, and migration diagnostics.

## Remaining operational work

Each other device has its own local active-backend setting. Other devices must be migrated individually:

1. Install version 0.1.52 or upgrade to the current `0.1.53` release.
2. Stop timers and let the current Google Sheets sync finish.
3. Configure the same MySQL API URL and token.
4. Test the connection.
5. Migrate that device to MySQL.
6. Confirm MySQL is active before resuming normal use.

Devices must not continue writing to Google Sheets after the cutover, or the data will split between two backends. If an older device has Google-only unsynchronized data, preserve it and resolve the difference before forcing a switch.

## Security follow-up

Bearer tokens were included in several HAR files shared during troubleshooting. The affected API token should be revoked/rotated, and the new token should be entered on every device. HAR files containing `Authorization` headers should not be shared again.

## Handoff conclusion

The five-session implementation objective is operationally complete. The remaining work is per-device rollout, token rotation, and optional future work for automated multi-device backend coordination.

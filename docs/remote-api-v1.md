# Personal Time Logger remote API v1

The remote providers implement the same small HTTPS contract. The extension
uses `Authorization: Bearer <token>` for every request and does not put the
token in URLs, request bodies, backups, diagnostics, or logs.

| Method | Path | Success response |
| --- | --- | --- |
| GET | `/v1/health` | `{ ok, service, apiVersion, schemaVersion, storage? }` |
| GET | `/v1/change-token` | `{ changeToken: string }` |
| GET | `/v1/snapshot` | `{ changeToken, entries: [{ entry, version }], config: [{ key, value, updated_at, version }] }` |
| POST | `/v1/entries/append` | `{ entries: [{ id, version }] }` |
| POST | `/v1/entries/update` | `{ entries: [{ id, version }] }` |
| POST | `/v1/entries/delete` | `{ deleted: [string] }` |
| POST | `/v1/config/update` | `{ key, version }` |

An entry is the canonical fourteen-field model defined by `SHEET_HEADERS`:
`id`, `project`, `task`, `description`, `start_at`, `end_at`,
`duration_seconds`, `status`, `created_at`, `updated_at`, `deleted_at`,
`device_id`, `revision`, and `multiply`. SQL-backed providers may return
`null` for `end_at`, `deleted_at`, and `multiply`; the extension normalizes
those values to empty strings.

Every error has this shape and a stable `error.code`:

```json
{"error":{"code":"REMOTE_VERSION_STALE","message":"The remote record changed before the operation completed."}}
```

Clients use only the status and code for recovery. Server implementation
messages, SQL errors, stack traces, URLs, tokens, and token digests are never
displayed or persisted.

Append is idempotent for the same ID and canonical content and conflicts for a
same ID with different content. Update, delete, and existing-config changes
require a positive `expectedVersion`; a successful physical mutation advances
that record's version. A mutation request is atomic, and its change token is
advanced at most once. An ordinary idempotent or no-op request does not advance
the token.

Google Sheets uses row/fingerprint references, while MySQL and Cloudflare D1
use opaque version references. Provider-specific transport details remain
behind the provider interface in `extension/src/remote-provider.js`.

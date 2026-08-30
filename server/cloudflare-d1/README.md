# Personal Time Logger Cloudflare Worker + D1 backend

This directory contains the optional API backend for the extension. It is
designed for one user's isolated Cloudflare Worker and D1 database. The Worker
does not contain a project-owned account, telemetry, or shared application
database.

## Requirements and local setup

Use Node.js 20 or newer. From this directory:

```bash
npm ci
cp wrangler.example.jsonc wrangler.jsonc
```

Edit the ignored `wrangler.jsonc` and replace the placeholder D1 `database_id`
after creating the database. Do not commit that file.

```bash
npx wrangler login
npx wrangler d1 create personal-time-logger
npm run db:migrate:local
npm run dev
```

Local Wrangler state is separate from the remote database. `--local` commands
use the local persisted D1 state; `--remote` commands act on the Cloudflare
database selected by the binding. The local integration test creates its own
temporary configuration and state, and never contacts a user's account.

## Token setup

Generate a long random token and keep the raw value in a password manager. The
Worker receives only its SHA-256 digest as a secret:

```bash
read -r -s PTL_RAW_TOKEN
PTL_TOKEN_DIGEST="$(printf '%s' "$PTL_RAW_TOKEN" | sha256sum | cut -d' ' -f1)"
printf '%s\n' "$PTL_TOKEN_DIGEST" | npx wrangler secret put PTL_API_TOKEN_SHA256
unset PTL_RAW_TOKEN PTL_TOKEN_DIGEST
```

The raw token is entered in the extension's Cloudflare D1 Storage controls. It
is kept in that Firefox profile only. If the token is lost, generate a new one,
replace the digest secret, and update the extension setting on each device.

## Deploy and verify

After setting the database ID and token digest:

```bash
npm run db:migrate:remote
npm run deploy
```

The deployment output provides the `https://...workers.dev` URL. Use that URL
in Options, then use **Test Cloudflare D1 connection** before selecting a
migration action. A direct smoke check is:

```bash
curl --fail \
  -H "Authorization: Bearer $PTL_RAW_TOKEN" \
  https://your-worker.your-subdomain.workers.dev/v1/health
```

Do not put a real token in shell history, source files, URLs, or bug reports.
The extension sends canonical entries and shared configuration to the Worker
only after local-first setup or migration has been verified.

## Migrations and backups

Add forward-only SQL files under `migrations/` and apply them explicitly. Check
the migration output before deploying code that depends on a new schema:

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

Wrangler rolls back a migration that fails, leaving the previous successful
migration applied. Before any risky remote change, export a SQL backup:

```bash
npx wrangler d1 export personal-time-logger --remote --output=./backup.sql
```

Review the file, keep it out of version control, and import only after checking
the target database and schema:

```bash
npx wrangler d1 execute personal-time-logger --remote --file=./backup.sql
```

Cloudflare also provides remote D1 backup listing/download and Time Travel
recovery. Confirm the current commands and retention policy in the
[Wrangler D1 command reference](https://developers.cloudflare.com/d1/wrangler-commands/)
and [D1 import/export guide](https://developers.cloudflare.com/d1/best-practices/import-export-data/).
Treat a restore or import as destructive to the current database and make a
fresh backup first.

## Operational boundaries

- `wrangler.jsonc`, `.wrangler/`, SQL exports, raw tokens, and token digests are
  local/secret material and must not be committed.
- The API accepts only the extension's `moz-extension://` origin and the
  configured bearer token. It does not expose a public custom-domain endpoint.
- API batches are intentionally small and atomic. A failed batch must be
  investigated rather than retried with manually edited versions.
- Cloudflare pricing, free allowances, backup retention, and limits are product
  details outside this repository; consult Cloudflare's current D1
  [local-development](https://developers.cloudflare.com/d1/best-practices/local-development/)
  documentation before operating at scale.

## Troubleshooting

- `401`: verify the raw token hashes to the current `PTL_API_TOKEN_SHA256`
  secret; the raw token is never recoverable from the Worker.
- `403`: use the exact `https://*.workers.dev` URL in Options and grant the
  optional host permission when Firefox asks.
- Migration errors: inspect the migration number and remote output, restore
  from a verified backup only after confirming the database identity, then
  deploy compatible code.
- Local/remote confusion: check whether the command has `--local` or
  `--remote`; local Wrangler data is not the deployed D1 database.

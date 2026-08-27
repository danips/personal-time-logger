# Architecture map

Personal Time Logger is a local-first Manifest V3 Firefox extension. The entry
points below share the same IndexedDB database and source modules; they do not
share JavaScript memory. Every state transition that can be reached from more
than one context therefore belongs in `extension/src/`, not in a page module.

```text
Popup / Calendar / Options / Reconcile ─┐
Usage page ─────────────────────────────┼── extension/src/ domain modules ── IndexedDB
Background alarm ───────────────────────┤          │                  │
                                         │          ├── browser APIs    └── entries + settings
ChatGPT usage service ─────────────────┘          └── remote providers
                                                        ├── Google Sheets / Drive APIs
                                                        └── MySQL HTTPS API
```

## Context boundaries

| Context | Entry point | Responsibility | Boundary |
| --- | --- | --- | --- |
| Background | `extension/background/background.js` | Alarm heartbeat, installation recovery, and non-interactive sync. | Does not own entries; it calls `extension/src/sync.js`. |
| Popup | `extension/popup/popup.js` | Start/stop/edit timers and bounded recent-history display. | Reads and writes through `extension/src/entries.js` and refreshes on entry events. |
| Calendar | `extension/calendar/calendar.js` | Week rendering, drag/resize/edit, merge, and displayed-week Tempo upload. | Geometry is in `extension/src/calendar-layout.js`; allocation is in `extension/src/time-allocation.js`; a fixed runtime message delegates Tempo transport to the background context through `extension/src/tempo.js`. |
| Options | `extension/options/options.js` | Navigated settings page for provider-aware storage, Google setup, MySQL API setup, ChatGPT usage, reconciliation, Tempo, and diagnostics. | It mounts the usage and reconciliation page modules; active backend and preparation target stay separate; OAuth client settings use synchronized browser storage, while tokens remain local. |
| Reconcile | `extension/reconcile/reconcile.js` | Compare local and remote snapshots, then apply reviewed resolutions. | It can run standalone or mounted in Options; it records local choices and lets normal sync carry writes, except verified duplicate-row deletion. |
| Usage | `extension/usage/usage.js` | Displays the current Firefox ChatGPT session's 5-hour and weekly limits. | It can run standalone or mounted in Options and delegates the fixed session-authenticated request to `extension/src/chatgpt-usage-service.js`. |
| ChatGPT usage service | `extension/src/chatgpt-usage-service.js` | Fetches the fixed session and usage endpoints directly from the extension context. | The access token stays in memory for one request and is never persisted, logged, or sent outside ChatGPT. |

`extension/src/platform.js` is the browser API adapter. It isolates Firefox promise APIs
and Chromium callback APIs so the domain modules do not branch on browser
flavour. The callback adapter remains unit-tested, but the current manifest,
runtime smoke test, and release pipeline support Firefox only.

## Local data and settings

`extension/src/db.js` opens IndexedDB database `timelogger_db` (version 5) with two
stores:

| Store | Contents | Important access paths |
| --- | --- | --- |
| `time_entries` | Local-first time records, including `dirty`, tombstone, sync-error, and revision bookkeeping. Dirty records persist a derived `dirty_key: 1`; clean records omit it. | Primary ID plus indexes for active timers, dirty-entry counts, deletion, start/end time, and status. |
| `settings` | Device-local configuration, sync/reconciliation state, locks, diagnostics, tokens, and the current ChatGPT usage snapshot. | Named keys; general extension keys live in `extension/src/setting-keys.js`. |

The OAuth client ID and secret are the deliberate exception: they live in
`browser.storage.sync` so a Firefox profile can restore the configuration.
Access/refresh tokens stay in IndexedDB. Entry changes are broadcast through
`extension/src/events.js`; receiving pages re-read data instead of trusting an event
payload as state.

Use `mutateEntries`, `mutateEntryState`, `mutateAllLocalState`, or
`mutateSettings` for shared state changes. Their mutators are synchronous
inside one IndexedDB transaction; entry mutations can require an expected
revision. `mutateAllLocalState` is reserved for intentional whole-history
operations. Do not replace an entry from an earlier read with a non-atomic
write when a conditional mutation is available.

## Entry, time, and remote model

`extension/src/entries.js` validates and normalizes the canonical remote entry
model. Google Sheets stores the model in the `time_entries` row order fixed by
`SHEET_HEADERS`:

```text
id, project, task, description, start_at, end_at, duration_seconds, status,
created_at, updated_at, deleted_at, device_id, revision, multiply
```

`duration_seconds` is effective duration. Ordinary calendar geometry uses the
actual interval; multiplied completed entries add a distinct visual tail through
their effective end. The tail participates in overlap layout but does not move
allocated time. `extension/src/time-allocation.js` apportions effective duration
proportionally across the actual interval at day/week/upload boundaries.
`docs/time-model.md` records the product decisions for allocation, merging,
conflicts, and multiplier validation.

`extension/src/sheets.js` owns Google Sheets and Drive I/O. It requires the exact
`time_entries` and `config` schemas on populated tabs; only empty or missing
tabs are initialized automatically. Remote updates and deletions carry a full
row fingerprint, re-read that row before mutation, and verify the intended
result afterward.

`extension/src/remote-provider.js` selects the active provider from
`REMOTE_BACKEND`. `remote-google-sheets.js` adapts Sheets row references and
fingerprints; `remote-mysql.js` adapts API version references and normalizes the
API's nullable optional fields. Generic sync and reconciliation code uses only
the provider contract and serializable provider metadata. Provider capabilities
currently control whether duplicate physical-record repair is presented.

## Sync, reconciliation, and fencing

`syncNow()` coalesces same-context calls with one registered drain: a stronger
request queues one follow-up cycle while the drain remains registered, so no
third call can overlap that queued work. Individual callers still receive the
active or queued cycle's result. An IndexedDB lease coordinates popup, calendar,
and background contexts. A lease has a holder and monotonic generation. The
owner renews it and calls `lease.assert()` before mutating phases; losing the
lease aborts the cycle, and `releaseLock` may only clear the generation it
acquired.

The sync sequence is:

1. Load local state and clean expired reconciliation intents.
2. Flag competing active timers and ensure the active provider is ready.
3. Use the active provider's change token as a read gate when supported; otherwise read its full remote snapshot.
4. Push dirty updates/appends with provider-owned opaque preconditions, then acknowledge only unchanged local revisions.
5. Pull remote changes with revision/reference checks, purge verified old tombstones, and synchronize the duration multiplier/config marker.
6. Record backoff/diagnostics and notify pages after a completed cycle.

Reconciliation records the displayed local revision and provider reference for
each choice. Equal `updated_at` values with different entry fingerprints remain
an explicit conflict rather than deriving an order from provider ordering.
Google Sheets has no atomic compare-and-swap: preflight and post-write checks
detect observable races but cannot prevent a manual edit in the request gap;
MySQL uses API version fencing.

## Trust and release boundaries

- Google Sheets/Drive and OAuth are required only for Google operation; the configured MySQL API origin is an optional host permission for MySQL operation.
- `chatgpt.com` is optional and isolated to the usage feature. Its page-world
  bridge is intentionally narrow because page scripts are untrusted extension
  inputs.
- Release packaging starts from tracked extension files only. The prepared
  source changes only the Firefox update URL; local secrets, tests, and build
  files are excluded.
- The release generator verifies the signed XPI manifest against the prepared
  manifest and release tag, then publishes checksums and provenance. GitHub
  Actions adds an artifact attestation for the XPI and published metadata.

## Maintenance gates

Run these before review:

```bash
npm test
npm run test:browser
npm run lint
npm run build:xpi
git diff --check
```

`npm run lint` runs ESLint over source, scripts, and tests before `web-ext`
lints the allow-listed extension package. Dependabot proposes weekly npm and
GitHub Actions updates; the scheduled dependency-health workflow installs the
lockfile and reports high-severity `npm audit` findings. Its audit is currently
non-blocking because `web-ext` carries an upstream `image-size` advisory with
no compatible remediation; Dependabot keeps that dependency chain under review.

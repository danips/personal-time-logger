# Architecture map

Personal Time Logger is a local-first Manifest V3 browser extension. The entry
points below share the same IndexedDB database and source modules; they do not
share JavaScript memory. Every state transition that can be reached from more
than one context therefore belongs in `src/`, not in a page module.

```text
Popup / Calendar / Options / Reconcile ─┐
Usage page ─────────────────────────────┼── src/ domain modules ── IndexedDB
Background alarm ───────────────────────┤          │                  │
                                         │          ├── browser APIs    └── entries + settings
ChatGPT content scripts ────────────────┘          └── Google APIs
```

## Context boundaries

| Context | Entry point | Responsibility | Boundary |
| --- | --- | --- | --- |
| Background | `background/background.js` | Alarm heartbeat, installation recovery, and non-interactive sync. | Does not own entries; it calls `src/sync.js`. |
| Popup | `popup/popup.js` | Start/stop/edit timers and bounded recent-history display. | Reads and writes through `src/entries.js` and refreshes on entry events. |
| Calendar | `calendar/calendar.js` | Week rendering, drag/resize/edit, merge, and displayed-week Tempo upload. | Geometry is in `src/calendar-layout.js`; allocation is in `src/time-allocation.js`; a fixed runtime message delegates Tempo transport to the background context through `src/tempo.js`. |
| Options | `options/options.js` | OAuth client setup, sync settings, spreadsheet adoption/replacement, and diagnostics. | OAuth client settings use synchronized browser storage; tokens remain local. |
| Reconcile | `reconcile/reconcile.js` | Compare local and remote snapshots, then apply reviewed resolutions. | It records local choices and lets normal sync carry writes, except verified duplicate-row deletion. |
| Usage | `usage/usage.js` | Firefox-only ChatGPT account setup and usage display. | It requests optional ChatGPT permission before contacting that host. |
| ChatGPT content scripts | `content/chatgpt-usage.js`, `content/chatgpt-usage-page.js` | Fetch the private usage endpoint in the isolated world; use the page world only after a 401. | The bridge correlates bounded messages by request ID. Session tokens stay in page memory and are never persisted by the extension. |

`src/platform.js` is the browser API adapter. It isolates Firefox promise APIs
and Chromium callback APIs so the domain modules do not branch on browser
flavour.

## Local data and settings

`src/db.js` opens IndexedDB database `timelogger_db` (version 3) with two
stores:

| Store | Contents | Important access paths |
| --- | --- | --- |
| `time_entries` | Local-first time records, including `dirty`, tombstone, sync-error, and revision bookkeeping. | Primary ID plus indexes for active timers, dirty entries, deletion, start/end time, and status. |
| `settings` | Device-local configuration, sync/reconciliation state, locks, diagnostics, tokens, and ChatGPT account data. | Named keys; general extension keys live in `src/setting-keys.js`. |

The OAuth client ID and secret are the deliberate exception: they live in
`browser.storage.sync` so a Firefox profile can restore the configuration.
Access/refresh tokens stay in IndexedDB. Entry changes are broadcast through
`src/events.js`; receiving pages re-read data instead of trusting an event
payload as state.

Use `mutateEntries`, `mutateEntryState`, `mutateAllLocalState`, or
`mutateSettings` for shared state changes. Their mutators are synchronous
inside one IndexedDB transaction; entry mutations can require an expected
revision. `mutateAllLocalState` is reserved for intentional whole-history
operations. Do not replace an entry from an earlier read with `putEntry` when a
conditional mutation is available.

## Entry, time, and spreadsheet model

`src/entries.js` validates and normalizes the entry model. The remote
`time_entries` row order is fixed by `SHEET_HEADERS`:

```text
id, project, task, description, start_at, end_at, duration_seconds, status,
created_at, updated_at, deleted_at, device_id, revision, multiply
```

`duration_seconds` is effective duration. Calendar geometry always uses the
actual interval, while `src/time-allocation.js` apportions effective duration
proportionally across day/week/upload boundaries. `docs/time-model.md` records
the product decisions for allocation, merging, conflicts, and multiplier
validation.

`src/sheets.js` owns Google Sheets and Drive I/O. It requires the exact
`time_entries` and `config` schemas on populated tabs; only empty or missing
tabs are initialized automatically. Remote updates and deletions carry a full
row fingerprint, re-read that row before mutation, and verify the intended
result afterward.

## Sync, reconciliation, and fencing

`syncNow()` coalesces same-context calls, while an IndexedDB lease coordinates
popup, calendar, and background contexts. A lease has a holder and monotonic
generation. The owner renews it and calls `lease.assert()` before mutating
phases; losing the lease aborts the cycle, and `releaseLock` may only clear the
generation it acquired.

The sync sequence is:

1. Load local state and clean expired reconciliation intents.
2. Flag competing active timers and ensure/recover the spreadsheet binding.
3. Use Drive modified time only as a read gate; otherwise read the full remote snapshot.
4. Push dirty updates/appends with remote row preconditions, then acknowledge only unchanged local revisions.
5. Pull remote changes with revision/fingerprint checks, purge verified old tombstones, and synchronize the duration multiplier/config marker.
6. Record backoff/diagnostics and notify pages after a completed cycle.

Reconciliation records the displayed local revision and remote fingerprint for
each choice. Equal `updated_at` values with different entry fingerprints remain
an explicit conflict rather than deriving an order from sheet-row position.
Google Sheets has no atomic compare-and-swap: preflight and post-write checks
detect observable races but cannot prevent a manual edit in the request gap.

## Trust and release boundaries

- Google Sheets/Drive and OAuth are the only required network hosts.
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
npm run lint
npm run package:firefox
```

`npm run lint` runs ESLint over source, scripts, and tests before `web-ext`
lints the allow-listed extension package. Dependabot proposes weekly npm and
GitHub Actions updates; the scheduled dependency-health workflow installs the
lockfile and reports high-severity `npm audit` findings. Its audit is currently
non-blocking because `web-ext` carries an upstream `image-size` advisory with
no compatible remediation; Dependabot keeps that dependency chain under review.

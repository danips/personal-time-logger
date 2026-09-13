# Architecture map

Personal Time Logger is a local-first Manifest V3 Firefox extension. The entry
points below share the same IndexedDB database and source modules; they do not
share JavaScript memory. Every state transition that can be reached from more
than one context therefore belongs in `extension/src/`, not in a page module.

```text
Extension pages (Popup, Calendar, Analytics, Options, Reconcile, Usage) ─┐
Background alarm ───────────────────────────────────────────────────────┼── extension/src/ domain modules ── IndexedDB
ChatGPT usage service ──────────────────────────────────────────────────┘          │                  │
                                                                                  ├── browser APIs    └── entries + settings
                                                                                  └── remote providers
                                                                                      ├── MySQL HTTPS API (authoritative)
                                                                                      └── Cloudflare Worker + D1 HTTPS API
```

## Context boundaries

| Context | Entry point | Responsibility | Boundary |
| --- | --- | --- | --- |
| Background | `extension/background/background.js` | Alarm heartbeat, installation recovery, and non-interactive sync. | Does not own entries; it calls `extension/src/sync.js`. |
| Popup | `extension/popup/popup.js` | Start/stop/edit timers, guarded deletion undo, merge preview/confirmation, actionable stale/competing-timer warnings, and bounded recent-history navigation/filtering. | Reads and writes through `extension/src/entries.js`; warning, undo, and merge actions carry expected revisions/tombstone identity; recent grouping, filtering, totals, and loaded-value suggestions are pure `extension/src/popup-recent-groups.js`; window-size controls use the page-local `extension/popup/window-size-controller.js`. |
| Calendar | `extension/calendar/calendar.js` | Week rendering, direct completed-entry creation, keyboard/pointer drag-resize/edit, guarded deletion undo, merge/duplicate preview and confirmation, and displayed-week Tempo upload. | Completed entries use the shared editor and local entry mutation without changing active timers. The editor reports browser-local time semantics and restores entry focus after keyboard cancellation/rerender. Deletion undo and merge/duplicate confirmation use page-local session state plus guarded `extension/src/entries.js` mutations. Geometry is in `extension/src/calendar-layout.js`; allocation is in `extension/src/time-allocation.js`; `extension/calendar/tempo-controller.js` captures the selected week and delegates Tempo transport to the background context. |
| Analytics | `extension/analytics/analytics.js` | Period reports, project/task filters, automatic comparisons, project/task and description breakdowns, fragmentation, anomaly display, and entry navigation. | Queries the bounded union of current and comparison intervals once, applies filters before building both period datasets, and preserves view state across refresh; pure period and aggregation logic lives in `extension/src/analytics-period.js` and `extension/src/analytics.js`. |
| Options | `extension/options/options.js` | Navigated settings page for MySQL/D1 storage, ChatGPT usage, reconciliation, Tempo, backups, and diagnostics. | It owns page wiring and draft revisions. `extension/options/provider-setup-controller.js` owns the shared API-provider save, permission-test, and activation policy. |
| Reconcile | `extension/reconcile/reconcile.js` | Compare local and remote snapshots, then apply reviewed resolutions. | It can run standalone or mounted in Options; it records local choices and lets normal sync carry writes, except verified duplicate-row deletion. |
| Usage | `extension/usage/usage.js` | Displays the current Firefox ChatGPT session's 5-hour and weekly limits. | It can run standalone or mounted in Options and delegates the fixed session-authenticated request to `extension/src/chatgpt-usage-service.js`. |
| ChatGPT usage service | `extension/src/chatgpt-usage-service.js` | Fetches the fixed session and usage endpoints directly from the extension context. | The access token stays in memory for one request and is never persisted, logged, or sent outside ChatGPT. |

`extension/src/platform.js` is the browser API adapter. It isolates Firefox promise APIs
and Chromium callback APIs so the domain modules do not branch on browser
flavour. The callback adapter remains unit-tested, but the current manifest,
runtime smoke test, and release pipeline support Firefox only.

Options keeps section-local draft revisions in the page controller. Refreshes
never replace a field whose draft revision is newer than the last acknowledgement;
they mark that section when an external saved value changed. Discard advances
the section's acknowledgement and reloads persisted values. Inline field errors
use the existing settings normalizers and native validity state, so validation
stays close to the input without adding a second state framework.

Theme selection is shared across pages through `extension/src/themes.js` and
`extension/src/themes.css`. Page styles retain only the fallback and geometry
tokens they need; the shared stylesheet owns selected palettes, high-contrast
edges, focus outlines, and reduced-motion overrides. Theme and responsive
checks use rendered computed styles and visible control geometry rather than
CSS spelling assertions.

ChatGPT usage presentation is shared by the Usage page and Popup through
`extension/src/usage-presentation.js`. It owns window names, local reset
countdowns, and stale-age calculation; countdown refreshes read the last local
snapshot without another network request. Each refresh claims a new generation
before requesting data, so a newer context response cannot be overwritten by an
older one. Clearing consent/snapshot increments the same generation and remains
separate from revoking the optional `chatgpt.com` host permission.

## Local data and settings

`extension/src/db.js` opens IndexedDB database `timelogger_db` (version 5) with two
stores:

| Store | Contents | Important access paths |
| --- | --- | --- |
| `time_entries` | Local-first time records, including `dirty`, tombstone, sync-error, and revision bookkeeping. Dirty records persist a derived `dirty_key: 1`; clean records omit it. | Primary ID plus indexes for active timers, dirty-entry counts, deletion, start/end time, and status. |
| `settings` | Device-local configuration, sync/reconciliation state, locks, diagnostics, tokens, and the current ChatGPT usage snapshot. | Named keys; general extension keys live in `extension/src/setting-keys.js`. |

Provider credentials remain in IndexedDB and are never synchronized. A
temporary removal-only compatibility scrub uses `browser.storage.sync.remove`
for two legacy OAuth keys without reading or writing synchronized values. Entry changes are broadcast through
`extension/src/events.js`; receiving pages re-read data instead of trusting an event
payload as state.

Use `mutateEntries`, `mutateEntryState`, `mutateAllLocalState`, or
`mutateSettings` for shared state changes. Their mutators are synchronous
inside one IndexedDB transaction; entry mutations can require an expected
revision. `mutateAllLocalState` is reserved for intentional whole-history
operations. Do not replace an entry from an earlier read with a non-atomic
write when a conditional mutation is available.

`extension/src/tempo-submission-ledger.js` uses the settings store for local,
versioned Tempo allocation claims. Its identity includes the entry fingerprint,
civil date, allocated seconds, issue, author, and fixed Tempo destination;
tokens and worklog content are not stored. Claims are atomically persisted before
future dispatch, acknowledgements are retained, and pending claims require the
explicit restart-recovery operation that changes them to `unknown` rather than
replaying them automatically. The ledger is intentionally outside portable
backups and diagnostics.

Tempo upload messages are handled in the background by
`extension/src/tempo-upload-handler.js`. That boundary validates the calendar sender
and allocation payload, claims each chunk before its privileged XHR, and records the
acknowledged, rejected, or unknown outcome before another retry can proceed. The
calendar page never sends the ledger identity metadata on the Tempo wire request.
Each upload has a page-generated operation ID; a cancel message marks that operation
in the background, lets the current XHR finish, and prevents later chunks from being
claimed. Reopening the preview reads the durable ledger instead of replaying
acknowledged or unknown allocations automatically. This recovery is profile-local;
there is no remote duplicate check, and allocations created before the ledger existed
remain untracked history requiring explicit review.

## Entry, time, and remote model

`extension/src/entries.js` validates and normalizes the canonical remote entry
model. `extension/src/entry-contract.js` owns its fourteen-field ordering; the
named cases in `test/fixtures/entry-contract.json` are the shared extension,
Cloudflare, and PHP conformance oracle. API providers use this canonical model:

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

Popup and Calendar share the editor markup and the pure merge/duplicate preview
calculations, but keep confirmation/session ownership in their page modules. The
pages have different selection, focus, rendering, and lifecycle rules, so R18
reviewed the repeated code without introducing a generic page controller or
callback-heavy abstraction. Confirmation rechecks the captured target/source
revisions before the local mutation.

Analytics keeps reporting and physical-session semantics separate. The page's
CSV export consumes the already-computed filtered report snapshot, preserving
its ranges, browser timezone, actual/effective labels, and numeric values;
formula-leading user text is neutralized only in text cells. Print styling
removes controls without creating a second reporting path. Effective
duration drives totals, shares, descriptions, and period comparisons. Actual
elapsed duration drives the explicit actual-time total, session statistics,
context switches, overlap checks, and long/short/stale anomalies. Project and
task filters are applied to the shared bounded entry set before both primary
and comparison reports are built, so their scope remains identical. Anomaly
navigation carries the entry ID and start date to Calendar; Calendar validates
the entry after its own visible query and reports a missing/deleted target
without opening an editor. The Analytics page retains period, filters,
expanded rows, scroll, and focus across refreshes. The page reads only the union
of its selected and comparison ranges through `getEntriesIntersecting()` and
refreshes after entry-change events. All aggregation stays local; Analytics
adds no provider calls, remote schema, permissions, telemetry, or derived-data
storage.

`extension/src/remote-provider.js` selects the active provider from
`REMOTE_BACKEND`. `remote-mysql.js` adapts API version references and normalizes
the API's nullable optional fields, and `remote-cloudflare-d1.js` adapts
Worker/D1 version references. Generic sync and reconciliation code uses only
the provider contract and serializable provider metadata. The provider-neutral
API is documented in `docs/remote-api-v1.md`.

`extension/src/remote-versioned-mutations.js` owns only the identical MySQL/D1
encoded chunking, canonical projection, acknowledgement ordering, and versioned
mutation payloads. Identity, URL normalization, host permissions, health, and
snapshot behavior stay in the individual adapters. Extension generic failures
use `extension/src/coded-error.js`; domain-specific error constructors remain
with their domains and `error-registry.js` gives every stable code an action.

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
5. Pull remote changes with revision/reference checks, retain tombstones as deletion evidence, and synchronize the duration multiplier through `sync-config.js`.
6. Record backoff/diagnostics and notify pages after a completed cycle.

Reconciliation records the displayed local revision and provider reference for
each choice. Equal `updated_at` values with different entry fingerprints remain
an explicit conflict rather than deriving an order from provider ordering. Each
rendered group is paginated at 50 items and searchable within the loaded report;
the summary counts remain full-report counts. Bulk actions preview their
affected, equal-time-conflict, and precondition counts, and a completed/pending/
failed outcome is shown after a fresh comparison when execution is partial.
Quarantined exports contain only provider/location/reason metadata and escape
CSV text, so invalid remote payloads are not normalized into a report.
MySQL and Cloudflare D1 use API version fencing for remote mutations; ambiguous
append results are confirmed by reading the provider's versioned snapshot.

Options treats the active backend and the prepared migration target as separate
identities. Storage migration persists a provider-neutral preview containing
source/target entry and shared-config counts plus disagreements before seeding;
the page renders that preview and resumes from its durable phase after a page
closure. Setup labels distinguish testing, initialization from this device,
adoption of existing remote data, migration, and resume. The provider setup
controller continues to own exact host permission and active-destination checks;
no second provider facade is introduced.

Deletion tombstones are retained locally and remotely rather than purged after a
fixed window. A clean local copy learns from a retained remote tombstone, while
a dirty edit against it and a previously synchronized local ID missing from a
remote snapshot are held for explicit Reconcile review. New unsent IDs remain
eligible for append. An entry restored from an old backup is treated as unproven
provenance and is also held for review. Older clients may already have erased
deletion evidence; current clients cannot infer that history from remote absence
and require an explicit reconciliation or rebootstrap decision.

## Boundary decisions

- Shared validator seam — considered generating validators from the JSON fixture; chosen: shared named conformance data while each runtime retains its local trust-boundary validator. Revisit when a build-time generator can preserve JavaScript, Worker, and PHP diagnostics without broadening the wire contract.
- Versioned provider helper — considered a whole-provider factory; chosen: a compact mutation helper because health, identity, configuration, and permissions differ. Revisit when another versioned provider has the same mutation contract.
- Options controller — considered moving setup into core storage modules; chosen: a page-local descriptor controller because locks, page status, permissions, and draft callbacks are Options policy. Revisit when a non-Options context needs this workflow.

## Trust and release boundaries

- MySQL is the authoritative deployment and Cloudflare D1 is a supported user-owned alternative. HTTPS origins are optional so Firefox can grant a self-hosted API domain, while runtime requests ask only for the exact configured provider origin. Raw bearer tokens remain local to the Firefox profile; the Worker stores only its SHA-256 digest.
- `chatgpt.com` is optional and isolated to the usage feature. The usage service
  performs its bounded session and usage requests directly from the extension
  context; no page-world bridge is used.
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

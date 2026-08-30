# Personal Time Logger Extension

Current release: `0.1.54` (`v0.1.54`).

A Firefox extension for local-first time tracking with Google Sheets, MySQL, or a user-owned Cloudflare Worker + D1 backend. It is intentionally plain: vanilla JavaScript modules, no bundler, no React, no TypeScript, no external runtime libraries. Node is used only to run the tests and the release packaging scripts.

## What Is Included

- Popup timer with live elapsed time; toolbar icon turns green when a timer is running.
- Project, task, description, and multiply fields in the popup.
- Start, active-timer Stop, and header Sync controls in the popup. Starting a timer stops the running one.
- Recent entries grouped by week and day, with totals, repeated entries collapsed into expandable groups, and **Load more** for earlier weeks.
- Weekly calendar view with movable and resizable time logs and direct displayed-week Tempo upload.
- Options page with left-side navigation for provider-aware storage, Google, ChatGPT usage, reconciliation, Tempo, and diagnostics settings.
- Multiple-active-timer warning.
- The Options page includes provider-aware storage controls, Google auth, sync interval, duration multiplier, calendar start hour, device ID, reconciliation, and experimental ChatGPT usage controls. Google-specific sections are shown while Google Sheets is active or selected as a migration target.
- Background sync that runs while the browser is open, with no page needed.
- IndexedDB local storage using database `timelogger_db`.
- Google Sheets API sync with `time_entries` as the canonical remote tab.
- MySQL 8.4 sync through an authenticated HTTPS API, with resumable verified migration between providers.
- Cloudflare Worker + D1 sync through an authenticated user-owned HTTPS API, with resumable verified migration between providers.
- Refresh-token-capable Google device OAuth flow for Firefox.
- Experimental ChatGPT 5-hour and weekly usage controls for the current Firefox session.
- Unit tests over the pure logic, run with `npm test`.

## ChatGPT Usage Limits (Experimental)

The **ChatGPT usage limits** section in Options reads the account signed in to the normal Firefox profile. It does not create containers or open ChatGPT tabs.

The feature reads the current session from ChatGPT's fixed `/api/auth/session` endpoint, keeps its access token in memory, and uses it only for the private, undocumented `backend-api/wham/usage` request. It is experimental and may stop working after a ChatGPT update. The token never reaches extension storage, logs, URLs, exports, or Firefox Sync. Permission, sign-in, network, endpoint, and schema failures are reported explicitly.

The usage card displays both the 5-hour and weekly percentages, reset times, and countdowns returned by ChatGPT.

### ChatGPT setup

1. Use Firefox and reload the extension from `about:debugging#/runtime/this-firefox` if it is already installed as a temporary add-on.
2. Open the popup, click the gear-shaped **Time Logger Options** button, and select **ChatGPT Usage** in the left navigation.
3. Click **Grant ChatGPT access** and approve the optional `chatgpt.com` host permission. Granting host access gives the extension the browser capability to interact with `chatgpt.com`; this implementation uses it only for the fixed usage request and does not inspect passwords, chats, prompts, or cookie values.
4. Make sure ChatGPT is signed in in your normal Firefox profile, then click **Refresh**.

The page displays the percentage remaining, percentage used, reset date and countdown for both windows, plus plan/status flags, collection time, and stale state. A failed refresh leaves the last successful snapshot visible. A revoked permission disables refresh until it is granted again.

**Clear ChatGPT usage data** removes the local snapshot and consent setting without touching the Firefox session. Passwords, session cookies, access tokens, raw account IDs, raw user IDs, and raw endpoint responses are never stored or synchronized.

## Load In Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `extension/manifest.json`.
4. Open the extension options page, enter the Google OAuth client ID and secret, and sign in.

Firefox temporary add-ons are removed when Firefox restarts. The manifest includes a stable Gecko extension ID for installed development builds.

The signed release targets Firefox 142 or newer so it can use Firefox's built-in data-transmission consent declaration required for new AMO submissions.

## Private Firefox Publishing With Automatic Updates

The repository includes a GitHub Actions release workflow for personal distribution:

- Mozilla signs every build as an **unlisted** add-on. It is not listed in AMO search.
- GitHub Pages hosts the signed XPI and the HTTPS Firefox update manifest.
- Pushing a version tag signs and publishes that version automatically.
- Firefox installations using the first signed build receive later versions automatically.

The GitHub Pages files are publicly fetchable because Firefox's updater cannot authenticate to a private download. They do not contain the Google OAuth client ID, client secret, access token, refresh token, spreadsheet ID, or time entries. OAuth client credentials are entered once in Options and stored in Firefox synchronized extension storage; OAuth tokens stay in each local Firefox profile.

### One-time setup

1. Create a GitHub repository and push this project. Keep `config.js` and `web-ext-artifacts/` ignored.
2. Create or sign in to an [addons.mozilla.org developer account](https://addons.mozilla.org/developers/).
3. Open [AMO API credentials](https://addons.mozilla.org/developers/addon/api/key/) and create credentials.
4. In the GitHub repository, open **Settings > Secrets and variables > Actions** and add these repository secrets:
   - `AMO_JWT_ISSUER`: the AMO JWT issuer/API key.
   - `AMO_JWT_SECRET`: the AMO JWT secret.
5. Open **Settings > Pages** and set **Source** to **GitHub Actions**.
6. Open **Settings > Environments > github-pages**. Under **Deployment branches and tags**, allow the tag pattern `v*` (or choose **No restriction**) so release tags can deploy.
7. If the normal Pages URL is not `https://OWNER.github.io/REPOSITORY`, add an Actions repository variable named `FIREFOX_UPDATE_BASE_URL` containing the actual HTTPS base URL without a trailing slash.

### Publish the first version

The Git tag must match `extension/manifest.json` with a leading `v`:

```bash
git tag v0.1.1
git push origin v0.1.1
```

Watch **Actions > Release Firefox extension**. It runs the unit tests, lints the allow-listed extension files, asks Mozilla to sign an unlisted XPI, verifies that the signed XPI, source manifest, and tag have the same version, then deploys the XPI with `updates.json`, `checksums.txt`, and `provenance.json` to GitHub Pages. The release workflow also creates GitHub artifact attestations for the published release files.

On every device, open `https://OWNER.github.io/REPOSITORY/` in Firefox and install the XPI. If Firefox downloads it instead, open `about:addons`, use the gear menu, choose **Install Add-on From File**, and select the downloaded XPI. Then open the extension's Options, save the Google OAuth credentials, and sign in.

### Publish later versions

1. Change `version` in `extension/manifest.json` to a higher numeric version such as `0.1.2`.
2. Commit and push the code.
3. Tag that commit and push the tag:

```bash
git tag v0.1.2
git push origin v0.1.2
```

Firefox periodically checks the deployed `updates.json` and installs a higher signed version. In `about:addons`, **Check for Updates** can trigger an immediate check.

The release package is generated from an explicit allow-list. The local `config.js`, old XPI files, temporary downloads, Git metadata, and development-agent files cannot enter the release. Normal Firefox installations require the Mozilla-signed XPI.

## Google Cloud OAuth Setup

1. Go to Google Cloud Console.
2. Create or select a project.
3. Under **APIs & Services > Library**, enable both the **Google Sheets API** and the **Google Drive API**. Drive is used only to list the extension's own spreadsheets and to read the file's modification time.
4. Configure the OAuth consent screen.
5. If the app is in **Testing**, add your Google account under **Test users**.
6. Create an OAuth client ID.
7. Choose **TVs and Limited Input devices**.
8. Copy the OAuth client ID and client secret.
9. Open the installed extension's Options page.
10. Enter the client ID and secret, click **Save Credentials**, and then click **Sign In**.

The extension requests two scopes: `spreadsheets`, and `drive.file` for per-file Drive access. `drive.file` covers only files this extension created, which is what lets it find its own spreadsheet and check whether the file changed before downloading it. Google's device flow accepts a fixed list of scopes; `drive.file` is on it and the broader `drive.metadata.readonly` is not.

When you click **Sign In**, the extension shows a Google device code and opens Google's device authorization page. Leave the options page open while Google authorizes the device. Device flow avoids extension redirect URI mismatch issues and stores a refresh token locally so the extension can refresh access tokens after the usual one-hour access token expires.

The device-flow client ID and client secret are stored with Firefox Sync so they can be restored on another desktop Firefox device signed into the same Mozilla account with Add-ons sync enabled. Access and refresh tokens remain in the local Firefox profile and are never synchronized, so each device still requires its own Google sign-in. None of these values are included in published XPI files.

### Long-Lived Sign-In With Device Flow

Use this if you do not want to sign in again every hour.

1. In Google Cloud Console, open **APIs & Services** > **Credentials**.
2. Create an OAuth client ID.
3. Choose **TVs and Limited Input devices**.
4. Save the client ID and client secret in the extension's Options page.
5. Reload the extension.
6. Open Options and click **Sign In**.
7. Enter the shown device code on Google's device authorization page.

Google's device flow returns a refresh token. The extension stores that token in IndexedDB and uses it to refresh access tokens without asking you to sign in again. You still may need to sign in again if you sign out, reinstall the extension, clear extension storage, revoke the app in your Google account, or Google expires/revokes the refresh token.

## Spreadsheet Setup

There is nothing to configure. After you sign in, the first sync finds or creates the spreadsheet:

- Drive is asked which spreadsheets this extension created. Under the `drive.file` scope that list contains only its own files, never the rest of your Drive.
- The most recently modified candidate whose `time_entries` header matches is adopted.
- If there are none, a spreadsheet named `Personal Time Logger` is created.
- If the listing fails, for example because the Drive API is not enabled or the token predates the `drive.file` scope, an error is reported and nothing is created. A failed listing is never mistaken for "no spreadsheet exists".

Options shows the spreadsheet as a link that opens it in Google Sheets, with its ID beside a **Copy ID** button. The ID is not editable, because detection and repair handle the cases that editing it used to cover.

If the spreadsheet is deleted or moved to the trash, the next sync confirms with Drive that it is really gone, then sets up a replacement and refills it from the entries held on this device. A spreadsheet that is merely unreachable reports an error instead, so a permission problem cannot silently strand you on a second copy.

The `time_entries` tab is created if missing and row 1 is kept as exactly these headers:

```text
id, project, task, description, start_at, end_at, duration_seconds, status, created_at, updated_at, deleted_at, device_id, revision, multiply
```

The `time_entries` tab is the canonical remote storage. Do not rename it unless you also update the code.

A second tab named `config` holds settings shared between devices, currently the duration multiplier, plus a marker identifying the spreadsheet as this extension's.

The `multiply` column stores the numeric multiplier value used for that entry, for example `1.5`. Existing rows without this value are treated as not multiplied.

Sync reads first and only inspects the layout when a read fails. A missing tab, or a completely empty tab, can be initialized automatically. A populated tab must already have the exact supported header row; an unrecognized or cleared header stops sync without changing the sheet. Restore the header or move the data to a new spreadsheet before trying again.

## Usage

1. Open the popup.
2. Expand **New timer** and fill in any fields.
3. Click **Start**. Any running timer is stopped first.
4. Click **Stop** when finished.
   Click the active timer card to open it in the edit panel when you need to change its details or start time.
5. Use the header sync button to push/pull immediately.
6. Click a recent entry row to edit it. Deleting asks for confirmation.
7. Use the play button on a recent entry to start a new timer with the same details.
8. Use **Load more** to reach earlier weeks in the recent list.
9. Use the calendar button to open the weekly calendar view, and the ⇄ button to open Reconcile.
10. Use **Send week to Tempo** in the calendar to create the displayed week's completed worklogs directly in Tempo. Open the adjacent menu and choose **Choose individual days** when you only want to send part of the week.
11. Use the merge controls in a recent entry edit panel or selected calendar entry to append another matching completed log's elapsed time to the selected entry.

Starting, stopping, editing, and deleting always write to IndexedDB first. The UI remains usable when offline or when the active provider is not ready.

If the popup and calendar are open at the same time, local changes broadcast between them and both views refresh automatically.

Set **Duration multiplier** in Options. Entries with **Multiply** checked store `duration_seconds` as actual elapsed seconds times that multiplier, and store the multiplier value itself in the active provider's shared `multiply` field. Entries without **Multiply** keep their actual duration and leave `multiply` empty.

## Remote Storage and Migration

IndexedDB is always the local source of truth. Each device has one **active
remote backend** used by normal sync and reconciliation, plus an independent
**backend to prepare** used to configure a possible migration. Selecting a
preparation target never changes the active backend; only a verified migration
does that.

Google Sheets is the legacy/default provider. MySQL 8.4 is configured with an
HTTPS API base URL and a device-local bearer token. Cloudflare Worker + D1 is
configured with a `workers.dev` HTTPS URL and a device-local bearer token; the
Worker stores only the token's SHA-256 digest. Google Account and
Spreadsheet settings are shown when Google is active or selected as the
preparation target, and are hidden during ordinary MySQL use without deleting
Google credentials, tokens, or spreadsheet state.

On a new installation, Options first asks whether to start with Google Sheets
or MySQL. The remaining settings stay hidden until the selected backend has
been established. MySQL setup can either adopt an existing remote dataset or
initialize it from this profile's local data.

Storage migration pauses ordinary synchronization, verifies the canonical
entries and shared configuration, and switches the active backend only after
verification succeeds. The source provider and its data remain available for
reverse migration.

For a new profile that does not use Google, choose the direct setup action for
MySQL or Cloudflare D1 in Storage. This initializes the selected backend from
that Firefox profile's local data without reading Google Sheets. Existing
remote records that do not match the local data are rejected rather than
overwritten.

If MySQL or Cloudflare D1 already contains the authoritative data, choose the
corresponding **Use existing ... data** action instead. This verifies any local
records that are already present, switches the backend, and imports remote-only
records into the local database; it does not require Google sign-in.

### Cloudflare Worker + D1 setup

The backend is an isolated Worker and D1 database owned and operated by the
user. Follow [the backend operations guide](server/cloudflare-d1/README.md) to
create the database, apply migrations, configure the digest-only secret, and
deploy the Worker. The extension's Storage page then accepts the Worker URL and
the raw token locally. Cloudflare's free limits and product terms can change;
check Cloudflare's current documentation before relying on them.

## Calendar View

The calendar page shows the current week by default and lets you move to previous, next, or selected weeks. Ordinary time logs are drawn from their actual start to end. A multiplied completed entry also has a visually distinct tail extending to its effective duration; that tail can overlap other blocks, but it does not move report, daily-total, sync, or Tempo time into a later period. Effective time is allocated proportionally across the actual interval. Entries whose displayed blocks overlap are shown side by side. Set the calendar start hour in Options; the initial calendar view starts displaying at that hour. The default is 07:00.

Click **Send week to Tempo** to send the displayed week's completed entries to Tempo. The first use asks Firefox for access to `api.tempo.io`; Tempo requests then run in the extension background context so they are not subject to page CORS checks. Configure the Tempo API token and author account ID in Options first. Each Task maps to a numeric Jira issue ID; the calendar asks when it encounters an unknown Task and stores the answer in the editable cache in Options. The entry description becomes the Tempo worklog comment, and multiplied time is apportioned proportionally when an entry crosses the week boundary. Running timers are skipped because Tempo requires a fixed duration. Review the confirmation carefully: sending the same week again creates duplicate Tempo worklogs.

The normal **Send week to Tempo** action sends the whole displayed week without showing extra controls. Its adjacent menu offers **Choose individual days**, which reveals an unchecked box in each day header and enables the send action after at least one day is selected. The checkboxes disappear after a successful send or when you change weeks. The selection is not stored, which keeps a resend after a partial send an explicit choice. Sending a day that was already sent still creates duplicates, so use this to send the remaining days rather than to correct an earlier send.

Drag a time log to move it to another day or start time. Dragging snaps the start time to 15-minute intervals such as `09:00`, `09:15`, `09:30`, and `09:45`. Completed entries keep their original duration when moved. Active timers keep running and only their `start_at` value changes.

Select a completed time log, then drag its top or bottom edge to change its start or end time. Resize handles are only available on the selected log. Resizing snaps to one-minute intervals and keeps a minimum duration of one minute. Use **Undo resize** beside the calendar status immediately afterward to restore the previous times.

Click a time log in the calendar to select it and open its edit panel. Click the selected time log again to clear the selection. If another completed log in the week has the exact same project, task, and description, the merge panel lets you combine them into one entry with the total duration of both logs. The same merge action is available from the popup edit panel for recent entries.

Use the edit panel that opens with a selected time log to change its project, task, description, multiply flag, start and end times, or review status. Saving recalculates the duration and syncs the updated entry. Entries are also reachable from the keyboard: focus a time log and press Enter or Space to open it.

Dates and times follow your browser's locale throughout.

Select a completed time log and click **Duplicate** to create a new entry with the same details, start time, end time, and duration. The copy is saved as a separate entry and synced normally.

## Sync Behavior

Sync happens when:

- the popup or calendar opens;
- a timer is started, stopped, edited, deleted, moved, resized, merged, or duplicated;
- the header sync button is clicked;
- a background alarm fires while the browser is open, with or without any page open.

The sync interval defaults to 60 seconds and is clamped to a minimum of 30 seconds. When nothing is changing, the background poller stretches its interval out to 2x, 5x, then 10x that value, capped at 15 minutes, and snaps back to the configured interval as soon as a cycle moves data or you act in the interface. A second device's edits can therefore take up to 15 minutes to appear on an idle machine; opening the popup or calendar syncs immediately.

The popup, calendar, and background each attempt sync independently. A renewable IndexedDB lease admits one current holder, and the holder checks its generation before each mutating phase. A context that cannot acquire or renew the lease stops and retries from a fresh snapshot; this prevents normal same-profile cycles from both appending an entry, but it is not a distributed database lock across devices.

On sync, the extension:

1. Flags competing active timers as `needs_review` if more than one is running.
2. Asks the active provider for its change token when available, and skips the exchange when nothing changed remotely and nothing is pending locally.
3. Reads the active provider's canonical entries and shared configuration.
4. Pushes local changes through the provider adapter with provider-specific concurrency references.
5. Pulls remote entries into IndexedDB, using last `updated_at` wins for normal edits.
6. Removes entries deleted more than 14 days ago through the active provider's cleanup semantics.

An idle cycle costs a single request. A timer left running overnight keeps running; it is never closed automatically.

Where a valid entry ID appears in several rows, the valid row with the newest `updated_at` is selected regardless of its position, so a stale duplicate cannot overwrite a newer one. Equal timestamps do not provide a reliable ordering and duplicate rows remain visible for review. Malformed rows are quarantined instead of participating in the choice. Surplus rows are deleted only after their full row fingerprints are rechecked.

Deleted entries are marked locally with `deleted_at` first so deletion is local-first and can sync later. During sync, the active provider receives the same tombstone instead of an immediate physical removal. This lets other devices learn about the deletion and prevents old local copies from being re-created as new remote entries. Tombstones older than 14 days are removed from remote storage and local storage.

## Reconcile Screen

The ⇄ button in the popup header opens a page comparing this device with the active remote backend. It sorts every entry into identical, differing, device-only, remote-only, and (when supported) duplicated records, and summarises the totals so the two sides visibly account for each other. The page identifies the active provider and does not use the backend selected for a future migration.

Differing entries list each field with the device value beside the active remote value and a note of which copy is newer. Each row can be resolved either way, and each group has bulk actions, including keeping the newest of each.

Resolutions validate the local revision and the remote fingerprint shown in the report before they change local state, then trigger a sync. Choosing a side leaves `updated_at` and `revision` untouched, so it does not read as a fresh edit on other devices. Normal remote rewrites and deletes recheck the complete record before the request and verify the result afterward. Providers without physical duplicate records do not show duplicate repair controls. Google Sheets has no atomic compare-and-swap, so a manual edit in the narrow interval between those requests is detected after the fact rather than prevented. Deleting duplicate Google Sheet rows is the one action that writes directly to the spreadsheet, because a duplicate row has no local counterpart; it verifies every target before sending the batch and checks the result afterward.

## Known Limitations

- Google Sheets is not a real database; MySQL uses the HTTPS API's relational uniqueness and version fencing.
- Sync is polling-based, not real-time.
- Conflict handling is intentionally simple.
- Calendar moving snaps to 15-minute intervals and preserves completed-entry duration; resizing a selected entry snaps to one-minute intervals.
- Merging keeps the selected entry's start, multiplier, and status; it appends the other matching entry's actual elapsed time as one contiguous interval, then marks the other entry deleted locally.
- Deleted entries remain in remote storage as tombstones for 14 days so multiple devices can converge during sync.
- When it does read, each provider currently returns its complete canonical snapshot; the provider change token avoids that read when possible.
- Google-specific read gating only works for a spreadsheet this extension created, because `drive.file` covers nothing else. A spreadsheet configured by hand in an older version reads on every cycle.
- A forgotten timer runs indefinitely. Nothing prompts about it.
- OAuth uses Google device flow and stores personal OAuth credentials in the local Firefox extension profile, unencrypted. See `PRIVACY.md`.
- No team or multi-user support.
- Browser runtime smoke tests run pages against Firefox's extension APIs without contacting live Sheets or Drive.
- No external runtime dependencies. Contributor tooling is installed from the locked npm development dependencies.
- Manifest V3 support in Firefox can vary by version; if a browser rejects the manifest, use a current Firefox release.
- SVG icons are in `extension/icons/`; the icon turns green when a timer is active. Replace them if you want custom branding.

## Development setup

Use Node.js **20 or newer** and npm **8 or newer**. The pinned `web-ext`
tooling requires Node 20; the extension itself does not ship Node modules.

From a clean checkout, install exactly the locked development dependencies:

```bash
npm ci
```

Run the checks with:

```bash
npm test
npm run lint
npm run build:xpi
```

`npm run build:xpi` writes an unsigned, versioned review archive to
`web-ext-artifacts/`. Firefox signing and publication are handled by the
tag-triggered release workflow.

`npm run lint` runs ESLint across JavaScript source, scripts, and tests before
running `web-ext` against the allow-listed extension package. See
[`docs/architecture.md`](docs/architecture.md) for module boundaries, storage,
provider adapters, sync fencing, remote schemas, and ChatGPT trust boundaries. See
[`docs/scaling.md`](docs/scaling.md) for the current bounded-history queries,
benchmark plan, and the unimplemented partitioning design.

## Tests

```bash
npm test
```

Runs the Node test runner over `test/`. It includes fake-IndexedDB transaction/concurrency checks and deterministic Google API barriers before response, response body, and commit acknowledgement. Run `npm ci` first so the pinned static-analysis and packaging tools are available; the extension itself has no runtime npm dependencies.

For a Firefox WebDriver behavior smoke test, install Firefox, `geckodriver`, and `zip`, then run:

```bash
npm run test:browser
```

Set `GECKODRIVER_BIN` or `FIREFOX_BINARY` when they are not on `PATH`. The smoke uses a temporary unsigned extension, opens every extension page, starts/stops/edits a timer, verifies its calendar rendering, exercises provider-aware Options visibility, saves Options, and checks the cross-context lock. It never contacts live Google, MySQL, or Cloudflare APIs; live Sheets/Drive behavior remains covered by deterministic mock state machines.

GitHub Actions runs the Node checks and Firefox behavior smoke on every push and pull request. The release workflow also requires the Firefox smoke before signing, so either test path can block a release.

## Files

```text
package.json
README.md
RELEASE_NOTES.md
PRIVACY.md
docs/
server/mysql-api/
extension/
  manifest.json
  background/
  calendar/
  content/
  icons/
  options/
  popup/
  reconcile/
  src/
  usage/
scripts/
test/
```

`extension/background/` holds the sync alarm, `extension/reconcile/` the comparison screen, `scripts/` the release packaging, and `test/` the unit tests. Only the contents of `extension/` are copied into a release; `test/`, `package.json`, `scripts/`, and documentation are excluded from the package.

OAuth client credentials are stored in Firefox synchronized extension storage through the Options page; access and refresh tokens remain in local IndexedDB. None are part of the extension package.

## Next Improvements

- Add project/task autocomplete from recent entries.
- Add a keyboard shortcut to start and stop the timer.
- Show elapsed time as badge text on the toolbar icon.
- Add a summary report of time by project and task for a chosen period.
- Add entry search across all history.
- Add local backup and restore of the entry database.

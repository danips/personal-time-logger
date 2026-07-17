# Personal Time Logger Extension

A complete MVP browser extension for local-first time tracking with Google Sheets sync. It is intentionally plain: vanilla JavaScript modules, no npm, no bundler, no React, no TypeScript, no external runtime libraries.

## What Is Included

- Popup timer with live elapsed time.
- Project, task, description, billable, and multiply fields in the popup.
- Start, active-timer Stop, header Sync, and Export CSV controls.
- Last 10 non-deleted entries with inline editing.
- Weekly calendar view with draggable time logs.
- Multiple-active-timer warning.
- Options page for Google auth, spreadsheet setup, sync interval, and device ID.
- IndexedDB local storage using database `timelogger_db`.
- Google Sheets API sync with `time_entries` as the canonical remote tab.
- Refresh-token-capable Google device OAuth flow for both Chromium and Firefox.
- Mock Sheets mode for testing without Google OAuth.

## Load In Chromium

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this project folder.
5. Open the extension options page, enter the Google OAuth client ID and secret, and sign in.

## Load In Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `manifest.json` in this folder.
4. Open the extension options page, enter the Google OAuth client ID and secret, and sign in.

For mock testing, enable **Use local mock Sheets data** in Options.

Firefox temporary add-ons are removed when Firefox restarts. The manifest includes a stable Gecko extension ID for installed development builds.

The signed release targets Firefox 142 or newer so it can use Firefox's built-in data-transmission consent declaration required for new AMO submissions.

## Private Firefox Publishing With Automatic Updates

The repository includes a GitHub Actions release workflow for personal distribution:

- Mozilla signs every build as an **unlisted** add-on. It is not listed in AMO search.
- GitHub Pages hosts the signed XPI and the HTTPS Firefox update manifest.
- Pushing a version tag signs and publishes that version automatically.
- Firefox installations using the first signed build receive later versions automatically.

The GitHub Pages files are publicly fetchable because Firefox's updater cannot authenticate to a private download. They do not contain the Google OAuth client ID, client secret, access token, refresh token, spreadsheet ID, or time entries. OAuth credentials are entered once in Options and stored only in each Firefox profile.

### One-time setup

1. Create a GitHub repository and push this project. Keep `config.js`, `time-logger.xpi`, and `web-ext-artifacts/` ignored.
2. Create or sign in to an [addons.mozilla.org developer account](https://addons.mozilla.org/developers/).
3. Open [AMO API credentials](https://addons.mozilla.org/developers/addon/api/key/) and create credentials.
4. In the GitHub repository, open **Settings > Secrets and variables > Actions** and add these repository secrets:
   - `AMO_JWT_ISSUER`: the AMO JWT issuer/API key.
   - `AMO_JWT_SECRET`: the AMO JWT secret.
5. Open **Settings > Pages** and set **Source** to **GitHub Actions**.
6. If the normal Pages URL is not `https://OWNER.github.io/REPOSITORY`, add an Actions repository variable named `FIREFOX_UPDATE_BASE_URL` containing the actual HTTPS base URL without a trailing slash.

### Publish the first version

The Git tag must match `manifest.json` with a leading `v`:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Watch **Actions > Release Firefox extension**. It lints the allow-listed extension files, asks Mozilla to sign an unlisted XPI, creates `updates.json`, and deploys both to GitHub Pages.

On every device, open `https://OWNER.github.io/REPOSITORY/` in Firefox and install the XPI. If Firefox downloads it instead, open `about:addons`, use the gear menu, choose **Install Add-on From File**, and select the downloaded XPI. Then open the extension's Options, save the Google OAuth credentials, and sign in.

### Publish later versions

1. Change `version` in `manifest.json` to a higher numeric version such as `0.1.1`.
2. Commit and push the code.
3. Tag that commit and push the tag:

```bash
git tag v0.1.1
git push origin v0.1.1
```

Firefox periodically checks the deployed `updates.json` and installs a higher signed version. In `about:addons`, **Check for Updates** can trigger an immediate check.

The release package is generated from an explicit allow-list. The local `config.js`, old XPI files, temporary downloads, Git metadata, and development-agent files cannot enter the release. `./xpi_gen.sh https://your-update-host.example/path` can create an unsigned review archive locally, but normal Firefox installations still require the Mozilla-signed XPI.

## Google Cloud OAuth Setup

1. Go to Google Cloud Console.
2. Create or select a project.
3. Configure the OAuth consent screen.
4. If the app is in **Testing**, add your Google account under **Test users**.
5. Create an OAuth client ID.
6. Choose **TVs and Limited Input devices**.
7. Copy the OAuth client ID and client secret.
8. Open the installed extension's Options page.
9. Enter the client ID and secret, click **Save Credentials**, and then click **Sign In**.

When you click **Sign In**, the extension shows a Google device code and opens Google's device authorization page. Leave the options page open while Google authorizes the device. This path is the same in Chromium and Firefox, avoids extension redirect URI mismatch issues, and stores a refresh token locally so the extension can refresh access tokens after the usual one-hour access token expires.

The device-flow credentials and tokens are stored in the local Firefox profile. They are not included in published XPI files or synchronized by the extension.

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

The options page has a **Create/Initialize Spreadsheet** button.

- If the spreadsheet ID field is empty, the extension creates a spreadsheet named `Personal Time Logger`.
- If the spreadsheet ID field has a value, the extension initializes that spreadsheet.
- It creates or uses the tab named `time_entries`.
- It ensures row 1 has exactly these headers:

```text
id, client, project, task, description, start_at, end_at, duration_seconds, billable, tags, status, created_at, updated_at, deleted_at, device_id, revision, multiply
```

The `time_entries` tab is the canonical remote storage. Do not rename it unless you also update the code.

The `multiply` column stores the numeric multiplier value used for that entry, for example `1.5`. Existing rows without this value are treated as not multiplied.

If the popup or options page reports `sheet tab/header missing`, open Options and click **Create/Initialize Spreadsheet**. Sync also tries to repair the `time_entries` tab and header automatically when a spreadsheet ID is configured.

## Mock Mode

Mock mode lets you test the popup, IndexedDB, CSV export, edit flow, and sync flow without Google OAuth.

1. Open the extension's Options page.
2. Enable **Use local mock Sheets data (development only)**.
3. Click **Save Settings**.

Mock remote rows are stored locally in IndexedDB settings. No Google API calls are made.

## Usage

1. Open the popup.
2. Fill in any timer fields.
3. Click **Start**.
4. Click **Stop** when finished.
5. Use the header sync button to push/pull immediately.
6. Use **Export CSV** to download completed, non-deleted local entries.
7. Click a recent entry row to edit it.
8. Use the play button on a recent entry to start a new timer with the same details.
9. Use the calendar button to open the weekly calendar view.
10. Use the merge controls in a recent entry edit panel or selected calendar entry to combine matching completed logs.

Starting, stopping, editing, and deleting always write to IndexedDB first. The UI remains usable when offline or when Google auth is not ready.

If the popup and calendar are open at the same time, local changes broadcast between them and both views refresh automatically.

Set **Duration multiplier** in Options. Entries with **Multiply** checked store `duration_seconds` as actual elapsed seconds times that multiplier, and store the multiplier value itself in the spreadsheet's `multiply` column. Entries without **Multiply** keep their actual duration and leave `multiply` empty.

## Calendar View

The calendar page shows the current week by default and lets you move to previous, next, or selected weeks. Time logs are drawn into a seven-day grid. Entries that overlap in time are shown side by side.

Drag a time log to move it to another day or start time. Dragging snaps the start time to 15-minute intervals such as `09:00`, `09:15`, `09:30`, and `09:45`. Completed entries keep their original duration when moved. Active timers keep running and only their `start_at` value changes.

Click a time log in the calendar to select it and open its edit panel. Click the selected time log again to clear the selection. If another completed log in the week has the exact same project, task, and description, the merge panel lets you combine them into one entry with the total duration of both logs. The same merge action is available from the popup edit panel for recent entries.

Use the edit panel that opens with a selected time log to change its project, task, description, flags, start and end times, or review status. Saving recalculates the duration and syncs the updated entry.

Select a completed time log and click **Duplicate** to create a new entry with the same details, start time, end time, and duration. The copy is saved as a separate entry and synced normally.

## Sync Behavior

Sync happens when:

- the popup opens;
- a timer is started, stopped, edited, or deleted;
- the header sync button is clicked;
- the popup is open and the configured interval elapses.

The sync interval defaults to 60 seconds and is clamped to a minimum of 30 seconds.

On sync, the extension:

1. Reads the whole `time_entries` sheet.
2. Builds an `id -> row index` map.
3. Pushes dirty local entries.
4. Reads the sheet again.
5. Pulls remote rows into IndexedDB.
6. Uses last `updated_at` wins for normal edits.
7. Marks older active timers as `needs_review` if multiple active timers exist.

Deleted entries are marked locally with `deleted_at` first so deletion is local-first and can sync later. During sync, the matching spreadsheet row is updated with the same `deleted_at` tombstone instead of being removed. This lets other devices learn about the deletion and prevents old local copies from being re-created as new remote rows.

## CSV Export

The CSV export includes:

- Project
- Task
- Description
- Start Date
- Start Time
- End Date
- End Time
- Duration (hours)
- Multiplied duration (hours)
- Multiply

`Duration (hours)` is the original elapsed time. `Multiplied duration (hours)` is the effective duration after applying the value in `Multiply`.

Deleted entries and active timers are excluded by default.

## Known Limitations

- Google Sheets is not a real database.
- Sync is polling-based, not real-time.
- Conflict handling is intentionally simple.
- Calendar dragging snaps start times to 15-minute intervals and preserves completed-entry duration.
- Merging keeps one entry, marks the other deleted locally, and requires matching project, task, and description.
- Deleted entries remain in the sheet as tombstones so multiple devices can converge during sync.
- The extension reads the whole `time_entries` sheet on every sync.
- OAuth uses Google device flow so setup is the same in Chromium and Firefox.
- The cross-browser refresh-token path uses Google device flow and stores personal OAuth credentials in the local extension profile.
- No team or multi-user support.
- No unit tests by design.
- No external dependencies by design.
- Manifest V3 support in Firefox can vary by version; if a browser rejects the manifest, use a current Firefox release.
- Placeholder PNG icons are in `icons/`; replace them before store packaging if you want polished branding.

## Files

```text
manifest.json
README.md
popup/
calendar/
options/
src/
icons/
```

OAuth credentials are stored in IndexedDB through the Options page and are not part of the extension package.

## Next Improvements

- Add entry search and filters.
- Add project/task autocomplete from recent entries.
- Add import from CSV.
- Add optional background sync for dirty entries.
- Add packaging notes for store submission.

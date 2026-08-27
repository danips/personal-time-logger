# Privacy Notice

Personal Time Logger stores time entries, settings, and Google OAuth tokens in the local Firefox profile. It stores the Google OAuth client ID and client secret in Firefox synchronized extension storage so Firefox can restore them on the user's other desktop devices.

## Tempo upload

The optional Tempo upload stores the user-entered Tempo API token, author account ID, and Task-to-Jira-issue-ID cache only in the extension's local IndexedDB profile. These values are not put in Firefox Sync. The token is unencrypted within the Firefox profile, like the Google access tokens described below.

## MySQL remote storage API

The optional MySQL backend sends canonical time entries and shared duration configuration to the HTTPS API origin entered by the user. The Firefox extension never connects directly to MySQL and never receives the database credentials. The user-generated API bearer token is stored only in the local Firefox profile, is not put in Firefox Sync, and is sent only in the `Authorization` header to that configured API origin. The API host permission is requested for that exact origin. The extension does not send time-entry data, the token, or database credentials to the extension developer, analytics, Google, or any other endpoint.

When the user clicks **Send to Tempo** for the first time, Firefox asks for optional access to `https://api.tempo.io`. After the user confirms the upload, a fixed message asks the extension background context to send the displayed week's completed worklogs directly to Tempo. The background context reads the locally stored token and uses its host permission so the request does not depend on Tempo providing page CORS headers. Each request contains the configured author account ID and Jira issue ID plus the entry description, local start date, and effective duration. The API token is sent only as the Tempo bearer authorization header and is never included in the page message. Running timers are not sent. No Tempo credential or worklog is sent to the extension developer, analytics, Google, or any endpoint other than Tempo as part of this action.

## ChatGPT usage limits

The optional ChatGPT usage feature requests access to `https://chatgpt.com/*` only after the user presses **Grant ChatGPT access**. It reads usage for the ChatGPT account signed in to the normal Firefox profile; it does not create containers or open ChatGPT tabs.

The feature fetches ChatGPT's fixed `/api/auth/session` endpoint from the extension context, reads the current access token in memory, and uses it only to authenticate one fixed `GET` request to ChatGPT's private `backend-api/wham/usage` endpoint. This endpoint is experimental and unsupported. The token is never persisted, logged, copied to a URL, synchronized, exported, or sent to any endpoint other than ChatGPT's usage service. The extension does not read ChatGPT cookies through the cookies API, passwords, local-storage tokens, chats, prompts, or unrelated page content.

ChatGPT usage data stays in the local IndexedDB profile. The single local snapshot may contain the plan type, limit status, 5-hour and weekly used and remaining percentages, reset times, collection timestamps, and safe error state. The extension does not store raw ChatGPT user IDs, account IDs, raw endpoint responses, session data, passwords, access tokens, or cookie values. It does not send ChatGPT usage data to the extension developer, a project backend, telemetry, exports, or Firefox Sync.

**Clear ChatGPT usage data** removes the local snapshot, safe error state, and consent setting without touching the Firefox session. Removing the extension or clearing its site data also removes the local records.

## How credentials are stored

The OAuth client ID and client secret are held in Firefox synchronized extension storage. Firefox Sync sends them through the user's Mozilla account to other desktop Firefox profiles where Add-ons sync is enabled. Access and refresh tokens are held only in the extension's IndexedDB database and are never put in Firefox Sync. All of these values are unencrypted within each local Firefox profile. Extensions have no access to OS keychains, so there is no encrypted alternative available.

Two practical consequences:

- Anyone who can read the Firefox profile directory, or who runs code in the profile, can read these values. Full-disk encryption and a locked user account are the effective protections.
- The client secret issued to a desktop OAuth client is not a confidential secret. Google's device authorization flow expects it to be distributed to clients, and it grants nothing on its own: an attacker also needs the user to complete a sign-in.

The client ID and client secret can be synchronized between desktop Firefox devices, but each device must complete Google sign-in separately. Signing out removes only that device's stored tokens. Access can also be revoked at any time from the Google Account permissions page, which invalidates the stored tokens regardless of what remains on disk.

When the user signs in or synchronizes, the extension sends authentication information to Google's OAuth endpoints and sends time-entry data to the Google Sheets API. This is necessary to synchronize with the spreadsheet selected by the user. The extension does not send data to the extension developer, use analytics, sell data, or share data with advertising services.

The user can remove locally stored data by removing the extension or clearing its site data. Clearing the client ID and client secret in Options removes their values from synchronized extension storage. The user can remove synchronized time entries from the selected Google Sheet and can revoke OAuth access in their Google Account.

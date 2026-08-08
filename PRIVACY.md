# Privacy Notice

Personal Time Logger stores time entries, settings, and Google OAuth tokens in the local Firefox profile. It stores the Google OAuth client ID and client secret in Firefox synchronized extension storage so Firefox can restore them on the user's other desktop devices.

## ChatGPT usage limits

The optional ChatGPT usage feature requests access to `https://chatgpt.com/*` only after the user presses **Grant ChatGPT access**. It uses Firefox contextual identities so simultaneously connected ChatGPT accounts remain in separate cookie stores. Firefox's built-in containers are sufficient; Mozilla's Multi-Account Containers extension is optional and is not required by Personal Time Logger.

The feature sends one fixed, session-authenticated `GET` request to ChatGPT's private `backend-api/wham/usage` endpoint from a ChatGPT tab in the selected container. This endpoint is experimental and unsupported. If Firefox returns HTTP 401 for the isolated content-script request, the extension retries in the ChatGPT page's `MAIN` JavaScript world. That fallback fetches ChatGPT's fixed `/api/auth/session` endpoint, reads the current access token only in page-memory, and uses it only to authenticate the one fixed usage request. The token is never returned to an extension page, persisted, logged, copied to a URL, synchronized, exported, or sent to any endpoint other than ChatGPT's usage service. Code running on `chatgpt.com` can observe or interfere with data flowing through this page-world fallback, as it can with the site's own requests. The extension does not read ChatGPT cookies, passwords, local-storage tokens, chats, prompts, or unrelated page content. The `cookies` manifest permission is present only because Firefox requires it for container-tab use; the extension never calls cookie-reading APIs.

ChatGPT usage data stays in the local IndexedDB profile. The local records may contain the user-defined account label, email address, plan type, limit status, used and remaining percentages, reset time, collection timestamps, the Firefox container binding, an account fingerprint, and safe error state. The account fingerprint is a salted SHA-256 duplicate-check value. The extension does not store raw ChatGPT user IDs, account IDs, raw endpoint responses, session data, passwords, access tokens, or cookie values. It does not send ChatGPT usage data to the extension developer, a project backend, telemetry, exports, or Firefox Sync.

Disconnecting removes the local ChatGPT binding, fingerprint, cached snapshot, and related local state. It deliberately does not delete the Firefox container or clear its cookies; the user controls those actions. **Clear ChatGPT usage data** removes all ChatGPT usage records and the local fingerprint salt without touching containers or sessions. Removing the extension or clearing its site data removes the local records.

## How credentials are stored

The OAuth client ID and client secret are held in Firefox synchronized extension storage. Firefox Sync sends them through the user's Mozilla account to other desktop Firefox profiles where Add-ons sync is enabled. Access and refresh tokens are held only in the extension's IndexedDB database and are never put in Firefox Sync. All of these values are unencrypted within each local Firefox profile. Extensions have no access to OS keychains, so there is no encrypted alternative available.

Two practical consequences:

- Anyone who can read the Firefox profile directory, or who runs code in the profile, can read these values. Full-disk encryption and a locked user account are the effective protections.
- The client secret issued to a desktop OAuth client is not a confidential secret. Google's device authorization flow expects it to be distributed to clients, and it grants nothing on its own: an attacker also needs the user to complete a sign-in.

The client ID and client secret can be synchronized between desktop Firefox devices, but each device must complete Google sign-in separately. Signing out removes only that device's stored tokens. Access can also be revoked at any time from the Google Account permissions page, which invalidates the stored tokens regardless of what remains on disk.

When the user signs in or synchronizes, the extension sends authentication information to Google's OAuth endpoints and sends time-entry data to the Google Sheets API. This is necessary to synchronize with the spreadsheet selected by the user. The extension does not send data to the extension developer, use analytics, sell data, or share data with advertising services.

The user can remove locally stored data by removing the extension or clearing its site data. Clearing the client ID and client secret in Options removes their values from synchronized extension storage. The user can remove synchronized time entries from the selected Google Sheet and can revoke OAuth access in their Google Account.

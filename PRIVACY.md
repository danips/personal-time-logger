# Privacy Notice

Personal Time Logger stores time entries, settings, Google OAuth credentials, and Google OAuth tokens in the local Firefox profile.

## How credentials are stored

The OAuth client ID, client secret, access token, and refresh token are held unencrypted in the extension's IndexedDB database inside the Firefox profile directory. Extensions have no access to OS keychains, so there is no encrypted alternative available.

Two practical consequences:

- Anyone who can read the Firefox profile directory, or who runs code in the profile, can read these values. Full-disk encryption and a locked user account are the effective protections.
- The client secret issued to a desktop OAuth client is not a confidential secret. Google's device authorization flow expects it to be distributed to clients, and it grants nothing on its own: an attacker also needs the user to complete a sign-in.

Each device is configured separately, so credentials are never synced between browsers or devices by this extension. Signing out removes the stored tokens. Removing the extension or clearing its site data removes everything, credentials included. Access can also be revoked at any time from the Google Account permissions page, which invalidates the stored tokens regardless of what remains on disk.

When the user signs in or synchronizes, the extension sends authentication information to Google's OAuth endpoints and sends time-entry data to the Google Sheets API. This is necessary to synchronize with the spreadsheet selected by the user. The extension does not send data to the extension developer, use analytics, sell data, or share data with advertising services.

The user can remove locally stored data by removing the extension or clearing its site data. The user can remove synchronized time entries from the selected Google Sheet and can revoke OAuth access in their Google Account.

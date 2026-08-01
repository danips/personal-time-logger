# Privacy Notice

Personal Time Logger stores time entries, settings, and Google OAuth tokens in the local Firefox profile. It stores the Google OAuth client ID and client secret in Firefox synchronized extension storage so Firefox can restore them on the user's other desktop devices.

## How credentials are stored

The OAuth client ID and client secret are held in Firefox synchronized extension storage. Firefox Sync sends them through the user's Mozilla account to other desktop Firefox profiles where Add-ons sync is enabled. Access and refresh tokens are held only in the extension's IndexedDB database and are never put in Firefox Sync. All of these values are unencrypted within each local Firefox profile. Extensions have no access to OS keychains, so there is no encrypted alternative available.

Two practical consequences:

- Anyone who can read the Firefox profile directory, or who runs code in the profile, can read these values. Full-disk encryption and a locked user account are the effective protections.
- The client secret issued to a desktop OAuth client is not a confidential secret. Google's device authorization flow expects it to be distributed to clients, and it grants nothing on its own: an attacker also needs the user to complete a sign-in.

The client ID and client secret can be synchronized between desktop Firefox devices, but each device must complete Google sign-in separately. Signing out removes only that device's stored tokens. Access can also be revoked at any time from the Google Account permissions page, which invalidates the stored tokens regardless of what remains on disk.

When the user signs in or synchronizes, the extension sends authentication information to Google's OAuth endpoints and sends time-entry data to the Google Sheets API. This is necessary to synchronize with the spreadsheet selected by the user. The extension does not send data to the extension developer, use analytics, sell data, or share data with advertising services.

The user can remove locally stored data by removing the extension or clearing its site data. Clearing the client ID and client secret in Options removes their values from synchronized extension storage. The user can remove synchronized time entries from the selected Google Sheet and can revoke OAuth access in their Google Account.

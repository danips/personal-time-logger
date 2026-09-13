# Privacy Notice

Personal Time Logger stores time entries, settings, diagnostics, and provider
credentials in the local Firefox profile. MySQL is the current authoritative
remote backend; Cloudflare Worker + D1 is a supported user-owned alternative.
The extension does not send data to the project developer, advertising
services, or analytics services.

## Remote storage

The selected API provider receives canonical time entries and shared duration
configuration at the HTTPS origin configured by the user. The extension sends
the user-entered bearer token only in the `Authorization` header to that exact
origin. It never connects directly to MySQL or receives database credentials.
The Cloudflare Worker stores only the token's SHA-256 digest. Explicit connection
testing or setup may contact the prepared provider when the user requests it;
normal sync and reconciliation use only the activated provider.

## Tempo upload

The optional Tempo upload stores the user-entered Tempo API token, author
account ID, and task-to-issue mapping only in local IndexedDB. The token is
sent only as the Tempo bearer authorization header; worklog content is sent
only to Tempo. Running timers are not uploaded.

## ChatGPT usage limits

The optional ChatGPT usage feature requests `chatgpt.com` access only after the
user grants it. It reads the normal Firefox profile's session and one fixed
usage endpoint. Its access token remains in memory for the request and is
never persisted, synchronized, logged, exported, or sent elsewhere. The
sanitized usage snapshot and consent state stay in local IndexedDB.

## Credentials and legacy cleanup

MySQL, Cloudflare D1, and Tempo tokens remain local and are excluded from
backups, diagnostics, URLs, and release artifacts. The manifest temporarily
retains Firefox's `storage` permission so an upgrade can remove two legacy
OAuth credential keys that older versions placed in synchronized storage. On
startup, a small removal-only scrub removes those two exact synchronized keys
and related legacy local state; it performs no synchronized-storage reads or
writes and makes no network request. It does not migrate a legacy profile to a
provider, remove supported MySQL/D1 state, or remove entries and unrelated
settings. The permission can be removed in a later compatibility release
after existing profiles have had an opportunity to run the scrub.

The user can remove all local records by removing the extension or clearing its
site data. API providers and Tempo are user-configured services; their remote
retention and deletion policies apply to data already uploaded there.

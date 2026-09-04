# Personal Time Logger 0.1.70

- Add a local Analytics dashboard with fair automatic period comparisons and custom date ranges.
- Report effective time by project, task, and description while keeping session and context-switch metrics based on actual elapsed time.
- Highlight deterministic data-quality anomalies, including overlaps, missing fields, review flags, short/long sessions, and stale active timers.
- Add popup navigation plus release-package and Firefox smoke coverage for Analytics.

# Personal Time Logger 0.1.54

- Allow validated Firefox extension origins without maintaining a per-device CORS allowlist.
- Distinguish server-side MySQL origin rejections from missing Firefox host permissions.
- Add deterministic MySQL CORS configuration tests.

# Personal Time Logger 0.1.53

- Hide Google-specific settings when MySQL is the active/prepared backend.
- Show Google setup automatically when Google Sheets is active or selected as a migration target.
- Make local/remote reconciliation provider-neutral and identify the active remote backend.
- Hide Google Sheet duplicate-row repair when the active backend does not support duplicate remote records.
# Unreleased

- Added an optional user-owned Cloudflare Worker + D1 remote backend with a
  digest-only Worker secret, atomic versioned mutations, local-first migration,
  and setup controls in Options. See `server/cloudflare-d1/README.md` for
  deployment and operations.

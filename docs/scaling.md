# History scaling strategy

The local UI is deliberately bounded by time range. The popup initially queries
the current week through IndexedDB and **Load more** expands the range by another
week; if the current week is empty, it jumps directly to the newest populated
week. A one-entry indexed probe determines whether older history exists. The
calendar queries only entries that can intersect its displayed week.

The entry store has indexes for dirty counts, deletion, start and end time,
status, and active timers. These keep local history views and status checks from
scanning the full database. Sync currently reads the complete canonical snapshot
from the active remote provider; local indexes cannot make that remote read
smaller. A provider change token can gate that full read out entirely. Google
Sheets uses a Drive modification time; MySQL uses the API change sequence.

Before introducing an archive threshold, run a Firefox browser-profile benchmark
with 10,000, 50,000, and 100,000 realistic entries. Record cold and warm timings,
peak memory, and the number of remote-provider requests for each size:

1. Open the popup and expand several weeks of history, including an empty current
   week that must jump to the newest populated week.
2. Switch the calendar through a recent week and a week with one long-running
   entry crossing into it.
3. Run an idle sync, a sync with one dirty update, and a forced sync after a
   remote edit.
4. Repeat an append/retry and reconciliation scan at each size.

Do not choose an automatic archive threshold from synthetic JavaScript timings.
The cutoff must be based on Firefox profile storage and realistic Sheets response
sizes.

## Remote partition design

If those measurements establish a need, the partition design must be owned by
each provider. Google Sheets could retain `time_entries` as the active tab and
create append-only archive tabs named `time_entries_YYYY`; MySQL would need an
equivalent API/schema partition contract. New and edited entries would stay in
the active partition until its calendar year is closed. A verified migration
would copy a year into the archive partition, retain its tombstones, and write a
versioned partition manifest in shared configuration.

Every compatible device would need to read the partition manifest before
syncing. Reconciliation and displayed-week Tempo upload could then read only the
partitions covering their selected range. Compatibility behavior for clients
that predate partitioning must be designed before rollout; they must not silently
interpret an incomplete active partition as the complete history.

This repository intentionally has no automatic partitioning or archive migration.
It needs benchmark data, an explicit backup confirmation, migration tests, and a
compatible manifest rollout before a remotely destructive move is safe.

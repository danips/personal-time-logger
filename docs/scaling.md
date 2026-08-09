# History scaling strategy

The local UI is deliberately bounded: the popup reads the newest 200 entries
and adds another 200 only when requested; the calendar asks IndexedDB for rows
that can intersect its displayed week. The entry store has indexes for dirty,
deleted, start, end, status, and active-timer queries. Sync still reads the
complete selected spreadsheet because the current `time_entries` tab is one
canonical ordered dataset; local indexes cannot make that remote read smaller.

Before introducing an archive threshold, run the following browser-profile
benchmark on supported Firefox and Chromium versions with 10,000, 50,000, and
100,000 realistic entries. Record cold and warm timings, peak memory, and the
number of Sheets/Drive requests for each size:

1. Open the popup and render its first and sixth history pages.
2. Switch the calendar through a recent week and a week with one long-running
   entry crossing into it.
3. Run an idle sync, a sync with one dirty update, and a forced sync after a
   remote edit.
4. Repeat an append/retry and reconciliation scan at each size.

Do not make an automatic archival choice from synthetic JavaScript timings.
The cutoff must be based on browser storage and real Sheets response sizes.

## Remote partition design

When those measurements establish a need, retain `time_entries` as the active
tab and create append-only archive tabs named `time_entries_YYYY`. New and
edited entries stay in the active tab until their calendar year is closed; a
verified migration copies a year into its archive tab, keeps tombstones there,
and writes a versioned partition manifest in `config`. Every device must read
the manifest before syncing, so old clients continue to use the unpartitioned
layout rather than silently losing history. Reconciliation and CSV export read
only the partitions covering their selected range, while a full-history export
may stream one partition at a time.

This repository intentionally has no automatic migration yet. It needs the
benchmark data above, an explicit backup/export confirmation, and a compatible
manifest rollout before a remotely destructive move is safe.

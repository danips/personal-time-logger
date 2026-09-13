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

## R34 benchmark result — 2026-09-12

The reproducible benchmark is [
`scripts/history-benchmark.mjs`](../scripts/history-benchmark.mjs). It creates a
fresh temporary Firefox WebDriver profile for each size, seeds the v5 IndexedDB
store with the fixed `r34-history-v1` fixture, opens Popup and Calendar, and
measures bounded interval reads, history expansion, reconciliation, backup
serialization, and migration digest/preview. The exact report is
[`docs/benchmarks/r34-history-benchmark.json`](benchmarks/r34-history-benchmark.json).
Run it with:

```bash
GECKODRIVER_BIN=/usr/local/bin/geckodriver node scripts/history-benchmark.mjs
```

The recorded Firefox results were:

| Entries | Seed | Popup query / visits | Calendar query / visits | Reconcile compare | Backup | Migration |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 814 ms | 8 ms / 108 | 79 ms / 84 | 131 ms | 263 ms / 5.72 MiB | 37 ms |
| 50,000 | 3,871 ms | 26 ms / 534 | 535 ms / 414 | 560 ms | 1,240 ms / 28.65 MiB | 252 ms |
| 100,000 | 7,869 ms | 37 ms / 1,062 | 1,078 ms / 822 | 1,118 ms | 2,621 ms / 57.41 MiB | 444 ms |

Each fixture spans 730 days, includes dense same-day overlaps, a long-running
entry crossing the benchmark calendar week, an active entry, tombstones, and
dirty entries. Idle, dirty, and forced sync request counts are recorded as the
synthetic plans 1, 3, and 1 respectively; no provider endpoint was contacted.
Firefox exposed neither `measureUserAgentSpecificMemory` nor
`performance.memory`, so peak memory is recorded as unavailable rather than
estimated. The report therefore provides a Firefox local-storage/query
baseline, not a live Sheets payload or provider-latency benchmark.

Decision: do not add archives, delta APIs, workers, health caching, or an
authentication read helper from this run. Popup range reads remain small at
100k, backup remains below the current 128 MiB validation limit, and the
calendar query is 1.078 s on this run. The highest-value bounded follow-up is
to measure and, only if real profiles exceed a user-facing budget, reduce the
calendar interval cursor work (currently 822 visits for the displayed week)
without changing complete-history sync or conflict semantics. That follow-up
is conditional; this card does not change the schema or storage architecture.

### R34a repeat and budget decision — 2026-09-12

R34a repeated the same seed and procedure on this host using fresh isolated
Firefox profiles. The repeat report is
[`r34a-history-benchmark.json`](benchmarks/r34a-history-benchmark.json). The
displayed-week Calendar read measured 78 ms at 10k, 517 ms at 50k, and 1,167
ms at 100k entries. The long-running entry remained included. Popup reads were
5/26/39 ms for 10k/50k/100k; memory remained unavailable; and provider request
counts remained simulated rather than live.

For this benchmark host/profile class, the provisional user-facing budget is
1,500 ms for a displayed-week Calendar database read at 100,000 local entries.
This is a measured usability guardrail, not a release SLA: hardware, Firefox
build, profile state, and entry distribution can change the result. Both
100k runs are below the budget (1,078 ms and 1,167 ms), so no production query
or index optimization is justified by the available evidence. R34a therefore
leaves archives, delta APIs, workers, and virtualization deferred; repeat the
benchmark on a representative deployment profile before changing storage
architecture.

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

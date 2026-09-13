# Time model decisions

These decisions define how the extension allocates duration between calendar,
popup totals, and Tempo upload.

## D-01 — Multiplied time at boundaries

Calendar blocks begin at the actual start timestamp and extend to the effective
duration. The lower multiplier-added tail is visually distinct so overlapping
effective work is visible during review. A completed entry's stored
`duration_seconds` is its effective duration; when a day, week, or upload
period clips the actual interval, that effective duration is divided
proportionally by elapsed overlap. The visual tail never moves time into a
later period for daily totals, sync, or Tempo uploads.

## D-02 — Merge

The entry selected for editing is the merge target. Its start time, multiplier,
and status are retained. The source's **actual elapsed** duration is appended to
the target, so the result is one contiguous interval beginning at the target's
start; any gap between the original records is compacted. The source is then a
tombstone. Source and target must still describe the same project, task, and
description, but their multipliers may differ.

## D-03 — Conflicts

Entries use optimistic revisions for local writes. A reconciliation choice is
validated against the local revision and the provider's complete remote
reference observed by the user; divergent edits remain a conflict until
explicitly resolved. Sync mutations use the provider's concurrency mechanism
and verify the intended result afterward. MySQL and Cloudflare D1 use API
version fences. A successful local resolution is a durable operation rather
than a synthetic timestamp bump.

## D-04 — Displayed-week Tempo allocation

Calendar Tempo upload contains only each completed entry's effective allocation
within the displayed week. Time is apportioned across the week boundary instead
of assigning the whole entry to either week. Running entries are excluded because
Tempo requires a fixed positive duration.

Choosing an individual-day send reveals header checkboxes that narrow the send
to chosen local civil dates. After clipping to the displayed week, each entry is
split across the local civil days it intersects. Its exact effective seconds are
rounded once per entry: each day is floored, remaining seconds go to descending
fractional remainders with local-date order as the tie-breaker, and only then is
the selected-day filter applied. This keeps a selected day identical whether it
is sent alone or as part of the full week, including on 23-hour, 24-hour, and
25-hour civil days. Zero-second allocations are omitted. A worklog's date is
the local date of its daily allocation.

## Second-audit decisions

### D1 — Remote optimistic concurrency

Every remote update or deletion checks the provider reference observed in the
snapshot. MySQL and Cloudflare D1 use an API remote version and verify the
affected records after mutation. Append ambiguity is confirmed by a fresh
versioned snapshot before local acknowledgement.

### D2 — Cross-device conflict ordering

When records have equal timestamps but different fingerprints, the extension
shows an explicit conflict. It does not select a winner by local array order,
row order, or device clock value.

### D3 — Append idempotency

After an ambiguous remote append result, the active provider re-reads by entry
ID and its expected provider reference before retrying. Only a confirmed
matching record can be acknowledged as synchronized; a same-ID record with
different contents is a conflict.

### D4 — DST input behavior

The editor rejects nonexistent local times during a spring-forward transition.
It also rejects a repeated fall-back local time as ambiguous rather than
silently choosing one occurrence. The current editor has no occurrence/offset
selector, so that local wall time cannot be saved directly.

### D5 — Multiplier domain

Stored multipliers are decimal values from **1.000** through **5.001**,
inclusive, with at most three decimal places. Values outside that domain or
with greater precision are rejected instead of rounded silently.

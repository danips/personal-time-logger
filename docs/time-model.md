# Time model decisions

These decisions define how the extension allocates duration between calendar,
popup totals, and CSV export.

## D-01 — Multiplied time at boundaries

Calendar blocks always use the actual start and end timestamps. A completed
entry's stored `duration_seconds` is its effective duration; when a day, week,
or export period clips the actual interval, that effective duration is divided
proportionally by elapsed overlap. A multiplier never creates an additional
visual tail or moves time into a later period.

## D-02 — Merge

The entry selected for editing is the merge target. Its start time, multiplier,
and status are retained. The source's **actual elapsed** duration is appended to
the target, so the result is one contiguous interval beginning at the target's
start; any gap between the original records is compacted. The source is then a
tombstone. Source and target must still describe the same project, task, and
description, but their multipliers may differ.

## D-03 — Conflicts

Entries use optimistic revisions for local writes. A sync/reconcile choice is
validated against the local revision and remote fingerprint observed by the
user; divergent edits remain a conflict until explicitly resolved. A successful
resolution is a durable operation rather than a synthetic timestamp bump.

## D-04 — Displayed-week export

Calendar CSV export contains only each entry's allocation within the displayed
week. Every row includes the original entry ID and machine-readable allocation
start/end timestamps, so the clipped record remains traceable. A whole-entry
export is intentionally not produced by this command.

## Second-audit decisions

### D1 — Remote optimistic concurrency

Every remote update or deletion is fenced by the complete serialized row
fingerprint observed in the snapshot. The extension re-reads and compares that
row immediately before mutation, then verifies the intended result afterward.
A mismatch is a reconciliation conflict; the extension never overwrites it.

### D2 — Cross-device conflict ordering

When records have equal timestamps but different fingerprints, the extension
shows an explicit conflict. It does not select a winner by local array order,
row order, or device clock value.

### D3 — Append idempotency

After an ambiguous spreadsheet append result, the extension re-reads by entry
ID and expected fingerprint before retrying. Only a confirmed matching row can
be acknowledged as synchronized.

### D4 — DST input behavior

The editor rejects nonexistent local times during a spring-forward transition.
For a repeated fall-back local time, it requires an explicit occurrence/offset
choice rather than silently choosing one instant.

### D5 — Multiplier domain

Stored multipliers are decimal values from **1.000** through **5.001**,
inclusive, with at most three decimal places. Values outside that domain or
with greater precision are rejected instead of rounded silently.

### D6 — Spreadsheet schema recovery

Automatic schema repair is limited to an empty tab or an exact, tested legacy
schema. Any other header mismatch stops before writing and requires guided
recovery; matching column count alone is never sufficient.

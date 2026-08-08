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

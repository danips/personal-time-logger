// The single ordered contract for fields that cross the persisted-entry
// boundary. Local sync bookkeeping and provider-specific fields stay outside
// this list.
export const ENTRY_FIELDS = Object.freeze([
  "id",
  "project",
  "task",
  "description",
  "start_at",
  "end_at",
  "duration_seconds",
  "status",
  "created_at",
  "updated_at",
  "deleted_at",
  "device_id",
  "revision",
  "multiply"
]);

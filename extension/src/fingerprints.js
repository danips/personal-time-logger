// Fingerprints are serialized values, not delimiter-joined strings. Supported
// text fields may contain any Unicode character, including the old delimiter.
export const CANONICAL_ENTRY_FIELDS = Object.freeze([
  "id", "project", "task", "description", "start_at", "end_at", "duration_seconds",
  "status", "created_at", "updated_at", "deleted_at", "device_id", "revision", "multiply"
]);

export function canonicalEntryValues(entry) {
  return CANONICAL_ENTRY_FIELDS.map((field) => entry?.[field]);
}

export function entryFingerprint(entry) {
  return JSON.stringify(canonicalEntryValues(entry));
}

export function rawRowFingerprint(cells) {
  return JSON.stringify(Array.isArray(cells) ? cells : []);
}

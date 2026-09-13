import { ENTRY_FIELDS } from "./entry-contract.js";

// Fingerprints are serialized values, not delimiter-joined strings. Supported
// text fields may contain any Unicode character, including the old delimiter.
export const CANONICAL_ENTRY_FIELDS = ENTRY_FIELDS;

export function canonicalEntryValues(entry) {
  return CANONICAL_ENTRY_FIELDS.map((field) => entry?.[field]);
}

export function entryFingerprint(entry) {
  return JSON.stringify(canonicalEntryValues(entry));
}

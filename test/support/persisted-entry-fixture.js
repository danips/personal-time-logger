import assert from "node:assert/strict";

import { ENTRY_FIELDS } from "../../extension/src/entry-contract.js";

const LOCAL_FIELDS = new Set(["dirty", "last_sync_at", "sync_error"]);
const DEFAULT_ENTRY = Object.freeze({
  id: "entry-1",
  project: "Project",
  task: "Task",
  description: "Description",
  start_at: "2026-08-08T09:00:00.000Z",
  end_at: "2026-08-08T10:00:00.000Z",
  duration_seconds: 3600,
  status: "ok",
  created_at: "2026-08-08T09:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
  deleted_at: "",
  device_id: "device",
  revision: 1,
  multiply: ""
});

/** Build an ordinary valid persisted record without invoking runtime normalization. */
export function persistedEntryFixture(overrides = {}) {
  const entry = { ...DEFAULT_ENTRY, ...overrides };
  const persistedKeys = Object.keys(entry).filter((key) => !LOCAL_FIELDS.has(key)).sort();
  assert.deepEqual(persistedKeys, [...ENTRY_FIELDS].sort(), "fixture must match the persisted entry contract");
  return entry;
}

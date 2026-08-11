import { getSetting, mutateEntries, mutateEntry, mutateEntryState, mutateSetting, putEntry } from "./db.js";
import { notifyEntriesChanged } from "./events.js";
import { ERROR_CODE } from "./error-codes.js";
import { SETTING_KEY } from "./setting-keys.js";
import { durationSeconds, nowIso, uuid } from "./time.js";

export const SHEET_HEADERS = [
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
];

const CREATE_FIELDS = new Set(["project", "task", "description", "multiply"]);
const EDITABLE_FIELDS = new Set([
  "project",
  "task",
  "description",
  "start_at",
  "end_at",
  "status",
  "multiply",
  "deleted_at"
]);

function entryModelError(message) {
  const error = new TypeError(message);
  error.code = ERROR_CODE.ENTRY_INVALID;
  return error;
}

function validTimestamp(value) {
  return typeof value === "string" && value && Number.isFinite(new Date(value).getTime());
}

function assertAllowedFields(values, allowed, kind) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw entryModelError(`${kind} must be an object.`);
  }
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) throw entryModelError(`${key} cannot be changed by an entry ${kind.toLowerCase()}.`);
  }
}

function decodeText(value, field) {
  if (typeof value !== "string") throw entryModelError(`${field} must be text.`);
  return value.trim();
}

/** Decodes the form fields accepted when a new running entry is created. */
export function decodeEntryCreate(fields) {
  assertAllowedFields(fields, CREATE_FIELDS, "entry create request");
  const decoded = {};
  for (const field of ["project", "task", "description"]) {
    if (Object.hasOwn(fields, field)) decoded[field] = decodeText(fields[field], field);
  }
  if (Object.hasOwn(fields, "multiply")
    && typeof fields.multiply !== "boolean"
    && typeof fields.multiply !== "string"
    && typeof fields.multiply !== "number") {
    throw entryModelError("multiply must be a checkbox value or numeric multiplier.");
  }
  if (Object.hasOwn(fields, "multiply")) decoded.multiply = fields.multiply;
  return decoded;
}

/** Decodes a mutation payload and rejects identity and sync bookkeeping fields. */
export function decodeEntryEdit(changes) {
  assertAllowedFields(changes, EDITABLE_FIELDS, "entry edit request");
  const decoded = {};
  for (const field of ["project", "task", "description"]) {
    if (Object.hasOwn(changes, field)) decoded[field] = decodeText(changes[field], field);
  }
  for (const field of ["start_at", "end_at", "deleted_at"]) {
    if (!Object.hasOwn(changes, field)) continue;
    const value = changes[field];
    if (field === "end_at" && value === "") {
      decoded[field] = "";
      continue;
    }
    if (!validTimestamp(value)) throw entryModelError(`${field} must be a valid timestamp.`);
    decoded[field] = value;
  }
  if (Object.hasOwn(changes, "status")) {
    if (changes.status !== "ok" && changes.status !== "needs_review") {
      throw entryModelError("status must be ok or needs_review.");
    }
    decoded.status = changes.status;
  }
  if (Object.hasOwn(changes, "multiply")) {
    const value = changes.multiply;
    if (typeof value !== "boolean" && typeof value !== "string" && typeof value !== "number") {
      throw entryModelError("multiply must be a checkbox value or numeric multiplier.");
    }
    decoded.multiply = value;
  }
  return decoded;
}

/**
 * Strictly decodes a record crossing the local/remote persistence boundary.
 * Construction code may still use normalizeEntry to supply intentional defaults;
 * persisted records must already carry every required field.
 */
export function decodePersistedEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw entryModelError("Persisted entry must be an object.");
  for (const field of ["id", "project", "task", "description", "start_at", "end_at", "duration_seconds", "status", "created_at", "updated_at", "deleted_at", "device_id", "revision", "multiply"]) {
    if (!Object.hasOwn(entry, field)) throw entryModelError(`Persisted entry is missing ${field}.`);
  }
  if (typeof entry.id !== "string" || !entry.id.trim()) throw entryModelError("id must be a non-empty string.");
  for (const field of ["project", "task", "description", "device_id"]) {
    if (typeof entry[field] !== "string") throw entryModelError(`${field} must be text.`);
  }
  for (const field of ["start_at", "created_at", "updated_at"]) {
    if (!validTimestamp(entry[field])) throw entryModelError(`${field} must be a valid timestamp.`);
  }
  for (const field of ["end_at", "deleted_at"]) {
    if (entry[field] !== "" && !validTimestamp(entry[field])) throw entryModelError(`${field} must be empty or a valid timestamp.`);
  }
  if (!Number.isFinite(Number(entry.duration_seconds)) || Number(entry.duration_seconds) < 0) {
    throw entryModelError("duration_seconds must be a non-negative number.");
  }
  if (!Number.isInteger(Number(entry.revision)) || Number(entry.revision) < 1) {
    throw entryModelError("revision must be a positive integer.");
  }
  if (entry.status !== "ok" && entry.status !== "needs_review") throw entryModelError("status must be ok or needs_review.");
  if (entry.multiply !== "" && !normalizeMultiplierText(entry.multiply)) {
    throw entryModelError("multiply must be empty or a valid numeric multiplier.");
  }
  return normalizeEntry(entry);
}

export async function getDeviceId() {
  return mutateSetting(SETTING_KEY.DEVICE_ID, (deviceId) => deviceId || uuid());
}

async function getDurationMultiplier() {
  return normalizeMultiplierText(await getSetting(SETTING_KEY.DURATION_MULTIPLIER, "1")) || "1";
}

export function normalizeMultiplierText(value) {
  const text = String(value == null ? "" : value).trim().replace(",", ".");
  if (!text) return "";
  if (!/^\d+(?:\.\d{1,3})?$/.test(text)) return "";
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric < 1 || numeric > 5.001) return "";
  return numeric.toFixed(3);
}

/**
 * Stored multiply values are always a numeric string or "". Checkbox booleans
 * are resolved to the configured multiplier by selectedMultiplyValue before they
 * reach storage, so they are treated as "no multiplier" here.
 */
function normalizeMultiplyValue(value) {
  if (typeof value === "boolean" || value == null || value === "") return "";
  if (value === "true" || value === "TRUE" || value === "false" || value === "FALSE") return "";
  return normalizeMultiplierText(value);
}

export function hasMultiplier(entry) {
  return Boolean(normalizeMultiplyValue(entry && entry.multiply));
}

function sameMergeFields(first, second) {
  return first.project === second.project
    && first.task === second.task
    && first.description === second.description;
}

function actualDurationMs(entry) {
  return durationSeconds(entry.start_at, entry.end_at) * 1000;
}

export function canMergeEntries(firstEntry, secondEntry) {
  if (!firstEntry || !secondEntry || firstEntry.id === secondEntry.id) return false;
  const first = normalizeEntry(firstEntry);
  const second = normalizeEntry(secondEntry);
  return !first.deleted_at
    && !second.deleted_at
    && Boolean(first.end_at)
    && Boolean(second.end_at)
    && sameMergeFields(first, second);
}

async function selectedMultiplyValue(value) {
  if (value === true || value === "true" || value === "TRUE") return String(await getDurationMultiplier());
  return normalizeMultiplyValue(value);
}

function computedDurationSeconds(startAt, endAt, multiply) {
  const actual = durationSeconds(startAt, endAt);
  const multiplier = Number(normalizeMultiplyValue(multiply));
  if (!multiplier) return actual;
  return Math.round(actual * multiplier);
}

export function normalizeEntry(entry) {
  const duration = Number(entry.duration_seconds) || 0;
  const normalized = {
    id: entry.id || uuid(),
    project: entry.project || "",
    task: entry.task || "",
    description: entry.description || "",
    start_at: entry.start_at || nowIso(),
    end_at: entry.end_at || "",
    duration_seconds: duration,
    status: entry.status === "needs_review" ? "needs_review" : "ok",
    created_at: entry.created_at || nowIso(),
    updated_at: entry.updated_at || nowIso(),
    deleted_at: entry.deleted_at || "",
    device_id: entry.device_id || "",
    revision: Number.parseInt(entry.revision, 10) || 1,
    multiply: normalizeMultiplyValue(entry.multiply),
    dirty: Boolean(entry.dirty),
    last_sync_at: entry.last_sync_at || "",
    sync_error: entry.sync_error || ""
  };

  if (normalized.end_at && !duration) {
    normalized.duration_seconds = durationSeconds(normalized.start_at, normalized.end_at);
  }

  return normalized;
}

export async function createEntry(fields) {
  const timestamp = nowIso();
  const createFields = decodeEntryCreate(fields);
  const multiply = await selectedMultiplyValue(createFields.multiply);
  const entry = normalizeEntry({
    ...createFields,
    id: uuid(),
    start_at: timestamp,
    end_at: "",
    duration_seconds: 0,
    multiply,
    status: "ok",
    created_at: timestamp,
    updated_at: timestamp,
    device_id: await getDeviceId(),
    revision: 1,
    dirty: true
  });
  await putEntry(entry);
  notifyEntriesChanged({ action: "create", ids: [entry.id] });
  return entry;
}

/**
 * Stops every running entry and starts one replacement in a single database
 * transaction. Retrying with the same operation id returns the already-created
 * timer without changing any later active entry.
 */
export async function replaceActiveTimer(fields, { operationId = uuid() } = {}) {
  const timestamp = nowIso();
  const createFields = decodeEntryCreate(fields);
  const multiply = await selectedMultiplyValue(createFields.multiply);
  const entry = await mutateEntryState({
    settingKeys: [SETTING_KEY.DEVICE_ID, SETTING_KEY.ACTIVE_TIMER_OPERATION],
    includeActiveEntries: true,
    additionalEntryIds(settings) {
      const previousOperation = settings.get(SETTING_KEY.ACTIVE_TIMER_OPERATION);
      return previousOperation?.entry_id ? [previousOperation.entry_id] : [];
    }
  }, ({ entries, settings }) => {
    const previousOperation = settings.get(SETTING_KEY.ACTIVE_TIMER_OPERATION);
    if (previousOperation && previousOperation.id === operationId) {
      const previousEntry = entries.get(previousOperation.entry_id);
      if (previousEntry) return previousEntry;
    }

    const deviceId = settings.get(SETTING_KEY.DEVICE_ID) || uuid();
    settings.set(SETTING_KEY.DEVICE_ID, deviceId);
    for (const existing of entries.values()) {
      if (existing.deleted_at || existing.end_at) continue;
      const currentMultiply = normalizeMultiplyValue(existing.multiply);
      entries.set(existing.id, normalizeEntry({
        ...existing,
        end_at: timestamp,
        duration_seconds: computedDurationSeconds(existing.start_at, timestamp, currentMultiply),
        updated_at: timestamp,
        revision: Number(existing.revision || 0) + 1,
        dirty: true,
        sync_error: ""
      }));
    }

    const next = normalizeEntry({
      ...createFields,
      id: uuid(),
      start_at: timestamp,
      end_at: "",
      duration_seconds: 0,
      multiply,
      status: "ok",
      created_at: timestamp,
      updated_at: timestamp,
      device_id: deviceId,
      revision: 1,
      dirty: true
    });
    entries.set(next.id, next);
    settings.set(SETTING_KEY.ACTIVE_TIMER_OPERATION, { id: operationId, entry_id: next.id });
    return next;
  });
  notifyEntriesChanged({ action: "replace_active", ids: [entry.id] });
  return entry;
}

export async function duplicateEntry(id, { expectedRevision } = {}) {
  const timestamp = nowIso();
  const deviceId = await getDeviceId();
  const entry = await mutateEntries([id], expectedRevision, (entries) => {
    const existing = entries.get(id);
    if (existing.deleted_at) throw new Error("Entry not found");
    if (!existing.end_at) throw new Error("Active entries cannot be duplicated");

    const duplicate = normalizeEntry({
      ...existing,
      id: uuid(),
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: "",
      device_id: deviceId,
      revision: 1,
      dirty: true,
      last_sync_at: "",
      sync_error: ""
    });
    entries.set(duplicate.id, duplicate);
    return duplicate;
  });
  notifyEntriesChanged({ action: "duplicate", ids: [entry.id], sourceId: id });
  return entry;
}

export async function stopEntry(id, { expectedRevision } = {}) {
  const timestamp = nowIso();
  const entry = await mutateEntry(id, expectedRevision, (existing) => {
    // Idempotent: a second stop (stale UI, double click) must not rewrite end_at.
    if (existing.end_at) return normalizeEntry(existing);
    const multiply = normalizeMultiplyValue(existing.multiply);
    return normalizeEntry({
      ...existing,
      end_at: timestamp,
      duration_seconds: computedDurationSeconds(existing.start_at, timestamp, multiply),
      updated_at: timestamp,
      revision: Number(existing.revision || 0) + 1,
      dirty: true,
      sync_error: ""
    });
  });
  notifyEntriesChanged({ action: "stop", ids: [entry.id] });
  return entry;
}

export async function updateEntry(id, changes, { expectedRevision } = {}) {
  const timestamp = nowIso();
  const editableChanges = decodeEntryEdit(changes);
  const requestedMultiply = editableChanges.multiply !== undefined
    ? await selectedMultiplyValue(editableChanges.multiply)
    : undefined;
  const next = await mutateEntry(id, expectedRevision, (existing) => {
    const nextStart = editableChanges.start_at || existing.start_at;
    const nextEnd = editableChanges.end_at !== undefined ? editableChanges.end_at : existing.end_at;
    const nextMultiply = requestedMultiply === undefined
      ? normalizeMultiplyValue(existing.multiply)
      : requestedMultiply;
    return normalizeEntry({
      ...existing,
      ...editableChanges,
      multiply: nextMultiply,
      duration_seconds: nextEnd
        ? computedDurationSeconds(nextStart, nextEnd, nextMultiply)
        : 0,
      updated_at: timestamp,
      revision: Number(existing.revision || 0) + 1,
      dirty: true,
      sync_error: ""
    });
  });
  notifyEntriesChanged({ action: "update", ids: [next.id] });
  return next;
}

export async function softDeleteEntry(id, options = {}) {
  return updateEntry(id, { deleted_at: nowIso() }, options);
}

export async function mergeEntries(targetId, sourceId, { expectedRevisions } = {}) {
  const timestamp = nowIso();
  const result = await mutateEntries([targetId, sourceId], expectedRevisions, (entries) => {
    const targetExisting = entries.get(targetId);
    const sourceExisting = entries.get(sourceId);
    if (!canMergeEntries(targetExisting, sourceExisting)) {
      throw new Error("Entries must be completed and have the same project, task, and description");
    }

    const target = normalizeEntry(targetExisting);
    const source = normalizeEntry(sourceExisting);
    // A merge appends the selected source's elapsed work to the selected target.
    // It intentionally compacts gaps and retains the target's multiplier/status,
    // so differing historical multipliers never silently change the target.
    const mergedStart = target.start_at;
    const actualMs = actualDurationMs(target) + actualDurationMs(source);
    const mergedEnd = new Date(new Date(mergedStart).getTime() + actualMs).toISOString();

    const merged = normalizeEntry({
      ...target,
      start_at: mergedStart,
      end_at: mergedEnd,
      duration_seconds: computedDurationSeconds(mergedStart, mergedEnd, target.multiply),
      multiply: target.multiply,
      status: target.status,
      updated_at: timestamp,
      revision: Number(target.revision || 0) + 1,
      dirty: true,
      sync_error: ""
    });

    const deleted = normalizeEntry({
      ...source,
      deleted_at: timestamp,
      updated_at: timestamp,
      revision: Number(source.revision || 0) + 1,
      dirty: true,
      sync_error: ""
    });
    entries.set(merged.id, merged);
    entries.set(deleted.id, deleted);
    return { merged, deleted };
  });
  notifyEntriesChanged({ action: "merge", ids: [result.merged.id, result.deleted.id] });
  return result;
}

export function entryToRow(entry) {
  const normalized = decodePersistedEntry(entry);
  return [
    normalized.id,
    normalized.project,
    normalized.task,
    normalized.description,
    normalized.start_at,
    normalized.end_at,
    String(normalized.duration_seconds || 0),
    normalized.status,
    normalized.created_at,
    normalized.updated_at,
    normalized.deleted_at,
    normalized.device_id,
    String(normalized.revision || 1),
    normalized.multiply
  ];
}

export function rowToEntry(row) {
  if (!Array.isArray(row) || row.length < SHEET_HEADERS.length) {
    throw entryModelError("Spreadsheet row does not contain every entry field.");
  }
  const object = {};
  SHEET_HEADERS.forEach((header, index) => {
    object[header] = row[index] || "";
  });
  return decodePersistedEntry({
    ...object,
    dirty: false,
    last_sync_at: nowIso(),
    sync_error: ""
  });
}

export function isRemoteNewer(remoteEntry, localEntry) {
  if (!localEntry) return true;
  return String(remoteEntry.updated_at || "").localeCompare(String(localEntry.updated_at || "")) > 0;
}

export function hasEqualTimestampConflict(firstEntry, secondEntry) {
  return Boolean(firstEntry && secondEntry
    && String(firstEntry.updated_at || "") === String(secondEntry.updated_at || "")
    && entryToRow(firstEntry).join("\u0000") !== entryToRow(secondEntry).join("\u0000"));
}

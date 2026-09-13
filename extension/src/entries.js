import { getSetting, mutateEntries, mutateEntry, mutateEntryState, mutateSetting } from "./db.js";
import { notifyEntriesChanged } from "./events.js";
import { ERROR_CODE } from "./error-codes.js";
import { SETTING_KEY } from "./setting-keys.js";
import { durationSeconds, nowIso, uuid } from "./time.js";
import { entryFingerprint } from "./fingerprints.js";
import { ENTRY_FIELDS } from "./entry-contract.js";

export const SHEET_HEADERS = ENTRY_FIELDS;

const CREATE_FIELDS = new Set(["project", "task", "description", "multiply"]);
const COMPLETED_CREATE_FIELDS = new Set([...CREATE_FIELDS, "start_at", "end_at", "status"]);
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
const textEncoder = new TextEncoder();
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function entryModelError(message) {
  const error = new TypeError(message);
  error.code = ERROR_CODE.ENTRY_INVALID;
  return error;
}

function validTimestamp(value) {
  return typeof value === "string" && value && Number.isFinite(new Date(value).getTime());
}

function persistedText(value, field, maxBytes, allowEmpty = true) {
  if (typeof value !== "string") throw entryModelError(`${field} must be text.`);
  if (!allowEmpty && !value.trim()) throw entryModelError(`${field} must not be empty.`);
  if (textEncoder.encode(value).byteLength > maxBytes) throw entryModelError(`${field} is too long.`);
  return value;
}

function persistedTimestamp(value, field) {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) {
    throw entryModelError(`${field} must be an ISO-8601 timestamp.`);
  }
  const [, year, month, day, hour, minute, second] = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    throw entryModelError(`${field} must be a valid timestamp.`);
  }
  const normalized = new Date(value);
  if (!Number.isFinite(normalized.getTime())) throw entryModelError(`${field} must be a valid timestamp.`);
  return normalized.toISOString();
}

function persistedInteger(value, field, minimum) {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw entryModelError(`${field} must be a safe integer of at least ${minimum}.`);
  }
  return number;
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
  if (Object.hasOwn(decoded, "multiply") && typeof decoded.multiply !== "boolean"
    && decoded.multiply !== "" && decoded.multiply !== "true" && decoded.multiply !== "TRUE"
    && decoded.multiply !== "false" && decoded.multiply !== "FALSE"
    && !normalizeMultiplierText(decoded.multiply)) {
    throw entryModelError("multiply must be empty or a valid numeric multiplier.");
  }
  return decoded;
}

/** Decodes the explicit fields required to create a completed local entry. */
export function decodeCompletedEntryCreate(fields) {
  assertAllowedFields(fields, COMPLETED_CREATE_FIELDS, "completed entry create request");
  const decoded = decodeEntryCreate(Object.fromEntries(
    [...CREATE_FIELDS].filter((field) => Object.hasOwn(fields, field)).map((field) => [field, fields[field]])
  ));
  if (typeof fields.start_at !== "string" || typeof fields.end_at !== "string"
    || !fields.start_at || !fields.end_at) {
    throw entryModelError("A completed entry requires both a start and end time.");
  }
  decoded.start_at = persistedTimestamp(fields.start_at, "start_at");
  decoded.end_at = persistedTimestamp(fields.end_at, "end_at");
  if (decoded.end_at < decoded.start_at) throw entryModelError("end_at must not precede start_at.");
  if (fields.status !== undefined) {
    if (fields.status !== "ok" && fields.status !== "needs_review") {
      throw entryModelError("status must be ok or needs_review.");
    }
    decoded.status = fields.status;
  }
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
    if ((field === "end_at" || field === "deleted_at") && value === "") {
      decoded[field] = "";
      continue;
    }
    if (!validTimestamp(value)) throw entryModelError(`${field} must be a valid timestamp.`);
    decoded[field] = persistedTimestamp(value, field);
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
    if (typeof value !== "boolean" && value !== "" && value !== "true" && value !== "TRUE"
      && value !== "false" && value !== "FALSE" && !normalizeMultiplierText(value)) {
      throw entryModelError("multiply must be empty or a valid numeric multiplier.");
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
  for (const field of ENTRY_FIELDS) {
    if (!Object.hasOwn(entry, field)) throw entryModelError(`Persisted entry is missing ${field}.`);
  }
  const decoded = {
    ...entry,
    id: persistedText(entry.id, "id", 64, false),
    project: persistedText(entry.project, "project", 65535),
    task: persistedText(entry.task, "task", 65535),
    description: persistedText(entry.description, "description", 65535),
    start_at: persistedTimestamp(entry.start_at, "start_at"),
    end_at: entry.end_at === "" ? "" : persistedTimestamp(entry.end_at, "end_at"),
    duration_seconds: persistedInteger(entry.duration_seconds, "duration_seconds", 0),
    created_at: persistedTimestamp(entry.created_at, "created_at"),
    updated_at: persistedTimestamp(entry.updated_at, "updated_at"),
    deleted_at: entry.deleted_at === "" ? "" : persistedTimestamp(entry.deleted_at, "deleted_at"),
    device_id: persistedText(entry.device_id, "device_id", 128, false),
    revision: persistedInteger(entry.revision, "revision", 1)
  };
  if (decoded.end_at && decoded.end_at < decoded.start_at) throw entryModelError("end_at must not precede start_at.");
  if (entry.status !== "ok" && entry.status !== "needs_review") throw entryModelError("status must be ok or needs_review.");
  if (entry.multiply !== "" && !normalizeMultiplierText(entry.multiply)) {
    throw entryModelError("multiply must be empty or a valid numeric multiplier.");
  }
  return normalizeEntry(decoded);
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

export function mergeEntryPreview(targetEntry, sourceEntry) {
  if (!canMergeEntries(targetEntry, sourceEntry)) {
    throw new Error("Entries must be completed and have the same project, task, and description");
  }
  const target = normalizeEntry(targetEntry);
  const source = normalizeEntry(sourceEntry);
  const targetActualSeconds = durationSeconds(target.start_at, target.end_at);
  const sourceActualSeconds = durationSeconds(source.start_at, source.end_at);
  const actualSeconds = targetActualSeconds + sourceActualSeconds;
  const startAt = target.start_at;
  const endAt = new Date(new Date(startAt).getTime() + actualSeconds * 1000).toISOString();
  return Object.freeze({
    targetId: target.id,
    sourceId: source.id,
    targetActualSeconds,
    sourceActualSeconds,
    targetEffectiveSeconds: target.duration_seconds,
    sourceEffectiveSeconds: source.duration_seconds,
    actualSeconds,
    effectiveSeconds: computedDurationSeconds(startAt, endAt, target.multiply),
    startAt,
    endAt,
    // Merge compacts the elapsed gap regardless of which interval was chosen
    // as the target. Keep the larger directional gap visible in the preview.
    compactedGapSeconds: Math.max(
      0,
      durationSeconds(target.end_at, source.start_at),
      durationSeconds(source.end_at, target.start_at)
    ),
    targetMultiply: target.multiply,
    targetStatus: target.status,
    sourceMultiply: source.multiply,
    sourceStatus: source.status
  });
}

export function duplicateEntryPreview(entry) {
  const normalized = normalizeEntry(entry);
  if (normalized.deleted_at || !normalized.end_at) throw new Error("Only completed entries can be duplicated");
  const actualSeconds = durationSeconds(normalized.start_at, normalized.end_at);
  return Object.freeze({
    entryId: normalized.id,
    actualSeconds,
    effectiveSeconds: normalized.duration_seconds,
    startAt: normalized.start_at,
    endAt: normalized.end_at,
    overlapSeconds: actualSeconds,
    multiply: normalized.multiply,
    status: normalized.status
  });
}

async function selectedMultiplyValue(value) {
  if (value === true || value === "true" || value === "TRUE") return String(await getDurationMultiplier());
  return normalizeMultiplyValue(value);
}

/** Creates a completed entry in one local mutation, without an active timer. */
export async function createCompletedEntry(fields) {
  const decoded = decodeCompletedEntryCreate(fields);
  const timestamp = nowIso();
  const deviceId = await getDeviceId();
  const multiply = await selectedMultiplyValue(decoded.multiply);
  const entry = normalizeEntry({
    ...decoded,
    id: uuid(),
    duration_seconds: computedDurationSeconds(decoded.start_at, decoded.end_at, multiply),
    status: decoded.status || "ok",
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: "",
    device_id: deviceId,
    revision: 1,
    dirty: true,
    last_sync_at: "",
    sync_error: "",
    multiply
  });
  await mutateEntries([entry.id], (entries) => {
    entries.set(entry.id, entry);
    return entry;
  });
  notifyEntriesChanged({ action: "create_completed", ids: [entry.id] });
  return entry;
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
    if (new Date(existing.start_at).getTime() > Date.now()) {
      throw entryModelError("This timer starts in the future. Correct its start time before stopping it.");
    }
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
    if (!nextEnd && new Date(nextStart).getTime() > Date.now()) {
      throw entryModelError("An active timer cannot start in the future. Correct its start time first.");
    }
    const candidate = normalizeEntry({
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
    // Older local fixtures/records may predate device_id. Preserve their
    // compatibility while still strictly validating modern persisted entries.
    return candidate.device_id ? decodePersistedEntry(candidate) : candidate;
  });
  notifyEntriesChanged({ action: "update", ids: [next.id] });
  return next;
}

export async function softDeleteEntry(id, options = {}) {
  return updateEntry(id, { deleted_at: nowIso() }, options);
}

export function deletionUndoToken(entry) {
  const normalized = normalizeEntry(entry);
  if (!normalized.deleted_at) throw entryModelError("Only a deleted entry can be undone.");
  return Object.freeze({
    id: normalized.id,
    expectedRevision: normalized.revision,
    expectedDeletedAt: normalized.deleted_at,
    expectedFingerprint: entryFingerprint(normalized)
  });
}

const UNDOABLE_ENTRY_FIELDS = Object.freeze([
  "project",
  "task",
  "description",
  "start_at",
  "end_at",
  "status",
  "multiply",
  "deleted_at"
]);

/** Captures the prior editable values for a bounded, conflict-safe correction undo. */
export function entryUpdateUndoToken(before, after) {
  const previous = normalizeEntry(before);
  const updated = normalizeEntry(after);
  if (previous.id !== updated.id) throw entryModelError("An entry update must keep the same entry.");
  return Object.freeze({
    id: updated.id,
    expectedRevision: updated.revision,
    expectedFingerprint: entryFingerprint(updated),
    previous: Object.freeze(Object.fromEntries(
      UNDOABLE_ENTRY_FIELDS.map((field) => [field, previous[field]])
    ))
  });
}

function undoUnavailableError() {
  const error = new Error("Entry undo is no longer available");
  error.code = ERROR_CODE.UNDO_UNAVAILABLE;
  return error;
}

export async function undoDeletedEntry(id, token = {}) {
  if (!id || token.id !== id || !token.expectedDeletedAt || !token.expectedFingerprint) {
    throw undoUnavailableError();
  }

  let restored;
  try {
    restored = await mutateEntry(id, token.expectedRevision, (existing) => {
      if (!existing || existing.deleted_at !== token.expectedDeletedAt
        || entryFingerprint(existing) !== token.expectedFingerprint) {
        throw undoUnavailableError();
      }
      return normalizeEntry({
        ...existing,
        deleted_at: "",
        updated_at: nowIso(),
        revision: Number(existing.revision || 0) + 1,
        dirty: true,
        sync_error: ""
      });
    });
  } catch (error) {
    if (error.code === ERROR_CODE.STORAGE_CONFLICT) throw undoUnavailableError();
    throw error;
  }
  notifyEntriesChanged({ action: "undo_delete", ids: [restored.id] });
  return restored;
}

/** Restores one prior edit only while the edited record is still unchanged. */
export async function undoEntryUpdate(token = {}) {
  if (!token.id || !Number.isSafeInteger(token.expectedRevision)
    || !token.expectedFingerprint || !token.previous || typeof token.previous !== "object") {
    throw undoUnavailableError();
  }

  let restored;
  try {
    restored = await mutateEntry(token.id, token.expectedRevision, (existing) => {
      if (!existing || entryFingerprint(existing) !== token.expectedFingerprint) {
        throw undoUnavailableError();
      }
      return normalizeEntry({
        ...existing,
        ...decodeEntryEdit(token.previous),
        updated_at: nowIso(),
        revision: Number(existing.revision || 0) + 1,
        dirty: true,
        sync_error: ""
      });
    });
  } catch (error) {
    if (error.code === ERROR_CODE.STORAGE_CONFLICT) throw undoUnavailableError();
    throw error;
  }
  notifyEntriesChanged({ action: "undo_update", ids: [restored.id] });
  return restored;
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
    const preview = mergeEntryPreview(target, source);
    // A merge appends the selected source's elapsed work to the selected target.
    // It intentionally compacts gaps and retains the target's multiplier/status,
    // so differing historical multipliers never silently change the target.
    const mergedStart = preview.startAt;
    const mergedEnd = preview.endAt;

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
    && entryFingerprint(firstEntry) !== entryFingerprint(secondEntry));
}

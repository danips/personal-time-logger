import { getSetting, setSetting, getEntry, putEntry } from "./db.js";
import { notifyEntriesChanged } from "./events.js";
import { durationSeconds, nowIso, uuid } from "./time.js";

export const SHEET_HEADERS = [
  "id",
  "client",
  "project",
  "task",
  "description",
  "start_at",
  "end_at",
  "duration_seconds",
  "billable",
  "tags",
  "status",
  "created_at",
  "updated_at",
  "deleted_at",
  "device_id",
  "revision",
  "multiply"
];

export async function getDeviceId() {
  let deviceId = await getSetting("device_id");
  if (!deviceId) {
    deviceId = uuid();
    await setSetting("device_id", deviceId);
  }
  return deviceId;
}

async function getDurationMultiplier() {
  return normalizeMultiplierText(await getSetting("duration_multiplier", "1")) || "1";
}

function boolValue(value) {
  return value === true || value === "true" || value === "TRUE";
}

export function normalizeMultiplierText(value) {
  const text = String(value == null ? "" : value).trim().replace(",", ".");
  if (!text) return "";
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return text;
}

function normalizeMultiplyValue(value) {
  if (value === true || value === "true" || value === "TRUE") return "1.0";
  if (value === false || value === "false" || value === "FALSE" || value == null || value === "") return "";
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

function storedDuration(entry) {
  return Number(entry.duration_seconds) || durationSeconds(entry.start_at, entry.end_at);
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

async function computedDurationSeconds(startAt, endAt, multiply) {
  const actual = durationSeconds(startAt, endAt);
  const multiplier = Number(normalizeMultiplyValue(multiply));
  if (!multiplier) return actual;
  return Math.round(actual * multiplier);
}

export function normalizeEntry(entry) {
  const duration = Number(entry.duration_seconds) || 0;
  const normalized = {
    id: entry.id || uuid(),
    client: entry.client || "",
    project: entry.project || "",
    task: entry.task || "",
    description: entry.description || "",
    start_at: entry.start_at || nowIso(),
    end_at: entry.end_at || "",
    duration_seconds: duration,
    billable: boolValue(entry.billable),
    tags: entry.tags || "",
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
  const multiply = await selectedMultiplyValue(fields.multiply);
  const entry = normalizeEntry({
    ...fields,
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

export async function duplicateEntry(id) {
  const existing = await getEntry(id);
  if (!existing || existing.deleted_at) throw new Error("Entry not found");
  if (!existing.end_at) throw new Error("Active entries cannot be duplicated");

  const timestamp = nowIso();
  const entry = normalizeEntry({
    ...existing,
    id: uuid(),
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: "",
    device_id: await getDeviceId(),
    revision: 1,
    dirty: true,
    last_sync_at: "",
    sync_error: ""
  });
  await putEntry(entry);
  notifyEntriesChanged({ action: "duplicate", ids: [entry.id], sourceId: existing.id });
  return entry;
}

export async function stopEntry(id) {
  const existing = await getEntry(id);
  if (!existing) throw new Error("Entry not found");
  const timestamp = nowIso();
  const multiply = await selectedMultiplyValue(existing.multiply);
  const entry = normalizeEntry({
    ...existing,
    end_at: timestamp,
    duration_seconds: await computedDurationSeconds(existing.start_at, timestamp, multiply),
    updated_at: timestamp,
    revision: Number(existing.revision || 0) + 1,
    dirty: true,
    sync_error: ""
  });
  await putEntry(entry);
  notifyEntriesChanged({ action: "stop", ids: [entry.id] });
  return entry;
}

export async function updateEntry(id, changes) {
  const existing = await getEntry(id);
  if (!existing) throw new Error("Entry not found");
  const timestamp = nowIso();
  const nextStart = changes.start_at || existing.start_at;
  const nextEnd = changes.end_at !== undefined ? changes.end_at : existing.end_at;
  const nextMultiply = changes.multiply !== undefined
    ? await selectedMultiplyValue(changes.multiply)
    : await selectedMultiplyValue(existing.multiply);
  const next = normalizeEntry({
    ...existing,
    ...changes,
    multiply: nextMultiply,
    duration_seconds: nextEnd
      ? await computedDurationSeconds(nextStart, nextEnd, nextMultiply)
      : 0,
    updated_at: timestamp,
    revision: Number(existing.revision || 0) + 1,
    dirty: true,
    sync_error: ""
  });
  await putEntry(next);
  notifyEntriesChanged({ action: "update", ids: [next.id] });
  return next;
}

export async function softDeleteEntry(id) {
  return updateEntry(id, { deleted_at: nowIso() });
}

export async function mergeEntries(targetId, sourceId) {
  const targetExisting = await getEntry(targetId);
  const sourceExisting = await getEntry(sourceId);
  if (!canMergeEntries(targetExisting, sourceExisting)) {
    throw new Error("Entries must be completed and have the same project, task, and description");
  }

  const target = normalizeEntry(targetExisting);
  const source = normalizeEntry(sourceExisting);
  const timestamp = nowIso();
  const targetStart = new Date(target.start_at);
  const sourceStart = new Date(source.start_at);
  const mergedStart = targetStart <= sourceStart ? target.start_at : source.start_at;
  const actualMs = actualDurationMs(target) + actualDurationMs(source);
  const mergedEnd = new Date(new Date(mergedStart).getTime() + actualMs).toISOString();
  const sameMultiply = target.multiply === source.multiply;
  const sameBillable = target.billable === source.billable;

  const merged = normalizeEntry({
    ...target,
    start_at: mergedStart,
    end_at: mergedEnd,
    duration_seconds: storedDuration(target) + storedDuration(source),
    billable: target.billable || source.billable,
    multiply: sameMultiply ? target.multiply : "",
    status: target.status === "needs_review" || source.status === "needs_review" || !sameMultiply || !sameBillable
      ? "needs_review"
      : "ok",
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

  await putEntry(merged);
  await putEntry(deleted);
  notifyEntriesChanged({ action: "merge", ids: [merged.id, deleted.id] });
  return { merged, deleted };
}

export function entryToRow(entry) {
  const normalized = normalizeEntry(entry);
  return [
    normalized.id,
    normalized.client,
    normalized.project,
    normalized.task,
    normalized.description,
    normalized.start_at,
    normalized.end_at,
    String(normalized.duration_seconds || 0),
    normalized.billable ? "TRUE" : "FALSE",
    normalized.tags,
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
  const object = {};
  SHEET_HEADERS.forEach((header, index) => {
    object[header] = row[index] || "";
  });
  return normalizeEntry({
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

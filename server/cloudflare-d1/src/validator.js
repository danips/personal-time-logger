import { ApiError, ERROR } from "./errors.js";

export const ENTRY_FIELDS = Object.freeze([
  "id", "project", "task", "description", "start_at", "end_at", "duration_seconds",
  "status", "created_at", "updated_at", "deleted_at", "device_id", "revision", "multiply"
]);
const textEncoder = new globalThis.TextEncoder();

function invalid(message, code = ERROR.ENTRY_INVALID) {
  throw new ApiError(400, code, message);
}

function text(value, field, maxBytes, allowEmpty = true) {
  if (typeof value !== "string") invalid(`${field} must be text.`);
  if (!allowEmpty && !value.trim()) invalid(`${field} must not be empty.`);
  if (textEncoder.encode(value).byteLength > maxBytes) invalid(`${field} is too long.`);
  return value;
}

function integer(value, field, minimum) {
  let number;
  if (Number.isSafeInteger(value)) number = value;
  else if (typeof value === "string" && /^\d+$/.test(value)) number = Number(value);
  else if (typeof value === "number" && Number.isFinite(value)) number = value;
  else invalid(`${field} must be an integer.`);
  if (!Number.isSafeInteger(number) || number < minimum) invalid(`${field} is out of range.`);
  return number;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
export function normalizeTimestamp(value, field) {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) invalid(`${field} must be an ISO-8601 timestamp.`);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
    invalid(`${field} must be a valid timestamp.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) invalid(`${field} must be a valid timestamp.`);
  return date.toISOString();
}

function optionalTimestamp(value, field) {
  if (value === "" || value === null) return null;
  return normalizeTimestamp(value, field);
}

function multiply(value) {
  if (value === "" || value === null) return null;
  if (typeof value !== "string" && typeof value !== "number") invalid("multiply must be numeric or empty.");
  const normalized = String(value).trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,3})?$/.test(normalized)) invalid("multiply is invalid.");
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 1 || number > 5.001) invalid("multiply is out of range.");
  return number.toFixed(3);
}

export function entry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("entry must be an object.");
  for (const field of ENTRY_FIELDS) if (!Object.hasOwn(value, field)) invalid(`entry is missing ${field}.`);
  for (const field of Object.keys(value)) if (!ENTRY_FIELDS.includes(field)) invalid(`entry field ${field} is not supported.`);
  return {
    id: text(value.id, "id", 64, false),
    project: text(value.project, "project", 65535),
    task: text(value.task, "task", 65535),
    description: text(value.description, "description", 65535),
    start_at: normalizeTimestamp(value.start_at, "start_at"),
    end_at: optionalTimestamp(value.end_at, "end_at"),
    duration_seconds: integer(value.duration_seconds, "duration_seconds", 0),
    status: value.status === "ok" || value.status === "needs_review"
      ? value.status : invalid("status must be ok or needs_review."),
    created_at: normalizeTimestamp(value.created_at, "created_at"),
    updated_at: normalizeTimestamp(value.updated_at, "updated_at"),
    deleted_at: optionalTimestamp(value.deleted_at, "deleted_at"),
    device_id: text(value.device_id, "device_id", 128, false),
    revision: integer(value.revision, "revision", 1),
    multiply: multiply(value.multiply)
  };
}

export function id(value) { return text(value, "id", 64, false); }
export function version(value, field = "expectedVersion") { return integer(value, field, 1); }
export function configKey(value) { return text(value, "key", 128, false); }
export function configValue(value) { return text(value, "value", 65535); }

export function list(body, field, max = 15) {
  if (!Object.hasOwn(body, field) || !Array.isArray(body[field]) || body[field].length > max) {
    invalid(`${field} must be a list of at most ${max} items.`, ERROR.INVALID_REQUEST);
  }
  return body[field];
}

export function assertKeys(value, allowed, message = "The request contains unsupported fields.") {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) invalid(message, ERROR.INVALID_REQUEST);
}

export function assertUniqueIds(items) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item)) invalid("A batch contains duplicate entry IDs.", ERROR.INVALID_REQUEST);
    seen.add(item);
  }
}

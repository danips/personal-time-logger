import { ApiError, ERROR } from "./errors.js";
import { assertKeys, assertUniqueIds, configKey, configValue, entry, id, list, normalizeTimestamp, version } from "./validator.js";

const ENTRY_COLUMNS = [
  "id", "project", "task", "description", "start_at", "end_at", "duration_seconds", "status",
  "created_at", "updated_at", "deleted_at", "device_id", "revision", "multiply"
];

function rowEntry(row) {
  return entry({
    id: String(row.id), project: String(row.project), task: String(row.task), description: String(row.description),
    start_at: String(row.start_at), end_at: row.end_at, duration_seconds: Number(row.duration_seconds),
    status: String(row.status), created_at: String(row.created_at), updated_at: String(row.updated_at),
    deleted_at: row.deleted_at, device_id: String(row.device_id), revision: Number(row.revision), multiply: row.multiply
  });
}

function rowConfig(row) {
  return {
    key: String(row.key), value: String(row.value),
    updated_at: normalizeTimestamp(String(row.updated_at), "updated_at"), version: Number(row.remote_version)
  };
}

function statement(db, sql, ...values) {
  return db.prepare(sql).bind(...values);
}

function isGuardFailure(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("mutation_guard") || message.includes("not null constraint")
    || message.includes("constraint failed");
}

function mutationFailure(error, conflictCode) {
  if (error instanceof ApiError) throw error;
  if (isGuardFailure(error)) throw new ApiError(409, conflictCode, conflictCode === ERROR.REMOTE_APPEND_CONFLICT
    ? "An entry with this ID has different content."
    : "The remote record changed before the operation completed.");
  throw error;
}

async function findEntry(db, entryId) {
  return statement(db, "SELECT * FROM time_entries WHERE id = ?", entryId).first();
}

async function findConfig(db, key) {
  return statement(db, "SELECT `key`, `value`, updated_at, remote_version FROM config WHERE `key` = ?", key).first();
}

function sameEntry(left, right) {
  return JSON.stringify(rowEntry(left)) === JSON.stringify(right);
}

function entryValues(value) {
  return ENTRY_COLUMNS.map((column) => value[column] === "" && ["end_at", "deleted_at", "multiply"].includes(column)
    ? null : value[column]);
}

function realGuard(db, sql, ...values) {
  return statement(db, sql, ...values);
}

function appendInsert(db, value) {
  return statement(db, `INSERT OR IGNORE INTO time_entries (${ENTRY_COLUMNS.join(", ")}) VALUES (${ENTRY_COLUMNS.map(() => "?").join(", ")})`, ...entryValues(value));
}

function ordered(values, key = (value) => value.id) {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}


export async function health(db) {
  const meta = await statement(db, "SELECT schema_version, change_seq FROM app_meta WHERE id = 1").first();
  if (!meta) throw new ApiError(500, ERROR.DATABASE_SCHEMA_INVALID, "The API metadata row is missing.");
  return { ok: true, service: "personal-time-logger", apiVersion: 1, schemaVersion: Number(meta.schema_version), storage: "cloudflare-d1" };
}

export async function changeToken(db) {
  const meta = await statement(db, "SELECT change_seq FROM app_meta WHERE id = 1").first();
  if (!meta) throw new ApiError(500, ERROR.DATABASE_SCHEMA_INVALID, "The API metadata row is missing.");
  return String(meta.change_seq);
}

export async function snapshot(db) {
  const [entriesResult, configResult, meta] = await db.batch([
    statement(db, "SELECT id, project, task, description, start_at, end_at, duration_seconds, status, created_at, updated_at, deleted_at, device_id, revision, multiply, remote_version FROM time_entries ORDER BY id"),
    statement(db, "SELECT `key`, `value`, updated_at, remote_version FROM config ORDER BY `key`"),
    statement(db, "SELECT change_seq FROM app_meta WHERE id = 1")
  ]);
  if (!meta?.results?.[0]) throw new ApiError(500, ERROR.DATABASE_SCHEMA_INVALID, "The API metadata row is missing.");
  return {
    changeToken: String(meta.results[0].change_seq),
    entries: (entriesResult.results || []).map((row) => ({ entry: rowEntry(row), version: Number(row.remote_version) })),
    config: (configResult.results || []).map(rowConfig)
  };
}

export async function append(db, body) {
  assertKeys(body, ["entries"]);
  const values = list(body, "entries").map(entry);
  assertUniqueIds(values.map((value) => value.id));
  const preflight = new Map();
  let hasMissing = false;
  for (const value of values) {
    const existing = await findEntry(db, value.id);
    if (existing && !sameEntry(existing, value)) throw new ApiError(409, ERROR.REMOTE_APPEND_CONFLICT, "An entry with this ID has different content.");
    preflight.set(value.id, existing ? Number(existing.remote_version) : 1);
    if (!existing) hasMissing = true;
  }
  if (!hasMissing) return { entries: values.map((value) => ({ id: value.id, version: preflight.get(value.id) })) };

  const sorted = ordered(values);
  const statements = sorted.map((value) => appendInsert(db, value));
  statements.push(...sorted.map((value) => realGuard(db,
    `INSERT INTO mutation_guard(value) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM time_entries WHERE id = ? AND project IS ? AND task IS ? AND description IS ? AND start_at IS ? AND end_at IS ? AND duration_seconds IS ? AND status IS ? AND created_at IS ? AND updated_at IS ? AND deleted_at IS ? AND device_id IS ? AND revision IS ? AND multiply IS ?)`,
    ...entryValues(value))));
  statements.push(statement(db, "UPDATE app_meta SET change_seq = change_seq + 1 WHERE id = 1"));
  statements.push(statement(db, `SELECT id, remote_version FROM time_entries WHERE id IN (${sorted.map(() => "?").join(", ")})`, ...sorted.map((value) => value.id)));
  try {
    const results = await db.batch(statements);
    const versions = new Map((results.at(-1).results || []).map((row) => [String(row.id), Number(row.remote_version)]));
    return { entries: values.map((value) => ({ id: value.id, version: versions.get(value.id) })) };
  } catch (error) {
    mutationFailure(error, ERROR.REMOTE_APPEND_CONFLICT);
  }
}

export async function update(db, body) {
  assertKeys(body, ["updates"]);
  const updates = list(body, "updates").map((value) => {
    assertKeys(value, ["entry", "expectedVersion"], "Each update needs entry and expectedVersion.");
    if (!Object.hasOwn(value, "entry") || !Object.hasOwn(value, "expectedVersion")) throw new ApiError(400, ERROR.INVALID_REQUEST, "Each update needs entry and expectedVersion.");
    return { entry: entry(value.entry), expectedVersion: version(value.expectedVersion) };
  });
  assertUniqueIds(updates.map(({ entry: value }) => value.id));
  for (const updateValue of updates) {
    const existing = await findEntry(db, updateValue.entry.id);
    if (!existing) throw new ApiError(409, ERROR.REMOTE_ENTRY_MISSING, "The remote entry does not exist.");
    if (Number(existing.remote_version) !== updateValue.expectedVersion) throw new ApiError(409, ERROR.REMOTE_VERSION_STALE, "The remote record changed before the operation completed.");
  }
  if (!updates.length) return { entries: [] };
  const sorted = ordered(updates, (value) => value.entry.id);
  const statements = [];
  for (const updateValue of sorted) {
    const value = updateValue.entry;
    statements.push(realGuard(db, "INSERT INTO mutation_guard(value) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM time_entries WHERE id = ? AND remote_version = ?)", value.id, updateValue.expectedVersion));
    statements.push(statement(db, `UPDATE time_entries SET ${ENTRY_COLUMNS.filter((column) => column !== "id").map((column) => `${column} = ?`).join(", ")}, remote_version = remote_version + 1 WHERE id = ? AND remote_version = ?`, ...entryValues(value).slice(1), value.id, updateValue.expectedVersion));
  }
  if (updates.length) statements.push(statement(db, "UPDATE app_meta SET change_seq = change_seq + 1 WHERE id = 1"));
  try {
    await db.batch(statements);
    return { entries: updates.map(({ entry: value, expectedVersion }) => ({ id: value.id, version: expectedVersion + 1 })) };
  } catch (error) {
    mutationFailure(error, ERROR.REMOTE_VERSION_STALE);
  }
}

export async function remove(db, body) {
  assertKeys(body, ["preconditions"]);
  const values = list(body, "preconditions").map((value) => {
    assertKeys(value, ["id", "expectedVersion"], "Each delete needs id and expectedVersion.");
    if (!Object.hasOwn(value, "id") || !Object.hasOwn(value, "expectedVersion")) throw new ApiError(400, ERROR.INVALID_REQUEST, "Each delete needs id and expectedVersion.");
    return { id: id(value.id), expectedVersion: version(value.expectedVersion) };
  });
  assertUniqueIds(values.map((value) => value.id));
  for (const value of values) {
    const existing = await findEntry(db, value.id);
    if (!existing) throw new ApiError(409, ERROR.REMOTE_ENTRY_MISSING, "The remote entry does not exist.");
    if (Number(existing.remote_version) !== value.expectedVersion) throw new ApiError(409, ERROR.REMOTE_VERSION_STALE, "The remote record changed before the operation completed.");
  }
  if (!values.length) return { deleted: [] };
  const statements = [];
  for (const value of ordered(values)) {
    statements.push(realGuard(db, "INSERT INTO mutation_guard(value) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM time_entries WHERE id = ? AND remote_version = ?)", value.id, value.expectedVersion));
    statements.push(statement(db, "DELETE FROM time_entries WHERE id = ? AND remote_version = ?", value.id, value.expectedVersion));
  }
  if (values.length) statements.push(statement(db, "UPDATE app_meta SET change_seq = change_seq + 1 WHERE id = 1"));
  try {
    await db.batch(statements);
    return { deleted: values.map((value) => value.id) };
  } catch (error) {
    mutationFailure(error, ERROR.REMOTE_VERSION_STALE);
  }
}

export async function updateConfig(db, body) {
  assertKeys(body, ["key", "value", "updated_at", "expectedVersion"]);
  if (!Object.hasOwn(body, "key") || !Object.hasOwn(body, "value") || !Object.hasOwn(body, "updated_at")) throw new ApiError(400, ERROR.INVALID_REQUEST, "Config update needs key, value, and updated_at.");
  const key = configKey(body.key);
  const value = configValue(body.value);
  const updatedAt = normalizeTimestamp(body.updated_at, "updated_at");
  const expectedVersion = Object.hasOwn(body, "expectedVersion") ? version(body.expectedVersion) : null;
  const existing = await findConfig(db, key);
  if (!existing) {
    if (expectedVersion !== null) throw new ApiError(409, ERROR.CONFIG_CONFLICT, "The remote config key does not exist.");
    const statements = [
      realGuard(db, "INSERT INTO mutation_guard(value) SELECT NULL WHERE EXISTS (SELECT 1 FROM config WHERE `key` = ?)", key),
      statement(db, "INSERT INTO config (`key`, `value`, updated_at, remote_version) VALUES (?, ?, ?, 1)", key, value, updatedAt),
      statement(db, "UPDATE app_meta SET change_seq = change_seq + 1 WHERE id = 1")
    ];
    try {
      await db.batch(statements);
      return { key, version: 1 };
    } catch (error) {
      mutationFailure(error, ERROR.CONFIG_CONFLICT);
    }
  }
  if (expectedVersion === null || Number(existing.remote_version) !== expectedVersion) throw new ApiError(409, ERROR.REMOTE_VERSION_STALE, "The remote record changed before the operation completed.");
  if (String(existing.value) === value && normalizeTimestamp(String(existing.updated_at), "updated_at") === updatedAt) return { key, version: expectedVersion };
  try {
    await db.batch([
      realGuard(db, "INSERT INTO mutation_guard(value) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM config WHERE `key` = ? AND remote_version = ?)", key, expectedVersion),
      statement(db, "UPDATE config SET `value` = ?, updated_at = ?, remote_version = remote_version + 1 WHERE `key` = ? AND remote_version = ?", value, updatedAt, key, expectedVersion),
      statement(db, "UPDATE app_meta SET change_seq = change_seq + 1 WHERE id = 1")
    ]);
    return { key, version: expectedVersion + 1 };
  } catch (error) {
    mutationFailure(error, ERROR.REMOTE_VERSION_STALE);
  }
}

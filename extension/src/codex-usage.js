export class UsageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "UsageError";
    this.code = code;
    Object.assign(this, details);
  }
}

function schemaError(message) {
  return new UsageError("schema_changed", message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value, field) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw schemaError(`${field} has an invalid type`);
  return value;
}

function optionalBoolean(value, field, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw schemaError(`${field} has an invalid type`);
  return value;
}

function optionalFiniteNumber(value, field, { minimum = 0, integer = false } = {}) {
  if (value === undefined || value === null) return null;
  const numericValue = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof numericValue !== "number" || !Number.isFinite(numericValue) || numericValue < minimum || (integer && !Number.isInteger(numericValue))) {
    throw schemaError(`${field} has an invalid number`);
  }
  return numericValue;
}

function resetAtToIso(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw schemaError(`${field} has an invalid timestamp`);
  }
  // ChatGPT has returned reset_at in both Unix seconds and Unix milliseconds.
  // The latter is distinguishable from a plausible seconds timestamp.
  const milliseconds = value >= 100_000_000_000 ? value : value * 1000;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeWindow(raw, fieldName, collectedAtMs) {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) throw schemaError(`${fieldName} has an invalid type`);
  const usedPercent = optionalFiniteNumber(raw.used_percent, `${fieldName}.used_percent`, { minimum: 0 });
  if (usedPercent === null || usedPercent > 100) throw schemaError(`${fieldName}.used_percent is missing or out of range`);
  let resetAt = resetAtToIso(raw.reset_at, `${fieldName}.reset_at`);
  if (!resetAt && raw.reset_after_seconds !== undefined && raw.reset_after_seconds !== null) {
    const seconds = optionalFiniteNumber(raw.reset_after_seconds, `${fieldName}.reset_after_seconds`, { minimum: 0 });
    resetAt = new Date(collectedAtMs + seconds * 1000).toISOString();
  }
  return {
    used_percent: usedPercent,
    remaining_percent: 100 - usedPercent,
    window_seconds: optionalFiniteNumber(raw.window_seconds ?? raw.limit_window_seconds, `${fieldName}.window_seconds`, { integer: true }),
    reset_at: resetAt
  };
}

function normalizeLimitReachedType(rateLimit, raw) {
  const value = rateLimit.limit_reached_type ?? raw.rate_limit_reached_type;
  if (isRecord(value)) return optionalString(value.type, "rate_limit_reached_type.type") || null;
  return optionalString(value, "rate_limit.limit_reached_type") || null;
}

export function normalizeUsageResponse(raw, { collectedAt = new Date().toISOString() } = {}) {
  if (!isRecord(raw)) throw schemaError("usage response is not an object");
  if (!("rate_limit" in raw) && !("plan_type" in raw)) {
    throw schemaError("usage response has no recognized usage fields");
  }
  if (raw.rate_limit !== undefined && raw.rate_limit !== null && !isRecord(raw.rate_limit)) {
    throw schemaError("rate_limit has an invalid type");
  }
  if (typeof collectedAt !== "string" || Number.isNaN(new Date(collectedAt).getTime())) {
    throw new TypeError("collectedAt must be an ISO timestamp");
  }
  const collectedAtMs = new Date(collectedAt).getTime();
  const rateLimit = isRecord(raw.rate_limit) ? raw.rate_limit : {};

  const primaryWindow = normalizeWindow(rateLimit.primary_window, "rate_limit.primary_window", collectedAtMs);
  const secondaryWindow = normalizeWindow(rateLimit.secondary_window, "rate_limit.secondary_window", collectedAtMs);

  const account = isRecord(raw.account) ? raw.account : raw;

  return {
    account: {
      plan_type: optionalString(account.plan_type ?? raw.plan_type, "account.plan_type")
    },
    access: {
      allowed: optionalBoolean(rateLimit.allowed, "rate_limit.allowed", true),
      limit_reached: optionalBoolean(rateLimit.limit_reached, "rate_limit.limit_reached"),
      limit_reached_type: normalizeLimitReachedType(rateLimit, raw)
    },
    primary_window: primaryWindow,
    secondary_window: secondaryWindow,
    collected_at: new Date(collectedAt).toISOString()
  };
}

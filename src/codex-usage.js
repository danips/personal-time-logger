export const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const OFFICIAL_USAGE_URL = "https://chatgpt.com/codex/cloud/settings/analytics#usage";
export const USAGE_SCHEMA_VERSION = 1;

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

function resetAtToIso(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  // ChatGPT has returned reset_at in both Unix seconds and Unix milliseconds.
  // The latter is distinguishable from a plausible seconds timestamp.
  const milliseconds = value >= 100_000_000_000 ? value : value * 1000;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeWindow(raw, fieldName) {
  if (!isRecord(raw)) return null;
  try {
    const usedPercent = optionalFiniteNumber(raw.used_percent, `${fieldName}.used_percent`, { minimum: 0 });
    if (usedPercent === null || usedPercent > 100) return null;
    return {
      used_percent: usedPercent,
      remaining_percent: 100 - usedPercent,
      window_seconds: optionalFiniteNumber(raw.window_seconds ?? raw.limit_window_seconds, `${fieldName}.window_seconds`, { integer: true }),
      reset_at: resetAtToIso(raw.reset_at)
    };
  } catch (error) {
    if (error instanceof UsageError && error.code === "schema_changed") return null;
    throw error;
  }
}

function normalizeCredits(raw) {
  if (raw === undefined || raw === null) {
    return {
      has_credits: false,
      unlimited: false,
      overage_limit_reached: false,
      balance: null
    };
  }
  if (!isRecord(raw)) throw schemaError("credits has an invalid type");
  const balance = typeof raw.balance === "number" || typeof raw.balance === "string"
    ? optionalFiniteNumber(raw.balance, "credits.balance", { minimum: 0 })
    : null;
  return {
    has_credits: optionalBoolean(raw.has_credits, "credits.has_credits"),
    unlimited: optionalBoolean(raw.unlimited, "credits.unlimited"),
    overage_limit_reached: optionalBoolean(raw.overage_limit_reached, "credits.overage_limit_reached"),
    balance
  };
}

function normalizeLimitReachedType(rateLimit, raw) {
  const value = rateLimit.limit_reached_type ?? raw.rate_limit_reached_type;
  if (isRecord(value)) return optionalString(value.type, "rate_limit_reached_type.type") || null;
  return optionalString(value, "rate_limit.limit_reached_type") || null;
}

function hasUnsupportedAdditionalLimit(raw, rateLimit) {
  return [raw, rateLimit].some((source) =>
    (source.additional_rate_limits !== undefined && source.additional_rate_limits !== null)
      || (source.code_review_rate_limit !== undefined && source.code_review_rate_limit !== null)
  );
}

function accountSource(raw) {
  const account = isRecord(raw.account) ? raw.account : raw;
  return {
    email: optionalString(account.email ?? raw.email, "account.email"),
    plan_type: optionalString(account.plan_type ?? raw.plan_type, "account.plan_type")
  };
}

/**
 * Extracts only the transient identity fields needed for duplicate detection.
 * Callers must not persist or display this return value.
 */
export function extractUsageIdentity(raw) {
  if (!isRecord(raw)) throw schemaError("usage response is not an object");
  const account = isRecord(raw.account) ? raw.account : {};
  const rawUserId = raw.user_id ?? account.user_id;
  const rawAccountId = raw.account_id ?? account.account_id;
  // Identity is only a duplicate-detection aid, never required to display a
  // usage response. Some valid account responses omit one of these fields.
  if (typeof rawUserId !== "string" || typeof rawAccountId !== "string"
    || !rawUserId || !rawAccountId) return null;
  const userId = rawUserId;
  const accountId = rawAccountId;
  return { user_id: userId, account_id: accountId };
}

export function normalizeUsageResponse(raw, { label = "ChatGPT account", collectedAt = new Date().toISOString() } = {}) {
  if (!isRecord(raw)) throw schemaError("usage response is not an object");
  if (!("rate_limit" in raw) && !("plan_type" in raw) && !("credits" in raw)) {
    throw schemaError("usage response has no recognized usage fields");
  }
  const rateLimit = isRecord(raw.rate_limit) ? raw.rate_limit : {};

  const primaryWindow = normalizeWindow(rateLimit.primary_window, "rate_limit.primary_window");
  let secondaryWindow = null;
  let secondaryNotice = false;
  if (rateLimit.secondary_window !== undefined && rateLimit.secondary_window !== null) {
    secondaryWindow = normalizeWindow(rateLimit.secondary_window, "rate_limit.secondary_window");
    secondaryNotice = secondaryWindow === null;
  }

  if (typeof collectedAt !== "string" || Number.isNaN(new Date(collectedAt).getTime())) {
    throw new TypeError("collectedAt must be an ISO timestamp");
  }

  const account = accountSource(raw);
  const notices = [];
  if (!primaryWindow) notices.push("usage_window_unavailable");
  if (hasUnsupportedAdditionalLimit(raw, rateLimit)) notices.push("unsupported_additional_limit");
  if (secondaryNotice) notices.push("unsupported_secondary_limit");

  return {
    schema_version: USAGE_SCHEMA_VERSION,
    account: {
      label: String(label || "ChatGPT account"),
      email: account.email,
      plan_type: account.plan_type
    },
    access: {
      allowed: optionalBoolean(rateLimit.allowed, "rate_limit.allowed", true),
      limit_reached: optionalBoolean(rateLimit.limit_reached, "rate_limit.limit_reached"),
      limit_reached_type: normalizeLimitReachedType(rateLimit, raw)
    },
    primary_window: primaryWindow,
    secondary_window: secondaryWindow,
    credits: normalizeCredits(raw.credits),
    collected_at: new Date(collectedAt).toISOString(),
    notices,
    official_usage_url: OFFICIAL_USAGE_URL
  };
}

export function normalizeBridgeResult(result, options = {}) {
  if (!isRecord(result)) throw new UsageError("service_error", "The ChatGPT usage bridge returned no result");
  if (result.ok === false || (typeof result.status === "number" && result.status < 200)) {
    throw new UsageError(result.error_code || "service_error", "ChatGPT usage could not be read", {
      http_status: Number.isFinite(result.status) ? result.status : null,
      retry_after_seconds: Number.isFinite(result.retry_after_seconds) ? result.retry_after_seconds : null
    });
  }
  if (typeof result.status !== "number") throw new UsageError("service_error", "The ChatGPT usage bridge returned no status");
  if (result.status === 401) throw new UsageError("sign_in_required", "Sign in to ChatGPT in this container");
  if (result.status === 403) throw new UsageError("access_denied", "ChatGPT denied usage access");
  if (result.status === 404 || result.status === 410) throw new UsageError("endpoint_unavailable", "ChatGPT usage endpoint is unavailable");
  if (result.status === 429) throw new UsageError("temporarily_rate_limited", "ChatGPT temporarily rate-limited this request");
  if (result.status < 200 || result.status >= 300) throw new UsageError("service_error", "ChatGPT usage returned an error");
  try {
    return normalizeUsageResponse(result.body, options);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw schemaError("The ChatGPT usage response could not be validated");
  }
}

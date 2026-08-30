export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const ERROR = Object.freeze({
  AUTH_REQUIRED: "AUTH_REQUIRED",
  ORIGIN_NOT_ALLOWED: "ORIGIN_NOT_ALLOWED",
  ROUTE_NOT_FOUND: "ROUTE_NOT_FOUND",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  INVALID_REQUEST: "INVALID_REQUEST",
  ENTRY_INVALID: "ENTRY_INVALID",
  REMOTE_ENTRY_MISSING: "REMOTE_ENTRY_MISSING",
  REMOTE_APPEND_CONFLICT: "REMOTE_APPEND_CONFLICT",
  REMOTE_VERSION_STALE: "REMOTE_VERSION_STALE",
  CONFIG_CONFLICT: "CONFIG_CONFLICT",
  DATABASE_SCHEMA_INVALID: "DATABASE_SCHEMA_INVALID",
  API_ERROR: "API_ERROR"
});

export function errorResponse(error, headers = {}) {
  const safe = error instanceof ApiError
    ? error
    : new ApiError(500, ERROR.API_ERROR, "The remote API could not complete the request.");
  return new globalThis.Response(JSON.stringify({ error: { code: safe.code, message: safe.message } }), {
    status: safe.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

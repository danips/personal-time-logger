import { ApiError, ERROR } from "./errors.js";

export const MAX_BODY_BYTES = 512 * 1024;

export async function jsonBody(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    throw new ApiError(400, ERROR.INVALID_REQUEST, "The request must use JSON content type.");
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) throw new ApiError(413, ERROR.INVALID_REQUEST, "The request body is too large.");
  let value;
  try {
    value = JSON.parse(new globalThis.TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, ERROR.INVALID_REQUEST, "The request JSON is invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, ERROR.INVALID_REQUEST, "The request body must be an object.");
  }
  return value;
}

export function jsonResponse(value, status = 200, headers = {}) {
  return new globalThis.Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

import { ApiError, ERROR } from "./errors.js";

export const MAX_BODY_BYTES = 512 * 1024;

export async function jsonBody(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    throw new ApiError(400, ERROR.INVALID_REQUEST, "The request must use JSON content type.");
  }
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) throw new ApiError(413, ERROR.INVALID_REQUEST, "The request body is too large.");
  let bytes;
  if (request.body?.getReader) {
    const reader = request.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new ApiError(413, ERROR.INVALID_REQUEST, "The request body is too large.");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  } else bytes = await request.arrayBuffer();
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

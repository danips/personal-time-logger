import { ApiError, ERROR } from "./errors.js";

function decodeHex(value) {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{64}$/.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function constantTimeEqual(left, right) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index % (left.length || 1)] || 0) ^ (right[index % (right.length || 1)] || 0);
  }
  return difference === 0;
}

export async function authenticate(request, env) {
  const configured = decodeHex(env?.PTL_API_TOKEN_SHA256);
  const authorization = request.headers.get("Authorization") || "";
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  let supplied = new Uint8Array();
  if (match) supplied = new globalThis.TextEncoder().encode(match[1]);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", supplied);
  const valid = configured !== null && match !== null
    && constantTimeEqual(new Uint8Array(digest), configured);
  if (!valid) throw new ApiError(401, ERROR.AUTH_REQUIRED, "Authentication is required.");
}

export { decodeHex, constantTimeEqual };

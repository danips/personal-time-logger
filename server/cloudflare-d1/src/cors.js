import { ApiError, ERROR } from "./errors.js";

const METHODS = new Set(["GET", "POST", "OPTIONS"]);
const HEADERS = new Set(["authorization", "content-type"]);

export function extensionOrigin(value) {
  if (!value) return null;
  try {
    const url = new globalThis.URL(value);
    if (url.protocol !== "moz-extension:" || !url.hostname || url.port || url.username || url.password
      || (url.pathname && url.pathname !== "/") || url.search || url.hash) return null;
    // WHATWG URL reports an opaque origin for moz-extension in Node, while
    // Firefox exposes the scheme-specific origin to CORS. Reconstruct only
    // after the URL fields above have rejected all path/query credentials.
    return `moz-extension://${url.host}`;
  } catch {
    return null;
  }
}

export function corsHeaders(origin) {
  return origin ? {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin"
  } : {};
}

export function validateOrigin(request) {
  const supplied = request.headers.get("Origin");
  if (!supplied) return null;
  const origin = extensionOrigin(supplied);
  if (!origin) throw new ApiError(403, ERROR.ORIGIN_NOT_ALLOWED, "The request origin is not allowed.");
  return origin;
}

export function handlePreflight(request, origin) {
  if (!origin) throw new ApiError(403, ERROR.ORIGIN_NOT_ALLOWED, "A valid extension origin is required.");
  const requestedMethod = request.headers.get("Access-Control-Request-Method") || "";
  const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") || "")
    .split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
  if (!METHODS.has(requestedMethod) || requestedHeaders.some((header) => !HEADERS.has(header))) {
    throw new ApiError(403, ERROR.ORIGIN_NOT_ALLOWED, "The requested CORS method or header is not allowed.");
  }
  return new globalThis.Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Cache-Control": "no-store"
    }
  });
}

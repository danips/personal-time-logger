import { ERROR_CODE } from "./error-codes.js";

const KNOWN_ERROR_CODES = new Set(Object.values(ERROR_CODE));

/** Creates a safe, stable error consumed by the recovery registry. */
export function codedError(code, message, { cause, details = {} } = {}) {
  if (!KNOWN_ERROR_CODES.has(code)) throw new TypeError(`Unknown extension error code: ${code}`);
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  for (const [key, value] of Object.entries(details)) error[key] = value;
  return error;
}

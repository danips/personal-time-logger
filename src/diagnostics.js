import { getSetting, mutateSetting, setSetting } from "./db.js";

export const DIAGNOSTICS_KEY = "diagnostic_ring";
export const MAX_DIAGNOSTICS = 50;
const DEDUPE_WINDOW_MS = 60_000;

function text(value, fallback = "unknown") {
  const normalized = String(value || fallback)
    .replace(/https?:\S+/gi, "")
    .replace(/[^a-zA-Z0-9_:. -]/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function count(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.min(Math.floor(numeric), 1_000_000) : 0;
}

function normalizedRetryAt(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

/**
 * Persists a short recovery record without entry content, account data, URLs,
 * request bodies, or raw error messages. Repeated expected failures refresh the
 * newest record instead of filling the ring during a background retry loop.
 */
export async function recordDiagnostic({ subsystem, phase, code, error, entryCount = 0, retryAt = 0, recovery = "Retry the operation." } = {}) {
  const diagnostic = {
    at: new Date().toISOString(),
    subsystem: text(subsystem, "extension"),
    phase: text(phase, "unknown"),
    code: text(code || error?.code, "UNEXPECTED_ERROR"),
    entry_count: count(entryCount),
    retry_at: normalizedRetryAt(retryAt),
    recovery: text(recovery, "Retry the operation.")
  };
  return mutateSetting(DIAGNOSTICS_KEY, (current) => {
    const records = Array.isArray(current) ? current : [];
    const previous = records.at(-1);
    const previousAt = Date.parse(previous?.at || "");
    const duplicate = previous
      && previous.subsystem === diagnostic.subsystem
      && previous.phase === diagnostic.phase
      && previous.code === diagnostic.code
      && Date.now() - previousAt < DEDUPE_WINDOW_MS;
    return [...(duplicate ? records.slice(0, -1) : records), diagnostic].slice(-MAX_DIAGNOSTICS);
  });
}

export async function getDiagnostics() {
  const records = await getSetting(DIAGNOSTICS_KEY, []);
  return Array.isArray(records) ? records.map((record) => ({ ...record })) : [];
}

export async function clearDiagnostics() {
  await setSetting(DIAGNOSTICS_KEY, []);
}

export function diagnosticsText(records) {
  return (Array.isArray(records) ? records : [])
    .map((record) => [
      record.at,
      record.subsystem,
      record.phase,
      record.code,
      `entries=${count(record.entry_count)}`,
      `retry_at=${normalizedRetryAt(record.retry_at)}`,
      record.recovery
    ].join("\t"))
    .join("\n");
}

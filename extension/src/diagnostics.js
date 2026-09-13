import { getSetting, mutateSetting, setSetting } from "./db.js";
import { SETTING_KEY } from "./setting-keys.js";

export const DIAGNOSTICS_KEY = SETTING_KEY.DIAGNOSTIC_RING;
export const MAX_DIAGNOSTICS = 50;
export const MAX_OCCURRENCES = 1_000_000;
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

function extensionVersion() {
  try {
    return text(globalThis.browser?.runtime?.getManifest?.()?.version, "unknown");
  } catch {
    return "unknown";
  }
}

/**
 * Persists a short recovery record without entry content, account data, URLs,
 * request bodies, or raw error messages. Repeated expected failures refresh the
 * newest record instead of filling the ring during a background retry loop.
 */
export async function recordDiagnostic({
  subsystem,
  phase,
  code,
  error,
  entryCount = 0,
  retryAt = 0,
  provider = "unknown",
  freshness = "",
  recovery = "Retry the operation."
} = {}) {
  const diagnostic = {
    at: new Date().toISOString(),
    subsystem: text(subsystem, "extension"),
    phase: text(phase, "unknown"),
    code: text(code || error?.code, "UNEXPECTED_ERROR"),
    cause_code: text(error?.cause?.code, ""),
    extension_version: extensionVersion(),
    provider: text(provider, "unknown"),
    freshness: text(freshness, ""),
    entry_count: count(entryCount),
    retry_at: normalizedRetryAt(retryAt),
    recovery: text(recovery, "Retry the operation."),
    occurrences: 1
  };
  return mutateSetting(DIAGNOSTICS_KEY, (current) => {
    const records = Array.isArray(current) ? current : [];
    const previous = records.at(-1);
    const previousAt = Date.parse(previous?.at || "");
    const duplicate = previous
      && previous.phase === diagnostic.phase
      && previous.code === diagnostic.code
      && previous.cause_code === diagnostic.cause_code
      && Date.now() - previousAt < DEDUPE_WINDOW_MS;
    const next = duplicate
      ? {
        ...previous,
        ...diagnostic,
        occurrences: Math.min(count(previous.occurrences || 1) + 1, MAX_OCCURRENCES)
      }
      : diagnostic;
    return [...(duplicate ? records.slice(0, -1) : records), next].slice(-MAX_DIAGNOSTICS);
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
      record.cause_code || "",
      `version=${text(record.extension_version, "unknown")}`,
      `provider=${text(record.provider, "unknown")}`,
      `freshness=${text(record.freshness, "")}`,
      `entries=${count(record.entry_count)}`,
      `retry_at=${normalizedRetryAt(record.retry_at)}`,
      `occurrences=${Math.min(count(record.occurrences || 1), MAX_OCCURRENCES)}`,
      record.recovery
    ].join("\t"))
    .join("\n");
}

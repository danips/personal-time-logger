import { getAllEntries, getSetting } from "./db.js";
import { getActiveRemoteProvider } from "./remote-provider.js";
import { SETTING_KEY } from "./setting-keys.js";

function futureTimestamp(value, now) {
  const timestamp = Number(value) || Date.parse(value || "") || 0;
  return timestamp > now ? timestamp : 0;
}

function formatTimestamp(value, fallback = "not yet") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString();
}

export async function readSyncStatus({ now = Date.now(), provider = null } = {}) {
  const [activeProvider, entries, lastSuccessAt, lastStatus, dueAt, retryAt] = await Promise.all([
    provider || getActiveRemoteProvider(),
    getAllEntries(),
    getSetting(SETTING_KEY.SYNC_LAST_SUCCESS_AT, ""),
    getSetting(SETTING_KEY.SYNC_LAST_STATUS, ""),
    getSetting(SETTING_KEY.BACKGROUND_SYNC_DUE_AT, 0),
    getSetting(SETTING_KEY.SYNC_BACKOFF_UNTIL, 0)
  ]);
  const liveEntries = entries.filter((entry) => !entry.deleted_at);
  const pendingCount = liveEntries.filter((entry) => entry.dirty).length;
  const reviewCount = liveEntries.filter((entry) => entry.status === "needs_review").length;
  const nextRetryAt = futureTimestamp(retryAt, now);
  const nextDueAt = futureTimestamp(dueAt, now);
  const state = reviewCount || lastStatus === "needs review"
    ? "needs-review"
    : pendingCount
      ? "locally-saved"
      : lastSuccessAt
        ? "remotely-synchronized"
        : "not-synchronized";
  return {
    provider: { id: activeProvider.id, label: activeProvider.label },
    pendingCount,
    reviewCount,
    lastSuccessAt: String(lastSuccessAt || ""),
    lastStatus: String(lastStatus || ""),
    nextRetryAt,
    nextDueAt,
    state
  };
}

export function formatSyncContext(snapshot) {
  const stateLabel = {
    "locally-saved": "locally saved",
    "remotely-synchronized": "remotely synchronized",
    "needs-review": "needs review",
    "not-synchronized": "not synchronized"
  }[snapshot?.state] || "not synchronized";
  const retry = snapshot?.nextRetryAt
    ? `next retry ${formatTimestamp(snapshot.nextRetryAt)}`
    : snapshot?.nextDueAt
      ? `next retry check ${formatTimestamp(snapshot.nextDueAt)}`
      : "next retry not scheduled";
  return `State: ${stateLabel} · Provider: ${snapshot?.provider?.label || "unknown"} · Local pending: ${snapshot?.pendingCount ?? 0} · Last remote success: ${formatTimestamp(snapshot?.lastSuccessAt)} · Review: ${snapshot?.reviewCount ?? 0} · ${retry}`;
}

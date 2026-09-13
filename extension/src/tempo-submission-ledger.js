import { mutateSetting, getSetting } from "./db.js";
import { normalizeTempoIssueId } from "./tempo.js";
import { ERROR_CODE } from "./error-codes.js";
import { SETTING_KEY } from "./setting-keys.js";

export const TEMPO_LEDGER_SCHEMA_VERSION = 1;
export const TEMPO_LEDGER_DESTINATION = "tempo";
export const TEMPO_LEDGER_SETTING_KEY = SETTING_KEY.TEMPO_SUBMISSION_LEDGER;
export const TEMPO_TRACKING_STARTED_SETTING_KEY = SETTING_KEY.TEMPO_SUBMISSION_TRACKING_STARTED_AT;
export const TEMPO_LEDGER_STATE = Object.freeze({
  PENDING: "pending",
  ACKNOWLEDGED: "acknowledged",
  REJECTED: "rejected",
  UNKNOWN: "unknown"
});

const TERMINAL_STATES = new Set([
  TEMPO_LEDGER_STATE.ACKNOWLEDGED,
  TEMPO_LEDGER_STATE.REJECTED,
  TEMPO_LEDGER_STATE.UNKNOWN
]);

function ledgerError(message) {
  return Object.assign(new Error(message), { code: ERROR_CODE.TEMPO_LEDGER_INVALID });
}

function timestamp(value) {
  const parsed = new Date(value || Date.now());
  if (Number.isNaN(parsed.getTime())) throw ledgerError("Tempo ledger timestamps must be valid dates");
  return parsed.toISOString();
}

function optionalTimestamp(value) {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw ledgerError(`Tempo ledger ${label} is required`);
  return normalized;
}

function normalizeAllocation(identity) {
  const entryFingerprint = requiredText(identity?.entryFingerprint, "entry fingerprint");
  const localDate = requiredText(identity?.localDate, "local date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw ledgerError("Tempo ledger local date is invalid");
  const timeSpentSeconds = Number(identity?.timeSpentSeconds);
  if (!Number.isSafeInteger(timeSpentSeconds) || timeSpentSeconds < 1) {
    throw ledgerError("Tempo ledger duration must be a positive integer");
  }
  const issueId = normalizeTempoIssueId(identity?.issueId);
  if (!issueId) throw ledgerError("Tempo ledger issue ID is invalid");
  const authorAccountId = requiredText(identity?.authorAccountId, "author account");
  return {
    destination: TEMPO_LEDGER_DESTINATION,
    entry_fingerprint: entryFingerprint,
    local_date: localDate,
    time_spent_seconds: timeSpentSeconds,
    issue_id: issueId,
    author_account_id: authorAccountId
  };
}

export function tempoAllocationIdentity(identity) {
  const normalized = normalizeAllocation(identity);
  return {
    ...normalized,
    key: JSON.stringify(normalized)
  };
}

function claimId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeRecord(record) {
  if (!record || record.schema_version !== TEMPO_LEDGER_SCHEMA_VERSION) {
    throw ledgerError("Tempo ledger record version is unsupported");
  }
  const allocation = normalizeAllocation({
    entryFingerprint: record.entry_fingerprint,
    localDate: record.local_date,
    timeSpentSeconds: record.time_spent_seconds,
    issueId: record.issue_id,
    authorAccountId: record.author_account_id
  });
  const state = String(record.state || "");
  if (!Object.values(TEMPO_LEDGER_STATE).includes(state)) throw ledgerError("Tempo ledger state is invalid");
  const normalized = {
    schema_version: TEMPO_LEDGER_SCHEMA_VERSION,
    claim_id: requiredText(record.claim_id, "claim ID"),
    ...allocation,
    key: JSON.stringify(allocation),
    state,
    claimed_at: timestamp(record.claimed_at),
    updated_at: timestamp(record.updated_at || record.claimed_at),
    outcome_at: record.outcome_at ? timestamp(record.outcome_at) : ""
  };
  if (record.key && record.key !== normalized.key) throw ledgerError("Tempo ledger identity key is inconsistent");
  return normalized;
}

function normalizedRecords(value, { recoverPending = false, now = Date.now() } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw ledgerError("Tempo submission ledger must be an array");
  const records = value.map(normalizeRecord);
  if (!recoverPending) return records;
  const recoveredAt = timestamp(now);
  return records.map((record) => record.state === TEMPO_LEDGER_STATE.PENDING
    ? { ...record, state: TEMPO_LEDGER_STATE.UNKNOWN, updated_at: recoveredAt, outcome_at: recoveredAt }
    : record);
}

function latestFor(records, key) {
  return records.filter((record) => record.key === key).at(-1);
}

function relatedAllocation(records, allocation) {
  return records.find((record) => record.entry_fingerprint === allocation.entry_fingerprint
    && record.local_date === allocation.local_date
    && record.key !== JSON.stringify(allocation));
}

function publicResult({ claimed, reason, record, related }) {
  return {
    claimed,
    reason,
    requiresReview: reason === "unknown-history" || reason === "changed-allocation",
    record: record ? { ...record } : null,
    related: related ? { ...related } : null
  };
}

export async function getTempoSubmissionLedger() {
  const records = normalizedRecords(await getSetting(TEMPO_LEDGER_SETTING_KEY, []));
  return records.map((record) => ({ ...record }));
}

/** Establishes the local feature epoch used to distinguish new work from pre-ledger history. */
export async function ensureTempoSubmissionTrackingStarted({ now = Date.now() } = {}) {
  let startedAt = "";
  await mutateSetting(TEMPO_TRACKING_STARTED_SETTING_KEY, (current) => {
    startedAt = optionalTimestamp(current) || timestamp(now);
    return startedAt;
  });
  return startedAt;
}

export async function recoverPendingTempoClaims({ now = Date.now() } = {}) {
  let recovered = 0;
  const recoveredAt = timestamp(now);
  await mutateSetting(TEMPO_LEDGER_SETTING_KEY, (current) => {
    const records = normalizedRecords(current);
    const next = records.map((record) => {
      if (record.state !== TEMPO_LEDGER_STATE.PENDING) return record;
      recovered += 1;
      return { ...record, state: TEMPO_LEDGER_STATE.UNKNOWN, updated_at: recoveredAt, outcome_at: recoveredAt };
    });
    return next;
  });
  return recovered;
}

export async function getTempoAllocationStatus(identity) {
  const allocation = tempoAllocationIdentity(identity);
  const records = await getTempoSubmissionLedger();
  const record = latestFor(records, allocation.key);
  if (!record) {
    const related = relatedAllocation(records, allocation);
    const trackingStartedAt = optionalTimestamp(identity?.trackingStartedAt)
      || optionalTimestamp(await getSetting(TEMPO_TRACKING_STARTED_SETTING_KEY, ""));
    const createdAt = optionalTimestamp(identity?.entryCreatedAt);
    const isPostTrackingUnsent = !related && trackingStartedAt && createdAt
      && new Date(createdAt).getTime() >= new Date(trackingStartedAt).getTime();
    return {
      state: isPostTrackingUnsent ? "unsent" : "unknown",
      history: "unknown",
      eligible: Boolean(isPostTrackingUnsent),
      requiresReview: !isPostTrackingUnsent,
      reason: related ? "changed-allocation" : isPostTrackingUnsent ? "unsent" : "unknown-history",
      record: null,
      related: related ? { ...related } : null
    };
  }
  return {
    state: record.state,
    history: "known",
    eligible: record.state === TEMPO_LEDGER_STATE.REJECTED,
    requiresReview: false,
    reason: record.state === TEMPO_LEDGER_STATE.REJECTED ? "known-rejection" : record.state,
    record: { ...record },
    related: null
  };
}

export async function claimTempoAllocation(identity, { resend = false, reviewed = false, now = Date.now() } = {}) {
  const allocation = tempoAllocationIdentity(identity);
  const claimedAt = timestamp(now);
  let result;
  await mutateSetting(TEMPO_LEDGER_SETTING_KEY, (current) => {
    const records = normalizedRecords(current);
    const existing = latestFor(records, allocation.key);
    const related = relatedAllocation(records, allocation);
    if (!existing) {
      if (!reviewed) {
        result = publicResult({ claimed: false, reason: related ? "changed-allocation" : "unknown-history", related });
        return records;
      }
    } else if (existing.state === TEMPO_LEDGER_STATE.PENDING) {
      result = publicResult({ claimed: false, reason: "pending", record: existing });
      return records;
    } else if (existing.state === TEMPO_LEDGER_STATE.ACKNOWLEDGED && !resend) {
      result = publicResult({ claimed: false, reason: "acknowledged", record: existing });
      return records;
    } else if (existing.state === TEMPO_LEDGER_STATE.UNKNOWN && !resend) {
      result = publicResult({ claimed: false, reason: "unknown", record: existing });
      return records;
    }
    const record = {
      schema_version: TEMPO_LEDGER_SCHEMA_VERSION,
      claim_id: claimId(),
      ...allocation,
      key: allocation.key,
      state: TEMPO_LEDGER_STATE.PENDING,
      claimed_at: claimedAt,
      updated_at: claimedAt,
      outcome_at: ""
    };
    records.push(record);
    result = publicResult({ claimed: true, reason: "claimed", record, related });
    return records;
  });
  return result;
}

export async function recordTempoOutcome(claimIdValue, state, { now = Date.now() } = {}) {
  if (!TERMINAL_STATES.has(state)) throw ledgerError("Tempo outcome must be acknowledged, rejected, or unknown");
  const id = requiredText(claimIdValue, "claim ID");
  const outcomeAt = timestamp(now);
  let result;
  await mutateSetting(TEMPO_LEDGER_SETTING_KEY, (current) => {
    const records = normalizedRecords(current);
    const index = records.findIndex((record) => record.claim_id === id);
    if (index < 0) throw ledgerError("Tempo ledger claim was not found");
    if (records[index].state !== TEMPO_LEDGER_STATE.PENDING) throw ledgerError("Tempo ledger claim is already resolved");
    records[index] = { ...records[index], state, updated_at: outcomeAt, outcome_at: outcomeAt };
    result = { ...records[index] };
    return records;
  });
  return result;
}

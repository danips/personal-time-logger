import { getSetting } from "./db.js";
import { ERROR_CODE } from "./error-codes.js";
import {
  claimTempoAllocation,
  recordTempoOutcome,
  recoverPendingTempoClaims,
  tempoAllocationIdentity
} from "./tempo-submission-ledger.js";
import {
  sendTempoWorklogs,
  TEMPO_CANCEL_MESSAGE,
  TEMPO_UPLOAD_MESSAGE,
  tempoXhrRequest
} from "./tempo.js";
import { SETTING_KEY } from "./setting-keys.js";

const TEMPO_ERROR_CODES = new Set([
  ERROR_CODE.TEMPO_API_ERROR,
  ERROR_CODE.TEMPO_CANCELLED,
  ERROR_CODE.TEMPO_CONFIG_MISSING,
  ERROR_CODE.TEMPO_LEDGER_INVALID,
  ERROR_CODE.TEMPO_NETWORK,
  ERROR_CODE.TEMPO_PARTIAL,
  ERROR_CODE.TEMPO_PERMISSION_MISSING
]);

function uploadError(message) {
  return Object.assign(new Error(message), { code: ERROR_CODE.TEMPO_API_ERROR });
}

function validateGroups(groups, tempoAllocationIdentity) {
  if (!Array.isArray(groups)) throw uploadError("Tempo upload payload is invalid");
  return groups.map((group) => {
    const issueId = String(group?.issueId ?? "").trim();
    if (!/^\d+$/.test(issueId) || BigInt(issueId) < 1n || !Array.isArray(group.worklogs)) {
      throw uploadError("Tempo upload payload is invalid");
    }
    const worklogs = group.worklogs.map((worklog) => {
      if (!worklog || typeof worklog !== "object"
        || typeof worklog.entryFingerprint !== "string"
        || typeof worklog.authorAccountId !== "string"
        || typeof worklog.description !== "string"
        || typeof worklog.startDate !== "string"
        || (worklog.resend !== undefined && typeof worklog.resend !== "boolean")) {
        throw uploadError("Tempo upload payload is invalid");
      }
      try {
        tempoAllocationIdentity({
          entryFingerprint: worklog.entryFingerprint,
          localDate: worklog.startDate,
          timeSpentSeconds: worklog.timeSpentSeconds,
          issueId,
          authorAccountId: worklog.authorAccountId
        });
      } catch {
        throw uploadError("Tempo upload payload is invalid");
      }
      return { ...worklog };
    });
    return { issueId, worklogs };
  });
}

function outcomeError(error) {
  const code = TEMPO_ERROR_CODES.has(error?.code)
    ? error.code
    : ERROR_CODE.TEMPO_NETWORK;
  return {
    code,
    message: error?.message || "Tempo upload failed.",
    acknowledgedWorklogs: error?.acknowledgedWorklogs ?? 0,
    requestCount: error?.requestCount ?? 0,
    currentRequestOutcome: error?.currentRequestOutcome ?? "unknown"
  };
}

export function createTempoUploadHandler({
  platform,
  getSettingImpl = getSetting,
  sendTempoWorklogsImpl = sendTempoWorklogs,
  tempoXhrRequestImpl = tempoXhrRequest,
  claimTempoAllocationImpl = claimTempoAllocation,
  recordTempoOutcomeImpl = recordTempoOutcome,
  recoverPendingTempoClaimsImpl = recoverPendingTempoClaims,
  isCancelled = () => false
} = {}) {
  if (!platform?.getURL) throw new TypeError("A platform URL adapter is required");
  const startupRecovery = Promise.resolve().then(() => recoverPendingTempoClaimsImpl());
  startupRecovery.catch(() => {});

  return async function uploadTempoWorklogs(message, sender) {
    const calendarUrl = platform.getURL("calendar/calendar.html");
    if (sender?.url !== calendarUrl) {
      return { ok: false, error: { code: ERROR_CODE.TEMPO_PERMISSION_MISSING } };
    }
    let groups;
    try {
      groups = validateGroups(message?.groups, tempoAllocationIdentity);
    } catch (error) {
      return { ok: false, error: outcomeError(error) };
    }
    try {
      const operationId = String(message?.operationId ?? "").trim();
      await startupRecovery;
      const token = await getSettingImpl(SETTING_KEY.TEMPO_API_TOKEN, "");
      const skipped = [];
      const result = await sendTempoWorklogsImpl(groups, {
        token,
        shouldCancel: () => isCancelled(operationId),
        fetchImpl: tempoXhrRequestImpl,
        beforeChunk: async ({ issueId, worklogs }) => {
          const sendable = [];
          const claimIds = [];
          for (const worklog of worklogs) {
            const decision = await claimTempoAllocationImpl({
              entryFingerprint: worklog.entryFingerprint,
              localDate: worklog.startDate,
              timeSpentSeconds: worklog.timeSpentSeconds,
              issueId,
              authorAccountId: worklog.authorAccountId
            }, { reviewed: true, resend: Boolean(worklog.resend) });
            if (decision.claimed) {
              sendable.push(worklog);
              claimIds.push(decision.record.claim_id);
            } else {
              skipped.push({ reason: decision.reason, entryFingerprint: worklog.entryFingerprint, localDate: worklog.startDate });
            }
          }
          return { worklogs: sendable, claimIds };
        },
        onChunkOutcome: async ({ claimIds, outcome }) => {
          for (const claimId of claimIds) await recordTempoOutcomeImpl(claimId, outcome);
        }
      });
      return { ok: true, result: { ...result, skippedWorklogs: skipped.length, skipped } };
    } catch (error) {
      return { ok: false, error: outcomeError(error) };
    }
  };
}

export { TEMPO_UPLOAD_MESSAGE, TEMPO_CANCEL_MESSAGE };

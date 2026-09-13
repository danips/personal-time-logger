import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;
const db = await import("../extension/src/db.js");
const ledger = await import("../extension/src/tempo-submission-ledger.js");
const backup = await import("../extension/src/backup.js");
const { SETTING_KEY } = await import("../extension/src/setting-keys.js");

const allocation = (over = {}) => ({
  entryFingerprint: "entry-fingerprint-1",
  localDate: "2026-09-12",
  timeSpentSeconds: 3600,
  issueId: "42",
  authorAccountId: "author-1",
  ...over
});

describe("Tempo submission ledger", () => {
  beforeEach(async () => {
    await db.removeSetting(SETTING_KEY.TEMPO_SUBMISSION_LEDGER);
    await db.removeSetting(SETTING_KEY.TEMPO_SUBMISSION_TRACKING_STARTED_AT);
  });

  it("requires review for untracked history and atomically blocks duplicate claims", async () => {
    const first = await ledger.claimTempoAllocation(allocation(), { reviewed: false, now: "2026-09-12T10:00:00.000Z" });
    assert.equal(first.claimed, false);
    assert.equal(first.reason, "unknown-history");
    assert.equal(first.requiresReview, true);

    const claims = await Promise.all([
      ledger.claimTempoAllocation(allocation(), { reviewed: true, now: "2026-09-12T10:01:00.000Z" }),
      ledger.claimTempoAllocation(allocation(), { reviewed: true, now: "2026-09-12T10:01:01.000Z" })
    ]);
    assert.equal(claims.filter(({ claimed }) => claimed).length, 1);
    const claimed = claims.find(({ claimed: didClaim }) => didClaim);
    const duplicate = claims.find(({ claimed: didClaim }) => !didClaim);
    assert.equal(claimed.record.state, "pending");
    assert.equal(duplicate.reason, "pending");
  });

  it("identifies post-epoch allocations as unsent while retaining pre-epoch review", async () => {
    const trackingStartedAt = await ledger.ensureTempoSubmissionTrackingStarted({ now: "2026-09-12T10:00:00.000Z" });
    assert.equal(
      await ledger.ensureTempoSubmissionTrackingStarted({ now: "2026-09-12T11:00:00.000Z" }),
      trackingStartedAt
    );
    const unsent = await ledger.getTempoAllocationStatus({
      ...allocation(),
      entryCreatedAt: "2026-09-12T10:00:01.000Z"
    });
    assert.equal(unsent.state, "unsent");
    assert.equal(unsent.reason, "unsent");
    assert.equal(unsent.eligible, true);
    assert.equal(unsent.requiresReview, false);

    const historical = await ledger.getTempoAllocationStatus({
      ...allocation({ entryFingerprint: "old-entry" }),
      entryCreatedAt: "2026-09-12T09:59:59.000Z",
      trackingStartedAt
    });
    assert.equal(historical.state, "unknown");
    assert.equal(historical.reason, "unknown-history");
    assert.equal(historical.requiresReview, true);
  });

  it("preserves acknowledged and unknown outcomes until explicit resend", async () => {
    const claimed = await ledger.claimTempoAllocation(allocation(), { reviewed: true, now: "2026-09-12T11:00:00.000Z" });
    const acknowledged = await ledger.recordTempoOutcome(claimed.record.claim_id, "acknowledged", { now: "2026-09-12T11:01:00.000Z" });
    assert.equal(acknowledged.state, "acknowledged");
    assert.equal((await ledger.claimTempoAllocation(allocation())).reason, "acknowledged");

    const resend = await ledger.claimTempoAllocation(allocation(), { resend: true, now: "2026-09-12T11:02:00.000Z" });
    assert.equal(resend.claimed, true);
    assert.notEqual(resend.record.claim_id, acknowledged.claim_id);
    assert.equal((await ledger.getTempoSubmissionLedger()).filter(({ key }) => key === resend.record.key).length, 2);
    await ledger.recordTempoOutcome(resend.record.claim_id, "unknown", { now: "2026-09-12T11:03:00.000Z" });
    assert.equal((await ledger.claimTempoAllocation(allocation())).reason, "unknown");
    const explicitUnknownResend = await ledger.claimTempoAllocation(allocation(), { resend: true, now: "2026-09-12T11:04:00.000Z" });
    assert.equal(explicitUnknownResend.claimed, true);

    const rejectedClaim = await ledger.claimTempoAllocation(allocation({ localDate: "2026-09-13" }), { reviewed: true });
    await ledger.recordTempoOutcome(rejectedClaim.record.claim_id, "rejected");
    const retry = await ledger.claimTempoAllocation(allocation({ localDate: "2026-09-13" }));
    assert.equal(retry.claimed, true);
  });

  it("keeps changed same-day allocations under review without overwriting acknowledgement evidence", async () => {
    const claimed = await ledger.claimTempoAllocation(allocation(), { reviewed: true });
    await ledger.recordTempoOutcome(claimed.record.claim_id, "acknowledged");
    const changed = allocation({ timeSpentSeconds: 3601 });
    const blocked = await ledger.claimTempoAllocation(changed, { reviewed: false });
    assert.equal(blocked.reason, "changed-allocation");
    const reviewed = await ledger.claimTempoAllocation(changed, { reviewed: true });
    assert.equal(reviewed.claimed, true);
    assert.equal((await ledger.getTempoAllocationStatus(changed)).state, "pending");
    assert.equal((await ledger.getTempoSubmissionLedger()).filter(({ state }) => state === "acknowledged").length, 1);
  });

  it("recovers pending claims as unknown and excludes ledger data from backups", async () => {
    const claimed = await ledger.claimTempoAllocation(allocation(), { reviewed: true });
    assert.equal((await ledger.getTempoSubmissionLedger())[0].state, "pending");
    const recovered = await ledger.recoverPendingTempoClaims();
    assert.equal(recovered, 1);
    assert.equal((await ledger.getTempoAllocationStatus(allocation())).history, "known");

    await db.setSetting(SETTING_KEY.TEMPO_SUBMISSION_LEDGER, [{ ...claimed.record, state: "acknowledged" }]);
    const snapshot = await backup.readPortableBackupSnapshot();
    const serialized = backup.serializeBackup(snapshot);
    assert.equal(serialized.includes("tempo_submission_ledger"), false);
    assert.equal(serialized.includes(claimed.record.entry_fingerprint), false);
  });
});

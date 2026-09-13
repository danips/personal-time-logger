import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { installFakeIndexedDB } from "./support/fake-indexeddb.js";
import {
  tempoCalendarUrl,
  tempoGroup,
  tempoPlatform,
  tempoResponse,
  tempoXhrTransport
} from "./support/tempo-fixtures.js";

installFakeIndexedDB();
globalThis.BroadcastChannel = undefined;
const db = await import("../extension/src/db.js");
const { createTempoUploadHandler } = await import("../extension/src/tempo-upload-handler.js");
const ledger = await import("../extension/src/tempo-submission-ledger.js");
const { SETTING_KEY } = await import("../extension/src/setting-keys.js");

const createHandler = (overrides = {}) => createTempoUploadHandler({
  platform: tempoPlatform,
  getSettingImpl: db.getSetting,
  tempoXhrRequestImpl: tempoXhrTransport(),
  ...overrides
});

describe("Tempo upload runtime handler", () => {
  beforeEach(async () => {
    await db.removeSetting(SETTING_KEY.TEMPO_SUBMISSION_LEDGER);
    await db.setSetting(SETTING_KEY.TEMPO_API_TOKEN, "handler-token");
  });

  it("validates the sender and full allocation payload before claiming", async () => {
    let claims = 0;
    const handler = createHandler({
      claimTempoAllocationImpl: async () => { claims += 1; return { claimed: true, record: { claim_id: "never" } }; },
      tempoXhrRequestImpl: async () => tempoResponse(200)
    });
    const wrongSender = await handler({ groups: [tempoGroup()] }, { url: "https://example.invalid/" });
    assert.equal(wrongSender.error.code, "TEMPO_PERMISSION_MISSING");
    const malformed = await handler({ groups: [{ issueId: "42", worklogs: [{}] }] }, { url: tempoCalendarUrl });
    assert.equal(malformed.error.code, "TEMPO_API_ERROR");
    assert.equal(claims, 0);
  });

  it("claims before XHR, records acknowledgement, and strips ledger metadata from the wire body", async () => {
    const requests = [];
    const handler = createHandler({
      tempoXhrRequestImpl: tempoXhrTransport({
        onSend: ({ url, body }) => requests.push({ url, body: JSON.parse(body) })
      })
    });
    const result = await handler({ groups: [tempoGroup()] }, { url: tempoCalendarUrl });
    assert.equal(result.ok, true);
    assert.equal(result.result.sentWorklogs, 1);
    assert.equal(result.result.skippedWorklogs, 0);
    assert.deepEqual(requests[0].body, [{
      authorAccountId: "author-1",
      description: "Work comment",
      startDate: "2026-09-12",
      timeSpentSeconds: 3600
    }]);
    assert.equal((await ledger.getTempoSubmissionLedger())[0].state, "acknowledged");
  });

  it("allows only one concurrent handler to dispatch a claimed allocation", async () => {
    let requests = 0;
    const handler = createHandler({
      tempoXhrRequestImpl: async () => { requests += 1; return tempoResponse(200); }
    });
    const results = await Promise.all([
      handler({ groups: [tempoGroup()] }, { url: tempoCalendarUrl }),
      handler({ groups: [tempoGroup()] }, { url: tempoCalendarUrl })
    ]);
    assert.equal(results.filter(({ ok, result }) => ok && result.sentWorklogs === 1).length, 1);
    assert.equal(requests, 1);
    assert.equal(results.filter(({ result }) => result?.skippedWorklogs === 1).length, 1);
  });

  it("recovers pending claims once at background-handler startup", async () => {
    await ledger.claimTempoAllocation({
      entryFingerprint: "entry-restart",
      localDate: "2026-09-12",
      timeSpentSeconds: 3600,
      issueId: "42",
      authorAccountId: "author-1"
    }, { reviewed: true });
    let requests = 0;
    const handler = createHandler({
      tempoXhrRequestImpl: tempoXhrTransport({ onSend: () => { requests += 1; } })
    });
    const result = await handler({ groups: [tempoGroup({ entryFingerprint: "entry-restart" })] }, { url: tempoCalendarUrl });
    assert.equal(result.ok, true);
    assert.equal(result.result.skipped[0].reason, "unknown");
    assert.equal(requests, 0);
    assert.equal((await ledger.getTempoSubmissionLedger())[0].state, "unknown");
  });

  it("records a known rejection as retryable and a lost response as unknown", async () => {
    const rejectedHandler = createHandler({
      tempoXhrRequestImpl: tempoXhrTransport({ status: 400, responseText: JSON.stringify({ message: "denied" }) })
    });
    const rejected = await rejectedHandler({ groups: [tempoGroup()] }, { url: tempoCalendarUrl });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "TEMPO_API_ERROR");
    assert.equal((await ledger.getTempoSubmissionLedger())[0].state, "rejected");

    const retryHandler = createHandler();
    assert.equal((await retryHandler({ groups: [tempoGroup()] }, { url: tempoCalendarUrl })).ok, true);

    const lostHandler = createHandler({
      tempoXhrRequestImpl: tempoXhrTransport({ event: "timeout" })
    });
    const lost = await lostHandler({ groups: [tempoGroup({ entryFingerprint: "entry-2" })] }, { url: tempoCalendarUrl });
    assert.equal(lost.ok, false);
    assert.equal(lost.error.code, "TEMPO_NETWORK");
    assert.equal(lost.error.currentRequestOutcome, "unknown");
    assert.equal((await ledger.getTempoSubmissionLedger()).find(({ entry_fingerprint: fingerprint }) => fingerprint === "entry-2").state, "unknown");
  });

  it("records an interrupted response body as a known rejection", async () => {
    const handler = createHandler({
      tempoXhrRequestImpl: tempoXhrTransport({ status: 400, responseText: "{" })
    });
    const result = await handler({ groups: [tempoGroup({ entryFingerprint: "entry-3" })] }, { url: tempoCalendarUrl });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "TEMPO_API_ERROR");
    assert.equal((await ledger.getTempoSubmissionLedger()).find(({ entry_fingerprint: fingerprint }) => fingerprint === "entry-3").state, "rejected");
  });

  it("cancels future chunks and reopens unknown history without replaying it", async () => {
    let cancelled = false;
    let requests = 0;
    const worklogs = Array.from({ length: 51 }, (_, index) => ({
      authorAccountId: "author-1",
      description: `Work ${index}`,
      startDate: "2026-09-12",
      timeSpentSeconds: 60,
      entryFingerprint: `entry-cancel-${index}`
    }));
    const handler = createHandler({
      isCancelled: (operationId) => cancelled && operationId === "cancel-me",
      tempoXhrRequestImpl: tempoXhrTransport({ onSend: () => { requests += 1; cancelled = true; } })
    });
    const result = await handler({ operationId: "cancel-me", groups: [{ issueId: "42", worklogs }] }, { url: tempoCalendarUrl });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "TEMPO_CANCELLED");
    assert.equal(result.error.acknowledgedWorklogs, 50);
    assert.equal(result.error.currentRequestOutcome, "acknowledged");
    assert.equal(requests, 1);
    assert.equal((await ledger.getTempoSubmissionLedger()).filter(({ state }) => state === "acknowledged").length, 50);

    const lostHandler = createHandler({
      tempoXhrRequestImpl: tempoXhrTransport({ event: "timeout" })
    });
    const lost = await lostHandler({ groups: [tempoGroup({ entryFingerprint: "entry-after-close" })] }, { url: tempoCalendarUrl });
    assert.equal(lost.error.code, "TEMPO_NETWORK");
    const reopenedHandler = createHandler({
      tempoXhrRequestImpl: tempoXhrTransport({ onSend: () => { requests += 1; } })
    });
    const reopened = await reopenedHandler({ groups: [tempoGroup({ entryFingerprint: "entry-after-close" })] }, { url: tempoCalendarUrl });
    assert.equal(reopened.ok, true);
    assert.equal(reopened.result.skipped[0].reason, "unknown");
    assert.equal(requests, 1);
  });
});

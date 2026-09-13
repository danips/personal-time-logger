import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { errorInfo, userErrorMessage } from "../extension/src/error-registry.js";
import { ERROR_CODE } from "../extension/src/error-codes.js";
import { ERROR_REGISTRY } from "../extension/src/error-registry.js";
import { formatError, statusFromError } from "../extension/src/ui-helpers.js";

describe("error recovery registry", () => {
  it("gives every stable error code explicit actionable recovery", () => {
    assert.deepEqual(Object.keys(ERROR_REGISTRY).sort(), Object.values(ERROR_CODE).sort());
    for (const entry of Object.values(ERROR_REGISTRY)) {
      assert.ok(entry.title);
      assert.ok(entry.detail);
      assert.ok(entry.recovery);
    }
  });
  it("maps sync failure modes to stable, actionable guidance", () => {
    for (const code of ["REMOTE_VERSION_STALE", "API_TIMEOUT", "REMOTE_APPEND_CONFLICT", "SYNC_BUSY", "RECONCILIATION_PARTIAL"]) {
      const info = errorInfo({ code, message: "private server detail" });
      assert.equal(info.diagnosticsCode, code);
      assert.ok(info.recovery.length > 10);
      assert.equal(userErrorMessage({ code, message: "private server detail" }).includes("private server detail"), false);
    }
  });

  it("keeps remote authorization and retry states useful to every page", () => {
    assert.equal(statusFromError({ code: "REMOTE_AUTH_REQUIRED" }), "not authorized");
    assert.equal(statusFromError({ code: "BACKOFF" }), "pending");
    assert.equal(statusFromError({ code: "OFFLINE" }), "offline");
    assert.match(formatError({ code: "REMOTE_VERSION_STALE" }), /refresh Reconcile/);
    assert.match(formatError({ code: "TEMPO_PERMISSION_MISSING" }), /approve the permission request/);
    assert.match(formatError({ code: "TEMPO_PARTIAL" }), /Do not resend the whole week/);
  });

  it("does not expose an unknown error message verbatim", () => {
    const message = formatError({ message: "token=not-safe" });
    assert.equal(message.includes("token=not-safe"), false);
    assert.match(message, /Extension error/);
  });

  it("renders Tempo progress without making an uncertain request look rejected", () => {
    const message = formatError({
      code: "TEMPO_NETWORK",
      acknowledgedWorklogs: 50,
      requestCount: 2,
      currentRequestOutcome: "unknown"
    });
    assert.match(message, /50 worklogs were acknowledged across 2 requests/);
    assert.match(message, /outcome is unknown/);
    assert.match(message, /Inspect Tempo before resending/);
  });
});

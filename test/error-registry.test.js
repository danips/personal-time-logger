import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { errorInfo, userErrorMessage } from "../src/error-registry.js";
import { formatError, statusFromError } from "../src/ui-helpers.js";

describe("error recovery registry", () => {
  it("maps sync failure modes to stable, actionable guidance", () => {
    for (const code of ["REMOTE_ROW_STALE", "API_TIMEOUT", "REMOTE_APPEND_CONFLICT", "SYNC_BUSY", "RECONCILIATION_PARTIAL"]) {
      const info = errorInfo({ code, message: "private server detail" });
      assert.equal(info.diagnosticsCode, code);
      assert.ok(info.recovery.length > 10);
      assert.equal(userErrorMessage({ code, message: "private server detail" }).includes("private server detail"), false);
    }
  });

  it("keeps authentication and retry states useful to every page", () => {
    assert.equal(statusFromError({ code: "AUTH_EXPIRED" }), "not signed in");
    assert.equal(statusFromError({ code: "BACKOFF" }), "pending");
    assert.equal(statusFromError({ code: "OFFLINE" }), "offline");
    assert.match(formatError({ code: "REMOTE_ROW_STALE" }), /Refresh Reconcile/);
  });

  it("does not expose an unknown error message verbatim", () => {
    const message = formatError({ message: "token=not-safe" });
    assert.equal(message.includes("token=not-safe"), false);
    assert.match(message, /Extension error/);
  });
});

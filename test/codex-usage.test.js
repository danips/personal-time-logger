import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeUsageResponse } from "../extension/src/codex-usage.js";

const fixture = (over = {}) => ({
  user_id: "redacted-user-id",
  account_id: "redacted-account-id",
  email: "member-one@example.invalid",
  plan_type: "team",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    limit_reached_type: null,
    primary_window: {
      used_percent: 4,
      window_seconds: 604800,
      reset_at: 1786773902,
      reset_after_seconds: 604000
    },
    secondary_window: null,
    additional_rate_limits: null,
    code_review_rate_limit: null
  },
  credits: {
    has_credits: false,
    unlimited: false,
    overage_limit_reached: false,
    balance: null
  },
  additive_field_from_future: { ignored: true },
  ...over
});

describe("ChatGPT usage normalizer", () => {
  it("normalizes the redacted Business/team response shape", () => {
    const normalized = normalizeUsageResponse(fixture(), {
      collectedAt: "2026-08-08T12:00:00.000Z"
    });

    assert.deepEqual(normalized.account, { plan_type: "team" });
    assert.equal(normalized.primary_window.used_percent, 4);
    assert.equal(normalized.primary_window.remaining_percent, 96);
    assert.equal(normalized.primary_window.reset_at, "2026-08-15T06:05:02.000Z");
    assert.equal(normalized.primary_window.window_seconds, 604800);
    assert.deepEqual(normalized.secondary_window, null);
    assert.equal("credits" in normalized, false);
    assert.equal("notices" in normalized, false);
    assert.equal("user_id" in normalized, false);
    assert.equal("account_id" in normalized, false);
    assert.equal(JSON.stringify(normalized).includes("redacted-user-id"), false);
    assert.equal(JSON.stringify(normalized).includes("redacted-account-id"), false);
  });

  it("calculates remaining percentage from used percentage", () => {
    for (const [used, remaining] of [[0, 100], [37, 63], [100, 0]]) {
      const value = normalizeUsageResponse(fixture({
        rate_limit: { ...fixture().rate_limit, primary_window: { ...fixture().rate_limit.primary_window, used_percent: used } }
      }));
      assert.equal(value.primary_window.remaining_percent, remaining);
    }
  });

  it("normalizes a valid secondary window with its own reset time", () => {
    const value = normalizeUsageResponse(fixture({
      rate_limit: {
        ...fixture().rate_limit,
        secondary_window: {
          used_percent: 25,
          window_seconds: 3600,
          reset_at: 1786179902
        }
      }
    }));
    assert.equal(value.secondary_window.remaining_percent, 75);
    assert.equal(value.secondary_window.window_seconds, 3600);
  });

  it("accepts the observed limit_window_seconds field", () => {
    const value = normalizeUsageResponse(fixture({
      rate_limit: {
        ...fixture().rate_limit,
        primary_window: {
          used_percent: 4,
          limit_window_seconds: 604800,
          reset_at: 1786773902
        }
      }
    }));
    assert.equal(value.primary_window.window_seconds, 604800);
  });

  it("accepts reset timestamps expressed in Unix milliseconds", () => {
    const value = normalizeUsageResponse(fixture({
      rate_limit: {
        ...fixture().rate_limit,
        primary_window: {
          ...fixture().rate_limit.primary_window,
          reset_at: 1786773902000
        }
      }
    }));
    assert.equal(value.primary_window.reset_at, "2026-08-15T06:05:02.000Z");
  });

  it("keeps a usage response when ChatGPT omits a reset time or current window", () => {
    const noReset = normalizeUsageResponse(fixture({
      rate_limit: {
        ...fixture().rate_limit,
        primary_window: { ...fixture().rate_limit.primary_window, reset_at: null, reset_after_seconds: null }
      }
    }));
    assert.equal(noReset.primary_window.reset_at, null);

    const noWindow = normalizeUsageResponse(fixture({ rate_limit: { primary_window: null } }));
    assert.equal(noWindow.primary_window, null);
  });

  it("derives a reset timestamp from a validated relative reset", () => {
    const value = normalizeUsageResponse(fixture({
      rate_limit: {
        ...fixture().rate_limit,
        primary_window: { used_percent: 20, reset_after_seconds: 90 }
      }
    }), { collectedAt: "2026-08-08T12:00:00.000Z" });
    assert.equal(value.primary_window.reset_at, "2026-08-08T12:01:30.000Z");
  });

  it("rejects wrong field types rather than treating them as missing data", () => {
    assert.throws(
      () => normalizeUsageResponse(fixture({ rate_limit: "not-an-object" })),
      { code: "schema_changed" }
    );
    assert.throws(
      () => normalizeUsageResponse(fixture({
        rate_limit: { ...fixture().rate_limit, primary_window: { used_percent: "nope" } }
      })),
      { code: "schema_changed" }
    );
  });

  it("preserves access and reached states", () => {
    const value = normalizeUsageResponse(fixture({
      rate_limit: {
        ...fixture().rate_limit,
        allowed: false,
        limit_reached: true,
        limit_reached_type: "weekly"
      }
    }));
    assert.deepEqual(value.access, { allowed: false, limit_reached: true, limit_reached_type: "weekly" });
  });

  it("accepts the observed object form of reached type without retaining details", () => {
    const value = normalizeUsageResponse(fixture({
      rate_limit_reached_type: { type: "weekly", details: { intentionally: "not persisted" } }
    }));
    assert.equal(value.access.limit_reached_type, "weekly");
    assert.equal(JSON.stringify(value).includes("not persisted"), false);
  });

  it("ignores unsupported additional limits without retaining raw data", () => {
    const value = normalizeUsageResponse(fixture({
      additional_rate_limits: { private_shape: "not persisted" }
    }));
    assert.equal(JSON.stringify(value).includes("private_shape"), false);
  });

  it("ignores unknown additive fields", () => {
    const value = normalizeUsageResponse(fixture());
    assert.equal("additive_field_from_future" in value, false);
  });

  it("rejects missing required objects and wrong field types", () => {
    assert.throws(() => normalizeUsageResponse({}), { code: "schema_changed" });
    assert.throws(() => normalizeUsageResponse(fixture({ rate_limit: { ...fixture().rate_limit, allowed: "yes" } })), { code: "schema_changed" });
    assert.throws(
      () => normalizeUsageResponse(fixture({ rate_limit: { ...fixture().rate_limit, primary_window: { ...fixture().rate_limit.primary_window, used_percent: 101 } } })),
      { code: "schema_changed" }
    );
    assert.throws(
      () => normalizeUsageResponse(fixture({ rate_limit: { ...fixture().rate_limit, primary_window: { ...fixture().rate_limit.primary_window, reset_at: "tomorrow" } } })),
      { code: "schema_changed" }
    );
  });

  it("keeps a secondary window when ChatGPT omits its reset time", () => {
    const value = normalizeUsageResponse(fixture({
      rate_limit: { ...fixture().rate_limit, secondary_window: { used_percent: 10 } }
    }));
    assert.equal(value.secondary_window.remaining_percent, 90);
    assert.equal(value.secondary_window.reset_at, null);
  });
});

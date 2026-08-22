import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHATGPT_USAGE_URL,
  OFFICIAL_USAGE_URL,
  extractUsageIdentity,
  normalizeBridgeResult,
  normalizeUsageResponse
} from "../extension/src/codex-usage.js";

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
  it("centralizes the private endpoint and official fallback URL", () => {
    assert.equal(CHATGPT_USAGE_URL, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(OFFICIAL_USAGE_URL, "https://chatgpt.com/codex/cloud/settings/analytics#usage");
  });

  it("records whether data came from the isolated reader or page fallback", () => {
    assert.equal(normalizeBridgeResult({ status: 200, body: fixture() }).source, "isolated");
    assert.equal(
      normalizeBridgeResult({ status: 200, body: fixture(), transport: "page_world_session" }).source,
      "page_fallback"
    );
  });

  it("normalizes the redacted Business/team response shape", () => {
    const normalized = normalizeUsageResponse(fixture(), {
      label: "Account 1",
      collectedAt: "2026-08-08T12:00:00.000Z"
    });

    assert.deepEqual(normalized.account, {
      label: "Account 1",
      email: "member-one@example.invalid",
      plan_type: "team"
    });
    assert.equal(normalized.schema_version, 1);
    assert.equal(normalized.primary_window.used_percent, 4);
    assert.equal(normalized.primary_window.remaining_percent, 96);
    assert.equal(normalized.primary_window.reset_at, "2026-08-15T06:05:02.000Z");
    assert.equal(normalized.primary_window.window_seconds, 604800);
    assert.deepEqual(normalized.secondary_window, null);
    assert.deepEqual(normalized.notices, []);
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
    assert.deepEqual(noWindow.notices, ["usage_window_unavailable"]);
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
    assert.throws(
      () => extractUsageIdentity(fixture({ user_id: 42 })),
      { code: "schema_changed" }
    );
  });

  it("preserves access, reached, unlimited, credit, and overage states", () => {
    const value = normalizeUsageResponse(fixture({
      rate_limit: {
        ...fixture().rate_limit,
        allowed: false,
        limit_reached: true,
        limit_reached_type: "weekly"
      },
      credits: {
        has_credits: true,
        unlimited: true,
        overage_limit_reached: true,
        balance: 12.5
      }
    }));
    assert.deepEqual(value.access, { allowed: false, limit_reached: true, limit_reached_type: "weekly" });
    assert.deepEqual(value.credits, {
      has_credits: true,
      unlimited: true,
      overage_limit_reached: true,
      balance: 12.5
    });
  });

  it("accepts the observed object forms of reached type and credit balance", () => {
    const value = normalizeUsageResponse(fixture({
      rate_limit_reached_type: { type: "weekly", details: { intentionally: "not persisted" } },
      credits: {
        has_credits: true,
        unlimited: false,
        overage_limit_reached: false,
        balance: { currency: "not persisted" }
      }
    }));
    assert.equal(value.access.limit_reached_type, "weekly");
    assert.equal(value.credits.balance, null);
    assert.equal(JSON.stringify(value).includes("not persisted"), false);
  });

  it("retains a non-fatal notice for unsupported additional limits without raw data", () => {
    const value = normalizeUsageResponse(fixture({
      additional_rate_limits: { private_shape: "not persisted" }
    }));
    assert.deepEqual(value.notices, ["unsupported_additional_limit"]);
    assert.equal(JSON.stringify(value).includes("private_shape"), false);
    assert.equal(value.official_usage_url, OFFICIAL_USAGE_URL);
  });

  it("ignores unknown additive fields", () => {
    const value = normalizeUsageResponse(fixture());
    assert.equal("additive_field_from_future" in value, false);
  });

  it("accepts a valid usage response without optional identity fields", () => {
    const raw = fixture();
    delete raw.user_id;
    delete raw.account_id;
    assert.equal(extractUsageIdentity(raw), null);
    assert.equal(normalizeUsageResponse(raw).primary_window.remaining_percent, 96);
  });

  it("does not reject valid usage when only one optional identity field is present", () => {
    const raw = fixture();
    delete raw.user_id;
    assert.equal(extractUsageIdentity(raw), null);
    assert.equal(normalizeUsageResponse(raw).primary_window.remaining_percent, 96);
  });

  it("reads optional identity fields from a nested account object", () => {
    const raw = fixture();
    delete raw.user_id;
    delete raw.account_id;
    raw.account = { user_id: "nested-user", account_id: "nested-account" };
    assert.deepEqual(extractUsageIdentity(raw), { user_id: "nested-user", account_id: "nested-account" });
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
    assert.deepEqual(value.notices, []);
  });

  it("maps malformed bridge bodies and HTTP outcomes to stable errors", () => {
    assert.throws(() => normalizeBridgeResult({ status: 200, body: "not-json" }), { code: "schema_changed" });
    assert.throws(() => normalizeBridgeResult({ status: 401, ok: false, error_code: "sign_in_required" }), (error) => {
      assert.equal(error.code, "sign_in_required");
      assert.equal(error.http_status, 401);
      return true;
    });
    assert.throws(() => normalizeBridgeResult({ status: 403, ok: false, error_code: "access_denied" }), { code: "access_denied" });
    assert.throws(() => normalizeBridgeResult({ status: 404, ok: false, error_code: "endpoint_unavailable" }), { code: "endpoint_unavailable" });
    assert.throws(() => normalizeBridgeResult({ status: 429, ok: false, error_code: "temporarily_rate_limited", retry_after_seconds: 12 }), (error) => {
      assert.equal(error.code, "temporarily_rate_limited");
      assert.equal(error.retry_after_seconds, 12);
      return true;
    });
  });
});

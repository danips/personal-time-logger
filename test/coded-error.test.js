import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { codedError } from "../extension/src/coded-error.js";
import { ERROR_CODE } from "../extension/src/error-codes.js";

describe("codedError", () => {
  it("rejects unknown codes", () => {
    assert.throws(() => codedError("NOT_A_CODE", "nope"), /Unknown extension error code/);
  });

  it("preserves an explicit cause and safe details", () => {
    const cause = new Error("transport failure");
    const error = codedError(ERROR_CODE.API_NETWORK, "Network failed", {
      cause,
      details: { requestCount: 2 }
    });
    assert.equal(error.code, ERROR_CODE.API_NETWORK);
    assert.equal(error.cause, cause);
    assert.equal(error.requestCount, 2);
  });
});

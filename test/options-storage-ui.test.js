import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { storageUiState } from "../extension/src/options-storage-ui.js";

describe("storage UI state", () => {
  it("keeps Google configuration relevant while Google is active", () => {
    assert.deepEqual(storageUiState({
      activeProviderId: "google-sheets",
      targetProviderId: "mysql"
    }), {
      showGoogleAccount: true,
      showSpreadsheet: true
    });
  });
});

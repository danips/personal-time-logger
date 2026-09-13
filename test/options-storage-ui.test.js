import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { storageUiState } from "../extension/src/options-storage-ui.js";

describe("storage UI state", () => {
  it("matches the active/target provider visibility matrix", () => {
    const cases = [
      ["google-sheets", "google-sheets", true],
      ["google-sheets", "mysql", true],
      ["mysql", "mysql", false],
      ["mysql", "google-sheets", true],
      ["cloudflare-d1", "cloudflare-d1", false],
      ["mysql", "cloudflare-d1", false],
      ["google-sheets", "cloudflare-d1", true]
    ];

    for (const [activeProviderId, targetProviderId, visible] of cases) {
      assert.deepEqual(storageUiState({ activeProviderId, targetProviderId }), {
        showGoogleAccount: visible,
        showSpreadsheet: visible
      });
    }
  });
});

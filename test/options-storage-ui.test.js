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

  it("does not mutate Google settings while deciding visibility", () => {
    const googleSettings = Object.freeze({
      clientId: "client-id",
      clientSecret: "client-secret",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      spreadsheetId: "spreadsheet-id"
    });
    const before = { ...googleSettings };

    assert.deepEqual(storageUiState({
      activeProviderId: "mysql",
      targetProviderId: "mysql",
      googleSettings
    }), {
      showGoogleAccount: false,
      showSpreadsheet: false
    });
    assert.deepEqual(googleSettings, before);
  });
});

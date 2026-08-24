const GOOGLE_SHEETS_PROVIDER_ID = "google-sheets";

/**
 * Returns which provider-specific settings are operationally relevant.
 * The active provider and the migration target are intentionally independent.
 */
export function storageUiState({ activeProviderId, targetProviderId } = {}) {
  const googleRelevant = activeProviderId === GOOGLE_SHEETS_PROVIDER_ID
    || targetProviderId === GOOGLE_SHEETS_PROVIDER_ID;

  return {
    showGoogleAccount: googleRelevant,
    showSpreadsheet: googleRelevant
  };
}

const DEFAULT = {
  retryable: true,
  status: "error",
  title: "Extension error",
  detail: "The operation could not finish.",
  recovery: "Retry it, then open Options diagnostics if it continues.",
  diagnosticsCode: "UNEXPECTED_ERROR"
};

export const ERROR_REGISTRY = {
  CONFIG_MISSING: {
    retryable: false, status: "not signed in", title: "Google setup is incomplete",
    detail: "A Google OAuth client ID and secret are required.", recovery: "Open Options and save both credentials."
  },
  CONFIG_INVALID: {
    retryable: true, status: "error", title: "Google credentials are incomplete",
    detail: "A client ID and client secret must be saved together.", recovery: "Enter both values, or clear both."
  },
  CONFIG_SAVE_FAILED: {
    retryable: true, status: "error", title: "Google credentials were not saved",
    detail: "Synchronized extension storage rejected the change.", recovery: "Retry saving in Options. Sign in again if prompted."
  },
  AUTH_REQUIRED: {
    retryable: false, status: "not signed in", title: "Google sign-in is required",
    detail: "This device has no usable Google token.", recovery: "Open Options and sign in."
  },
  AUTH_EXPIRED: {
    retryable: false, status: "not signed in", title: "Google sign-in expired",
    detail: "The saved Google authorization can no longer be refreshed.", recovery: "Open Options and sign in again."
  },
  AUTH_FAILED: {
    retryable: true, status: "error", title: "Google authentication failed",
    detail: "Google did not accept the authorization request.", recovery: "Check Options credentials, then sign in again."
  },
  AUTH_STALE: {
    retryable: true, status: "pending", title: "Google sign-in changed",
    detail: "A newer sign-in action superseded this one.", recovery: "Retry the current sign-in action."
  },
  SCOPE_MISSING: {
    retryable: false, status: "not signed in", title: "Google permission is missing",
    detail: "The current token cannot access the required Google service.", recovery: "Open Options and sign in again."
  },
  SPREADSHEET_MISSING: {
    retryable: false, status: "spreadsheet missing", title: "Spreadsheet is not configured",
    detail: "No usable spreadsheet is selected.", recovery: "Open Options to reconnect or create a replacement."
  },
  SHEET_MISSING: {
    retryable: true, status: "spreadsheet missing", title: "Spreadsheet layout needs repair",
    detail: "A required sheet tab or header is missing.", recovery: "Retry sync; if it continues, use Options recovery."
  },
  SHEET_SCHEMA_UNSUPPORTED: {
    retryable: false, status: "spreadsheet missing", title: "Spreadsheet layout is incompatible",
    detail: "The selected spreadsheet does not have the required time_entries columns.", recovery: "Choose a compatible spreadsheet in Options."
  },
  REMOTE_ROW_STALE: {
    retryable: true, status: "pending", title: "Spreadsheet changed during sync",
    detail: "A row changed after it was verified.", recovery: "Refresh Reconcile and retry the chosen action."
  },
  REMOTE_ROW_PRECONDITION_REQUIRED: {
    retryable: true, status: "pending", title: "Spreadsheet row needs a fresh read",
    detail: "The row write did not have a verified snapshot.", recovery: "Retry sync or refresh Reconcile first."
  },
  CONFIG_CONFLICT: {
    retryable: false, status: "error", title: "Spreadsheet settings conflict",
    detail: "A shared configuration row is duplicated or invalid.", recovery: "Fix the config tab, then retry sync."
  },
  RECONCILIATION_BATCH_INVALID: {
    retryable: true, status: "error", title: "Reconciliation selection is invalid",
    detail: "One or more selected rows are no longer safe to apply.", recovery: "Rescan Reconcile and choose again."
  },
  RECONCILIATION_PARTIAL: {
    retryable: true, status: "pending", title: "Reconciliation needs another pass",
    detail: "Only part of the selected reconciliation could be completed.", recovery: "Rescan Reconcile before retrying."
  },
  REMOTE_APPEND_CONFLICT: {
    retryable: true, status: "pending", title: "Spreadsheet append is ambiguous",
    detail: "A row with the same ID has different content.", recovery: "Open Reconcile and verify the conflicting entry."
  },
  API_TIMEOUT: {
    retryable: true, status: "pending", title: "Google request timed out",
    detail: "Google did not finish the request in time.", recovery: "Wait for the retry deadline, then sync again."
  },
  API_NETWORK: {
    retryable: true, status: "pending", title: "Google network request failed",
    detail: "The request did not reach or complete with Google.", recovery: "Check the connection and retry sync."
  },
  API_ERROR: {
    retryable: true, status: "pending", title: "Google API request failed",
    detail: "Google could not complete the request.", recovery: "Retry sync; check Options diagnostics if it continues."
  },
  RATE_LIMIT: {
    retryable: true, status: "pending", title: "Google rate limit reached",
    detail: "Google is temporarily rejecting requests.", recovery: "Wait for the retry deadline before syncing again."
  },
  OFFLINE: {
    retryable: true, status: "offline", title: "Device is offline",
    detail: "Sync cannot reach Google while offline.", recovery: "Reconnect to the internet and retry."
  },
  BACKOFF: {
    retryable: true, status: "pending", title: "Sync is waiting before retrying",
    detail: "A recent Google failure started a temporary backoff.", recovery: "Wait for the retry deadline before syncing again."
  },
  SYNC_BUSY: {
    retryable: true, status: "pending", title: "Another sync is active",
    detail: "A different extension context owns the current sync lease.", recovery: "Wait for it to finish, then retry."
  },
  STORAGE_CONFLICT: {
    retryable: true, status: "pending", title: "Entry changed in another window",
    detail: "The displayed entry revision is no longer current.", recovery: "Review the refreshed entry and retry."
  },
  WINDOW_SIZE_INVALID: {
    retryable: true, status: "error", title: "Window size is invalid",
    detail: "A preset must contain whole dimensions in the supported range.", recovery: "Edit the preset and try again."
  },
  WINDOW_MODE_INVALID: {
    retryable: true, status: "error", title: "Window resize mode is invalid",
    detail: "The preset did not specify viewport or outer-window mode.", recovery: "Edit the preset and try again."
  },
  VIEWPORT_UNAVAILABLE: {
    retryable: true, status: "error", title: "Viewport size is unavailable",
    detail: "The browser did not report the active tab dimensions.", recovery: "Retry with an outer-window preset."
  },
  WINDOW_CHROME_INVALID: {
    retryable: true, status: "error", title: "Browser window measurements are inconsistent",
    detail: "The browser reported a viewport larger than its window.", recovery: "Retry after the browser finishes resizing."
  },
  ENTRY_INVALID: {
    retryable: true, status: "error", title: "Entry data is invalid",
    detail: "The change does not match the time-entry format.", recovery: "Correct the entry fields and try again."
  }
};

export function errorInfo(error) {
  const code = String(error?.code || "");
  const info = ERROR_REGISTRY[code] || DEFAULT;
  return { code: code || DEFAULT.diagnosticsCode, ...info, diagnosticsCode: info.diagnosticsCode || code || DEFAULT.diagnosticsCode };
}

export function userErrorMessage(error) {
  const info = errorInfo(error);
  return `${info.title}. ${info.detail} ${info.recovery}`;
}

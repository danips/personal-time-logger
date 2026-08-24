import { ERROR_CODE } from "./error-codes.js";

const DEFAULT = {
  retryable: true,
  status: "error",
  title: "Extension error",
  detail: "The operation could not finish.",
  recovery: "Retry it, then open Options diagnostics if it continues.",
  diagnosticsCode: "UNEXPECTED_ERROR"
};

export const ERROR_REGISTRY = {
  [ERROR_CODE.CONFIG_MISSING]: {
    retryable: false, status: "not signed in", title: "Google setup is incomplete",
    detail: "A Google OAuth client ID and secret are required.", recovery: "Open Options and save both credentials."
  },
  [ERROR_CODE.CONFIG_INVALID]: {
    retryable: true, status: "error", title: "Google credentials are incomplete",
    detail: "A client ID and client secret must be saved together.", recovery: "Enter both values, or clear both."
  },
  [ERROR_CODE.CONFIG_SAVE_FAILED]: {
    retryable: true, status: "error", title: "Google credentials were not saved",
    detail: "Synchronized extension storage rejected the change.", recovery: "Retry saving in Options. Sign in again if prompted."
  },
  [ERROR_CODE.MYSQL_CONFIG_INVALID]: {
    retryable: false, status: "error", title: "MySQL API URL is invalid",
    detail: "The API URL must be an HTTPS origin without credentials, a query, or a fragment.", recovery: "Check Storage settings and save the HTTPS API URL again."
  },
  [ERROR_CODE.MYSQL_CONFIG_MISSING]: {
    retryable: false, status: "not configured", title: "MySQL API setup is incomplete",
    detail: "A MySQL API URL and token are required before this backend can be tested.", recovery: "Open Storage settings and enter both values."
  },
  [ERROR_CODE.AUTH_REQUIRED]: {
    retryable: false, status: "not signed in", title: "Google sign-in is required",
    detail: "This device has no usable Google token.", recovery: "Open Options and sign in."
  },
  [ERROR_CODE.AUTH_EXPIRED]: {
    retryable: false, status: "not signed in", title: "Google sign-in expired",
    detail: "The saved Google authorization can no longer be refreshed.", recovery: "Open Options and sign in again."
  },
  [ERROR_CODE.AUTH_FAILED]: {
    retryable: true, status: "error", title: "Google authentication failed",
    detail: "Google did not accept the authorization request.", recovery: "Check Options credentials, then sign in again."
  },
  [ERROR_CODE.AUTH_STALE]: {
    retryable: true, status: "pending", title: "Google sign-in changed",
    detail: "A newer sign-in action superseded this one.", recovery: "Retry the current sign-in action."
  },
  [ERROR_CODE.SCOPE_MISSING]: {
    retryable: false, status: "not signed in", title: "Google permission is missing",
    detail: "The current token cannot access the required Google service.", recovery: "Open Options and sign in again."
  },
  [ERROR_CODE.SPREADSHEET_MISSING]: {
    retryable: false, status: "spreadsheet missing", title: "Spreadsheet is not configured",
    detail: "No usable spreadsheet is selected.", recovery: "Open Options to reconnect or create a replacement."
  },
  [ERROR_CODE.SHEET_MISSING]: {
    retryable: true, status: "spreadsheet missing", title: "Spreadsheet layout needs repair",
    detail: "A required sheet tab or header is missing.", recovery: "Retry sync; if it continues, use Options recovery."
  },
  [ERROR_CODE.SHEET_SCHEMA_UNSUPPORTED]: {
    retryable: false, status: "spreadsheet missing", title: "Spreadsheet layout is incompatible",
    detail: "The selected spreadsheet does not have the required time_entries columns.", recovery: "Choose a compatible spreadsheet in Options."
  },
  [ERROR_CODE.REMOTE_ROW_STALE]: {
    retryable: true, status: "pending", title: "Spreadsheet changed during sync",
    detail: "A row changed after it was verified.", recovery: "Refresh Reconcile and retry the chosen action."
  },
  [ERROR_CODE.REMOTE_ROW_PRECONDITION_REQUIRED]: {
    retryable: true, status: "pending", title: "Spreadsheet row needs a fresh read",
    detail: "The row write did not have a verified snapshot.", recovery: "Retry sync or refresh Reconcile first."
  },
  [ERROR_CODE.CONFIG_CONFLICT]: {
    retryable: false, status: "error", title: "Spreadsheet settings conflict",
    detail: "A shared configuration row is duplicated or invalid.", recovery: "Fix the config tab, then retry sync."
  },
  [ERROR_CODE.RECONCILIATION_BATCH_INVALID]: {
    retryable: true, status: "error", title: "Reconciliation selection is invalid",
    detail: "One or more selected rows are no longer safe to apply.", recovery: "Rescan Reconcile and choose again."
  },
  [ERROR_CODE.RECONCILIATION_PARTIAL]: {
    retryable: true, status: "pending", title: "Reconciliation needs another pass",
    detail: "Only part of the selected reconciliation could be completed.", recovery: "Rescan Reconcile before retrying."
  },
  [ERROR_CODE.REMOTE_APPEND_CONFLICT]: {
    retryable: true, status: "pending", title: "Spreadsheet append is ambiguous",
    detail: "A row with the same ID has different content.", recovery: "Open Reconcile and verify the conflicting entry."
  },
  [ERROR_CODE.REMOTE_BACKEND_UNSUPPORTED]: {
    retryable: false, status: "error", title: "Remote storage backend is unavailable",
    detail: "The selected remote storage backend is not supported by this extension version.", recovery: "Select Google Sheets or update the extension before trying again."
  },
  [ERROR_CODE.REMOTE_API_INCOMPATIBLE]: {
    retryable: false, status: "error", title: "Remote API is incompatible",
    detail: "The configured remote API does not provide the required Personal Time Logger API contract.", recovery: "Check the API URL and server deployment before retrying."
  },
  [ERROR_CODE.REMOTE_AUTH_REQUIRED]: {
    retryable: false, status: "not authorized", title: "MySQL API authorization is required",
    detail: "The remote API rejected the configured token.", recovery: "Open Storage settings and save a valid API token."
  },
  [ERROR_CODE.REMOTE_PERMISSION]: {
    retryable: false, status: "permission missing", title: "Remote API permission is missing",
    detail: "Firefox did not grant access to the configured remote API origin.", recovery: "Use Test connection and approve the exact API host permission."
  },
  [ERROR_CODE.REMOTE_VERSION_STALE]: {
    retryable: true, status: "pending", title: "Remote entry changed during sync",
    detail: "The remote record changed before this operation could be applied.", recovery: "Sync again or refresh Reconcile before choosing a resolution."
  },
  [ERROR_CODE.API_TIMEOUT]: {
    retryable: true, status: "pending", title: "Google request timed out",
    detail: "Google did not finish the request in time.", recovery: "Wait for the retry deadline, then sync again."
  },
  [ERROR_CODE.API_NETWORK]: {
    retryable: true, status: "pending", title: "Google network request failed",
    detail: "The request did not reach or complete with Google.", recovery: "Check the connection and retry sync."
  },
  [ERROR_CODE.API_ERROR]: {
    retryable: true, status: "pending", title: "Google API request failed",
    detail: "Google could not complete the request.", recovery: "Retry sync; check Options diagnostics if it continues."
  },
  [ERROR_CODE.RATE_LIMIT]: {
    retryable: true, status: "pending", title: "Google rate limit reached",
    detail: "Google is temporarily rejecting requests.", recovery: "Wait for the retry deadline before syncing again."
  },
  [ERROR_CODE.OFFLINE]: {
    retryable: true, status: "offline", title: "Device is offline",
    detail: "Sync cannot reach Google while offline.", recovery: "Reconnect to the internet and retry."
  },
  [ERROR_CODE.BACKOFF]: {
    retryable: true, status: "pending", title: "Sync is waiting before retrying",
    detail: "A recent Google failure started a temporary backoff.", recovery: "Wait for the retry deadline before syncing again."
  },
  [ERROR_CODE.SYNC_BUSY]: {
    retryable: true, status: "pending", title: "Another sync is active",
    detail: "A different extension context owns the current sync lease.", recovery: "Wait for it to finish, then retry."
  },
  [ERROR_CODE.TEMPO_CONFIG_MISSING]: {
    retryable: false, status: "error", title: "Tempo setup is incomplete",
    detail: "A Tempo API token and author account ID are required.", recovery: "Open Options and save both Tempo values."
  },
  [ERROR_CODE.TEMPO_PERMISSION_MISSING]: {
    retryable: true, status: "error", title: "Tempo access is not granted",
    detail: "Firefox did not grant access to the Tempo API host.", recovery: "Click Send to Tempo again and approve the permission request."
  },
  [ERROR_CODE.TEMPO_NETWORK]: {
    retryable: true, status: "pending", title: "Tempo network request failed",
    detail: "The background request did not complete with Tempo.", recovery: "Check the connection and Tempo host permission, then retry."
  },
  [ERROR_CODE.TEMPO_API_ERROR]: {
    retryable: true, status: "error", title: "Tempo rejected the worklogs",
    detail: "Tempo did not accept the requested worklog batch.", recovery: "Check the token, author account ID, issue IDs, and required Tempo attributes."
  },
  [ERROR_CODE.TEMPO_PARTIAL]: {
    retryable: false, status: "error", title: "Tempo upload was only partly completed",
    detail: "At least one earlier batch was created before a later batch failed.", recovery: "Do not resend the whole week; inspect Tempo and send only missing worklogs manually."
  },
  [ERROR_CODE.STORAGE_CONFLICT]: {
    retryable: true, status: "pending", title: "Entry changed in another window",
    detail: "The displayed entry revision is no longer current.", recovery: "Review the refreshed entry and retry."
  },
  [ERROR_CODE.WINDOW_SIZE_INVALID]: {
    retryable: true, status: "error", title: "Window size is invalid",
    detail: "A preset must contain whole dimensions in the supported range.", recovery: "Edit the preset and try again."
  },
  [ERROR_CODE.WINDOW_MODE_INVALID]: {
    retryable: true, status: "error", title: "Window resize mode is invalid",
    detail: "The preset did not specify viewport or outer-window mode.", recovery: "Edit the preset and try again."
  },
  [ERROR_CODE.VIEWPORT_UNAVAILABLE]: {
    retryable: true, status: "error", title: "Viewport size is unavailable",
    detail: "The browser did not report the active tab dimensions.", recovery: "Retry with an outer-window preset."
  },
  [ERROR_CODE.WINDOW_CHROME_INVALID]: {
    retryable: true, status: "error", title: "Browser window measurements are inconsistent",
    detail: "The browser reported a viewport larger than its window.", recovery: "Retry after the browser finishes resizing."
  },
  [ERROR_CODE.ENTRY_INVALID]: {
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

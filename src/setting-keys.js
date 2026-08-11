/**
 * Names for persisted extension state. Keeping them in one module makes setting
 * ownership auditable and prevents one context from silently writing a near-
 * duplicate key that another context never reads.
 */
export const SETTING_KEY = Object.freeze({
  ACTIVE_TIMER_OPERATION: "active_timer_operation",
  AUTH_GENERATION: "auth_generation",
  BACKGROUND_SCHEDULE_ERROR: "background_schedule_error",
  BACKGROUND_SYNC_DUE_AT: "background_sync_due_at",
  CHATGPT_USAGE_ACCOUNT_GENERATION: "chatgpt_usage_account_generation",
  CHATGPT_USAGE_ACCOUNTS: "chatgpt_usage_accounts",
  CHATGPT_USAGE_CACHE_VERSION: "chatgpt_usage_cache_version",
  CHATGPT_USAGE_PROFILE_SALT: "chatgpt_usage_profile_salt",
  CHATGPT_USAGE_SESSION_TOKEN_CONSENT: "chatgpt_usage_session_token_consent",
  DEVICE_ID: "device_id",
  DIAGNOSTIC_RING: "diagnostic_ring",
  DURATION_MULTIPLIER: "duration_multiplier",
  DURATION_MULTIPLIER_SYNCED_AT: "duration_multiplier_synced_at",
  DURATION_MULTIPLIER_UPDATED_AT: "duration_multiplier_updated_at",
  GOOGLE_OAUTH_CLIENT_ID: "google_oauth_client_id",
  GOOGLE_OAUTH_CLIENT_SECRET: "google_oauth_client_secret",
  GOOGLE_TOKEN_DATA: "token_data",
  RECONCILIATION_INTENTS: "reconciliation_intents",
  REMOTE_MODIFIED_TIME: "remote_modified_time",
  SPREADSHEET_ID: "spreadsheet_id",
  SPREADSHEET_PROVISION_PENDING: "spreadsheet_provision_pending",
  STALE_RECONCILIATION_INTENTS: "stale_reconciliation_intents",
  SYNC_BACKOFF_SECONDS: "sync_backoff_seconds",
  SYNC_BACKOFF_UNTIL: "sync_backoff_until",
  SYNC_IDLE_STREAK: "sync_idle_streak",
  SYNC_INTERVAL_SECONDS: "sync_interval_seconds",
  TEMPO_API_TOKEN: "tempo_api_token",
  TEMPO_AUTHOR_ACCOUNT_ID: "tempo_author_account_id",
  TEMPO_TASK_ISSUE_IDS: "tempo_task_issue_ids",
  TIME_ENTRIES_SHEET_ID: "time_entries_sheet_id",
  WINDOW_RESIZE_PRESETS: "window_resize_presets"
});

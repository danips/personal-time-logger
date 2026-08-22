/** Persisted or cross-callback state values shared by extension contexts. */
export const RECONCILIATION_INTENT_STATE = Object.freeze({
  PENDING_REMOTE_PUSH: "pending_remote_push"
});

/** Lifecycle states exposed on an extension page's document root. */
export const PAGE_RUNTIME_STATE = Object.freeze({
  STARTING: "starting",
  READY: "ready",
  FAILED: "failed"
});

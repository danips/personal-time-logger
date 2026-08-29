import { platform } from "./platform.js";

export const SYNC_REQUEST_MESSAGE = "timelogger_request_sync";
export const UPDATE_CHECK_MESSAGE = "timelogger_request_update_check";
export const UPDATE_INSTALL_MESSAGE = "timelogger-install-update";

function responseError(response) {
  const error = new Error(response?.error?.message || "Background sync request failed");
  error.code = response?.error?.code || "SYNC_REQUEST_FAILED";
  return error;
}

/**
 * Runs sync in the background context so it continues if a popup is closed.
 * The caller may await this for an explicit Sync button, or deliberately leave
 * it pending after a local edit while rendering the committed change at once.
 */
export async function requestBackgroundSync({ force = false } = {}) {
  const response = await platform.sendRuntimeMessage({
    type: SYNC_REQUEST_MESSAGE,
    force: Boolean(force)
  });
  if (!response?.ok) throw responseError(response);
  return response.result;
}

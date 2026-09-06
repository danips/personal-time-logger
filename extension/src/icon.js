import { recordDiagnostic } from "./diagnostics.js";
import { ERROR_CODE } from "./error-codes.js";
import { platform } from "./platform.js";

let lastIconFailure = null;
const ICON_FAILURE_DEDUPE_MS = 60_000;

export async function setActiveIcon(active) {
  await platform.setIcon({
    path: platform.getURL(active ? "icons/icon-active.svg" : "icons/icon.svg")
  });
}

/**
 * Updates the toolbar icon without allowing a resource or browser API failure
 * to escape the popup render path. Repeated failures are recorded at most once
 * per minute until an icon update succeeds.
 */
export async function updateActiveIcon(active, {
  setIcon = setActiveIcon,
  reportDiagnostic = recordDiagnostic,
  now = Date.now
} = {}) {
  try {
    await setIcon(active);
    lastIconFailure = null;
    return true;
  } catch (error) {
    const at = Number(now()) || 0;
    const repeated = lastIconFailure
      && lastIconFailure.code === ERROR_CODE.ICON_UPDATE_FAILED
      && at - lastIconFailure.at < ICON_FAILURE_DEDUPE_MS;
    if (!repeated) {
      lastIconFailure = { code: ERROR_CODE.ICON_UPDATE_FAILED, at };
      try {
        await reportDiagnostic({
          subsystem: "popup",
          phase: "icon-update",
          code: ERROR_CODE.ICON_UPDATE_FAILED,
          error,
          recovery: "The toolbar icon may be stale. Retry or reopen the popup, then check Options diagnostics."
        });
      } catch {
        // A diagnostics storage failure must not create a second unhandled rejection.
      }
    }
    return false;
  }
}

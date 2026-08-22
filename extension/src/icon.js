import { recordDiagnostic } from "./diagnostics.js";
import { ERROR_CODE } from "./error-codes.js";
import { platform } from "./platform.js";

let svgTemplate = null;
let svgTemplatePromise = null;
let iconGeneration = 0;
let lastIconFailure = null;
const ICON_FAILURE_DEDUPE_MS = 60_000;

async function getSvgTemplate() {
  if (svgTemplate) return svgTemplate;
  if (!svgTemplatePromise) {
    svgTemplatePromise = fetch(platform.getURL("icons/icon.svg"))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load extension icon (HTTP ${response.status})`);
        const svg = await response.text();
        if (!svg.includes("<svg")) throw new Error("Extension icon is not valid SVG");
        svgTemplate = svg;
        return svg;
      })
      .finally(() => {
        svgTemplatePromise = null;
      });
  }
  return svgTemplatePromise;
}

export async function setActiveIcon(active) {
  const generation = ++iconGeneration;
  const svg = await getSvgTemplate();
  if (generation !== iconGeneration) return;
  const colored = active ? svg.replace("#1a73e8", "#22c55e") : svg;
  const url = "data:image/svg+xml," + encodeURIComponent(colored);
  await platform.setIcon({ path: url });
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

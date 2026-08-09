import { recordDiagnostic } from "./diagnostics.js";
import { userErrorMessage } from "./error-registry.js";
import { platform } from "./platform.js";

const RECOVERY = "Use Retry to restart this page, or open Options diagnostics for details.";

async function recordPageFailure(page, phase, error) {
  try {
    await recordDiagnostic({
      subsystem: "page",
      phase: `${page}.${phase}`,
      error,
      recovery: RECOVERY
    });
  } catch {
    // The fatal panel remains useful if local diagnostics storage is unavailable.
  }
}

function ensureFatalPanel() {
  if (!globalThis.document?.body) return null;
  let panel = document.getElementById("pageFatalPanel");
  if (panel) return panel;

  panel = document.createElement("section");
  panel.id = "pageFatalPanel";
  panel.hidden = true;
  panel.setAttribute("role", "alert");
  Object.assign(panel.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    display: "grid",
    placeItems: "center",
    padding: "24px",
    background: "rgba(0, 0, 0, 0.45)",
    color: "CanvasText"
  });

  const dialog = document.createElement("div");
  Object.assign(dialog.style, {
    width: "min(460px, 100%)",
    padding: "20px",
    border: "1px solid CanvasText",
    borderRadius: "10px",
    background: "Canvas",
    boxShadow: "0 12px 42px rgba(0, 0, 0, 0.32)"
  });
  const title = document.createElement("h1");
  title.id = "pageFatalTitle";
  title.style.margin = "0";
  title.style.fontSize = "20px";
  const message = document.createElement("p");
  message.id = "pageFatalMessage";
  message.style.margin = "10px 0 0";
  const hint = document.createElement("p");
  hint.textContent = "A recovery record was saved locally when possible.";
  hint.style.margin = "10px 0 0";
  const actions = document.createElement("div");
  Object.assign(actions.style, { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "16px" });
  const retry = document.createElement("button");
  retry.type = "button";
  retry.id = "pageFatalRetry";
  retry.textContent = "Retry";
  const diagnostics = document.createElement("button");
  diagnostics.type = "button";
  diagnostics.id = "pageFatalDiagnostics";
  diagnostics.textContent = "Open diagnostics";
  actions.append(retry, diagnostics);
  dialog.append(title, message, hint, actions);
  panel.append(dialog);
  document.body.append(panel);
  return panel;
}

function hideFatalPanel() {
  const panel = globalThis.document?.getElementById("pageFatalPanel");
  if (panel) panel.hidden = true;
}

function setPageRuntimeState(state) {
  if (globalThis.document?.documentElement) {
    globalThis.document.documentElement.dataset.pageRuntime = state;
  }
}

function showFatalPanel({ title, error, retry }) {
  const panel = ensureFatalPanel();
  if (!panel) return;
  const titleElement = panel.querySelector("#pageFatalTitle");
  const messageElement = panel.querySelector("#pageFatalMessage");
  const retryButton = panel.querySelector("#pageFatalRetry");
  const diagnosticsButton = panel.querySelector("#pageFatalDiagnostics");
  titleElement.textContent = `Could not start ${title}`;
  messageElement.textContent = userErrorMessage(error);
  retryButton.onclick = () => {
    retryButton.disabled = true;
    void retry().finally(() => {
      retryButton.disabled = false;
    });
  };
  diagnosticsButton.onclick = () => {
    void platform.openOptionsPage().catch(() => {
      messageElement.textContent = "Could not open Options. Retry this page, then open Options diagnostics manually.";
    });
  };
  panel.hidden = false;
  retryButton.focus();
}

/**
 * Runs a page callback without leaving a rejected promise outside an action
 * boundary. A failed timer or event callback is recorded and later invocations
 * are still free to run.
 */
export async function runPageTask({ page, phase, task, onError } = {}) {
  try {
    return await task();
  } catch (error) {
    await recordPageFailure(page, phase, error);
    try {
      await onError?.(error);
    } catch {
      // Reporting a page failure must not create another unhandled rejection.
    }
    return undefined;
  }
}

/**
 * Starts an extension page with a recoverable fatal state. `init` must be
 * idempotent because Retry can run it after a partial startup.
 */
export function startPage({ page, title, init } = {}) {
  const start = async () => {
    let failed = false;
    setPageRuntimeState("starting");
    const result = await runPageTask({
      page,
      phase: "startup",
      task: init,
      onError(error) {
        failed = true;
        setPageRuntimeState("failed");
        showFatalPanel({ title, error, retry: start });
      }
    });
    if (!failed) {
      hideFatalPanel();
      setPageRuntimeState("ready");
    }
    return result;
  };
  void start();
  return start;
}

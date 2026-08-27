import { runAction } from "../src/action-runner.js";
import { getSetting, setSetting } from "../src/db.js";
import {
  CHATGPT_HOST_PERMISSION,
  CHATGPT_SESSION_TOKEN_CONSENT_KEY,
  clearChatGptUsageData,
  getChatGptUsageState,
  refreshChatGptUsage
} from "../src/chatgpt-usage-service.js";
import { UsageError } from "../src/codex-usage.js";
import { platform } from "../src/platform.js";
import { startPage } from "../src/page-runtime.js";

const AUTO_REFRESH_AFTER_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 15 * 60 * 1000;

const $ = (selector) => document.querySelector(selector);
const $status = $("#pageStatus");
const $grant = $("#grantAccess");
const $refresh = $("#refreshUsage");
const $clearData = $("#clearData");
const $sessionTokenConsent = $("#sessionTokenConsent");
const $snapshot = $("#usageSnapshot");
let sessionTokenConsent = false;
let renderGeneration = 0;
let eventsBound = false;

function messageFor(error) {
  if (error?.code === "schema_changed") {
    const detail = typeof error.message === "string" && error.message ? ` (${error.message})` : "";
    return `ChatGPT returned an unexpected usage response${detail}.`;
  }
  const messages = {
    permission_required: "Grant ChatGPT access before refreshing usage.",
    consent_required: "Confirm the in-memory session-token notice before refreshing usage.",
    sign_in_required: "Sign in to ChatGPT in your normal Firefox profile, then try again.",
    workspace_deactivated: "ChatGPT is still using a deactivated workspace. Switch ChatGPT to your personal workspace, then refresh.",
    access_denied: "ChatGPT denied access to the usage response.",
    endpoint_unavailable: "The private ChatGPT usage endpoint is unavailable.",
    network_error: "The ChatGPT usage request could not reach the service.",
    temporarily_rate_limited: "ChatGPT is temporarily rate-limiting usage checks."
  };
  return messages[error?.code] || error?.message || "ChatGPT usage operation failed.";
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatCountdown(resetAt, now = Date.now()) {
  const remaining = new Date(resetAt).getTime() - now;
  if (!Number.isFinite(remaining)) return "reset time unavailable";
  if (remaining <= 0) return "reset time has passed; refresh to confirm the new allowance";
  const totalMinutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || !parts.length) parts.push(`${minutes}m`);
  return `in ${parts.join(" ")}`;
}

export function usageWindowLabel(window, fallback) {
  const seconds = Number(window?.window_seconds);
  if (seconds === 5 * 60 * 60) return "5-hour limit";
  if (seconds === 7 * 24 * 60 * 60) return "Weekly limit";
  return fallback;
}

function snapshotAge(snapshot) {
  return Date.now() - new Date(snapshot?.collected_at || 0).getTime();
}

function usageWindow(window, fallbackLabel) {
  const section = document.createElement("section");
  section.className = "usage-window";
  const heading = document.createElement("h3");
  heading.textContent = usageWindowLabel(window, fallbackLabel);
  section.append(heading);

  const value = document.createElement("div");
  value.className = "account-value";
  value.textContent = `${window.remaining_percent}%`;
  const suffix = document.createElement("span");
  suffix.textContent = " remaining";
  value.append(suffix);
  section.append(value);

  const progress = document.createElement("progress");
  progress.max = 100;
  progress.value = window.remaining_percent;
  progress.setAttribute("aria-label", `${window.remaining_percent}% ${heading.textContent.toLowerCase()} remaining`);
  section.append(progress);

  const used = document.createElement("p");
  used.className = "account-used";
  used.textContent = `${window.used_percent}% used`;
  section.append(used);

  const reset = document.createElement("p");
  reset.className = "account-reset";
  reset.textContent = window.reset_at
    ? `Resets ${formatDate(window.reset_at)} (${formatCountdown(window.reset_at)})`
    : "Reset time unavailable";
  section.append(reset);
  return section;
}

function renderSnapshot(state) {
  $snapshot.replaceChildren();
  const snapshot = state.snapshot;
  if (!snapshot) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No ChatGPT usage snapshot yet. Sign in to ChatGPT and refresh.";
    $snapshot.append(empty);
    if (state.last_error) {
      const error = document.createElement("p");
      error.className = "account-error";
      error.textContent = messageFor(state.last_error);
      $snapshot.append(error);
    }
    return;
  }

  const stale = snapshotAge(snapshot) > STALE_AFTER_MS;
  const card = document.createElement("article");
  card.className = "account-card";
  card.dataset.stale = String(stale);

  const heading = document.createElement("div");
  heading.className = "account-heading";
  const title = document.createElement("h3");
  title.textContent = snapshot.account?.plan_type ? `ChatGPT ${snapshot.account.plan_type}` : "ChatGPT usage";
  heading.append(title);
  if (stale) {
    const badge = document.createElement("span");
    badge.className = "account-badge";
    badge.textContent = "Stale";
    heading.append(badge);
  }
  card.append(heading);

  const windows = document.createElement("div");
  windows.className = "usage-windows";
  if (snapshot.primary_window) windows.append(usageWindow(snapshot.primary_window, "Primary limit"));
  if (snapshot.secondary_window) windows.append(usageWindow(snapshot.secondary_window, "Secondary limit"));
  card.append(windows);

  if (!snapshot.primary_window && !snapshot.secondary_window) {
    const unavailable = document.createElement("p");
    unavailable.className = "account-notice";
    unavailable.textContent = "ChatGPT did not publish a current usage window.";
    card.append(unavailable);
  }

  const stateLine = document.createElement("p");
  stateLine.className = "account-state";
  stateLine.textContent = snapshot.access.limit_reached
    ? `Limit reached${snapshot.access.limit_reached_type ? ` · ${snapshot.access.limit_reached_type}` : ""}`
    : snapshot.access.allowed ? "Usage allowed" : "Usage not allowed";
  card.append(stateLine);

  const collected = document.createElement("p");
  collected.className = "account-collected";
  collected.textContent = `Last refreshed: ${formatDate(snapshot.collected_at)}`;
  card.append(collected);

  if (state.last_error) {
    const error = document.createElement("p");
    error.className = "account-error";
    error.textContent = messageFor(state.last_error);
    card.append(error);
  }
  $snapshot.append(card);
}

function runUsageAction(key, action, button = null) {
  return runAction(key, action, {
    setBusy(next) {
      if (button) button.disabled = next;
    },
    onError(error) {
      $status.textContent = messageFor(error);
    },
    onFinally() {
      return render({ autoRefresh: false }).catch((error) => {
        $status.textContent = messageFor(error);
      });
    }
  });
}

async function refreshUsage({ automatic = false } = {}) {
  const outcome = await refreshChatGptUsage({ ignoreCooldown: !automatic });
  $status.textContent = outcome.kind === "skipped" ? "Usage is already up to date." : "ChatGPT usage refreshed.";
}

async function render({ autoRefresh = true } = {}) {
  const generation = ++renderGeneration;
  const [permitted, storedConsent, state] = await Promise.all([
    platform.hasOptionalHostPermission(CHATGPT_HOST_PERMISSION),
    getSetting(CHATGPT_SESSION_TOKEN_CONSENT_KEY, false),
    getChatGptUsageState()
  ]);
  if (generation !== renderGeneration) return;

  sessionTokenConsent = Boolean(storedConsent);
  const enabled = permitted && sessionTokenConsent;
  $sessionTokenConsent.checked = sessionTokenConsent;
  $grant.hidden = permitted;
  $grant.disabled = !sessionTokenConsent;
  $refresh.disabled = !enabled;
  renderSnapshot(state);

  if (!sessionTokenConsent) {
    $status.textContent = "Confirm the in-memory session-token notice to enable usage checks.";
  } else {
    $status.textContent = permitted ? "ChatGPT access is granted." : "Grant ChatGPT access to read usage.";
  }

  if (autoRefresh && enabled && (!state.snapshot || snapshotAge(state.snapshot) > AUTO_REFRESH_AFTER_MS)) {
    void runUsageAction("refresh-chatgpt-usage", () => refreshUsage({ automatic: true }), $refresh);
  }
}

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;

  $grant.addEventListener("click", () => runUsageAction("grant-chatgpt-access", async () => {
    if (!sessionTokenConsent) throw new UsageError("consent_required", "Confirm session-token use first");
    $status.textContent = "Requesting ChatGPT access…";
    const granted = await platform.requestOptionalHostPermission(CHATGPT_HOST_PERMISSION);
    if (!granted) throw new UsageError("permission_required", "ChatGPT access was not granted");
  }, $grant));

  $refresh.addEventListener("click", () => runUsageAction(
    "refresh-chatgpt-usage",
    () => refreshUsage({ automatic: false }),
    $refresh
  ));

  $clearData.addEventListener("click", () => runUsageAction("clear-chatgpt-data", async () => {
    if (!confirm("Clear the local ChatGPT usage snapshot and consent setting?")) return;
    await clearChatGptUsageData();
  }, $clearData));

  $sessionTokenConsent.addEventListener("change", () => runUsageAction("save-chatgpt-consent", async () => {
    sessionTokenConsent = $sessionTokenConsent.checked;
    await setSetting(CHATGPT_SESSION_TOKEN_CONSENT_KEY, sessionTokenConsent);
  }, $sessionTokenConsent));
}

export async function initUsagePage() {
  bindEvents();
  await render();
}

if (document.body?.dataset.page === "usage") {
  startPage({ page: "usage", title: "ChatGPT usage limits", init: initUsagePage });
}

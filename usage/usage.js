import {
  CHATGPT_HOST_PERMISSION,
  CHATGPT_SESSION_TOKEN_CONSENT_KEY,
  createAccountContainer,
  disconnectAccount,
  getChatGptAccounts,
  refreshAccount,
  refreshAllAccounts,
  verifyAccount,
  clearChatGptUsageData
} from "../src/chatgpt-containers.js";
import { getSetting, setSetting } from "../src/db.js";
import { UsageError } from "../src/codex-usage.js";
import { platform } from "../src/platform.js";

const OFFICIAL_USAGE_URL = "https://chatgpt.com/codex/cloud/settings/analytics#usage";
const AUTO_REFRESH_AFTER_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 15 * 60 * 1000;
const RETRY_DELAY_MS = 2_000;

const $ = (selector) => document.querySelector(selector);
const $status = $("#pageStatus");
const $grant = $("#grantAccess");
const $setup = $("#setupPanel");
const $label = $("#accountLabel");
const $accounts = $("#accounts");
const $refreshAll = $("#refreshAll");
const $clearData = $("#clearData");
const $sessionTokenConsent = $("#sessionTokenConsent");
const retryTimers = new Map();
let sessionTokenConsent = false;
let renderGeneration = 0;

function messageFor(error) {
  if (error?.code === "sign_in_required" && error.http_status === 401) {
    return "The ChatGPT usage endpoint returned HTTP 401 for this container session. Reload the ChatGPT tab and try again.";
  }
  if (error?.code === "schema_changed") {
    const detail = typeof error.message === "string" && error.message
      ? ` (${error.message})`
      : "";
    return `ChatGPT returned an unexpected usage response${detail}.`;
  }
  const messages = {
    permission_required: "Grant ChatGPT access before refreshing an account.",
    containers_unavailable: "Firefox containers are unavailable in this profile.",
    sign_in_required: "Sign in to ChatGPT in this container, then try again.",
    access_denied: "ChatGPT denied access to the usage response.",
    endpoint_unavailable: "The private ChatGPT usage endpoint is unavailable.",
    network_error: "The ChatGPT usage request could not reach the service.",
    temporarily_rate_limited: "ChatGPT is temporarily rate-limiting this account.",
    duplicate_account: "That ChatGPT account is already connected.",
    account_mismatch: "This container is signed in to a different ChatGPT account.",
    container_deleted: "The Firefox container for this account no longer exists.",
    invalid_label: "Enter a local label for this account."
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

function snapshotAge(snapshot) {
  return Date.now() - new Date(snapshot?.collected_at || 0).getTime();
}

function isExpired(snapshot) {
  return Boolean(snapshot?.primary_window?.reset_at) && new Date(snapshot.primary_window.reset_at).getTime() <= Date.now();
}

function isStale(snapshot) {
  return snapshotAge(snapshot) > STALE_AFTER_MS;
}

function appendLink(parent, text, url) {
  const link = document.createElement("a");
  link.textContent = text;
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer";
  parent.append(link);
}

function usageTab(account) {
  return platform.createTab({ url: OFFICIAL_USAGE_URL, cookieStoreId: account.cookie_store_id, active: true });
}

function errorCode(account) {
  return account.last_error?.code || "";
}

function consentRequired() {
  $status.textContent = "Confirm the in-memory session-token notice before checking ChatGPT usage.";
  $sessionTokenConsent.focus();
}

async function retryTransient(account) {
  if (retryTimers.has(account.id)) return;
  retryTimers.set(account.id, true);
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  try {
    await refreshAccount(account, { ignoreCooldown: true });
  } finally {
    retryTimers.delete(account.id);
  }
}

async function refreshOne(account, { automatic = false } = {}) {
  try {
    await refreshAccount(account, { ignoreCooldown: automatic });
    $status.textContent = `${account.label} refreshed.`;
  } catch (error) {
    if (error?.code === "network_error") {
      try {
        await retryTransient(account);
        $status.textContent = `${account.label} refreshed after a network retry.`;
      } catch (retryError) {
        $status.textContent = `${account.label}: ${messageFor(retryError)}`;
      }
    } else {
      $status.textContent = `${account.label}: ${messageFor(error)}`;
    }
  }
  await render({ autoRefresh: false });
}

function accountCard(account, enabled) {
  const snapshot = account.snapshot;
  const stale = Boolean(snapshot && isStale(snapshot));
  const expired = Boolean(snapshot && isExpired(snapshot));
  const card = document.createElement("article");
  card.className = "account-card";
  card.dataset.stale = String(stale);
  card.dataset.expired = String(expired);

  const heading = document.createElement("div");
  heading.className = "account-heading";
  const title = document.createElement("h3");
  title.textContent = account.label;
  heading.append(title);
  if (stale || expired) {
    const badge = document.createElement("span");
    badge.className = "account-badge";
    badge.textContent = expired ? "Expired" : "Stale";
    heading.append(badge);
  }
  card.append(heading);

  const meta = document.createElement("p");
  meta.className = "account-meta";
  if (account.email) {
    meta.textContent = `${account.email}${account.plan_type ? ` · ${account.plan_type}` : ""}`;
  } else {
    meta.textContent = account.pending_setup ? "Setup pending — sign in in the Firefox container tab." : "No email provided by ChatGPT.";
  }
  card.append(meta);

  if (snapshot?.primary_window) {
    const remaining = snapshot.primary_window.remaining_percent;
    const value = document.createElement("div");
    value.className = "account-value";
    value.textContent = String(remaining);
    const suffix = document.createElement("span");
    suffix.textContent = "% Weekly usage remaining";
    value.append(suffix);
    card.append(value);

    const progress = document.createElement("progress");
    progress.max = 100;
    progress.value = remaining;
    progress.setAttribute("aria-label", `${remaining}% weekly usage remaining`);
    card.append(progress);

    const used = document.createElement("p");
    used.className = "account-used";
    used.textContent = `${snapshot.primary_window.used_percent}% used`;
    card.append(used);

    const reset = document.createElement("p");
    reset.className = "account-reset";
    reset.textContent = `Resets ${formatDate(snapshot.primary_window.reset_at)} (${formatCountdown(snapshot.primary_window.reset_at)})`;
    card.append(reset);

    const state = document.createElement("p");
    state.className = "account-state";
    const states = [];
    if (snapshot.access.limit_reached) states.push("Limit reached");
    else if (snapshot.access.allowed) states.push("Usage allowed");
    else states.push("Usage not allowed");
    if (snapshot.credits.unlimited) states.push("Unlimited credits");
    if (snapshot.credits.has_credits) states.push("Credits available");
    if (snapshot.credits.overage_limit_reached) states.push("Overage limit reached");
    state.textContent = states.join(" · ");
    card.append(state);

    if (snapshot.notices.length) {
      const notice = document.createElement("p");
      notice.className = "account-notice";
      notice.textContent = "An additional ChatGPT limit is not supported by this experimental reader. ";
      appendLink(notice, "Open official Usage page", snapshot.official_usage_url || OFFICIAL_USAGE_URL);
      card.append(notice);
    }

    const collected = document.createElement("p");
    collected.className = "account-collected";
    collected.textContent = `Last successful refresh: ${formatDate(snapshot.collected_at)}${stale ? " · stale" : ""}`;
    card.append(collected);
  } else if (snapshot) {
    const unavailable = document.createElement("p");
    unavailable.className = "account-notice";
    unavailable.textContent = "ChatGPT did not publish a current usage window for this account. ";
    appendLink(unavailable, "Open official Usage page", snapshot.official_usage_url || OFFICIAL_USAGE_URL);
    card.append(unavailable);

    const collected = document.createElement("p");
    collected.className = "account-collected";
    collected.textContent = `Last successful refresh: ${formatDate(snapshot.collected_at)}${stale ? " · stale" : ""}`;
    card.append(collected);
  }

  if (snapshot?.source) {
    const source = document.createElement("p");
    source.className = "account-collected";
    source.textContent = snapshot.source === "page_fallback"
      ? "Source: page fallback — experimental and unverified"
      : "Source: isolated extension request";
    card.append(source);
  }

  const storedError = errorCode(account);
  if (storedError) {
    const error = document.createElement("p");
    error.className = "account-error";
    error.textContent = account.last_error?.message || messageFor({ code: storedError });
    card.append(error);
  }

  const actions = document.createElement("div");
  actions.className = "actions account-actions";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "Refresh";
  refresh.disabled = !enabled;
  refresh.title = enabled ? "Refresh this account" : "Grant ChatGPT access and confirm the session-token notice to refresh";
  refresh.addEventListener("click", () => refreshOne(account));
  actions.append(refresh);

  const openUsage = document.createElement("button");
  openUsage.type = "button";
  openUsage.textContent = "Open ChatGPT Usage";
  openUsage.addEventListener("click", () => usageTab(account));
  actions.append(openUsage);

  if (account.pending_setup || storedError === "sign_in_required" || storedError === "account_mismatch") {
    const signIn = document.createElement("button");
    signIn.type = "button";
    signIn.textContent = "Sign in";
    signIn.addEventListener("click", () => usageTab(account));
    actions.append(signIn);
  }

  if (account.pending_setup) {
    const check = document.createElement("button");
    check.type = "button";
    check.textContent = "Check signed-in account";
    check.disabled = !enabled;
    check.addEventListener("click", async () => {
      if (!sessionTokenConsent) return consentRequired();
      check.disabled = true;
      $status.textContent = `Checking ${account.label}…`;
      try {
        await verifyAccount(account.cookie_store_id);
        $status.textContent = `${account.label} is connected.`;
        await render({ autoRefresh: false });
      } catch (error) {
        $status.textContent = `${account.label}: ${messageFor(error)}`;
        check.disabled = false;
      }
    });
    actions.append(check);
  }

  const disconnect = document.createElement("button");
  disconnect.type = "button";
  disconnect.textContent = "Disconnect";
  disconnect.addEventListener("click", async () => {
    if (!confirm(`Disconnect ${account.label}? The Firefox container will remain.`)) return;
    await disconnectAccount(account.id);
    await render({ autoRefresh: false });
  });
  actions.append(disconnect);
  card.append(actions);
  return card;
}

async function render({ autoRefresh = true } = {}) {
  const generation = ++renderGeneration;
  const [permitted, storedConsent, accounts] = await Promise.all([
    platform.hasOptionalHostPermission(CHATGPT_HOST_PERMISSION),
    getSetting(CHATGPT_SESSION_TOKEN_CONSENT_KEY, false),
    getChatGptAccounts()
  ]);
  if (generation !== renderGeneration) return;
  sessionTokenConsent = Boolean(storedConsent);
  const enabled = permitted && sessionTokenConsent;
  $sessionTokenConsent.checked = sessionTokenConsent;
  $grant.hidden = permitted;
  $grant.disabled = !sessionTokenConsent;
  $setup.hidden = !enabled;
  $clearData.disabled = false;
  $refreshAll.hidden = !enabled || !accounts.length;
  $accounts.replaceChildren();
  if (!accounts.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = permitted ? "No ChatGPT accounts connected yet." : "Grant access to set up an account.";
    $accounts.append(empty);
  } else {
    for (const account of accounts) $accounts.append(accountCard(account, enabled));
  }
  if (permitted && !sessionTokenConsent) {
    $status.textContent = "Confirm the in-memory session-token notice to enable ChatGPT usage checks.";
  } else {
    $status.textContent = permitted ? "ChatGPT access is granted." : "ChatGPT access is not granted.";
  }
  if (autoRefresh && enabled) {
    const due = accounts.filter((account) => account.snapshot && (snapshotAge(account.snapshot) > AUTO_REFRESH_AFTER_MS || isExpired(account.snapshot)));
    for (const account of due) refreshOne(account, { automatic: true });
  }
}

$grant.addEventListener("click", async () => {
  if (!sessionTokenConsent) return consentRequired();
  $grant.disabled = true;
  $status.textContent = "Requesting ChatGPT access…";
  try {
    const granted = await platform.requestOptionalHostPermission(CHATGPT_HOST_PERMISSION);
    if (!granted) throw new UsageError("permission_required", "ChatGPT access was not granted");
    await render({ autoRefresh: false });
  } catch (error) {
    $status.textContent = messageFor(error);
    $grant.disabled = false;
  }
});

$("#addAccount").addEventListener("click", async () => {
  if (!sessionTokenConsent) return consentRequired();
  const button = $("#addAccount");
  button.disabled = true;
  try {
    await createAccountContainer($label.value);
    $label.value = `Account ${Math.min((await getChatGptAccounts()).length + 1, 3)}`;
    $status.textContent = "Firefox opened a ChatGPT tab. Sign in there, then use Check signed-in account.";
    await render({ autoRefresh: false });
  } catch (error) {
    $status.textContent = messageFor(error);
  } finally {
    button.disabled = false;
  }
});

$refreshAll.addEventListener("click", async () => {
  if (!sessionTokenConsent) return consentRequired();
  $refreshAll.disabled = true;
  try {
    const results = await refreshAllAccounts(await getChatGptAccounts());
    const succeeded = results.filter((result) => result.ok).length;
    $status.textContent = `${succeeded} of ${results.length} account refreshes succeeded.`;
  } catch (error) {
    $status.textContent = messageFor(error);
  } finally {
    $refreshAll.disabled = false;
    await render({ autoRefresh: false });
  }
});

$clearData.addEventListener("click", async () => {
  if (!confirm("Clear all local ChatGPT usage bindings, snapshots, fingerprints, and the profile salt? Firefox containers and sessions will remain.")) return;
  await clearChatGptUsageData();
  await render({ autoRefresh: false });
});

$sessionTokenConsent.addEventListener("change", async () => {
  sessionTokenConsent = $sessionTokenConsent.checked;
  await setSetting(CHATGPT_SESSION_TOKEN_CONSENT_KEY, sessionTokenConsent);
  await render({ autoRefresh: false });
});

render().catch((error) => {
  $status.textContent = messageFor(error);
});

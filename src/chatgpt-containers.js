import { getSetting, removeSetting, setSetting } from "./db.js";
import { extractUsageIdentity, normalizeBridgeResult, OFFICIAL_USAGE_URL, UsageError } from "./codex-usage.js";
import { platform } from "./platform.js";

export const CHATGPT_ACCOUNTS_KEY = "chatgpt_usage_accounts";
export const CHATGPT_PROFILE_SALT_KEY = "chatgpt_usage_profile_salt";
export const CHATGPT_CACHE_VERSION_KEY = "chatgpt_usage_cache_version";
export const CHATGPT_SESSION_TOKEN_CONSENT_KEY = "chatgpt_usage_session_token_consent";
export const CHATGPT_CACHE_VERSION = 1;
export const CHATGPT_USAGE_PAGE_URL = OFFICIAL_USAGE_URL;
export const CHATGPT_HOST_PERMISSION = "https://chatgpt.com/*";
export const CHATGPT_MESSAGE_TYPE = "GET_CHATGPT_USAGE";
export const REFRESH_COOLDOWN_MS = 60_000;

const inFlightRefreshes = new Map();

function dependencies(overrides = {}) {
  return {
    platform: overrides.platform || platform,
    getSetting: overrides.getSetting || getSetting,
    setSetting: overrides.setSetting || setSetting,
    removeSetting: overrides.removeSetting || removeSetting,
    now: overrides.now || (() => Date.now()),
    crypto: overrides.crypto || globalThis.crypto
  };
}

function usageError(code, message, details = {}) {
  return new UsageError(code, message, details);
}

function normalizeLabel(label) {
  const value = String(label || "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (!value) throw usageError("invalid_label", "Enter a name for this ChatGPT account");
  return value;
}

function accountId(cryptoApi) {
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return `account-${base64Url(bytes)}`;
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function ensureCrypto(cryptoApi) {
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function" || !cryptoApi.subtle) {
    throw new Error("Web Crypto is unavailable");
  }
}

async function readAccounts(deps) {
  const value = await deps.getSetting(CHATGPT_ACCOUNTS_KEY, []);
  return Array.isArray(value) ? value : [];
}

async function writeAccounts(deps, accounts) {
  await deps.setSetting(CHATGPT_ACCOUNTS_KEY, accounts);
  return accounts;
}

function withoutTransientIdentity(account) {
  const copy = { ...account };
  delete copy.user_id;
  delete copy.account_id;
  return copy;
}

function findAccount(accounts, predicate) {
  return accounts.find(predicate) || null;
}

async function ensureProfileSalt(deps) {
  ensureCrypto(deps.crypto);
  const existing = await deps.getSetting(CHATGPT_PROFILE_SALT_KEY, "");
  if (typeof existing === "string" && existing) return existing;
  const bytes = new Uint8Array(32);
  deps.crypto.getRandomValues(bytes);
  const salt = base64Url(bytes);
  await deps.setSetting(CHATGPT_PROFILE_SALT_KEY, salt);
  return salt;
}

async function fingerprintAccount(identity, salt, cryptoApi) {
  const input = new TextEncoder().encode(`${salt}\0${identity.user_id}\0${identity.account_id}`);
  const digest = await cryptoApi.subtle.digest("SHA-256", input);
  return base64Url(new Uint8Array(digest));
}

async function checkAccess(deps) {
  if (!(await deps.platform.hasOptionalHostPermission(CHATGPT_HOST_PERMISSION))) {
    throw usageError("permission_required", "Grant ChatGPT access before connecting an account");
  }
}

async function openOrCreateTab(deps, cookieStoreId, { active, temporary = false } = {}) {
  const existing = await deps.platform.queryChatGptTabs(cookieStoreId);
  if (existing.length) return { tab: existing[0], temporary: false };
  const tab = await deps.platform.createTab({
    url: CHATGPT_USAGE_PAGE_URL,
    cookieStoreId,
    active
  });
  if (!tab || tab.id === undefined || tab.id === null) throw usageError("tab_unavailable", "Could not create a ChatGPT tab");
  return { tab, temporary };
}

async function readUsageFromTab(deps, tab, label) {
  await deps.platform.waitForTabComplete(tab.id);
  const result = await deps.platform.sendTabMessage(tab.id, { type: CHATGPT_MESSAGE_TYPE });
  return normalizeBridgeResult(result, { label, collectedAt: new Date(deps.now()).toISOString() });
}

async function saveVerifiedAccount(deps, account, rawBody) {
  const normalized = normalizeBridgeResult({ status: 200, body: rawBody }, {
    label: account.label,
    collectedAt: new Date(deps.now()).toISOString()
  });
  const identity = extractUsageIdentity(rawBody);
  const accounts = await readAccounts(deps);
  let fingerprint = account.fingerprint || "";
  if (identity) {
    const salt = await ensureProfileSalt(deps);
    fingerprint = await fingerprintAccount(identity, salt, deps.crypto);
    const duplicate = accounts.find((candidate) => candidate.id !== account.id && candidate.fingerprint === fingerprint);
    if (duplicate) throw usageError("duplicate_account", "This ChatGPT account is already connected");
  }

  const saved = withoutTransientIdentity({
    ...account,
    pending_setup: false,
    fingerprint,
    email: normalized.account.email,
    plan_type: normalized.account.plan_type,
    snapshot: normalized,
    last_success_at: normalized.collected_at,
    last_refresh_at: deps.now(),
    last_error: null
  });
  const next = accounts.map((candidate) => candidate.id === account.id ? saved : candidate);
  await writeAccounts(deps, next);
  return saved;
}

export async function getChatGptAccounts(overrides = {}) {
  return readAccounts(dependencies(overrides));
}

export async function createAccountContainer(label, overrides = {}) {
  const deps = dependencies(overrides);
  await checkAccess(deps);
  if (!deps.platform.contextualIdentitiesAvailable()) {
    throw usageError("containers_unavailable", "Firefox containers are unavailable");
  }
  const normalizedLabel = normalizeLabel(label);
  const identity = await deps.platform.createContextualIdentity(`Worklog ChatGPT - ${normalizedLabel}`);
  if (!identity || !identity.cookieStoreId) throw usageError("containers_unavailable", "Firefox did not create a container");
  const accounts = await readAccounts(deps);
  const account = {
    id: accountId(deps.crypto),
    label: normalizedLabel,
    cookie_store_id: identity.cookieStoreId,
    pending_setup: true,
    fingerprint: "",
    email: "",
    plan_type: "",
    snapshot: null,
    last_success_at: null,
    last_refresh_at: 0,
    last_error: null
  };
  await writeAccounts(deps, [...accounts, account]);
  await deps.platform.createTab({ url: CHATGPT_USAGE_PAGE_URL, cookieStoreId: identity.cookieStoreId, active: true });
  return account;
}

export async function verifyAccount(cookieStoreId, overrides = {}) {
  const deps = dependencies(overrides);
  await checkAccess(deps);
  const accounts = await readAccounts(deps);
  const account = findAccount(accounts, (candidate) => candidate.cookie_store_id === cookieStoreId);
  if (!account) throw usageError("account_not_found", "Connect this Firefox container before checking it");
  const tabInfo = await openOrCreateTab(deps, cookieStoreId, { active: true });
  await deps.platform.waitForTabComplete(tabInfo.tab.id);
  const result = await deps.platform.sendTabMessage(tabInfo.tab.id, { type: CHATGPT_MESSAGE_TYPE });
  if (!result || result.status !== 200 || result.ok === false) normalizeBridgeResult(result, { label: account.label });
  const rawBody = result.body;
  return saveVerifiedAccount(deps, account, rawBody);
}

async function refreshAccountInternal(account, deps) {
  await checkAccess(deps);
  const currentContainer = await deps.platform.getContextualIdentity(account.cookie_store_id);
  if (!currentContainer) throw usageError("container_deleted", "The Firefox container for this account no longer exists");
  const tabInfo = await openOrCreateTab(deps, account.cookie_store_id, { active: false, temporary: true });
  try {
    const result = await deps.platform.sendTabMessage(
      (await deps.platform.waitForTabComplete(tabInfo.tab.id)).id,
      { type: CHATGPT_MESSAGE_TYPE }
    );
    if (!result || result.status !== 200 || result.ok === false) normalizeBridgeResult(result, { label: account.label });
    const normalized = normalizeBridgeResult(result, {
      label: account.label,
      collectedAt: new Date(deps.now()).toISOString()
    });
    const identity = extractUsageIdentity(result.body);
    let refreshedFingerprint = account.fingerprint || "";
    if (identity) {
      const salt = await ensureProfileSalt(deps);
      const fingerprint = await fingerprintAccount(identity, salt, deps.crypto);
      if (account.fingerprint && fingerprint !== account.fingerprint) {
        throw usageError("account_mismatch", "The connected Firefox container is signed in to a different ChatGPT account");
      }
      refreshedFingerprint = fingerprint;
    }
    const accounts = await readAccounts(deps);
    const saved = withoutTransientIdentity({
      ...account,
      fingerprint: refreshedFingerprint,
      email: normalized.account.email,
      plan_type: normalized.account.plan_type,
      snapshot: normalized,
      last_success_at: normalized.collected_at,
      last_refresh_at: deps.now(),
      last_error: null
    });
    await writeAccounts(deps, accounts.map((candidate) => candidate.id === account.id ? saved : candidate));
    return saved;
  } finally {
    if (tabInfo.temporary) await deps.platform.removeTab(tabInfo.tab.id);
  }
}

export async function refreshAccount(account, overrides = {}) {
  const deps = dependencies(overrides);
  if (!account || !account.id) throw usageError("account_not_found", "ChatGPT account is unavailable");
  const existing = inFlightRefreshes.get(account.id);
  if (existing) return existing;
  const lastAttemptAt = Number(account.last_attempt_at || account.last_refresh_at || 0);
  const retryAfterMs = Number(account.last_error?.retry_after_seconds || 0) * 1000;
  const cooldownMs = Math.max(REFRESH_COOLDOWN_MS, retryAfterMs);
  if (!overrides.ignoreCooldown && deps.now() - lastAttemptAt < cooldownMs) {
    return { ...account, skipped: true, skip_reason: "cooldown" };
  }
  const request = (async () => {
    const attemptedAt = deps.now();
    const accounts = await readAccounts(deps);
    const attemptedAccount = accounts.find((candidate) => candidate.id === account.id) || account;
    await writeAccounts(deps, accounts.map((candidate) => candidate.id === account.id
      ? { ...candidate, last_attempt_at: attemptedAt }
      : candidate));
    return refreshAccountInternal({ ...attemptedAccount, last_attempt_at: attemptedAt }, deps);
  })()
    .catch(async (error) => {
      const accounts = await readAccounts(deps);
      const safeError = error instanceof UsageError ? error : usageError("service_error", "ChatGPT usage refresh failed");
      const failure = {
        code: safeError.code,
        occurred_at: new Date(deps.now()).toISOString(),
        retry_after_seconds: Number.isFinite(safeError.retry_after_seconds) ? safeError.retry_after_seconds : null
      };
      await writeAccounts(deps, accounts.map((candidate) => candidate.id === account.id
        ? { ...candidate, last_error: failure }
        : candidate));
      throw safeError;
    })
    .finally(() => inFlightRefreshes.delete(account.id));
  inFlightRefreshes.set(account.id, request);
  return request;
}

export async function refreshAllAccounts(accounts, overrides = {}) {
  const results = await Promise.all((accounts || []).map(async (account) => {
    try {
      return { accountId: account.id, ok: true, account: await refreshAccount(account, overrides) };
    } catch (error) {
      return {
        accountId: account.id,
        ok: false,
        error: error instanceof UsageError ? error : usageError("service_error", "ChatGPT usage refresh failed")
      };
    }
  }));
  return results;
}

export async function disconnectAccount(accountIdToRemove, overrides = {}) {
  const deps = dependencies(overrides);
  const accounts = await readAccounts(deps);
  await writeAccounts(deps, accounts.filter((account) => account.id !== accountIdToRemove));
}

export async function clearChatGptUsageData(overrides = {}) {
  const deps = dependencies(overrides);
  await deps.removeSetting(CHATGPT_ACCOUNTS_KEY);
  await deps.removeSetting(CHATGPT_PROFILE_SALT_KEY);
  await deps.removeSetting(CHATGPT_CACHE_VERSION_KEY);
  await deps.removeSetting(CHATGPT_SESSION_TOKEN_CONSENT_KEY);
}

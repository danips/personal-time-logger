import { getSetting, mutateSetting, mutateSettings, removeSetting, setSetting } from "./db.js";
import { CHATGPT_ACCOUNTS_KEY, normalizeChatGptAccounts } from "./chatgpt-account-cache.js";
import { extractUsageIdentity, normalizeBridgeResult, OFFICIAL_USAGE_URL, UsageError } from "./codex-usage.js";
import { platform } from "./platform.js";
import { SETTING_KEY } from "./setting-keys.js";

export { CHATGPT_ACCOUNTS_KEY };
export const CHATGPT_ACCOUNT_GENERATION_KEY = SETTING_KEY.CHATGPT_USAGE_ACCOUNT_GENERATION;
export const CHATGPT_PROFILE_SALT_KEY = SETTING_KEY.CHATGPT_USAGE_PROFILE_SALT;
export const CHATGPT_SESSION_TOKEN_CONSENT_KEY = SETTING_KEY.CHATGPT_USAGE_SESSION_TOKEN_CONSENT;
export const CHATGPT_USAGE_PAGE_URL = OFFICIAL_USAGE_URL;
export const CHATGPT_HOST_PERMISSION = "https://chatgpt.com/*";
export const CHATGPT_MESSAGE_TYPE = "GET_CHATGPT_USAGE";
export const REFRESH_COOLDOWN_MS = 60_000;

const inFlightRefreshes = new Map();

function dependencies(overrides = {}) {
  const get = overrides.getSetting || getSetting;
  const set = overrides.setSetting || setSetting;
  const remove = overrides.removeSetting || removeSetting;
  const localMutateSetting = async (key, mutator) => {
    const next = mutator(await get(key));
    if (next === undefined) await remove(key);
    else await set(key, next);
    return next;
  };
  return {
    platform: overrides.platform || platform,
    getSetting: get,
    setSetting: set,
    removeSetting: remove,
    mutateSetting: overrides.mutateSetting || (overrides.getSetting || overrides.setSetting || overrides.removeSetting
      ? localMutateSetting
      : mutateSetting),
    mutateSettings: overrides.mutateSettings || (overrides.getSetting || overrides.setSetting || overrides.removeSetting
      ? async (keys, mutator) => {
        const values = new Map();
        for (const key of keys) {
          const value = await get(key);
          if (value !== undefined) values.set(key, value);
        }
        const result = mutator(values);
        for (const key of keys) {
          if (values.has(key)) await set(key, values.get(key));
          else await remove(key);
        }
        return result;
      }
      : mutateSettings),
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
  return normalizeChatGptAccounts(value);
}

function accountGeneration(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
}

async function readAccountState(deps) {
  const [accounts, generation] = await Promise.all([
    readAccounts(deps),
    deps.getSetting(CHATGPT_ACCOUNT_GENERATION_KEY, 0)
  ]);
  return { accounts, generation: accountGeneration(generation) };
}

async function mutateAccounts(deps, mutator) {
  let result;
  await deps.mutateSettings([CHATGPT_ACCOUNTS_KEY, CHATGPT_ACCOUNT_GENERATION_KEY], (settings) => {
    const value = settings.get(CHATGPT_ACCOUNTS_KEY);
    const accounts = Array.isArray(value) ? value : [];
    const generation = accountGeneration(settings.get(CHATGPT_ACCOUNT_GENERATION_KEY));
    const outcome = mutator(accounts, generation);
    if (!outcome || !Array.isArray(outcome.accounts)) {
      throw new TypeError("Account mutators must return an accounts array");
    }
    result = outcome.result;
    settings.set(CHATGPT_ACCOUNTS_KEY, outcome.accounts);
    settings.set(CHATGPT_ACCOUNT_GENERATION_KEY, outcome.generation === undefined ? generation : outcome.generation);
  });
  return result;
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

async function ensureProfileSalt(deps, expectedGeneration) {
  ensureCrypto(deps.crypto);
  let salt;
  await deps.mutateSettings([CHATGPT_PROFILE_SALT_KEY, CHATGPT_ACCOUNT_GENERATION_KEY], (settings) => {
    if (expectedGeneration !== undefined
      && accountGeneration(settings.get(CHATGPT_ACCOUNT_GENERATION_KEY)) !== expectedGeneration) {
      throw usageError("account_not_found", "ChatGPT usage data was cleared while this account was refreshing");
    }
    const existing = settings.get(CHATGPT_PROFILE_SALT_KEY);
    if (typeof existing === "string" && existing) return existing;
    const bytes = new Uint8Array(32);
    deps.crypto.getRandomValues(bytes);
    salt = base64Url(bytes);
    settings.set(CHATGPT_PROFILE_SALT_KEY, salt);
  });
  return salt || await deps.getSetting(CHATGPT_PROFILE_SALT_KEY, "");
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

async function saveVerifiedAccount(deps, account, rawBody, expectedGeneration) {
  const normalized = normalizeBridgeResult({ status: 200, body: rawBody }, {
    label: account.label,
    collectedAt: new Date(deps.now()).toISOString()
  });
  const identity = extractUsageIdentity(rawBody);
  let fingerprint = account.fingerprint || "";
  if (identity) {
    const salt = await ensureProfileSalt(deps, expectedGeneration);
    fingerprint = await fingerprintAccount(identity, salt, deps.crypto);
  }

  return mutateAccounts(deps, (accounts, generation) => {
    if (generation !== expectedGeneration) {
      throw usageError("account_not_found", "ChatGPT usage data was cleared while this account was being verified");
    }
    const current = findAccount(accounts, (candidate) => candidate.id === account.id);
    if (!current) throw usageError("account_not_found", "ChatGPT account was disconnected while it was being verified");
    if (fingerprint) {
      const duplicate = accounts.find((candidate) => candidate.id !== account.id && candidate.fingerprint === fingerprint);
      if (duplicate) throw usageError("duplicate_account", "This ChatGPT account is already connected");
    }
    const saved = withoutTransientIdentity({
      ...current,
      pending_setup: false,
      fingerprint,
      email: normalized.account.email,
      plan_type: normalized.account.plan_type,
      snapshot: normalized,
      last_success_at: normalized.collected_at,
      last_refresh_at: deps.now(),
      last_error: null
    });
    return {
      accounts: accounts.map((candidate) => candidate.id === account.id ? saved : candidate),
      result: saved
    };
  });
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
  await mutateAccounts(deps, (accounts) => ({ accounts: [...accounts, account], result: account }));
  try {
    await deps.platform.createTab({ url: CHATGPT_USAGE_PAGE_URL, cookieStoreId: identity.cookieStoreId, active: true });
  } catch (error) {
    // The account cannot be completed without its first setup tab. Remove the
    // durable pending state and best-effort clean up the unused container; a
    // cleanup failure must not hide the actionable setup error.
    try {
      await mutateAccounts(deps, (accounts) => ({
        accounts: accounts.filter((candidate) => candidate.id !== account.id),
        result: null
      }));
    } finally {
      try {
        await deps.platform.removeContextualIdentity?.(identity.cookieStoreId);
      } catch {
        // The account record is gone, so the remaining container is harmless
        // and can still be removed manually from Firefox container settings.
      }
    }
    throw usageError("setup_tab_unavailable", "Could not open the ChatGPT setup tab", { cause: error });
  }
  return account;
}

export async function verifyAccount(cookieStoreId, overrides = {}) {
  const deps = dependencies(overrides);
  await checkAccess(deps);
  const { accounts, generation } = await readAccountState(deps);
  const account = findAccount(accounts, (candidate) => candidate.cookie_store_id === cookieStoreId);
  if (!account) throw usageError("account_not_found", "Connect this Firefox container before checking it");
  const tabInfo = await openOrCreateTab(deps, cookieStoreId, { active: true });
  await deps.platform.waitForTabComplete(tabInfo.tab.id);
  const result = await deps.platform.sendTabMessage(tabInfo.tab.id, { type: CHATGPT_MESSAGE_TYPE });
  if (!result || result.status !== 200 || result.ok === false) normalizeBridgeResult(result, { label: account.label });
  const rawBody = result.body;
  return saveVerifiedAccount(deps, account, rawBody, generation);
}

async function refreshAccountInternal(account, generation, deps) {
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
      const salt = await ensureProfileSalt(deps, generation);
      const fingerprint = await fingerprintAccount(identity, salt, deps.crypto);
      if (account.fingerprint && fingerprint !== account.fingerprint) {
        throw usageError("account_mismatch", "The connected Firefox container is signed in to a different ChatGPT account");
      }
      refreshedFingerprint = fingerprint;
    }
    return mutateAccounts(deps, (accounts, currentGeneration) => {
      if (currentGeneration !== generation) {
        throw usageError("account_not_found", "ChatGPT usage data was cleared while this account was refreshing");
      }
      const current = findAccount(accounts, (candidate) => candidate.id === account.id);
      if (!current) throw usageError("account_not_found", "ChatGPT account was disconnected while it was refreshing");
      if (current.fingerprint && refreshedFingerprint && current.fingerprint !== refreshedFingerprint) {
        throw usageError("account_mismatch", "The connected Firefox container is signed in to a different ChatGPT account");
      }
      const saved = withoutTransientIdentity({
        ...current,
        fingerprint: refreshedFingerprint,
        email: normalized.account.email,
        plan_type: normalized.account.plan_type,
        snapshot: normalized,
        last_success_at: normalized.collected_at,
        last_refresh_at: deps.now(),
        last_error: null
      });
      return {
        accounts: accounts.map((candidate) => candidate.id === account.id ? saved : candidate),
        result: saved
      };
    });
  } finally {
    if (tabInfo.temporary) {
      try {
        await deps.platform.removeTab(tabInfo.tab.id);
      } catch {
        // A temporary-tab cleanup failure must not hide a successful refresh or
        // replace the original service error. The tab contains the user's own
        // container session and is therefore left for normal browser cleanup.
      }
    }
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
  let refreshGeneration;
  const request = (async () => {
    const attemptedAt = deps.now();
    const attempted = await mutateAccounts(deps, (accounts, generation) => {
      const current = findAccount(accounts, (candidate) => candidate.id === account.id);
      if (!current) throw usageError("account_not_found", "ChatGPT account is unavailable");
      const attempted = { ...current, last_attempt_at: attemptedAt };
      return {
        accounts: accounts.map((candidate) => candidate.id === account.id ? attempted : candidate),
        result: { account: attempted, generation }
      };
    });
    refreshGeneration = attempted.generation;
    return refreshAccountInternal(attempted.account, attempted.generation, deps);
  })()
    .catch(async (error) => {
      const safeError = error instanceof UsageError ? error : usageError("service_error", "ChatGPT usage refresh failed");
      const failure = {
        code: safeError.code,
        message: String(safeError.message || "ChatGPT usage refresh failed").slice(0, 240),
        occurred_at: new Date(deps.now()).toISOString(),
        retry_after_seconds: Number.isFinite(safeError.retry_after_seconds) ? safeError.retry_after_seconds : null
      };
      if (refreshGeneration !== undefined) {
        const state = await readAccountState(deps);
        if (state.generation !== refreshGeneration) throw safeError;
      }
      await mutateAccounts(deps, (accounts) => ({
        accounts: accounts.map((candidate) => candidate.id === account.id
          ? { ...candidate, last_error: failure }
          : candidate),
        result: null
      }));
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
  await mutateAccounts(deps, (accounts) => ({
    accounts: accounts.filter((account) => account.id !== accountIdToRemove),
    result: null
  }));
}

export async function clearChatGptUsageData(overrides = {}) {
  const deps = dependencies(overrides);
  await deps.mutateSettings([
    CHATGPT_ACCOUNTS_KEY,
    CHATGPT_ACCOUNT_GENERATION_KEY,
    CHATGPT_PROFILE_SALT_KEY,
    CHATGPT_SESSION_TOKEN_CONSENT_KEY
  ], (settings) => {
    settings.delete(CHATGPT_ACCOUNTS_KEY);
    settings.set(
      CHATGPT_ACCOUNT_GENERATION_KEY,
      accountGeneration(settings.get(CHATGPT_ACCOUNT_GENERATION_KEY)) + 1
    );
    settings.delete(CHATGPT_PROFILE_SALT_KEY);
    settings.delete(CHATGPT_SESSION_TOKEN_CONSENT_KEY);
  });
}

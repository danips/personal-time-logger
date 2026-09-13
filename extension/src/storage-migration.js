import {
  claimLock,
  getAllEntries,
  getSetting,
  isLockCurrent,
  mutateSettings,
  releaseLock,
  renewLock,
  setSetting
} from "./db.js";
import { ERROR_CODE } from "./error-codes.js";
import { codedError } from "./coded-error.js";
import { canonicalEntryValues, entryFingerprint } from "./fingerprints.js";
import { getActiveRemoteProvider, getRemoteProvider, registeredRemoteProviderIds } from "./remote-provider.js";
import { SETTING_KEY } from "./setting-keys.js";
import { syncNow } from "./sync.js";

const SYNC_LOCK_KEY = "sync_lock";
const MIGRATION_LOCK_TTL_MS = 120_000;
const MIGRATION_BATCH_SIZE = 100;
const MAX_STABILIZATION_ATTEMPTS = 3;
const APP_MARKER_KEY = "app";
const MIGRATION_PHASES = new Set([
  "preparing",
  "seeding",
  "verifying",
  "source_changed",
  "post_switch",
  "complete",
  "failed"
]);

function migrationError(code, message) {
  return codedError(code, message);
}

function migrationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cleanProviderId(value) {
  const id = String(value || "").trim();
  if (!registeredRemoteProviderIds().includes(id)) {
    throw migrationError(ERROR_CODE.REMOTE_BACKEND_UNSUPPORTED, "The migration target backend is unsupported.");
  }
  return id;
}

function isActiveState(state) {
  return Boolean(state && typeof state === "object"
    && MIGRATION_PHASES.has(state.phase)
    && !["complete", "failed"].includes(state.phase));
}

function canonicalConfig(config = {}) {
  return Object.entries(config)
    .filter(([key]) => key !== APP_MARKER_KEY)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, String(value?.value ?? ""), String(value?.updated_at ?? "")]);
}

export function canonicalMigrationDataset(snapshot) {
  return {
    entries: [...(snapshot.entries || [])]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(canonicalEntryValues),
    config: canonicalConfig(snapshot.config)
  };
}

export function canonicalMigrationText(snapshot) {
  return JSON.stringify(canonicalMigrationDataset(snapshot));
}

async function digestText(value) {
  const bytes = new TextEncoder().encode(value);
  if (!globalThis.crypto?.subtle) throw migrationError(ERROR_CODE.API_ERROR, "Secure migration verification is unavailable.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function migrationDigest(snapshot) {
  return digestText(canonicalMigrationText(snapshot));
}

function validateSnapshot(snapshot, role) {
  if (!snapshot || !Array.isArray(snapshot.entries) || !snapshot.config || typeof snapshot.config !== "object") {
    throw migrationError(ERROR_CODE.REMOTE_API_INCOMPATIBLE, `${role} storage returned an invalid snapshot.`);
  }
  if (snapshot.quarantined?.length || snapshot.duplicates?.length) {
    throw migrationError(
      role === "source" ? ERROR_CODE.MIGRATION_SOURCE_UNSAFE : ERROR_CODE.MIGRATION_TARGET_CONFLICT,
      role === "source"
        ? "The source has quarantined or duplicate records that must be resolved before migration."
        : "The target has invalid or duplicate records and cannot be used for migration."
    );
  }
}

function mapEntries(snapshot) {
  return new Map(snapshot.entries.map((entry) => [entry.id, entry]));
}

function sameEntry(left, right) {
  return entryFingerprint(left) === entryFingerprint(right);
}

function mapConfig(snapshot) {
  return new Map(canonicalConfig(snapshot.config).map(([key, value, updatedAt]) => [key, { value, updated_at: updatedAt }]));
}

/** Return a non-mutating, provider-neutral dataset preview for Options. */
export function migrationPreview(source, target) {
  const sourceEntries = mapEntries(source);
  const targetEntries = mapEntries(target);
  const sourceConfig = mapConfig(source);
  const targetConfig = mapConfig(target);
  let sourceOnlyEntryCount = 0;
  let targetOnlyEntryCount = 0;
  let changedEntryCount = 0;
  for (const [id, entry] of sourceEntries) {
    if (!targetEntries.has(id)) sourceOnlyEntryCount += 1;
    else if (!sameEntry(entry, targetEntries.get(id))) changedEntryCount += 1;
  }
  for (const id of targetEntries.keys()) {
    if (!sourceEntries.has(id)) targetOnlyEntryCount += 1;
  }
  let configDisagreementCount = 0;
  for (const [key, value] of sourceConfig) {
    const targetValue = targetConfig.get(key);
    if (!targetValue || targetValue.value !== value.value || targetValue.updated_at !== value.updated_at) {
      configDisagreementCount += 1;
    }
  }
  for (const key of targetConfig.keys()) {
    if (!sourceConfig.has(key)) configDisagreementCount += 1;
  }
  return {
    sourceEntryCount: sourceEntries.size,
    targetEntryCount: targetEntries.size,
    sourceConfigCount: sourceConfig.size,
    targetConfigCount: targetConfig.size,
    sourceOnlyEntryCount,
    targetOnlyEntryCount,
    changedEntryCount,
    configDisagreementCount,
    disagreementCount: sourceOnlyEntryCount + targetOnlyEntryCount + changedEntryCount + configDisagreementCount
  };
}

function compareTarget(source, target, state = {}) {
  const ownedEntries = state.owned_entries || {};
  const sourceEntries = mapEntries(source);
  const targetEntries = mapEntries(target);
  for (const [id, entry] of targetEntries) {
    const targetFingerprint = entryFingerprint(entry);
    if (!sourceEntries.has(id) || (!sameEntry(sourceEntries.get(id), entry)
      && ownedEntries[id]?.target_fingerprint !== targetFingerprint
      && ownedEntries[id]?.fingerprint !== targetFingerprint)) {
      throw migrationError(ERROR_CODE.MIGRATION_TARGET_CONFLICT, `The migration target contains unrelated entry data (${id}).`);
    }
  }

  const sourceConfig = mapConfig(source);
  const targetConfig = mapConfig(target);
  for (const [key, value] of targetConfig) {
    const expected = sourceConfig.get(key);
    const owned = state.owned_config?.[key];
    const ownedAllows = owned && (
      (owned.target_value === value.value && owned.target_updated_at === value.updated_at)
      || (owned.value === value.value && owned.updated_at === value.updated_at)
    );
    if ((!expected || expected.value !== value.value || expected.updated_at !== value.updated_at)
      && !ownedAllows) {
      throw migrationError(ERROR_CODE.MIGRATION_TARGET_CONFLICT, `The migration target contains unrelated configuration (${key}).`);
    }
  }
  return { sourceEntries, targetEntries, sourceConfig, targetConfig };
}

export function assertLocalCompatibleWithRemote(local, remote, providerLabel = "the target backend") {
  const localEntries = mapEntries(local);
  const remoteEntries = mapEntries(remote);
  for (const [id, entry] of localEntries) {
    if (!remoteEntries.has(id) || !sameEntry(entry, remoteEntries.get(id))) {
      throw migrationError(ERROR_CODE.MIGRATION_TARGET_CONFLICT, `${providerLabel} does not contain the same local entry (${id}).`);
    }
  }

  const localConfig = mapConfig(local);
  const remoteConfig = mapConfig(remote);
  for (const [key, value] of localConfig) {
    const remoteValue = remoteConfig.get(key);
    if (!remoteValue || remoteValue.value !== value.value || remoteValue.updated_at !== value.updated_at) {
      throw migrationError(ERROR_CODE.MIGRATION_TARGET_CONFLICT, `${providerLabel} does not contain the same local configuration (${key}).`);
    }
  }
}

function progressState(state, patch) {
  return {
    ...state,
    ...patch,
    updated_at: new Date().toISOString()
  };
}

async function saveState(state) {
  await mutateSettings([SETTING_KEY.STORAGE_MIGRATION_STATE], (settings) => {
    const current = settings.get(SETTING_KEY.STORAGE_MIGRATION_STATE);
    if (isActiveState(current) && current.migration_id !== state.migration_id) {
      throw migrationError(ERROR_CODE.MIGRATION_IN_PROGRESS, "Another migration owns the shared migration state.");
    }
    settings.set(SETTING_KEY.STORAGE_MIGRATION_STATE, state);
  });
  return state;
}

async function readState() {
  const state = await getSetting(SETTING_KEY.STORAGE_MIGRATION_STATE, null);
  if (!state) return null;
  if (!MIGRATION_PHASES.has(state.phase) || typeof state.migration_id !== "string") {
    throw migrationError(ERROR_CODE.MIGRATION_SOURCE_UNSAFE, "The saved migration state is invalid.");
  }
  return state;
}

function activeSourceId(provider) {
  return provider.id;
}

async function prepareTarget(provider, lease, options) {
  if (provider.testConnection) {
    await provider.testConnection({ ...options, requestPermission: true });
  }
  const provisioned = await provider.ensureReady({
    ...options,
    lease,
    reseed: async (spreadsheetId) => {
      // Google provisioning can leave a pending binding while it is being
      // initialized. The target is not active yet, so a direct ready binding
      // is safe once provisioning has returned its verified spreadsheet ID.
      if (spreadsheetId) {
        await setSetting(SETTING_KEY.SPREADSHEET_ID, { state: "ready", spreadsheetId: String(spreadsheetId) });
      }
    }
  });
  if (provisioned?.spreadsheetId) {
    await setSetting(SETTING_KEY.SPREADSHEET_ID, { state: "ready", spreadsheetId: String(provisioned.spreadsheetId) });
  }
}

async function seedTarget(source, target, targetSnapshot, state, { lease, options }) {
  const comparison = compareTarget(source, targetSnapshot, state);
  const ownedEntries = state.owned_entries || {};
  const missingEntries = source.entries.filter((entry) => !comparison.targetEntries.has(entry.id));
  const ownedChangedEntries = source.entries.filter((entry) => comparison.targetEntries.has(entry.id)
    && !sameEntry(entry, comparison.targetEntries.get(entry.id))
    && ownedEntries[entry.id]?.fingerprint === entryFingerprint(comparison.targetEntries.get(entry.id)));
  const missingConfig = [...comparison.sourceConfig]
    .filter(([key]) => !comparison.targetConfig.has(key));
  const ownedChangedConfig = [...comparison.sourceConfig]
    .filter(([key, value]) => {
      const targetValue = comparison.targetConfig.get(key);
      const owned = state.owned_config?.[key];
      return targetValue
        && (targetValue.value !== value.value || targetValue.updated_at !== value.updated_at)
        && owned?.target_value === targetValue.value
        && owned?.target_updated_at === targetValue.updated_at;
    });
  const configWrites = [...missingConfig, ...ownedChangedConfig];

  await saveState(progressState(state, {
    phase: "seeding",
    total_entries: source.entries.length,
    total_config: comparison.sourceConfig.size,
    completed_entries: source.entries.length - missingEntries.length - ownedChangedEntries.length,
    completed_config: comparison.sourceConfig.size - configWrites.length
  }));

  for (let offset = 0; offset < missingEntries.length; offset += MIGRATION_BATCH_SIZE) {
    await lease.assert();
    const chunk = missingEntries.slice(offset, offset + MIGRATION_BATCH_SIZE);
    const acknowledgements = await target.appendEntries(chunk, options);
    chunk.forEach((entry, index) => { state.owned_entries = state.owned_entries || {}; state.owned_entries[entry.id] = { fingerprint: entryFingerprint(entry), ref: acknowledgements[index]?.ref || null }; });
    await saveState(progressState(state, {
      phase: "seeding",
      completed_entries: source.entries.length - missingEntries.length - ownedChangedEntries.length + Math.min(offset + MIGRATION_BATCH_SIZE, missingEntries.length)
    }));
  }

  for (const entry of ownedChangedEntries) {
    await lease.assert();
    const targetEntry = comparison.targetEntries.get(entry.id);
    state.owned_entries[entry.id] = {
      fingerprint: entryFingerprint(entry),
      target_fingerprint: entryFingerprint(targetEntry),
      ref: targetSnapshot.entryRefs?.get(entry.id) || null
    };
    await saveState(progressState(state, { phase: "seeding" }));
    await target.updateEntries([{ entry, expectedRef: targetSnapshot.entryRefs?.get(entry.id) }], options);
    state.owned_entries[entry.id] = { fingerprint: entryFingerprint(entry), ref: targetSnapshot.entryRefs?.get(entry.id) || null };
    await saveState(progressState(state, { phase: "seeding" }));
  }

  for (const [configIndex, [key, value]] of configWrites.entries()) {
    await lease.assert();
    state.owned_config = state.owned_config || {};
    state.owned_config[key] = {
      value: value.value,
      updated_at: value.updated_at,
      target_value: comparison.targetConfig.get(key)?.value,
      target_updated_at: comparison.targetConfig.get(key)?.updated_at
    };
    await saveState(progressState(state, { phase: "seeding" }));
    await target.updateConfig(key, value.value, value.updated_at, { ...options, expectedRef: targetSnapshot.configRefs?.get(key) });
    state.owned_config[key] = { value: value.value, updated_at: value.updated_at };
    await saveState(progressState(state, {
      phase: "seeding",
      completed_config: comparison.sourceConfig.size - configWrites.length + configIndex + 1
    }));
  }

  await lease.assert();
  await target.ensureAppMarker?.(targetSnapshot.config, targetSnapshot.configRefs, options);
}

function lockOwner(id) {
  return `storage-migration:${id}`;
}

async function withMigrationLease(id, callback) {
  const lock = await claimLock(SYNC_LOCK_KEY, lockOwner(id), MIGRATION_LOCK_TTL_MS);
  if (!lock) throw migrationError(ERROR_CODE.MIGRATION_IN_PROGRESS, "Another sync or migration is active.");
  let lost = false;
  const timer = setInterval(() => {
    renewLock(lock).then((renewed) => { if (!renewed) lost = true; }).catch(() => { lost = true; });
  }, Math.floor(MIGRATION_LOCK_TTL_MS / 3));
  const lease = {
    async assert() {
      if (lost || !await isLockCurrent(lock)) throw migrationError(ERROR_CODE.MIGRATION_IN_PROGRESS, "The migration lease was lost.");
    }
  };
  try {
    return await callback(lease);
  } finally {
    clearInterval(timer);
    await releaseLock(lock);
  }
}

async function switchBackend(targetId, state) {
  const committedState = progressState(state, { phase: "post_switch" });
  await mutateSettings([
    SETTING_KEY.REMOTE_BACKEND,
    SETTING_KEY.REMOTE_BACKEND_ESTABLISHED,
    SETTING_KEY.REMOTE_CHANGE_TOKEN,
    SETTING_KEY.MYSQL_REMOTE_CHANGE_TOKEN,
    SETTING_KEY.CLOUDFLARE_D1_REMOTE_CHANGE_TOKEN,
    SETTING_KEY.REMOTE_MODIFIED_TIME,
    SETTING_KEY.SYNC_BACKOFF_SECONDS,
    SETTING_KEY.SYNC_BACKOFF_UNTIL,
    SETTING_KEY.RECONCILIATION_INTENTS,
    SETTING_KEY.STORAGE_MIGRATION_STATE
  ], (settings) => {
    settings.set(SETTING_KEY.REMOTE_BACKEND, targetId);
    settings.set(SETTING_KEY.REMOTE_BACKEND_ESTABLISHED, true);
    settings.set(SETTING_KEY.REMOTE_CHANGE_TOKEN, "");
    settings.set(SETTING_KEY.MYSQL_REMOTE_CHANGE_TOKEN, "");
    settings.set(SETTING_KEY.CLOUDFLARE_D1_REMOTE_CHANGE_TOKEN, "");
    settings.set(SETTING_KEY.REMOTE_MODIFIED_TIME, "");
    settings.set(SETTING_KEY.SYNC_BACKOFF_SECONDS, 0);
    settings.set(SETTING_KEY.SYNC_BACKOFF_UNTIL, 0);
    settings.set(SETTING_KEY.RECONCILIATION_INTENTS, []);
    settings.set(SETTING_KEY.STORAGE_MIGRATION_STATE, committedState);
  });
  return committedState;
}

async function finishMigration(state) {
  return saveState(progressState(state, { phase: "complete", completed_at: new Date().toISOString() }));
}

async function failMigration(state, error) {
  if (!state) return;
  await saveState(progressState(state, { phase: "failed", error_code: String(error?.code || "MIGRATION_FAILED") }));
}

async function preservePostSwitchFailure(state, error) {
  const durable = await readState().catch(() => null);
  if (!durable || durable.phase !== "post_switch" || durable.migration_id !== state?.migration_id) return false;
  await saveState(progressState(durable, { error_code: String(error?.code || "MIGRATION_POST_SWITCH_FAILED") }));
  return true;
}

async function localMigrationSnapshot() {
  const entries = await getAllEntries();
  const config = {};
  const updatedAt = String(await getSetting(SETTING_KEY.DURATION_MULTIPLIER_UPDATED_AT, "") || "");
  if (updatedAt) {
    config.duration_multiplier = {
      value: String(await getSetting(SETTING_KEY.DURATION_MULTIPLIER, "1") || "1"),
      updated_at: updatedAt
    };
  }
  return { entries, config, duplicates: [], quarantined: [] };
}

/**
 * Starts a selected backend from this profile's local-first data without
 * contacting another remote provider.
 * This is deliberately separate from migrateStorage: the normal migration
 * must read the current remote backend, while a new profile may have no Google
 * account and still need a way to choose MySQL as its first backend.
 */
export async function activateProviderFromLocal(targetProviderId, { onProgress } = {}) {
  const active = await getActiveRemoteProvider();
  const targetId = cleanProviderId(targetProviderId);
  if (active.id === targetId) {
    throw migrationError(ERROR_CODE.MIGRATION_SOURCE_UNSAFE, "That storage backend is already active.");
  }

  let state = {
    migration_id: migrationId(),
    source_provider: "local",
    target_provider: targetId,
    phase: "preparing",
    attempt: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await saveState(state);
  onProgress?.(state);

  try {
    const targetProvider = getRemoteProvider(targetId);

    await withMigrationLease(state.migration_id, async (lease) => {
      const options = { lease };
      const sourceSnapshot = await localMigrationSnapshot();
      validateSnapshot(sourceSnapshot, "local");
      const sourceDigest = await migrationDigest(sourceSnapshot);
      await prepareTarget(targetProvider, lease, options);
      await lease.assert();
      let targetSnapshot = await targetProvider.readSnapshot(options);
      validateSnapshot(targetSnapshot, "target");
      state = progressState(state, {
        phase: "seeding",
        source_digest: sourceDigest,
        total_entries: sourceSnapshot.entries.length,
        total_config: canonicalConfig(sourceSnapshot.config).length,
        preview: migrationPreview(sourceSnapshot, targetSnapshot)
      });
      await saveState(state);
      onProgress?.(state);

      await seedTarget(sourceSnapshot, targetProvider, targetSnapshot, state, { lease, options });
      state = progressState(state, { phase: "verifying" });
      await saveState(state);
      onProgress?.(state);
      targetSnapshot = await targetProvider.readSnapshot(options);
      validateSnapshot(targetSnapshot, "target");
      if (await migrationDigest(targetSnapshot) !== sourceDigest) {
        throw migrationError(ERROR_CODE.MIGRATION_TARGET_CONFLICT, `The ${targetProvider.label} data does not match this device's local data.`);
      }
      if (await migrationDigest(await localMigrationSnapshot()) !== sourceDigest) {
        throw migrationError(ERROR_CODE.MIGRATION_SOURCE_CHANGED, `Local data changed during ${targetProvider.label} setup.`);
      }
      state = await switchBackend(targetId, state);
    });

    await syncNow({ force: true, interactiveAuth: false, migrationId: state.migration_id });
    return finishMigration(state);
  } catch (error) {
    if (!await preservePostSwitchFailure(state, error)) await failMigration(state, error);
    throw error;
  }
}

/**
 * Makes an existing remote dataset the active backend without contacting
 * Google. Local entries are checked first so an existing local edit cannot be
 * silently discarded; target-only entries are then imported by the normal sync
 * pull after the backend switch.
 */
export async function activateProviderFromRemote(targetProviderId, { onProgress } = {}) {
  const active = await getActiveRemoteProvider();
  const targetId = cleanProviderId(targetProviderId);
  if (active.id === targetId) {
    throw migrationError(ERROR_CODE.MIGRATION_SOURCE_UNSAFE, "That storage backend is already active.");
  }

  let state = {
    migration_id: migrationId(),
    source_provider: active.id,
    target_provider: targetId,
    phase: "preparing",
    attempt: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await saveState(state);
  onProgress?.(state);

  try {
    const targetProvider = getRemoteProvider(targetId);
    await withMigrationLease(state.migration_id, async (lease) => {
      const options = { lease };
      await prepareTarget(targetProvider, lease, options);
      await lease.assert();
      const targetSnapshot = await targetProvider.readSnapshot(options);
      validateSnapshot(targetSnapshot, "target");
      const localSnapshot = await localMigrationSnapshot();
      validateSnapshot(localSnapshot, "local");
      assertLocalCompatibleWithRemote(localSnapshot, targetSnapshot, targetProvider.label);
      state = progressState(state, {
        phase: "verifying",
        source_digest: await migrationDigest(targetSnapshot),
        total_entries: targetSnapshot.entries.length,
        total_config: canonicalConfig(targetSnapshot.config).length,
        completed_entries: targetSnapshot.entries.length,
        preview: migrationPreview(localSnapshot, targetSnapshot)
      });
      await saveState(state);
      onProgress?.(state);
      state = await switchBackend(targetId, state);
    });

    await syncNow({ force: true, interactiveAuth: false, migrationId: state.migration_id });
    return finishMigration(state);
  } catch (error) {
    if (!await preservePostSwitchFailure(state, error)) await failMigration(state, error);
    throw error;
  }
}

export async function getStorageMigrationState() {
  return readState();
}

export async function migrateStorage(targetProviderId, { interactiveAuth = true, onProgress } = {}) {
  const targetId = cleanProviderId(targetProviderId);
  let state = await readState();
  if (state?.phase === "post_switch") {
    try {
      await syncNow({ force: true, interactiveAuth, migrationId: state.migration_id });
    } catch (error) {
      await preservePostSwitchFailure(state, error);
      throw error;
    }
    return finishMigration(state);
  }
  if (isActiveState(state)) {
    if (state.target_provider !== targetId) throw migrationError(ERROR_CODE.MIGRATION_IN_PROGRESS, "Another migration is active.");
  } else {
    const source = await getActiveRemoteProvider();
    if (source.id === targetId) throw migrationError(ERROR_CODE.MIGRATION_SOURCE_UNSAFE, "Choose a different storage backend.");
    state = {
      migration_id: migrationId(),
      source_provider: activeSourceId(source),
      target_provider: targetId,
      phase: "preparing",
      attempt: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await saveState(state);
  }

  const sourceProvider = getRemoteProvider(state.source_provider);
  const targetProvider = getRemoteProvider(state.target_provider);
  for (let attempt = Number(state.attempt || 0) + 1; attempt <= MAX_STABILIZATION_ATTEMPTS; attempt += 1) {
    state = progressState(state, { phase: "preparing", attempt, error_code: "" });
    await saveState(state);
    onProgress?.(state);
    try {
      await syncNow({ force: true, interactiveAuth, migrationId: state.migration_id });
      const sourceSnapshot = await sourceProvider.readSnapshot({ interactiveAuth });
      validateSnapshot(sourceSnapshot, "source");
      const intents = await getSetting(SETTING_KEY.RECONCILIATION_INTENTS, []);
      if (Array.isArray(intents) && intents.length) {
        throw migrationError(ERROR_CODE.MIGRATION_SOURCE_UNSAFE, "Resolve reconciliation choices before migrating.");
      }
      const sourceDigest = await migrationDigest(sourceSnapshot);
      state = progressState(state, {
        phase: "seeding",
        source_digest: sourceDigest,
        total_entries: sourceSnapshot.entries.length,
        total_config: canonicalConfig(sourceSnapshot.config).length
      });
      await saveState(state);

      const result = await withMigrationLease(state.migration_id, async (lease) => {
        const options = { interactiveAuth, lease };
        await prepareTarget(targetProvider, lease, options);
        await lease.assert();
        let targetSnapshot = await targetProvider.readSnapshot(options);
        validateSnapshot(targetSnapshot, "target");
        state = progressState(state, { preview: migrationPreview(sourceSnapshot, targetSnapshot) });
        await saveState(state);
        onProgress?.(state);
        await seedTarget(sourceSnapshot, targetProvider, targetSnapshot, state, { lease, options });
        state = progressState(state, { phase: "verifying" });
        await saveState(state);
        targetSnapshot = await targetProvider.readSnapshot(options);
        validateSnapshot(targetSnapshot, "target");
        const targetDigest = await migrationDigest(targetSnapshot);
        if (targetDigest !== sourceDigest) {
          throw migrationError(ERROR_CODE.MIGRATION_TARGET_CONFLICT, "The target digest does not match the source.");
        }
        const localEntries = await getAllEntries();
        if (localEntries.some((entry) => entry.dirty)) {
          throw migrationError(ERROR_CODE.MIGRATION_SOURCE_CHANGED, "A local entry changed during migration.");
        }
        const finalSourceSnapshot = await sourceProvider.readSnapshot({ interactiveAuth });
        validateSnapshot(finalSourceSnapshot, "source");
        if (await migrationDigest(finalSourceSnapshot) !== sourceDigest) {
          throw migrationError(ERROR_CODE.MIGRATION_SOURCE_CHANGED, "The source changed during migration.");
        }
        state = await switchBackend(state.target_provider, state);
        return true;
      });
      if (result) {
        const postSwitch = await readState();
        await syncNow({ force: true, interactiveAuth, migrationId: state.migration_id });
        return finishMigration(postSwitch || state);
      }
    } catch (error) {
      if (await preservePostSwitchFailure(state, error)) {
        // The backend switch is durable. Preserve that recovery phase even if
        // the first post-switch sync failed; retry must finalize, never pretend
        // the active dataset was rolled back.
        throw error;
      }
      state = progressState(state, { attempt, error_code: String(error?.code || "MIGRATION_FAILED") });
      if (error?.code === ERROR_CODE.MIGRATION_SOURCE_CHANGED && attempt < MAX_STABILIZATION_ATTEMPTS) {
        state = progressState(state, { phase: "source_changed" });
        await saveState(state);
        continue;
      }
      await failMigration(state, error);
      throw error;
    }
  }
  const error = migrationError(ERROR_CODE.MIGRATION_SOURCE_CHANGED, "The source kept changing during migration.");
  await failMigration(state, error);
  throw error;
}

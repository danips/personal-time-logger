/** Shared Options policy for API-backed remote providers. */
export function createProviderSetupController({ claimLock, releaseLock, getSetting, mutateSettings, platform, keys, owner, activateFromLocal, activateFromRemote, permissionTimeoutMs = 10_000 }) {
  async function save(descriptor, rawBaseUrl, rawToken, { allowActiveChange = false } = {}) {
    const baseUrl = descriptor.normalizeBaseUrl(rawBaseUrl);
    const token = String(rawToken || "").trim();
    if (!token) throw descriptor.error(descriptor.missingCode, `Enter the ${descriptor.label} API token.`);
    const lock = await claimLock("sync_lock", owner(), 30_000);
    if (!lock) throw descriptor.error(keys.CONFIG_SAVE_FAILED, `A sync or migration is active. Wait before changing the ${descriptor.label} destination.`);
    try {
      const active = await getSetting(keys.REMOTE_BACKEND, "");
      const established = await getSetting(keys.REMOTE_BACKEND_ESTABLISHED, false);
      const currentUrl = await getSetting(descriptor.urlKey, descriptor.defaultUrl);
      if (!allowActiveChange && established && active === descriptor.id && currentUrl && currentUrl !== baseUrl) {
        throw descriptor.error(keys.CONFIG_SAVE_FAILED, `The active ${descriptor.label} destination cannot change from ordinary Save. Test the new destination, then use migration or activation.`);
      }
      await mutateSettings([descriptor.urlKey, descriptor.tokenKey], (settings) => {
        settings.set(descriptor.urlKey, baseUrl);
        settings.set(descriptor.tokenKey, token);
      });
    } finally {
      await releaseLock(lock);
    }
    return { baseUrl, token };
  }

  async function test(descriptor, rawBaseUrl, rawToken, { setConnectionStatus }) {
    const baseUrl = descriptor.normalizeBaseUrl(rawBaseUrl);
    const token = String(rawToken || "").trim();
    if (!token) throw descriptor.error(descriptor.missingCode, `Enter the ${descriptor.label} API token.`);
    setConnectionStatus(`Requesting the exact ${descriptor.permissionLabel} host permission...`);
    let granted;
    let timeoutId;
    try {
      granted = await Promise.race([
        platform.requestOptionalHostPermission(descriptor.hostPermission(baseUrl)),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(descriptor.error(keys.REMOTE_PERMISSION, "Firefox did not answer the host permission request.")), permissionTimeoutMs);
        })
      ]);
    } catch (error) {
      if (error?.code) throw error;
      throw descriptor.error(keys.REMOTE_PERMISSION, `Firefox could not grant the ${descriptor.label} host permission.`, error);
    } finally {
      clearTimeout(timeoutId);
    }
    if (!granted) throw descriptor.error(keys.REMOTE_PERMISSION, `Firefox did not grant the ${descriptor.label} host permission.`);
    setConnectionStatus(`Calling the ${descriptor.connectionLabel} health endpoint...`);
    return descriptor.provider.testConnection({ baseUrl, token, requestPermission: false });
  }

  async function activate(descriptor, source, { onProgress, onError } = {}) {
    try {
      return await (source === "remote" ? activateFromRemote : activateFromLocal)(descriptor.id, { onProgress });
    } catch (error) {
      await onError?.(error);
      throw error;
    }
  }

  return Object.freeze({ save, test, activate });
}

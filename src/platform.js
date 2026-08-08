const rawApi = globalThis.browser || globalThis.chrome;
const usesPromiseApi = typeof globalThis.browser !== "undefined" && rawApi === globalThis.browser;

function lastError() {
  return rawApi && rawApi.runtime ? rawApi.runtime.lastError : null;
}

function callbackApi(fn, context, ...args) {
  return new Promise((resolve, reject) => {
    try {
      fn.call(context, ...args, (result) => {
        const error = lastError();
        if (error) {
          reject(new Error(error.message || String(error)));
          return;
        }
        resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function apiCall(fn, context, ...args) {
  if (usesPromiseApi) return fn.call(context, ...args);
  return callbackApi(fn, context, ...args);
}

export const platform = {
  getURL(path) {
    return rawApi.runtime.getURL(path);
  },

  async openOptionsPage() {
    if (!rawApi.runtime.openOptionsPage) return;
    if (usesPromiseApi) return rawApi.runtime.openOptionsPage();
    return callbackApi(rawApi.runtime.openOptionsPage, rawApi.runtime);
  },

  async openExtensionPage(path) {
    const url = rawApi.runtime.getURL(path);
    if (rawApi.tabs && rawApi.tabs.create) {
      try {
        return await apiCall(rawApi.tabs.create, rawApi.tabs, { url });
      } catch (error) {
        window.open(url, "_blank");
        return;
      }
    }
    window.open(url, "_blank");
  },

  async hasOptionalHostPermission(origin) {
    if (!rawApi.permissions || !rawApi.permissions.contains) return false;
    return apiCall(rawApi.permissions.contains, rawApi.permissions, { origins: [origin] });
  },

  async requestOptionalHostPermission(origin) {
    if (!rawApi.permissions || !rawApi.permissions.request) return false;
    return apiCall(rawApi.permissions.request, rawApi.permissions, { origins: [origin] });
  },

  contextualIdentitiesAvailable() {
    return Boolean(rawApi.contextualIdentities);
  },

  async queryContextualIdentities() {
    if (!rawApi.contextualIdentities || !rawApi.contextualIdentities.query) return [];
    return apiCall(rawApi.contextualIdentities.query, rawApi.contextualIdentities);
  },

  async createContextualIdentity(name, color = "blue", icon = "fingerprint") {
    if (!rawApi.contextualIdentities || !rawApi.contextualIdentities.create) {
      throw new Error("Firefox contextual identities are unavailable");
    }
    return apiCall(rawApi.contextualIdentities.create, rawApi.contextualIdentities, { name, color, icon });
  },

  async getContextualIdentity(cookieStoreId) {
    if (!rawApi.contextualIdentities || !rawApi.contextualIdentities.get) return null;
    try {
      return await apiCall(rawApi.contextualIdentities.get, rawApi.contextualIdentities, cookieStoreId);
    } catch (error) {
      if (/not found|does not exist/i.test(error.message || "")) return null;
      throw error;
    }
  },

  async createTab(details) {
    if (!rawApi.tabs || !rawApi.tabs.create) throw new Error("Browser tabs API is unavailable");
    return apiCall(rawApi.tabs.create, rawApi.tabs, details);
  },

  async getTab(tabId) {
    if (!rawApi.tabs || !rawApi.tabs.get) return null;
    try {
      return await apiCall(rawApi.tabs.get, rawApi.tabs, tabId);
    } catch (error) {
      if (/tab.*not found|no tab/i.test(error.message || "")) return null;
      throw error;
    }
  },

  async queryChatGptTabs(cookieStoreId) {
    if (!rawApi.tabs || !rawApi.tabs.query) return [];
    return apiCall(rawApi.tabs.query, rawApi.tabs, {
      url: "https://chatgpt.com/*",
      cookieStoreId
    });
  },

  async waitForTabComplete(tabId, timeoutMs = 20_000) {
    const current = await this.getTab(tabId);
    if (!current) throw new Error("ChatGPT tab is no longer available");
    if (current.status === "complete") return current;
    if (!rawApi.tabs || !rawApi.tabs.onUpdated) {
      throw new Error("Browser tab update events are unavailable");
    }

    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        rawApi.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
      };
      const onUpdated = async (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
        const tab = await this.getTab(tabId);
        if (!tab) {
          cleanup();
          reject(new Error("ChatGPT tab is no longer available"));
          return;
        }
        cleanup();
        resolve(tab);
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for the ChatGPT tab to load"));
      }, timeoutMs);
      rawApi.tabs.onUpdated.addListener(onUpdated);
    });
  },

  async sendTabMessage(tabId, message) {
    if (!rawApi.tabs || !rawApi.tabs.sendMessage) throw new Error("Browser messaging API is unavailable");
    return apiCall(rawApi.tabs.sendMessage, rawApi.tabs, tabId, message);
  },

  async removeTab(tabId) {
    if (!rawApi.tabs || !rawApi.tabs.remove) return;
    return apiCall(rawApi.tabs.remove, rawApi.tabs, tabId);
  },

  isOnline() {
    return navigator.onLine !== false;
  },

  async setIcon(details) {
    if (!rawApi.action || !rawApi.action.setIcon) return;
    return apiCall(rawApi.action.setIcon, rawApi.action, details);
  },

  async getSyncedStorage(keys) {
    if (!rawApi.storage || !rawApi.storage.sync) return {};
    return apiCall(rawApi.storage.sync.get, rawApi.storage.sync, keys);
  },

  async setSyncedStorage(values) {
    if (!rawApi.storage || !rawApi.storage.sync) {
      throw new Error("Synchronized extension storage is unavailable");
    }
    return apiCall(rawApi.storage.sync.set, rawApi.storage.sync, values);
  },

  scheduleAlarm(name, periodInMinutes) {
    if (!rawApi.alarms || !rawApi.alarms.create) return false;
    rawApi.alarms.create(name, { periodInMinutes, delayInMinutes: periodInMinutes });
    return true;
  },

  onAlarm(listener) {
    if (!rawApi.alarms || !rawApi.alarms.onAlarm) return;
    rawApi.alarms.onAlarm.addListener(listener);
  },

  onInstalled(listener) {
    if (!rawApi.runtime || !rawApi.runtime.onInstalled) return;
    rawApi.runtime.onInstalled.addListener(listener);
  }
};

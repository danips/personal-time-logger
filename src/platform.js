const rawApi = globalThis.browser || globalThis.chrome;
const usesPromiseApi = typeof globalThis.browser !== "undefined" && rawApi === globalThis.browser;

function lastError() {
  return rawApi && rawApi.runtime ? rawApi.runtime.lastError : null;
}

function callbackOrPromiseApi(fn, context, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback) => (value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    try {
      const result = fn.call(context, ...args, (callbackResult) => {
        const error = lastError();
        if (error) {
          settle(reject)(new Error(error.message || String(error)));
          return;
        }
        settle(resolve)(callbackResult);
      });
      if (result && typeof result.then === "function") result.then(settle(resolve), settle(reject));
    } catch (error) {
      settle(reject)(error);
    }
  });
}

function apiCall(fn, context, ...args) {
  if (usesPromiseApi) return fn.call(context, ...args);
  return callbackOrPromiseApi(fn, context, ...args);
}

async function getTab(tabId) {
  if (!rawApi.tabs || !rawApi.tabs.get) return null;
  try {
    return await apiCall(rawApi.tabs.get, rawApi.tabs, tabId);
  } catch (error) {
    if (/tab.*not found|no tab/i.test(error.message || "")) return null;
    throw error;
  }
}

async function openOrFocusExtensionPage(path) {
  const url = rawApi.runtime.getURL(path);
  if (!rawApi.tabs || !rawApi.tabs.create) {
    throw new Error("Browser tabs API is unavailable");
  }

  try {
    if (rawApi.tabs.query && rawApi.tabs.update) {
      const existing = await apiCall(rawApi.tabs.query, rawApi.tabs, { url });
      const tab = Array.isArray(existing)
        ? existing.find((candidate) => Number.isInteger(candidate?.id))
        : null;
      if (tab) {
        if (rawApi.windows?.update && Number.isInteger(tab.windowId)) {
          await apiCall(rawApi.windows.update, rawApi.windows, tab.windowId, { focused: true });
        }
        return apiCall(rawApi.tabs.update, rawApi.tabs, tab.id, { active: true });
      }
    }
    return await apiCall(rawApi.tabs.create, rawApi.tabs, { url });
  } catch (error) {
    throw new Error(`Could not open extension page: ${error.message || error}`, { cause: error });
  }
}

export const platform = {
  getURL(path) {
    return rawApi.runtime.getURL(path);
  },

  async openOptionsPage() {
    if (rawApi.tabs?.create) return openOrFocusExtensionPage("options/options.html");
    if (!rawApi.runtime.openOptionsPage) return;
    if (usesPromiseApi) return rawApi.runtime.openOptionsPage();
    return callbackOrPromiseApi(rawApi.runtime.openOptionsPage, rawApi.runtime);
  },

  async openExtensionPage(path) {
    return openOrFocusExtensionPage(path);
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

  async removeContextualIdentity(cookieStoreId) {
    if (!rawApi.contextualIdentities || !rawApi.contextualIdentities.remove) return false;
    await apiCall(rawApi.contextualIdentities.remove, rawApi.contextualIdentities, cookieStoreId);
    return true;
  },

  async createTab(details) {
    if (!rawApi.tabs || !rawApi.tabs.create) throw new Error("Browser tabs API is unavailable");
    return apiCall(rawApi.tabs.create, rawApi.tabs, details);
  },

  async getTab(tabId) {
    return getTab(tabId);
  },

  async getCurrentTab(windowId) {
    if (!rawApi.tabs || !rawApi.tabs.query) return null;
    const tabs = await apiCall(rawApi.tabs.query, rawApi.tabs, {
      active: true,
      windowId
    });
    if (!tabs.length) return null;
    return getTab(tabs[0].id);
  },

  async getCurrentWindow() {
    if (!rawApi.windows || !rawApi.windows.getCurrent) return null;
    return apiCall(rawApi.windows.getCurrent, rawApi.windows);
  },

  async resizeWindow(windowId, width, height) {
    if (!rawApi.windows || !rawApi.windows.update) {
      throw new Error("Browser windows API is unavailable");
    }
    if (rawApi.windows.get) {
      const current = await apiCall(rawApi.windows.get, rawApi.windows, windowId);
      if (current?.state && current.state !== "normal") {
        // Browser APIs ignore width/height while a window is maximized or
        // fullscreen, so restore it before setting its outer dimensions.
        await apiCall(rawApi.windows.update, rawApi.windows, windowId, { state: "normal" });
      }
    }
    return apiCall(rawApi.windows.update, rawApi.windows, windowId, { width, height });
  },

  async queryChatGptTabs(cookieStoreId) {
    if (!rawApi.tabs || !rawApi.tabs.query) return [];
    return apiCall(rawApi.tabs.query, rawApi.tabs, {
      url: "https://chatgpt.com/*",
      cookieStoreId
    });
  },

  async waitForTabComplete(tabId, timeoutMs = 20_000) {
    if (!rawApi.tabs || !rawApi.tabs.onUpdated) {
      throw new Error("Browser tab update events are unavailable");
    }

    return new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      const cleanup = () => {
        rawApi.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
      };
      const settle = (callback) => (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onUpdated = async (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
        try {
          const tab = await getTab(tabId);
          if (!tab) throw new Error("ChatGPT tab is no longer available");
          settle(resolve)(tab);
        } catch (error) {
          settle(reject)(error);
        }
      };
      timer = setTimeout(() => {
        settle(reject)(new Error("Timed out waiting for the ChatGPT tab to load"));
      }, timeoutMs);
      rawApi.tabs.onUpdated.addListener(onUpdated);
      // Register first, then re-check so completion in the gap cannot strand
      // the wait until timeout.
      getTab(tabId).then((current) => {
        if (!current) throw new Error("ChatGPT tab is no longer available");
        if (current.status === "complete") settle(resolve)(current);
      }).catch(settle(reject));
    });
  },

  async sendTabMessage(tabId, message) {
    if (!rawApi.tabs || !rawApi.tabs.sendMessage) throw new Error("Browser messaging API is unavailable");
    return apiCall(rawApi.tabs.sendMessage, rawApi.tabs, tabId, message);
  },

  async sendRuntimeMessage(message) {
    if (!rawApi.runtime || !rawApi.runtime.sendMessage) {
      throw new Error("Extension messaging API is unavailable");
    }
    return apiCall(rawApi.runtime.sendMessage, rawApi.runtime, message);
  },

  async removeTab(tabId) {
    if (!rawApi.tabs || !rawApi.tabs.remove) return;
    return apiCall(rawApi.tabs.remove, rawApi.tabs, tabId);
  },

  isOnline() {
    return globalThis.navigator?.onLine !== false;
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
  },

  onRuntimeMessage(listener) {
    if (!rawApi.runtime || !rawApi.runtime.onMessage) return;
    rawApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
      let result;
      try {
        result = listener(message, sender);
      } catch (error) {
        sendResponse({ ok: false, error: { code: error?.code || "", message: error?.message || "" } });
        return false;
      }
      if (result === undefined) return false;
      Promise.resolve(result).then(sendResponse, (error) => {
        sendResponse({ ok: false, error: { code: error?.code || "", message: error?.message || "" } });
      });
      return true;
    });
  }
};

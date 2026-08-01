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

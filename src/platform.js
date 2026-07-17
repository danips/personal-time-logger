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
  }
};

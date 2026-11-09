// PrairieRun cross-browser compatibility shim.
//
// Firefox exposes promise-based APIs under `browser.*`, while Chrome/Brave
// expose them under `chrome.*` (MV3 `chrome.*` also returns promises, but
// older callback-style call sites break under Firefox where `chrome.*` is
// callback-oriented). Every PrairieRun script loads this file first and uses
// the `PrairieRunExt` helpers below instead of touching `chrome.*` or
// `browser.*` directly, so existing `await` / `.catch` call sites work in
// both browsers with no behavior change in Chrome.
//
// Load order: compat.js must come before calendar.js and background.js.
//   - Chrome service worker and Firefox 121+ service worker: background.js
//     pulls both in via the guarded importScripts call below.
//   - Any scripts-array background page: the manifest lists them in order and
//     the guard below (typeof importScripts === "function") skips reloading.
//   - Content scripts / popup: manifest / popup.html list compat.js first.
(function () {
  if (globalThis.PrairieRunExt) return;

  // Brave can expose a `browser` namespace too, so namespace presence alone
  // is not enough to identify Firefox. The browser identity determines both
  // the API preference and which Google OAuth client is valid.
  const isFirefox = typeof navigator !== "undefined" && /Firefox/i.test(navigator.userAgent || "");
  const ext = isFirefox ? (globalThis.browser ?? globalThis.chrome) : (globalThis.chrome ?? globalThis.browser);

  // Call an extension API exactly once and always get a promise back.
  // Firefox's `browser.*` namespace returns native promises; Chrome/Brave's
  // MV3 `chrome.*` namespace does the same when no callback is passed.
  // (Firefox's callback-oriented `chrome.*` mirror is never used because
  // Firefox is identified from its user agent and prefers `browser`.) Rejections already carry the real
  // error, so callers can rely on `await` / `.catch` in both browsers.
  function callAsync(api, method, ...args) {
    try {
      const result = api[method](...args);
      if (result && typeof result.then === "function") return result;
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function storageArea(area) {
    const store = ext?.storage?.[area];
    if (!store) throw new Error(`Extension storage area "${area}" is unavailable.`);
    return store;
  }

  async function storageGet(area, keys) {
    return callAsync(storageArea(area), "get", keys);
  }

  async function storageSet(area, items) {
    await callAsync(storageArea(area), "set", items);
  }

  async function storageClear(area) {
    await callAsync(storageArea(area), "clear");
  }

  // Token cache. `storage.session` exists on Firefox 115+ desktop, but its
  // lifetime/semantics differ from Chrome's service-worker session storage
  // and it is unreliable on Android, so fall back to an in-memory cache for
  // the browser session. Tokens must never be persisted to `storage.local`.
  const memorySession = new Map();

  function hasSessionStorage() {
    return Boolean(ext?.storage?.session);
  }

  async function getSessionValue(key) {
    if (hasSessionStorage()) {
      try {
        const cached = await storageGet("session", key);
        if (cached?.[key] !== undefined) return cached[key];
      } catch (_error) {
        // Fall through to the in-memory cache.
      }
    }
    return memorySession.get(key);
  }

  async function setSessionValue(key, value) {
    memorySession.set(key, value);
    if (hasSessionStorage()) {
      try {
        await storageSet("session", { [key]: value });
      } catch (_error) {
        // The in-memory copy above keeps this browser session working.
      }
    }
  }

  async function clearSessionValues() {
    memorySession.clear();
    if (hasSessionStorage()) {
      try {
        await storageClear("session");
      } catch (_error) {
        // Memory is already cleared; nothing else to do.
      }
    }
  }

  const PrairieRunExt = {
    isFirefox,
    storageLocalGet: (keys) => storageGet("local", keys),
    storageLocalSet: (items) => storageSet("local", items),
    storageLocalClear: () => storageClear("local"),
    getSessionValue,
    setSessionValue,
    clearSessionValues,
    tabsCreate: (options) => callAsync(ext.tabs, "create", options),
    tabsRemove: (tabId) => callAsync(ext.tabs, "remove", tabId),
    tabsQuery: (query) => callAsync(ext.tabs, "query", query),
    tabsGet: (tabId) => callAsync(ext.tabs, "get", tabId),
    tabsSendMessage: (tabId, message) => callAsync(ext.tabs, "sendMessage", tabId, message),
    runtimeSendMessage: (message) => callAsync(ext.runtime, "sendMessage", message),
    identityGetRedirectURL: (path) => ext.identity.getRedirectURL(path),
    identityLaunchWebAuthFlow: (details) => callAsync(ext.identity, "launchWebAuthFlow", details),
    addRuntimeMessageListener: (listener) => ext.runtime.onMessage.addListener(listener),
    addStorageChangedListener: (listener) => ext.storage.onChanged.addListener(listener),
    alarmsCreate: (name, info) => ext.alarms ? callAsync(ext.alarms, "create", name, info) : Promise.reject(new Error("Extension alarms API is unavailable.")),
    addAlarmsListener: (listener) => ext.alarms?.onAlarm?.addListener(listener),
    addTabsUpdatedListener: (listener) => ext.tabs.onUpdated.addListener(listener),
    removeTabsUpdatedListener: (listener) => ext.tabs.onUpdated.removeListener(listener),
  };

  globalThis.PrairieRunExt = PrairieRunExt;
})();

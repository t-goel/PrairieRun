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

  async function removeSessionValue(key) {
    memorySession.delete(key);
    if (hasSessionStorage()) {
      try {
        const area = storageArea("session");
        if (typeof area.remove === "function") {
          await callAsync(area, "remove", key);
        }
      } catch (_error) {
        // The in-memory copy is already cleared.
      }
    }
  }

  // Offscreen document management (Chrome only; Firefox parses in the
  // background page). Only one offscreen document can exist, so concurrent
  // callers share a module-level promise.
  let offscreenReady = null;

  function offscreenEnsure() {
    // Firefox has no chrome.offscreen API; parsing runs in place there.
    if (isFirefox) return Promise.resolve(false);
    if (offscreenReady) return offscreenReady;
    const attempt = (async () => {
      const runtime = ext?.runtime;
      if (runtime && typeof runtime.getContexts === "function") {
        try {
          const contexts = await callAsync(runtime, "getContexts", { contextTypes: ["OFFSCREEN_DOCUMENT"] });
          if (Array.isArray(contexts) && contexts.length) return true;
        } catch (_error) {
          // Older Chrome without getContexts: fall through to create.
        }
      }
      const offscreen = ext?.offscreen;
      if (!offscreen || typeof offscreen.createDocument !== "function") {
        throw new Error("Extension offscreen API is unavailable.");
      }
      try {
        await callAsync(offscreen, "createDocument", {
          url: "offscreen.html",
          reasons: ["DOM_PARSER"],
          justification: "Parse fetched course pages locally",
        });
      } catch (error) {
        // A concurrent creator may have won the race; that still satisfies us.
        if (/only one offscreen|already exists/i.test(error?.message || "")) return true;
        throw error;
      }
      return true;
    })();
    offscreenReady = attempt;
    attempt.then(
      () => undefined,
      () => {
        if (offscreenReady === attempt) offscreenReady = null;
      }
    );
    return offscreenReady;
  }

  function permissionsContains(origins) {
    const perms = ext?.permissions;
    // No permissions API (tests): assume granted so background logic still runs.
    if (!perms || typeof perms.contains !== "function") return Promise.resolve(true);
    return callAsync(perms, "contains", { origins: [...origins] }).then(Boolean);
  }

  function permissionsRequest(origins) {
    const perms = ext?.permissions;
    if (!perms || typeof perms.request !== "function") {
      return Promise.reject(new Error("Extension permissions API is unavailable."));
    }
    return callAsync(perms, "request", { origins: [...origins] }).then(Boolean);
  }

  const PrairieRunExt = {
    isFirefox,
    storageLocalGet: (keys) => storageGet("local", keys),
    storageLocalSet: (items) => storageSet("local", items),
    storageLocalClear: () => storageClear("local"),
    getSessionValue,
    setSessionValue,
    clearSessionValues,
    removeSessionValue,
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
    addStartupListener: (listener) => ext?.runtime?.onStartup?.addListener(listener),
    addInstalledListener: (listener) => ext?.runtime?.onInstalled?.addListener(listener),
    offscreenEnsure,
    permissionsContains,
    permissionsRequest,
    tabsCreateForeground: (url) => callAsync(ext.tabs, "create", { url, active: true }),
    alarmsCreate: (name, info) => ext.alarms ? callAsync(ext.alarms, "create", name, info) : Promise.reject(new Error("Extension alarms API is unavailable.")),
    addAlarmsListener: (listener) => ext.alarms?.onAlarm?.addListener(listener),
    addTabsUpdatedListener: (listener) => ext.tabs.onUpdated.addListener(listener),
    removeTabsUpdatedListener: (listener) => ext.tabs.onUpdated.removeListener(listener),
  };

  globalThis.PrairieRunExt = PrairieRunExt;
})();

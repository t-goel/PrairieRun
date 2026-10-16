// PrairieRun source registry: adapters self-register here.
// Plain IIFE script; no bundler.
(function () {
  const adapters = new Map();

  function validateAdapter(adapter) {
    if (!adapter || typeof adapter !== "object") throw new Error("Source adapter must be an object.");
    const required = ["id", "label", "origins", "signInUrl", "parsers", "isSignedOut", "sync"];
    for (const key of required) {
      if (adapter[key] == null) throw new Error(`Source adapter missing required field: ${key}`);
    }
    if (typeof adapter.id !== "string" || !adapter.id) throw new Error("Source adapter id must be a non-empty string.");
    if (typeof adapter.label !== "string" || !adapter.label) throw new Error("Source adapter label must be a non-empty string.");
    if (!Array.isArray(adapter.origins) || !adapter.origins.length) throw new Error("Source adapter origins must be a non-empty array.");
    if (typeof adapter.signInUrl !== "string" || !adapter.signInUrl) throw new Error("Source adapter signInUrl must be a non-empty string.");
    if (typeof adapter.parsers !== "object") throw new Error("Source adapter parsers must be an object.");
    if (typeof adapter.isSignedOut !== "function") throw new Error("Source adapter isSignedOut must be a function.");
    if (typeof adapter.sync !== "function") throw new Error("Source adapter sync must be a function.");
  }

  function register(adapter) {
    validateAdapter(adapter);
    if (adapters.has(adapter.id)) throw new Error(`Duplicate source adapter id: ${adapter.id}`);
    adapters.set(adapter.id, adapter);
    return adapter;
  }

  function get(id) {
    return adapters.get(id) || null;
  }

  function list() {
    return [...adapters.values()];
  }

  function enabled(settings = {}) {
    const sources = settings?.sources || {};
    return list().filter((adapter) => {
      const entry = sources[adapter.id];
      if (entry && typeof entry.enabled === "boolean") return entry.enabled;
      // prairielearn defaults to true; everything else defaults to false.
      if (adapter.id === "prairielearn") return true;
      return false;
    });
  }

  // Test-only reset; not used at runtime.
  function clearForTests() {
    adapters.clear();
  }

  const api = { register, get, list, enabled, clearForTests };
  globalThis.PrairieRunSources = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

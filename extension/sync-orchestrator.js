// PrairieRun sync orchestrator (PR 1 stub with final contract; PR 2 owns internals).
(function () {
  function defaultLog(message, details) {
    try {
      console.log(`[PrairieRun] ${message}`, details ?? "");
    } catch { /* ignore */ }
  }

  async function loadJson(key, fallback) {
    try {
      const stored = await globalThis.PrairieRunExt?.storageLocalGet?.(key);
      const value = stored?.[key];
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  async function runSync({ reason = "manual", sources = null } = {}) {
    const settings = (await loadJson("prairierunSettings", {})) || {};
    const secrets = (await loadJson("prairierunSecrets", {})) || {};
    const courseLinks = (await loadJson("prairierunCourseLinks", {})) || {};
    const prev = (await loadJson("prairierunDeadlines", [])) || [];

    const ctx = {
      fetchPage: (...args) => globalThis.PrairieRunNet.fetchPage(...args),
      parseHtml: (...args) => globalThis.PrairieRunParseHost.parseHtml(...args),
      settings,
      secrets,
      now: new Date(),
      log: defaultLog,
    };
    void reason;

    const registry = globalThis.PrairieRunSources;
    const adapters = sources
      ? sources.map((id) => registry.get(id)).filter(Boolean)
      : registry.enabled(settings);
    const results = {};
    for (const adapter of adapters) {
      try {
        const result = await adapter.sync(ctx);
        results[adapter.id] = result && typeof result === "object"
          ? result
          : { status: "error", items: [], error: "Invalid adapter result.", checkedAt: new Date().toISOString() };
      } catch (error) {
        results[adapter.id] = {
          status: "error",
          items: [],
          error: error?.message || String(error),
          checkedAt: new Date().toISOString(),
        };
      }
    }

    const { items, changes } = globalThis.PrairieRunDeadlineStore.mergeSourceResults(prev, results, courseLinks);
    const status = {};
    for (const [sourceId, result] of Object.entries(results)) {
      const { items: _dropped, ...rest } = result || {};
      void _dropped;
      status[sourceId] = rest;
    }
    try {
      await globalThis.PrairieRunExt?.storageLocalSet?.({
        prairierunDeadlines: items,
        prairierunSourceStatus: status,
      });
    } catch { /* storage failures must not break the contract in tests */ }

    await globalThis.PrairieRunOutputs.run(items, changes, settings);
    return { results, items, changes };
  }

  const api = { runSync };
  globalThis.PrairieRunOrchestrator = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

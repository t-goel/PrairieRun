// PrairieRun deadline store (PR 1 stub with final merge contract; PR 7 owns internals).
(function () {
  function fingerprintOf(item) {
    try {
      if (globalThis.PrairieRunModel?.fingerprint) return globalThis.PrairieRunModel.fingerprint(item);
    } catch { /* fall through */ }
    return JSON.stringify(item);
  }

  // Per source: status ok replaces that source's items; anything else keeps previous ones.
  // changes = {added:[], changed:[], removed:[]} by fingerprint.
  function mergeSourceResults(prev = [], results = {}, links = {}) {
    void links;
    const prevItems = Array.isArray(prev) ? prev : [];
    const byId = new Map(prevItems.map((item) => [item.id, item]));
    const prevFp = new Map(prevItems.map((item) => [item.id, fingerprintOf(item)]));
    const touchedSources = new Set(Object.keys(results || {}));
    const nextById = new Map(byId);

    for (const [sourceId, result] of Object.entries(results || {})) {
      if (result?.status === "ok") {
        // Remove this source's previous items, then add the fresh ones.
        for (const [id, item] of [...nextById]) {
          if (item?.source === sourceId) nextById.delete(id);
        }
        for (const item of result.items || []) {
          nextById.set(item.id, item);
        }
      }
      // Non-ok keeps previous items for that source.
    }

    void touchedSources;
    const items = [...nextById.values()];
    const nextFp = new Map(items.map((item) => [item.id, fingerprintOf(item)]));
    const added = [];
    const changed = [];
    const removed = [];
    for (const item of items) {
      if (!byId.has(item.id)) added.push(item.id);
      else if (prevFp.get(item.id) !== nextFp.get(item.id)) changed.push(item.id);
    }
    for (const id of byId.keys()) {
      if (!nextById.has(id)) removed.push(id);
    }
    return { items, changes: { added, changed, removed } };
  }

  const api = { mergeSourceResults };
  globalThis.PrairieRunDeadlineStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

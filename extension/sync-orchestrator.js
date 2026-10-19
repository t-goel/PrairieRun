// PrairieRun sync orchestrator (PR 2: session lease, permission gates,
// signed-out detection, per-source status).
// Contract: runSync -> adapter.sync -> PrairieRunDeadlineStore.mergeSourceResults
// -> save prairierunDeadlines + prairierunSourceStatus -> PrairieRunOutputs.run.
(function () {
  const LEASE_KEY = "prairierunSyncLease";
  const LEASE_TTL_MS = 5 * 60 * 1000;

  // In-process guard: set synchronously so a second runSync call in the same
  // tick sees the lock even before the session-lease round trip. The session
  // lease below is what survives service-worker restarts.
  let activeSync = null;
  // Fallback lease store when the session helpers are unavailable (tests).
  let memoryLease = null;

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

  function sessionStore() {
    const ext = globalThis.PrairieRunExt;
    if (ext && typeof ext.getSessionValue === "function" && typeof ext.setSessionValue === "function") return ext;
    return null;
  }

  async function readLease() {
    const store = sessionStore();
    if (store) {
      try {
        return await store.getSessionValue(LEASE_KEY);
      } catch {
        return undefined;
      }
    }
    return memoryLease;
  }

  async function writeLease(value) {
    const store = sessionStore();
    if (store) {
      try {
        await store.setSessionValue(LEASE_KEY, value);
      } catch { /* lease write failures must not break syncing */ }
      return;
    }
    memoryLease = value;
  }

  async function clearLease(owner) {
    const store = sessionStore();
    if (store) {
      try {
        const current = await store.getSessionValue(LEASE_KEY);
        if (current?.owner === owner) {
          if (typeof store.removeSessionValue === "function") await store.removeSessionValue(LEASE_KEY);
          else await store.setSessionValue(LEASE_KEY, { owner: null, expiresAt: 0 });
        }
      } catch { /* ignore */ }
      return;
    }
    if (memoryLease?.owner === owner) memoryLease = null;
  }

  function makeOwner() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function originOf(value) {
    try {
      return new URL(String(value)).origin;
    } catch {
      return null;
    }
  }

  function adapterOrigins(adapter) {
    return Array.isArray(adapter?.origins) ? adapter.origins : [];
  }

  // Generic signed-out check: most university logins bounce through an
  // identity provider on another host (shibboleth, Microsoft login, ...), so a
  // redirect away from the adapter's own origins means the session is gone.
  // This stays generic on purpose; adapters add their own isSignedOut checks.
  function isCrossHostRedirect(fetchResult, adapter) {
    if (!fetchResult || !fetchResult.redirected) return false;
    const finalOrigin = originOf(fetchResult.url);
    if (!finalOrigin) return false;
    const allowed = new Set(adapterOrigins(adapter).map(originOf).filter(Boolean));
    return !allowed.has(finalOrigin);
  }

  async function hasOriginPermission(adapter) {
    try {
      const check = globalThis.PrairieRunExt?.permissionsContains;
      if (typeof check !== "function") return true;
      return Boolean(await check(adapterOrigins(adapter)));
    } catch {
      return true;
    }
  }

  async function syncOneAdapter(adapter, ctx) {
    const checkedAt = () => new Date().toISOString();
    if (!adapter || typeof adapter.sync !== "function") {
      return { status: "error", items: [], error: "Invalid adapter.", checkedAt: checkedAt() };
    }
    // No host permission yet: never fetch, report disabled so the popup can
    // offer Grant access.
    let permitted = true;
    try {
      permitted = await hasOriginPermission(adapter);
    } catch {
      permitted = true;
    }
    if (!permitted) {
      return { status: "disabled", items: [], error: "permission", checkedAt: checkedAt() };
    }

    // Wrap fetchPage so the orchestrator sees every response for the generic
    // signed-out check. Adapters keep calling ctx.fetchPage as before.
    const seen = [];
    const adapterCtx = {
      ...ctx,
      fetchPage: async (url, opts) => {
        const merged = { log: ctx.log, ...(opts || {}) };
        const result = await globalThis.PrairieRunNet.fetchPage(url, merged);
        seen.push(result);
        return result;
      },
    };

    let result;
    try {
      const raw = await adapter.sync(adapterCtx);
      result = raw && typeof raw === "object"
        ? raw
        : { status: "error", items: [], error: "Invalid adapter result.", checkedAt: checkedAt() };
    } catch (error) {
      return {
        status: "error",
        items: [],
        error: error?.message || String(error),
        checkedAt: checkedAt(),
      };
    }

    if (result.status === "disabled" || result.status === "signed_out") {
      return {
        status: result.status,
        items: Array.isArray(result.items) ? result.items : [],
        ...(result.error ? { error: result.error } : {}),
        checkedAt: result.checkedAt || checkedAt(),
      };
    }

    const lastFetch = seen.length ? seen[seen.length - 1] : null;
    let signedOut = false;
    try {
      if (lastFetch && typeof adapter.isSignedOut === "function" && adapter.isSignedOut(lastFetch)) signedOut = true;
    } catch { /* a throwing detector must not fail the sync */ }
    let error = result.error;
    if (!signedOut && isCrossHostRedirect(lastFetch, adapter)) {
      signedOut = true;
      error = `Sign-in required (redirected to ${originOf(lastFetch.url)}).`;
    }
    if (signedOut) {
      return {
        status: "signed_out",
        items: Array.isArray(result.items) ? result.items : [],
        error: error || "Sign-in required.",
        checkedAt: result.checkedAt || checkedAt(),
      };
    }
    return result;
  }

  async function runSync({ reason = "manual", sources = null } = {}) {
    // A concurrent call returns immediately; the first run owns the sync.
    if (activeSync) return { skipped: "locked" };
    const owner = makeOwner();
    activeSync = owner;
    try {
      const existing = await readLease();
      if (existing && existing.owner && existing.expiresAt > Date.now()) {
        return { skipped: "locked" };
      }
      await writeLease({ owner, expiresAt: Date.now() + LEASE_TTL_MS });

      try {
        globalThis.PrairieRunNet?.resetBudgets?.();
      } catch { /* per-run budgets are best-effort */ }

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
          results[adapter.id] = await syncOneAdapter(adapter, ctx);
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
        const adapter = adapters.find((entry) => entry.id === sourceId);
        const { items: _dropped, ...rest } = result || {};
        void _dropped;
        status[sourceId] = {
          status: rest.status || "error",
          ...(rest.error ? { error: rest.error } : {}),
          checkedAt: rest.checkedAt || new Date().toISOString(),
          signInUrl: adapter?.signInUrl || rest.signInUrl || null,
        };
      }
      try {
        await globalThis.PrairieRunExt?.storageLocalSet?.({
          prairierunDeadlines: items,
          prairierunSourceStatus: status,
        });
      } catch { /* storage failures must not break the contract in tests */ }

      await globalThis.PrairieRunOutputs.run(items, changes, settings);
      return { results, items, changes };
    } finally {
      activeSync = null;
      await clearLease(owner);
    }
  }

  const api = { runSync };
  globalThis.PrairieRunOrchestrator = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

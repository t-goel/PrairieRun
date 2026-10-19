// PrairieRun safe fetch layer (PR 2 full version).
// Read-only: GET requests only. Never submit forms, click buttons, or POST.
// Cookies never leave their own site: every request goes to that site's own
// origin with credentials:"include" under that origin's host permission.
// No cookies permission is used; cookies and tokens are never read, copied,
// logged, or forwarded. Fetched HTML is parsed locally and dropped, never
// stored or sent anywhere.
// Plain IIFE script; no bundler.
(function () {
  class SafetyError extends Error {
    constructor(message) {
      super(message);
      this.name = "SafetyError";
    }
  }

  const PL_ORIGIN = "https://us.prairielearn.com";
  // PR 2 extends the PR 1 PrairieLearn-only allowlist to the other registered
  // source origins. Only PrairieLearn has attempt-creating GET routes, so only
  // it needs a path allowlist; the other sites allow any same-origin GET path.
  const ALLOWED_ORIGINS = new Set([
    PL_ORIGIN,
    "https://us.prairietest.com",
    "https://www.gradescope.com",
    "https://canvas.illinois.edu",
  ]);

  function assertSafePlPath(url) {
    const path = url.pathname;
    // Allowed (exact, no start-route):
    // /pl and /pl/
    if (path === "/pl" || path === "/pl/") return url;
    // /pl/course_instance/<ci> and /pl/course_instance/<ci>/assessments
    let match = path.match(/^\/pl\/course_instance\/(\d+)(\/?)$/);
    if (match) return url;
    match = path.match(/^\/pl\/course_instance\/(\d+)\/assessments\/?$/);
    if (match) return url;
    // /pl/course_instance/<ci>/assessment_instance/<iid>/ (with or without slash)
    match = path.match(/^\/pl\/course_instance\/(\d+)\/assessment_instance\/(\d+)\/?$/);
    if (match) return url;
    // Identity probe only: /pl/course_instance/<ci>/assessment/<aid>/__prairierun_identity__[/]
    match = path.match(/^\/pl\/course_instance\/(\d+)\/assessment\/(\d+)\/__prairierun_identity__\/?$/);
    if (match) return url;
    throw new SafetyError(`Unsafe PrairieLearn path (possible attempt-creating start route): ${url.href}`);
  }

  function assertSafeUrl(input) {
    let url;
    try {
      url = new URL(String(input));
    } catch {
      throw new SafetyError(`Unsafe URL (unparseable): ${input}`);
    }
    if (url.protocol !== "https:") throw new SafetyError(`Unsafe URL (protocol): ${url.href}`);
    if (url.origin === PL_ORIGIN) return assertSafePlPath(url);
    if (ALLOWED_ORIGINS.has(url.origin)) return url;
    throw new SafetyError(`Unsafe URL (origin not allowed): ${url.href}`);
  }

  // The Canvas ICS feed URL embeds a per-user secret token. Redact it and
  // drop query strings before anything URL-shaped reaches a log.
  function redactUrl(input) {
    const withoutQuery = String(input).split("?")[0].split("#")[0];
    return withoutQuery.replace(/\/feeds\/calendars\/user_[^/.?#]+/g, "/feeds/calendars/user_*");
  }

  // Per-origin politeness: one request at a time per origin with a jittered
  // 400-800 ms gap, and at most 40 requests per origin per sync run.
  const MIN_GAP_MS = 400;
  const JITTER_MS = 400;
  const MAX_REQUESTS_PER_ORIGIN = 40;
  const originState = new Map(); // origin -> { tail, count, lastEnd }

  function stateFor(origin) {
    let state = originState.get(origin);
    if (!state) {
      state = { tail: Promise.resolve(), count: 0, lastEnd: 0 };
      originState.set(origin, state);
    }
    return state;
  }

  function resetBudgets() {
    originState.clear();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function acquireSlot(origin) {
    const state = stateFor(origin);
    if (state.count >= MAX_REQUESTS_PER_ORIGIN) {
      throw new SafetyError(`Request budget exceeded for ${origin} (max ${MAX_REQUESTS_PER_ORIGIN} per run).`);
    }
    const previous = state.tail;
    let release = () => undefined;
    state.tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    // Re-check under the mutex: a burst of waiters must not overshoot.
    if (state.count >= MAX_REQUESTS_PER_ORIGIN) {
      release();
      throw new SafetyError(`Request budget exceeded for ${origin} (max ${MAX_REQUESTS_PER_ORIGIN} per run).`);
    }
    const gap = state.lastEnd ? Math.max(0, state.lastEnd + MIN_GAP_MS + Math.random() * JITTER_MS - Date.now()) : 0;
    if (gap > 0) await sleep(gap);
    state.count += 1;
    return () => {
      state.lastEnd = Date.now();
      release();
    };
  }

  async function fetchPage(url, { method = "GET", accept = "text/html", timeoutMs = 20000, credentials = "include", log = null } = {}) {
    if (String(method).toUpperCase() !== "GET") {
      throw new SafetyError(`Only GET is allowed (got ${method}).`);
    }
    const safe = assertSafeUrl(url);
    const release = await acquireSlot(safe.origin);
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timer = null;
    try {
      if (controller) {
        timer = setTimeout(() => controller.abort(), timeoutMs);
      }
      const response = await fetch(safe.href, {
        method: "GET",
        credentials,
        redirect: "follow",
        headers: { Accept: accept },
        ...(controller ? { signal: controller.signal } : {}),
      });
      const contentType = response.headers?.get ? response.headers.get("content-type") : null;
      const text = await response.text();
      const result = {
        ok: response.ok,
        status: response.status,
        url: response.url || safe.href,
        redirected: Boolean(response.redirected),
        contentType,
        text,
      };
      // Never log response text. Metadata only, with secrets redacted.
      try {
        if (typeof log === "function") {
          log("fetch", {
            url: redactUrl(safe.href),
            origin: safe.origin,
            path: safe.pathname,
            status: result.status,
            redirected: result.redirected,
          });
        }
      } catch { /* logging must never break fetching */ }
      return result;
    } finally {
      if (timer !== null && typeof clearTimeout !== "undefined") clearTimeout(timer);
      release();
    }
  }

  const api = { SafetyError, assertSafeUrl, fetchPage, redactUrl, resetBudgets, MAX_REQUESTS_PER_ORIGIN };
  globalThis.PrairieRunNet = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

// PrairieRun safe fetch layer (PR 1 basic version; PR 2 extends it).
// Read-only: GET requests only. Never submit forms or POST.
// Plain IIFE script.
(function () {
  class SafetyError extends Error {
    constructor(message) {
      super(message);
      this.name = "SafetyError";
    }
  }

  const PL_ORIGIN = "https://us.prairielearn.com";

  function assertSafeUrl(input) {
    let url;
    try {
      url = new URL(String(input));
    } catch {
      throw new SafetyError(`Unsafe URL (unparseable): ${input}`);
    }
    if (url.protocol !== "https:") throw new SafetyError(`Unsafe URL (protocol): ${url.href}`);
    if (url.origin !== PL_ORIGIN) {
      throw new SafetyError(`Unsafe URL (origin not allowed in PR 1): ${url.href}`);
    }
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

  async function fetchPage(url, { method = "GET", credentials = "include", accept = "text/html" } = {}) {
    if (String(method).toUpperCase() !== "GET") {
      throw new SafetyError(`Only GET is allowed (got ${method}).`);
    }
    const safe = assertSafeUrl(url);
    const response = await fetch(safe.href, {
      method: "GET",
      credentials,
      headers: { Accept: accept },
    });
    const contentType = response.headers?.get ? response.headers.get("content-type") : null;
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      url: response.url || safe.href,
      redirected: Boolean(response.redirected),
      contentType,
      text,
    };
  }

  const api = { SafetyError, assertSafeUrl, fetchPage };
  globalThis.PrairieRunNet = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

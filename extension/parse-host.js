// PrairieRun parse host (PR 2: offscreen parsing for Chrome, in-place for
// Firefox/tests). Routes parserKey ("<sourceId>.<name>", html, url) to the
// registered adapter parser either via a local DOMParser or via the offscreen
// document. Never fetches; parsing only.
(function () {
  // Only one offscreen document can exist, so serialize ensure calls behind a
  // module-level promise shared by concurrent parse requests.
  let offscreenPending = null;

  function splitKey(parserKey) {
    const key = String(parserKey || "");
    const dot = key.indexOf(".");
    if (dot === -1) throw new Error(`Invalid parser key: ${parserKey}`);
    return { sourceId: key.slice(0, dot), name: key.slice(dot + 1) };
  }

  function lookupParser(parserKey) {
    const { sourceId, name } = splitKey(parserKey);
    const adapter = globalThis.PrairieRunSources?.get?.(sourceId);
    if (!adapter) throw new Error(`Unknown source: ${sourceId}`);
    const parser = adapter.parsers?.[name];
    if (typeof parser !== "function") throw new Error(`Unknown parser: ${parserKey}`);
    return parser;
  }

  async function parseViaOffscreen(parserKey, html, url) {
    const ext = globalThis.PrairieRunExt;
    if (!ext?.offscreenEnsure || !ext?.runtimeSendMessage) {
      throw new Error("Offscreen parsing is unavailable (compat shim is missing offscreenEnsure).");
    }
    if (!offscreenPending) {
      offscreenPending = Promise.resolve().then(() => ext.offscreenEnsure());
      offscreenPending.then(
        () => {
          offscreenPending = null;
        },
        () => {
          offscreenPending = null;
        }
      );
    }
    await offscreenPending;
    const response = await ext.runtimeSendMessage({
      type: "PRAIRIERUN_PARSE",
      parserKey,
      html: String(html),
      url,
    });
    if (!response?.ok) throw new Error(response?.error || `Offscreen parse failed for ${parserKey}.`);
    return response.data;
  }

  async function parseHtml(parserKey, html, url) {
    // In-place parsing: Firefox event page and Node tests have DOMParser.
    if (typeof DOMParser !== "undefined") {
      const parser = lookupParser(parserKey);
      const doc = new DOMParser().parseFromString(String(html), "text/html");
      return parser(doc, url);
    }
    // Chrome service worker has no DOM: forward to the offscreen document.
    return parseViaOffscreen(parserKey, html, url);
  }

  const api = { parseHtml };
  globalThis.PrairieRunParseHost = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

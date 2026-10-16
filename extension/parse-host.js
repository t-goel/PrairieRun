// PrairieRun parse host (PR 1 stub; PR 2 implements offscreen parsing).
(function () {
  async function parseHtml(parserKey, html, url) {
    const key = String(parserKey || "");
    const dot = key.indexOf(".");
    if (dot === -1) throw new Error(`Invalid parser key: ${parserKey}`);
    const sourceId = key.slice(0, dot);
    const name = key.slice(dot + 1);
    const adapter = globalThis.PrairieRunSources?.get?.(sourceId);
    if (!adapter) throw new Error(`Unknown source: ${sourceId}`);
    const parser = adapter.parsers?.[name];
    if (typeof parser !== "function") throw new Error(`Unknown parser: ${parserKey}`);
    if (typeof DOMParser !== "undefined") {
      const doc = new DOMParser().parseFromString(String(html), "text/html");
      return parser(doc, url);
    }
    throw new Error("offscreen parsing not implemented (PR 2)");
  }

  const api = { parseHtml };
  globalThis.PrairieRunParseHost = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

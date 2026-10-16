// PrairieRun offscreen document (PR 2: DOMParser handling).
// Receives PRAIRIERUN_PARSE requests from the service worker, parses the HTML
// locally with DOMParser, runs the registered source parser, and replies with
// JSON-serializable data only. Never fetches.
(function () {
  function splitKey(parserKey) {
    const key = String(parserKey || "");
    const dot = key.indexOf(".");
    if (dot === -1) throw new Error(`Invalid parser key: ${parserKey}`);
    return { sourceId: key.slice(0, dot), name: key.slice(dot + 1) };
  }

  function toJsonSafe(data) {
    if (data === undefined || data === null) return data ?? null;
    return JSON.parse(JSON.stringify(data));
  }

  async function handleMessage(message) {
    if (!message || message.type !== "PRAIRIERUN_PARSE") return undefined;
    try {
      const { sourceId, name } = splitKey(message.parserKey);
      const adapter = globalThis.PrairieRunSources?.get?.(sourceId);
      if (!adapter) throw new Error(`Unknown source: ${sourceId}`);
      const parser = adapter.parsers?.[name];
      if (typeof parser !== "function") throw new Error(`Unknown parser: ${message.parserKey}`);
      const doc = new DOMParser().parseFromString(String(message.html ?? ""), "text/html");
      const data = await parser(doc, message.url);
      return { ok: true, data: toJsonSafe(data) };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  try {
    globalThis.PrairieRunExt?.addRuntimeMessageListener?.((message, _sender, sendResponse) => {
      if (message?.type !== "PRAIRIERUN_PARSE") return undefined;
      handleMessage(message).then(sendResponse);
      return true;
    });
  } catch { /* ignore in non-extension contexts */ }

  const api = { handleMessage };
  globalThis.PrairieRunOffscreen = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

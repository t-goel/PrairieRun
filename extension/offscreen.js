// PrairieRun offscreen document (PR 1 stub; PR 2 owns parsing).
// Listens for parse requests; full DOMParser handling lands in PR 2.
(function () {
  async function handleMessage(message) {
    void message;
    return { ok: false, error: "offscreen parsing not implemented (PR 2)" };
  }

  if (globalThis.chrome?.runtime?.onMessage) {
    try {
      globalThis.chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type !== "PRAIRIERUN_PARSE_HTML") return undefined;
        handleMessage(message).then(sendResponse);
        return true;
      });
    } catch { /* ignore in non-extension contexts */ }
  }

  const api = { handleMessage };
  globalThis.PrairieRunOffscreen = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

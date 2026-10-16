// PrairieRun relay push (PR 1 stub; PR 11 owns internals).
(function () {
  async function push() {
    return { status: "disabled" };
  }

  const api = { push };
  globalThis.PrairieRunRelay = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

// PrairieRun ICS parsing (PR 1 stub; PR 4 owns internals).
(function () {
  function parseIcs() {
    throw new Error("PR 4");
  }

  const api = { parseIcs };
  globalThis.PrairieRunIcs = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

// PrairieRun outputs fan-out (PR 1 stub; PR 9 owns internals).
(function () {
  async function run(items, changes, settings) {
    void items;
    void changes;
    void settings;
    return {};
  }

  const api = { run };
  globalThis.PrairieRunOutputs = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

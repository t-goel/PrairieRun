// PrairieRun outputs fan-out: after each successful source sync, push every
// configured output. Today the only output is the auto-updating iCalendar
// feed (PrairieRunRelay); later PRs own Google/gCal and file outputs.
(function () {
  async function run(items, changes, settings) {
    const results = {};
    if (globalThis.PrairieRunRelay && typeof globalThis.PrairieRunRelay.autoPublish === "function") {
      try {
        results.relay = await globalThis.PrairieRunRelay.autoPublish(items, settings);
      } catch (error) {
        results.relay = { status: "error", error: error?.message || String(error) };
      }
    }
    return results;
  }

  const api = { run };
  globalThis.PrairieRunOutputs = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

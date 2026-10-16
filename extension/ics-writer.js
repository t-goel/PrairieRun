// PrairieRun ICS writing (PR 1 stub; PR 8 owns internals).
(function () {
  function buildCalendar() {
    throw new Error("PR 8");
  }

  const api = { buildCalendar };
  globalThis.PrairieRunIcsWriter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

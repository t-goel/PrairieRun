// PrairieTest source adapter (PR 1 stub; PR 6 owns internals).
(function () {
  const adapter = {
    id: "prairietest",
    label: "PrairieTest",
    origins: ["https://us.prairietest.com"],
    signInUrl: "https://us.prairietest.com/pt",
    parsers: {},
    isSignedOut() { return false; },
    async sync() {
      return { status: "disabled", items: [], checkedAt: new Date().toISOString() };
    },
  };
  try { globalThis.PrairieRunSources?.register(adapter); } catch { /* ignore duplicates in tests */ }
  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
})();

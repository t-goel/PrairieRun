// Canvas source adapter (PR 1 stub; PR 4 owns internals).
(function () {
  const adapter = {
    id: "canvas",
    label: "Canvas",
    origins: ["https://canvas.illinois.edu"],
    signInUrl: "https://canvas.illinois.edu/",
    parsers: {},
    isSignedOut() { return false; },
    async sync() {
      return { status: "disabled", items: [], checkedAt: new Date().toISOString() };
    },
  };
  try { globalThis.PrairieRunSources?.register(adapter); } catch { /* ignore duplicates in tests */ }
  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
})();

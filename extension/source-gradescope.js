// Gradescope source adapter (PR 1 stub; PR 5 owns internals).
(function () {
  const adapter = {
    id: "gradescope",
    label: "Gradescope",
    origins: ["https://www.gradescope.com"],
    signInUrl: "https://www.gradescope.com/login",
    parsers: {},
    isSignedOut() { return false; },
    async sync() {
      return { status: "disabled", items: [], checkedAt: new Date().toISOString() };
    },
  };
  try { globalThis.PrairieRunSources?.register(adapter); } catch { /* ignore duplicates in tests */ }
  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
})();

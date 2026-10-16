// PrairieLearn source adapter (PR 1 wrapper; PR 3 owns fetch/parsing).
// Tab scanning stays in background.js for now; sync() maps stored legacy
// assignments to DeadlineItems with no behavior change.
(function () {
  async function readLegacyAssignments() {
    try {
      const stored = await globalThis.PrairieRunExt?.storageLocalGet?.("prairierunAssignments");
      const list = stored?.prairierunAssignments;
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  const adapter = {
    id: "prairielearn",
    label: "PrairieLearn",
    origins: ["https://us.prairielearn.com"],
    signInUrl: "https://us.prairielearn.com/pl",
    parsers: {},
    isSignedOut(fetchResult) {
      if (!fetchResult) return false;
      const status = fetchResult.status;
      if (status === 401 || status === 403) return true;
      const text = String(fetchResult.text || "").toLowerCase();
      return text.includes("sign in") && text.includes("prairielearn");
    },
    async sync() {
      const legacy = await readLegacyAssignments();
      const items = [];
      for (const entry of legacy) {
        try {
          items.push(globalThis.PrairieRunModel.fromLegacyPlAssignment(entry));
        } catch {
          // Skip malformed legacy rows without failing the whole source.
        }
      }
      return { status: "ok", items, checkedAt: new Date().toISOString() };
    },
  };

  try {
    globalThis.PrairieRunSources?.register(adapter);
  } catch {
    // In Node tests the registry may already hold this id; ignore duplicates here.
  }
  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
})();

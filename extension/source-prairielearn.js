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
    origins: ["https://us.prairielearn.com/*"],
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
      // Emit one enrolled-course row per course instance so Course Links keeps
      // PrairieLearn cells even when a family fold drops the live item set.
      const coursesByKey = new Map();
      for (const item of items) {
        const key = item?.courseKey;
        if (!key || coursesByKey.has(key)) continue;
        const match = String(key).match(/^prairielearn:(\d+)$/);
        const id = match ? match[1] : key;
        let url = item.url || "";
        try {
          const parsed = new URL(url);
          const home = parsed.pathname.match(/^(\/pl\/course_instance\/\d+)/i);
          if (home) url = `${parsed.origin}${home[1]}/assessments`;
        } catch { /* keep assignment url */ }
        coursesByKey.set(key, {
          id,
          source: "prairielearn",
          courseKey: key,
          courseCode: item.courseCode || null,
          courseName: item.courseName || item.courseCode || "",
          url,
        });
      }
      try {
        const storedCourses = await globalThis.PrairieRunExt?.storageLocalGet?.("prairierunCourses");
        const savedCourses = Array.isArray(storedCourses?.prairierunCourses) ? storedCourses.prairierunCourses : [];
        for (const sc of savedCourses) {
          if (sc?.source === "prairielearn" && sc?.courseKey && !coursesByKey.has(sc.courseKey)) {
            coursesByKey.set(sc.courseKey, sc);
          }
        }
      } catch { /* best-effort */ }
      return {
        status: "ok",
        items,
        courses: [...coursesByKey.values()],
        checkedAt: new Date().toISOString(),
      };
    },
  };

  try {
    globalThis.PrairieRunSources?.register(adapter);
  } catch {
    // In Node tests the registry may already hold this id; ignore duplicates here.
  }
  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
})();

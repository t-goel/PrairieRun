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
    parsers: {
      home(doc, url) {
        if (typeof globalThis.PrairieLearnAdapter?.getCourseLinks === "function") {
          return { courseLinks: globalThis.PrairieLearnAdapter.getCourseLinks(doc, { href: url || "https://us.prairielearn.com/pl" }) };
        }
        const seen = new Set();
        const courseLinks = [...doc.querySelectorAll("a[href]")]
          .map((a) => {
            const href = a.getAttribute("href") || "";
            const m = href.match(/\/course_instance\/(\d+)/i);
            const id = m ? m[1] : null;
            const fullHref = href.startsWith("http") ? href : `https://us.prairielearn.com${href}`;
            return {
              courseInstanceId: id,
              href: fullHref,
              text: (a.textContent || "").trim(),
            };
          })
          .filter((l) => l.courseInstanceId && !seen.has(l.courseInstanceId) && seen.add(l.courseInstanceId));
        return { courseLinks };
      },
    },
    isSignedOut(fetchResult) {
      if (!fetchResult) return false;
      const status = fetchResult.status;
      if (status === 401 || status === 403) return true;
      const text = String(fetchResult.text || "").toLowerCase();
      return text.includes("sign in") && text.includes("prairielearn");
    },
    async sync(ctx) {
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
      // If sync context is available, fetch the PrairieLearn home page to get all enrolled courses directly.
      if (typeof ctx?.fetchPage === "function") {
        try {
          const resp = await ctx.fetchPage("https://us.prairielearn.com/pl");
          if (resp && resp.ok && !adapter.isSignedOut(resp)) {
            const parsed = typeof ctx?.parseHtml === "function"
              ? await ctx.parseHtml("prairielearn.home", String(resp.text || ""), resp.url || "https://us.prairielearn.com/pl")
              : null;
            for (const link of (parsed?.courseLinks || [])) {
              if (!link?.courseInstanceId) continue;
              const key = `prairielearn:${link.courseInstanceId}`;
              const store = globalThis.PrairieRunDeadlineStore;
              const code = store?.normalizeCourseCode ? store.normalizeCourseCode(link.text) : null;
              const url = `${link.href.replace(/\/$/, "")}/assessments`;
              coursesByKey.set(key, {
                id: link.courseInstanceId,
                source: "prairielearn",
                courseKey: key,
                courseCode: code,
                courseName: link.text,
                url,
              });
            }
          }
        } catch { /* best-effort */ }
      }
      try {
        const storedCourses = await globalThis.PrairieRunExt?.storageLocalGet?.("prairierunCourses");
        const savedCourses = Array.isArray(storedCourses?.prairierunCourses) ? storedCourses.prairierunCourses : [];
        for (const sc of savedCourses) {
          const key = sc?.courseKey || (sc?.id ? `prairielearn:${sc.id}` : null);
          if (sc?.source === "prairielearn" && key && !coursesByKey.has(key)) {
            coursesByKey.set(key, { ...sc, courseKey: key });
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

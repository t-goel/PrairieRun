// PrairieRun course-link options (PR 7): confirm cross-source course links.
// Renders into the #course-links section.
(function () {
  const LINKS_KEY = "prairierunCourseLinks";
  const DEADLINES_KEY = "prairierunDeadlines";
  const COURSES_KEY = "prairierunCourses";
  const SOURCES = ["prairielearn", "gradescope", "canvas", "prairietest", "courseweb"];
  const SOURCE_LABELS = { prairielearn: "PrairieLearn", gradescope: "Gradescope", canvas: "Canvas", prairietest: "PrairieTest", courseweb: "Website" };

  // options.html does not list deadline-store.js yet (shared load list; PR 10
  // adds it). Load the flat extension script on demand until then.
  function ensureStoreLoaded() {
    if (globalThis.PrairieRunDeadlineStore) return Promise.resolve(true);
    if (typeof document === "undefined") return Promise.resolve(false);
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "deadline-store.js";
      script.onload = () => resolve(Boolean(globalThis.PrairieRunDeadlineStore));
      script.onerror = () => resolve(false);
      document.head.append(script);
    });
  }

  // Stored links may use the legacy spaced key format ("CS 425"); re-key them
  // through the current normalizer and fold same-family keys into the family's
  // shortest code, so old separate rows ("CS 498", "CS 498DK") collapse into
  // the one suggested family bucket ("CS498") and keep any confirmed state.
  function migrateStoredLinks(rawLinks) {
    const store = globalThis.PrairieRunDeadlineStore;
    if (!rawLinks || typeof rawLinks !== "object") return {};
    const normalize = store && typeof store.normalizeCourseCode === "function";
    const normalized = {};
    for (const [key, entry] of Object.entries(rawLinks)) {
      const code = normalize ? store.normalizeCourseCode(key) : key;
      if (!code) continue;
      const existing = normalized[code];
      if (!existing) {
        normalized[code] = { ...entry };
        continue;
      }
      const merged = { ...existing };
      for (const [source, keys] of Object.entries(entry)) {
        if (Array.isArray(keys)) {
          merged[source] = [...new Set([...(Array.isArray(existing[source]) ? existing[source] : []), ...keys])];
        }
      }
      merged.confirmed = existing.confirmed === true || entry.confirmed === true;
      normalized[code] = merged;
    }
    const codes = Object.keys(normalized);
    if (!codes.length) return {};
    const family = store && typeof store.familyMapOf === "function"
      ? store.familyMapOf(codes)
      : null;
    const migrated = {};
    for (const [code, entry] of Object.entries(normalized)) {
      const bucketCode = family ? family.get(code) || code : code;
      const target = migrated[bucketCode];
      if (!target) {
        migrated[bucketCode] = { ...entry };
        continue;
      }
      const merged = { ...target };
      for (const [source, keys] of Object.entries(entry)) {
        if (Array.isArray(keys)) {
          merged[source] = [...new Set([...(Array.isArray(target[source]) ? target[source] : []), ...keys])];
        }
      }
      merged.confirmed = target.confirmed === true || entry.confirmed === true;
      migrated[bucketCode] = merged;
    }
    return migrated;
  }

  async function loadData() {
    const stored = await globalThis.PrairieRunExt.storageLocalGet([
      DEADLINES_KEY,
      LINKS_KEY,
      COURSES_KEY,
      "prairierunAssignments",
    ]);
    const items = Array.isArray(stored[DEADLINES_KEY]) ? [...stored[DEADLINES_KEY]] : [];
    if (Array.isArray(stored.prairierunAssignments) && globalThis.PrairieRunModel?.fromLegacyPlAssignment) {
      const existingIds = new Set(items.map((it) => it?.id));
      for (const legacy of stored.prairierunAssignments) {
        try {
          const item = globalThis.PrairieRunModel.fromLegacyPlAssignment(legacy);
          if (item && !existingIds.has(item.id)) {
            items.push(item);
            existingIds.add(item.id);
          }
        } catch { /* skip */ }
      }
    }
    let courses = Array.isArray(stored[COURSES_KEY]) ? [...stored[COURSES_KEY]] : [];
    // If running in browser and PrairieLearn enrolled courses aren't populated yet,
    // fetch https://us.prairielearn.com/pl using the browser session.
    try {
      if (typeof fetch === "function" && typeof DOMParser !== "undefined") {
        const hasPl = courses.some((c) => c?.source === "prairielearn" && c?.url);
        if (!hasPl) {
          const resp = await fetch("https://us.prairielearn.com/pl", { credentials: "include" });
          if (resp && resp.ok) {
            const html = await resp.text();
            if (!html.toLowerCase().includes("sign in") || html.includes("course_instance")) {
              const doc = new DOMParser().parseFromString(html, "text/html");
              const seen = new Set();
              const plFetched = [...doc.querySelectorAll("a[href]")]
                .map((a) => {
                  const href = a.getAttribute("href") || "";
                  const m = href.match(/\/course_instance\/(\d+)/i);
                  const id = m ? m[1] : null;
                  const fullHref = href.startsWith("http") ? href : `https://us.prairielearn.com${href}`;
                  return { id, href: fullHref, text: (a.textContent || "").trim() };
                })
                .filter((l) => l.id && !seen.has(l.id) && seen.add(l.id));
              if (plFetched.length > 0) {
                const store = globalThis.PrairieRunDeadlineStore;
                const nonPl = courses.filter((c) => c?.source !== "prairielearn");
                const newPl = plFetched.map((l) => ({
                  id: l.id,
                  source: "prairielearn",
                  courseKey: `prairielearn:${l.id}`,
                  courseCode: store?.normalizeCourseCode ? store.normalizeCourseCode(l.text) : null,
                  courseName: l.text,
                  url: `${l.href.replace(/\/$/, "")}/assessments`,
                }));
                courses = [...nonPl, ...newPl];
                globalThis.PrairieRunExt?.storageLocalSet?.({ [COURSES_KEY]: courses }).catch(() => undefined);
              }
            }
          }
        }
      }
    } catch { /* best-effort */ }
    return {
      items,
      links: migrateStoredLinks(stored[LINKS_KEY] && typeof stored[LINKS_KEY] === "object" ? stored[LINKS_KEY] : {}),
      courses,
    };
  }

  // Derive a stable course home URL from an assignment URL for each source.
  function courseHomeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return null;
    try {
      const u = new URL(rawUrl);
      const pl = u.pathname.match(/^(\/pl\/course_instance\/\d+)/i);
      if (pl) return `${u.origin}${pl[1]}/assessments`;
      const courses = u.pathname.match(/^(\/courses\/[^/]+)/i);
      if (courses) return `${u.origin}${courses[1]}`;
      // PrairieTest reservations live under /pt/…; course-level home is /pt.
      if (/^\/pt(\/|$)/i.test(u.pathname)) return `${u.origin}/pt`;
      // UIUC course websites (grainger/courses.illinois.edu, etc.): the saved
      // page itself is the course home. Skip Canvas hosts already handled above.
      if (
        u.protocol === "https:"
        && u.hostname.endsWith(".illinois.edu")
        && !/^canvas\./i.test(u.hostname)
      ) {
        u.hash = "";
        return u.href;
      }
      return null;
    } catch {
      return null;
    }
  }

  function urlsByCourseKey(items) {
    const urls = new Map();
    for (const item of items || []) {
      if (!item?.courseKey || urls.has(item.courseKey)) continue;
      const href = courseHomeUrl(item.url || item.sourceUrl);
      if (href) urls.set(item.courseKey, href);
    }
    return urls;
  }

  function normalizeLoose(value) {
    const store = globalThis.PrairieRunDeadlineStore;
    if (store && typeof store.normalizeCourseCode === "function") {
      return store.normalizeCourseCode(value) || "";
    }
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  // Resolve a cell key (courseKey, courseName, or legacy course-code string)
  // to a course home URL for that source column. Falls back to same-source
  // items in the row's course family, so a stored key whose own items were
  // dropped still inherits the family's course home (CS498 key -> CS498DK2 items).
  function resolveCourseHref(items, source, key, urlIndex, familyCode) {
    if (!key) return null;
    if (source === "prairietest") {
      return "https://us.prairietest.com/pt";
    }
    if (urlIndex?.has(key)) return urlIndex.get(key);
    const cleanKey = String(key || "").replace(/^(?:prairielearn|prairietest|canvas|gradescope|courseweb):/, "");
    const want = normalizeLoose(cleanKey || key);
    for (const item of items || []) {
      if (item?.source !== source) continue;
      if (item.courseKey === key || item.courseName === key || item.courseCode === key) {
        const href = courseHomeUrl(item.url || item.sourceUrl);
        if (href) return href;
      }
      if (want) {
        const candidates = [item.courseKey, item.courseName, item.courseCode]
          .map((v) => normalizeLoose(String(v || "").replace(/^(?:prairielearn|prairietest|canvas|gradescope|courseweb):/, "")))
          .filter(Boolean);
        if (candidates.includes(want)) {
          const href = courseHomeUrl(item.url || item.sourceUrl);
          if (href) return href;
        }
      }
    }
    if (familyCode) {
      const familyWant = normalizeLoose(familyCode);
      const store = globalThis.PrairieRunDeadlineStore;
      const sameFamily = store && typeof store.sameCourseFamily === "function"
        ? (code) => store.sameCourseFamily(familyWant, code)
        : (code) => code === familyWant;
      for (const item of items || []) {
        if (item?.source !== source) continue;
        const candidates = [item.courseCode, item.courseName, item.courseKey]
          .map((v) => normalizeLoose(String(v || "").replace(/^(?:prairielearn|prairietest|canvas|gradescope|courseweb):/, "")))
          .filter(Boolean);
        if (candidates.some(sameFamily)) {
          const href = courseHomeUrl(item.url || item.sourceUrl);
          if (href) return href;
        }
      }
    }
    if (source === "prairielearn" && (String(key).startsWith("prairielearn:") || familyCode)) {
      return "https://us.prairielearn.com/pl";
    }
    return null;
  }

  // Fold suggested rows that share a course family with existing link rows
  // into the same family bucket, so e.g. "CS498DK" suggested alongside a
  // confirmed "CS498" link collapses into the CS498 row.
  function foldLinkRows(links, suggested) {
    const store = globalThis.PrairieRunDeadlineStore;
    const allCodes = [...new Set([...Object.keys(links || {}), ...Object.keys(suggested || {})])];
    const family = store && typeof store.familyMapOf === "function"
      ? store.familyMapOf(allCodes)
      : null;
    const foldedLinks = {};
    const foldedSuggested = {};

    function foldInto(target, source) {
      for (const [code, entry] of Object.entries(source || {})) {
        const bucket = family ? family.get(code) || code : code;
        if (!target[bucket]) target[bucket] = { confirmed: false };
        const row = target[bucket];
        for (const s of SOURCES) {
          const keys = entry[s];
          if (!Array.isArray(keys)) continue;
          if (!Array.isArray(row[s])) row[s] = [];
          for (const k of keys) {
            if (!row[s].includes(k)) row[s].push(k);
          }
          row[s].sort();
        }
        if (entry.confirmed === true) row.confirmed = true;
      }
    }

    foldInto(foldedLinks, links);
    foldInto(foldedSuggested, suggested);
    const codes = [...new Set([...Object.keys(foldedLinks), ...Object.keys(foldedSuggested)])].sort();
    return { codes, links: foldedLinks, suggested: foldedSuggested };
  }

  // Render a green checkmark + "Link" anchor for an enrolled course column.
  function appendPresenceLink(cell, document, href, sourceLabel) {
    if (!href) {
      cell.textContent = "—";
      return;
    }
    const mark = document.createElement("span");
    mark.className = "prr-course-link__check";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "✓";

    const link = document.createElement("a");
    link.className = "prr-course-link";
    link.href = href;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.setAttribute("aria-label", `Open ${sourceLabel} course page`);
    link.append(mark, document.createTextNode(" Link"));
    cell.append(link);
  }

  function firstCourseHref(items, source, keys, urls, familyCode) {
    for (const key of keys) {
      const href = resolveCourseHref(items, source, key, urls, familyCode);
      if (href) return href;
    }
    if (familyCode) {
      const href = resolveCourseHref(items, source, familyCode, urls, familyCode);
      if (href) return href;
    }
    return null;
  }

  function buildTable(document, items, links, suggested) {
    const urls = urlsByCourseKey(items);
    const folded = foldLinkRows(links, suggested);
    const table = document.createElement("table");
    const header = document.createElement("tr");
    for (const label of ["Course", ...SOURCES.map((source) => SOURCE_LABELS[source])]) {
      const cell = document.createElement("th");
      cell.textContent = label;
      header.append(cell);
    }
    table.append(header);
    for (const code of folded.codes) {
      const stored = folded.links[code] || {};
      const proposed = folded.suggested[code] || {};
      // Pair PrairieLearn and PrairieTest: any class with PrairieLearn has PrairieTest, and vice versa.
      const hasPl = Boolean(stored.prairielearn?.length || proposed.prairielearn?.length);
      const hasPt = Boolean(stored.prairietest?.length || proposed.prairietest?.length);
      if (hasPl || hasPt) {
        if (!stored.prairielearn?.length && !proposed.prairielearn?.length) {
          if (!proposed.prairielearn) proposed.prairielearn = [];
          proposed.prairielearn.push(`prairielearn:${code}`);
        }
        if (!stored.prairietest?.length && !proposed.prairietest?.length) {
          if (!proposed.prairietest) proposed.prairietest = [];
          proposed.prairietest.push(`prairietest:${code}`);
        }
      }
      const row = document.createElement("tr");
      const codeCell = document.createElement("td");
      codeCell.textContent = code;
      row.append(codeCell);
      for (const source of SOURCES) {
        const cell = document.createElement("td");
        const keys = [...new Set([...(stored[source] || []), ...(proposed[source] || [])])];
        if (!keys.length) {
          cell.textContent = "—";
        } else {
          appendPresenceLink(
            cell,
            document,
            firstCourseHref(items, source, keys, urls, code),
            SOURCE_LABELS[source] || source
          );
        }
        row.append(cell);
      }
      table.append(row);
    }
    return { table, codes: folded.codes };
  }

  async function render(section) {
    if (!section || typeof document === "undefined") return;
    if (section.querySelector("[data-prr-courses]")) return;
    for (const note of section.querySelectorAll("p.muted")) {
      if (/coming soon/i.test(note.textContent || "")) note.remove();
    }
    const root = document.createElement("div");
    root.dataset.prrCourses = "1";
    section.append(root);

    const storeReady = await ensureStoreLoaded();
    if (!storeReady) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "Course linking is unavailable (deadline store module not loaded).";
      root.append(note);
      return;
    }
    const store = globalThis.PrairieRunDeadlineStore;

    async function refresh() {
      root.textContent = "";
      const { items, links, courses: enrolledCourses } = await loadData();
      const allEntities = [...items, ...(enrolledCourses || [])];
      const suggested = store.suggestCourseLinks(allEntities);
      // Multi-source rows auto-link during sync; this table is read-only.
      const { table, codes } = buildTable(document, allEntities, links, suggested);
      if (!codes.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "No courses seen yet. Sync a source first.";
        root.append(empty);
      } else {
        root.append(table);
      }
    }

    const loading = document.createElement("p");
    loading.className = "muted";
    loading.textContent = "Loading courses…";
    root.append(loading);
    try {
      await refresh();
    } catch (error) {
      root.textContent = "";
      const failed = document.createElement("p");
      failed.className = "muted";
      failed.textContent = `Could not load course links: ${error?.message || error}`;
      root.append(failed);
    }

    try {
      globalThis.PrairieRunExt?.storageOnChanged?.((changes, area) => {
        if (area && area !== "local") return;
        if (changes[DEADLINES_KEY] || changes[LINKS_KEY] || changes[COURSES_KEY]) refresh();
      });
    } catch { /* ignore */ }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => {
      const section = document.getElementById("course-links");
      if (section) render(section);
    });
  }

  const api = {
    render,
    migrateStoredLinks,
    courseHomeUrl,
    urlsByCourseKey,
    resolveCourseHref,
    foldLinkRows,
    appendPresenceLink,
    firstCourseHref,
    buildTable,
  };
  globalThis.PrairieRunOptionsCourses = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

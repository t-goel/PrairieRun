// PrairieRun course-link options (PR 7): confirm cross-source course links,
// review near-miss duplicates. Renders into the #course-links section.
(function () {
  const LINKS_KEY = "prairierunCourseLinks";
  const DEADLINES_KEY = "prairierunDeadlines";
  const SOURCES = ["prairielearn", "gradescope", "canvas", "prairietest"];
  const SOURCE_LABELS = { prairielearn: "PrairieLearn", gradescope: "Gradescope", canvas: "Canvas", prairietest: "PrairieTest" };

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

  async function loadData() {
    const stored = await globalThis.PrairieRunExt.storageLocalGet([DEADLINES_KEY, LINKS_KEY]);
    return {
      items: Array.isArray(stored[DEADLINES_KEY]) ? stored[DEADLINES_KEY] : [],
      links: stored[LINKS_KEY] && typeof stored[LINKS_KEY] === "object" ? stored[LINKS_KEY] : {},
    };
  }

  function namesByCourseKey(items) {
    const names = new Map();
    for (const item of items || []) {
      if (item?.courseKey && item?.courseName && !names.has(item.courseKey)) {
        names.set(item.courseKey, item.courseName);
      }
    }
    return names;
  }

  function itemById(items) {
    const map = new Map();
    for (const item of items || []) {
      if (item?.id != null && !map.has(item.id)) map.set(item.id, item);
    }
    return map;
  }

  function describe(item) {
    if (!item) return "unknown item";
    const source = SOURCE_LABELS[item.source] || item.source || "unknown source";
    return `"${item.title || item.id}" (${source})`;
  }

  function buildTable(document, items, links, suggested, onConfirm) {
    const names = namesByCourseKey(items);
    const codes = [...new Set([...Object.keys(links), ...Object.keys(suggested)])].sort();
    const table = document.createElement("table");
    const header = document.createElement("tr");
    for (const label of ["Course", ...SOURCES.map((source) => SOURCE_LABELS[source]), "Linked"]) {
      const cell = document.createElement("th");
      cell.textContent = label;
      header.append(cell);
    }
    table.append(header);
    for (const code of codes) {
      const stored = links[code] || {};
      const proposed = suggested[code] || {};
      const row = document.createElement("tr");
      const codeCell = document.createElement("td");
      codeCell.textContent = code;
      row.append(codeCell);
      for (const source of SOURCES) {
        const cell = document.createElement("td");
        const keys = [...new Set([...(stored[source] || []), ...(proposed[source] || [])])];
        cell.textContent = keys.length
          ? keys.map((key) => names.get(key) || key).join(", ")
          : "—";
        row.append(cell);
      }
      const checkCell = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = stored.confirmed === true;
      checkbox.setAttribute("aria-label", `Link courses under ${code}`);
      checkbox.addEventListener("change", () => onConfirm(code, checkbox.checked));
      checkCell.append(checkbox);
      row.append(checkCell);
      table.append(row);
    }
    return { table, codes };
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
      const { items, links } = await loadData();
      const suggested = store.suggestCourseLinks(items);

      async function onConfirm(code, confirmed) {
        const current = (await loadData()).links;
        const entry = { ...(current[code] || {}), ...(suggested[code] || {}) };
        for (const source of SOURCES) {
          entry[source] = [...new Set([...(current[code]?.[source] || []), ...(suggested[code]?.[source] || [])])];
        }
        entry.confirmed = confirmed;
        await globalThis.PrairieRunExt.storageLocalSet({ [LINKS_KEY]: { ...current, [code]: entry } });
        await refresh();
      }

      const { table, codes } = buildTable(document, items, links, suggested, onConfirm);
      if (!codes.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "No courses seen yet. Sync a source first.";
        root.append(empty);
      } else {
        root.append(table);
      }

      const current = (await loadData()).links;
      const { nearMisses } = store.dedupe(items, current);
      const missHeader = document.createElement("h3");
      missHeader.textContent = "Possible duplicates";
      root.append(missHeader);
      if (!nearMisses.length) {
        const none = document.createElement("p");
        none.className = "muted";
        none.textContent = "No near-misses.";
        root.append(none);
      } else {
        const lookup = itemById(items);
        const list = document.createElement("ul");
        for (const miss of nearMisses) {
          const entry = document.createElement("li");
          entry.textContent = `${describe(lookup.get(miss.a))} vs ${describe(lookup.get(miss.b))}: ${miss.deltaMinutes} min apart (not merged).`;
          list.append(entry);
        }
        root.append(list);
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
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => {
      const section = document.getElementById("course-links");
      if (section) render(section);
    });
  }

  const api = { render };
  globalThis.PrairieRunOptionsCourses = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

// Dashboard Digest: upcoming deadlines across all sources, with direct links.
(function () {
  const DEADLINES_KEY = "prairierunDeadlines";
  const ASSIGNMENTS_KEY = "prairierunAssignments";
  const LINKS_KEY = "prairierunCourseLinks";
  const HIDDEN_CALENDAR_KEY = "prairierunHiddenFromCalendar";
  const REMOVED_DEADLINES_KEY = "prairierunRemovedDeadlines";
  const KEYWORD_FILTERS_KEY = "prairierunKeywordFilters";
  const SETTINGS_KEY = "prairierunSettings";
  const DEFAULT_LIMIT = 100;
  const DEFAULT_WINDOW_DAYS = 365;

  const SOURCE_BADGE = {
    prairielearn: "PrairieLearn",
    gradescope: "Gradescope",
    canvas: "Canvas",
    prairietest: "PrairieTest",
    courseweb: "Course Website",
    manual: "Manual",
  };

  function view() {
    return globalThis.PrairieRunView || null;
  }

  function dueMs(item) {
    if (item?.dueAt) {
      const t = Date.parse(item.dueAt);
      return Number.isFinite(t) ? t : null;
    }
    const local = String(item?.dueAtLocal || "");
    const match = local.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
    if (!match) return null;
    try {
      const iso = globalThis.PrairieRunModel?.localToUtc?.(`${match[1]} ${match[2]}:${match[3]}:00`, "America/Chicago");
      const t = Date.parse(iso || "");
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  }

  function isCompleted(item) {
    const api = view();
    if (api && typeof api.isCompleted === "function") return api.isCompleted(item);
    const status = item?.completionStatus ?? item?.status ?? "unknown";
    if (status === "completed") return true;
    const score = Number(item?.score);
    return Number.isFinite(score) && score > 95;
  }

  function itemUrl(item) {
    const api = view();
    if (api && typeof api.itemUrl === "function") return api.itemUrl(item) || "";
    return item?.url || item?.sourceUrl || "";
  }

  function courseLabel(item, links = null) {
    const api = view();
    if (api && typeof api.itemCourseCode === "function") {
      const code = api.itemCourseCode(item, links);
      if (code) return code;
    }
    const extract = api?.extractCourseCode || ((text) => {
      const match = String(text || "").match(/\b([A-Za-z]{2,4})\s*[-_]?\s*(\d{3}[A-Za-z0-9]{0,3})\b/);
      return match ? `${match[1].toUpperCase()} ${match[2].toUpperCase()}` : null;
    });
    const code = extract(item?.courseCode) || extract(item?.courseName) || extract(item?.courseKey) || extract(item?.url || item?.sourceUrl);
    if (code) return code;
    if (api && typeof api.itemCourseName === "function") {
      const name = api.itemCourseName(item);
      if (name) return name;
    }
    return item?.courseCode || item?.courseName || item?.courseKey || "";
  }

  function formatDue(item) {
    const api = view();
    if (api && typeof api.formatItemDue === "function") return api.formatItemDue(item);
    return item?.dueAt || item?.dueAtLocal || "";
  }

  function sourceBadge(item) {
    const api = view();
    if (api && typeof api.sourceBadge === "function") {
      const badge = api.sourceBadge(item);
      if (badge) return badge;
    }
    return SOURCE_BADGE[item?.source] || String(item?.source || "?").slice(0, 3).toUpperCase();
  }

  const SOURCE_PRECEDENCE = {
    prairielearn: 0,
    gradescope: 1,
    prairietest: 2,
    canvas: 3,
    courseweb: 4,
    manual: 5,
  };

  function sourceRank(source) {
    const rank = SOURCE_PRECEDENCE[source];
    return typeof rank === "number" ? rank : 99;
  }

  function normTitle(value) {
    let text = String(value || "").toLowerCase();
    text = text.replace(/\(.*?\bcrn\s*\d+.*?\)\s*$/u, "");
    text = text.replace(/[^\p{L}\p{N} ]+/gu, "");
    return text.replace(/\s+/g, " ").trim();
  }

  function titlesMatch(a, b) {
    const ta = normTitle(a);
    const tb = normTitle(b);
    if (!ta || !tb) return false;
    if (ta === tb) return true;
    if (ta.replace(/\s+/g, "") === tb.replace(/\s+/g, "")) return true;
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    if (short.length >= 3 && long.startsWith(short)) {
      const nextChar = long.charAt(short.length);
      return nextChar === " " || nextChar === "";
    }
    return false;
  }

  function deduplicateDigestItems(items, links = null) {
    if (!items || items.length <= 1) return items || [];
    const kept = [];
    const store = globalThis.PrairieRunDeadlineStore;

    for (const candidate of items) {
      const cCourse = (courseLabel(candidate, links) || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      const cDue = dueMs(candidate);
      let duplicateIndex = -1;

      for (let i = 0; i < kept.length; i += 1) {
        const existing = kept[i];
        if (existing.source === candidate.source) continue;
        const eCourse = (courseLabel(existing, links) || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
        if (!cCourse || !eCourse) continue;
        const sameCourse = store && typeof store.sameCourseFamily === "function"
          ? store.sameCourseFamily(cCourse, eCourse)
          : (cCourse === eCourse);
        if (!sameCourse) continue;
        if (!titlesMatch(existing.title, candidate.title)) continue;
        const eDue = dueMs(existing);
        if (cDue != null && eDue != null && Math.abs(cDue - eDue) <= 24 * 60 * 60 * 1000) {
          duplicateIndex = i;
          break;
        }
      }

      if (duplicateIndex === -1) {
        kept.push(candidate);
      } else {
        const existing = kept[duplicateIndex];
        const existingRank = sourceRank(existing.source);
        const candidateRank = sourceRank(candidate.source);
        if (candidateRank < existingRank) {
          kept[duplicateIndex] = candidate;
        }
      }
    }
    return kept;
  }

  function matchesKeywords(title, keywords) {
    if (!title || !Array.isArray(keywords) || !keywords.length) return false;
    const lower = String(title).toLowerCase();
    return keywords.some((kw) => {
      const k = String(kw || "").toLowerCase().trim();
      return k && lower.includes(k);
    });
  }

  // Pure helper: next dated, incomplete items within the window, capped.
  function selectDigestItems(items, { now = new Date(), limit = DEFAULT_LIMIT, windowDays = DEFAULT_WINDOW_DAYS, links = null, removedDeadlines = [], keywordFilters = [] } = {}) {
    const start = now instanceof Date ? now.getTime() : Date.parse(now);
    const end = windowDays != null ? start + Math.max(0, Number(windowDays) || 0) * 24 * 60 * 60 * 1000 : Infinity;
    const removedSet = new Set(removedDeadlines || []);
    const rows = [];
    for (const item of items || []) {
      if (!item || isCompleted(item)) continue;
      if (item.id && (removedSet.has(item.id) || (item.aliases || []).some((a) => removedSet.has(a)))) continue;
      const title = String(item.title || item.name || "");
      if (matchesKeywords(title, keywordFilters)) continue;
      const t = dueMs(item);
      if (t === null) continue;
      // Include anything due later today through the window; drop fully past.
      if (t < start - 60 * 60 * 1000) continue;
      if (Number.isFinite(end) && t > end) continue;
      rows.push(item);
    }
    rows.sort((a, b) => {
      const da = dueMs(a);
      const db = dueMs(b);
      if (da !== db) return da - db;
      return String(a.title || "").localeCompare(String(b.title || ""));
    });
    const deduped = deduplicateDigestItems(rows, links);
    return deduped.slice(0, Math.max(0, Number(limit) || DEFAULT_LIMIT));
  }

  function make(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "className") node.className = value;
      else if (value != null) node.setAttribute(key, value);
    }
    if (text != null) node.textContent = text;
    return node;
  }

  function renderRow(item, links = null, options = {}) {
    const { isCalendarHidden = false, onToggleHide = null, onRemove = null } = options;
    const row = make("li", {
      className: `prr-digest-row${isCalendarHidden ? " prr-digest-row--calendar-hidden" : ""}`,
    });
    row.append(make("span", { className: "prr-digest-badge" }, sourceBadge(item)));
    const course = courseLabel(item, links);
    if (course) row.append(make("span", { className: "prr-digest-course" }, course));
    const href = itemUrl(item);
    const title = String(item.title || "Untitled");
    if (href) {
      const link = make("a", {
        className: "prr-digest-title",
        href,
        target: "_blank",
        rel: "noreferrer",
      }, title);
      row.append(link);
    } else {
      row.append(make("span", { className: "prr-digest-title" }, title));
    }
    row.append(make("span", { className: "prr-digest-due" }, formatDue(item)));

    const actions = make("div", { className: "prr-digest-actions" });

    // Hide from calendar button (calendar icon with diagonal slash)
    const hideBtn = make("button", {
      type: "button",
      className: `prr-digest-action-btn prr-digest-action-hide${isCalendarHidden ? " prr-digest-action-btn--active" : ""}`,
      title: isCalendarHidden ? "Unhide from calendar" : "Hide from calendar",
      "aria-label": isCalendarHidden ? "Unhide from calendar" : "Hide from calendar",
      "aria-pressed": isCalendarHidden ? "true" : "false",
    });
    hideBtn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="1.5"></rect><line x1="2" y1="7" x2="14" y2="7"></line><line x1="5" y1="1.5" x2="5" y2="3.5"></line><line x1="11" y1="1.5" x2="11" y2="3.5"></line><line x1="2" y1="14" x2="14" y2="2"></line></svg>`;
    if (typeof onToggleHide === "function") {
      hideBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onToggleHide(item);
      });
    }
    actions.append(hideBtn);

    // Remove button (trash icon)
    const removeBtn = make("button", {
      type: "button",
      className: "prr-digest-action-btn prr-digest-action-remove",
      title: "Remove",
      "aria-label": "Remove",
    });
    removeBtn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h10"></path><path d="M5 4V2.5A.5.5 0 0 1 5.5 2h5a.5.5 0 0 1 .5.5V4"></path><path d="M4 4l.8 9.2a1 1 0 0 0 1 .8h4.4a1 1 0 0 0 1-.8L12 4"></path><line x1="6.5" y1="7" x2="6.5" y2="11"></line><line x1="9.5" y1="7" x2="9.5" y2="11"></line></svg>`;
    if (typeof onRemove === "function") {
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onRemove(item);
      });
    }
    actions.append(removeBtn);

    row.append(actions);
    return row;
  }

  async function loadData() {
    const stored = await globalThis.PrairieRunExt.storageLocalGet([
      DEADLINES_KEY,
      ASSIGNMENTS_KEY,
      LINKS_KEY,
      HIDDEN_CALENDAR_KEY,
      REMOVED_DEADLINES_KEY,
      KEYWORD_FILTERS_KEY,
      SETTINGS_KEY,
    ]);
    let items = [];
    if (Array.isArray(stored[DEADLINES_KEY])) items = stored[DEADLINES_KEY];
    else if (Array.isArray(stored[ASSIGNMENTS_KEY])) items = stored[ASSIGNMENTS_KEY];
    const links = stored[LINKS_KEY] && typeof stored[LINKS_KEY] === "object" ? stored[LINKS_KEY] : {};
    const hiddenCalendar = Array.isArray(stored[HIDDEN_CALENDAR_KEY]) ? stored[HIDDEN_CALENDAR_KEY] : [];
    const removedDeadlines = Array.isArray(stored[REMOVED_DEADLINES_KEY]) ? stored[REMOVED_DEADLINES_KEY] : [];
    const keywordFilters = [
      ...(Array.isArray(stored[SETTINGS_KEY]?.keywordFilters) ? stored[SETTINGS_KEY].keywordFilters : []),
      ...(Array.isArray(stored[KEYWORD_FILTERS_KEY]) ? stored[KEYWORD_FILTERS_KEY] : []),
    ];
    return { items, links, hiddenCalendar, removedDeadlines, keywordFilters };
  }

  async function render(section) {
    if (!section || typeof document === "undefined") return;
    let root = section.querySelector("[data-prr-digest]");
    if (!root) {
      root = make("div", { "data-prr-digest": "1" });
      section.append(root);
    }

    async function handleToggleHide(item) {
      if (!item?.id) return;
      const stored = await globalThis.PrairieRunExt.storageLocalGet(HIDDEN_CALENDAR_KEY);
      const current = Array.isArray(stored[HIDDEN_CALENDAR_KEY]) ? [...stored[HIDDEN_CALENDAR_KEY]] : [];
      const index = current.indexOf(item.id);
      const isHiding = index === -1;
      if (isHiding) {
        current.push(item.id);
        for (const alias of item.aliases || []) {
          if (!current.includes(alias)) current.push(alias);
        }
      } else {
        current.splice(index, 1);
        for (const alias of item.aliases || []) {
          const ai = current.indexOf(alias);
          if (ai !== -1) current.splice(ai, 1);
        }
      }
      await globalThis.PrairieRunExt.storageLocalSet({ [HIDDEN_CALENDAR_KEY]: current });

      try {
        await globalThis.PrairieRunExt.runtimeSendMessage?.({
          type: "PRAIRIERUN_TOGGLE_CALENDAR_HIDE",
          item,
          hidden: isHiding,
        });
      } catch { /* best effort */ }

      await refresh();
    }

    async function handleRemove(item) {
      if (!item?.id) return;
      const stored = await globalThis.PrairieRunExt.storageLocalGet([
        REMOVED_DEADLINES_KEY,
        DEADLINES_KEY,
        ASSIGNMENTS_KEY,
      ]);
      const currentRemoved = Array.isArray(stored[REMOVED_DEADLINES_KEY]) ? [...stored[REMOVED_DEADLINES_KEY]] : [];
      if (!currentRemoved.includes(item.id)) currentRemoved.push(item.id);
      for (const alias of item.aliases || []) {
        if (!currentRemoved.includes(alias)) currentRemoved.push(alias);
      }

      const currentDeadlines = Array.isArray(stored[DEADLINES_KEY])
        ? stored[DEADLINES_KEY].filter((d) => d.id !== item.id && !(item.aliases || []).includes(d.id))
        : [];
      const currentAssignments = Array.isArray(stored[ASSIGNMENTS_KEY])
        ? stored[ASSIGNMENTS_KEY].filter((a) => a.id !== item.id && !(item.aliases || []).includes(a.id))
        : [];

      await globalThis.PrairieRunExt.storageLocalSet({
        [REMOVED_DEADLINES_KEY]: currentRemoved,
        [DEADLINES_KEY]: currentDeadlines,
        [ASSIGNMENTS_KEY]: currentAssignments,
      });

      try {
        await globalThis.PrairieRunExt.runtimeSendMessage?.({
          type: "PRAIRIERUN_REMOVE_ASSIGNMENT",
          item,
        });
      } catch { /* best effort */ }

      await refresh();
    }

    async function refresh() {
      root.textContent = "";
      let items = [];
      let links = {};
      let hiddenCalendarSet = new Set();
      let removedDeadlines = [];
      let keywordFilters = [];
      try {
        const data = await loadData();
        items = data.items;
        links = data.links;
        hiddenCalendarSet = new Set(data.hiddenCalendar || []);
        removedDeadlines = data.removedDeadlines || [];
        keywordFilters = data.keywordFilters || [];
      } catch (error) {
        root.append(make("p", { className: "muted" }, error?.message || "Could not load digest."));
        return;
      }
      const selected = selectDigestItems(items, { links, removedDeadlines, keywordFilters });
      if (!selected.length) {
        root.append(make("p", { className: "muted" }, "Nothing upcoming."));
        return;
      }
      const list = make("ul", { className: "prr-digest-list" });
      for (const item of selected) {
        const isCalendarHidden = hiddenCalendarSet.has(item.id) || (item.aliases || []).some((a) => hiddenCalendarSet.has(a));
        list.append(renderRow(item, links, {
          isCalendarHidden,
          onToggleHide: handleToggleHide,
          onRemove: handleRemove,
        }));
      }
      root.append(list);
    }

    await refresh();
    try {
      globalThis.PrairieRunExt?.storageOnChanged?.((changes, area) => {
        if (area && area !== "local") return;
        if (
          changes[DEADLINES_KEY] ||
          changes[ASSIGNMENTS_KEY] ||
          changes[LINKS_KEY] ||
          changes[HIDDEN_CALENDAR_KEY] ||
          changes[REMOVED_DEADLINES_KEY] ||
          changes[KEYWORD_FILTERS_KEY] ||
          changes[SETTINGS_KEY]
        ) {
          refresh();
        }
      });
    } catch { /* ignore */ }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => {
      const section = document.getElementById("assignment-digest");
      if (section) render(section);
    });
  }

  const api = {
    selectDigestItems,
    dueMs,
    courseLabel,
    renderRow,
    render,
    deduplicateDigestItems,
    HIDDEN_CALENDAR_KEY,
    REMOVED_DEADLINES_KEY,
  };
  globalThis.PrairieRunOptionsDigest = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

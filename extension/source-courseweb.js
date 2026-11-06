// User-selected UIUC course pages. Read-only: fetches only URLs explicitly
// saved by the user, never follows links/crawls, and extracts only dates in
// elements identified as due/deadline fields.
(function () {
  const ORIGIN_PATTERN = "https://*.illinois.edu/*";
  const MAX_PAGES = 25;
  const MAX_ITEMS_PER_PAGE = 100;

  function safeCourseUrl(value) {
    try {
      const url = new URL(String(value || "").trim());
      if (url.protocol !== "https:" || !url.hostname.endsWith(".illinois.edu")) return null;
      url.hash = "";
      return url.href;
    } catch { return null; }
  }

  function courseCodeFrom(text) {
    const match = String(text || "").toUpperCase().match(/\b([A-Z]{2,4})\s*[- ]?\s*(\d{3}[A-Z0-9]{0,3})\b/);
    return match ? `${match[1]} ${match[2]}` : null;
  }

  function parseDate(raw, baseUrl) {
    const value = String(raw || "").trim();
    if (!value) return null;
    let termYear = new Date().getFullYear();
    const term = String(baseUrl || "").match(/\b(?:fa|sp|su|wi)(20\d{2})\b/i);
    if (term) termYear = Number(term[1]);
    // Keep authored timezone information as-is. Dates without a zone on UIUC
    // course pages are interpreted in the campus timezone, regardless of the
    // student's device timezone.
    if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
      const timestamp = Date.parse(value);
      if (!Number.isNaN(timestamp)) return new Date(timestamp).toISOString();
    }
    const toCentral = (year, month, day, hour = 23, minute = 59) => {
      const local = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
      try { return globalThis.PrairieRunModel?.localToUtc?.(local, "America/Chicago") || null; }
      catch { return null; }
    };
    // Accept clearly written dates with a year, optionally followed by a time.
    const match = value.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T,]+(\d{1,2})[:.](\d{2})\s*(AM|PM)?)?\b/i);
    if (match) {
      let hour = Number(match[4] || 23);
      const minute = Number(match[5] || (match[4] ? 59 : 59));
      if (match[6]?.toUpperCase() === "PM" && hour < 12) hour += 12;
      if (match[6]?.toUpperCase() === "AM" && hour === 12) hour = 0;
      return toCentral(Number(match[1]), Number(match[2]), Number(match[3]), hour, minute);
    }
    const numeric = value.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{4}))?(?:\s+(?:at\s+)?(\d{1,2})[:.](\d{2})\s*(AM|PM))?\b/i);
    if (numeric) {
      let hour = Number(numeric[4] || 23);
      if (numeric[6]?.toUpperCase() === "PM" && hour < 12) hour += 12;
      if (numeric[6]?.toUpperCase() === "AM" && hour === 12) hour = 0;
      return toCentral(Number(numeric[3] || termYear), Number(numeric[1]), Number(numeric[2]), hour, Number(numeric[5] || 59));
    }
    // Month-name dates without a year use the course page's current year.
    const short = value.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(AM|PM))?\b/i);
    if (!short) return null;
    const year = Number(short[3] || termYear);
    let hour = Number(short[4] || 23);
    const minute = Number(short[5] || 59);
    if (short[6]?.toUpperCase() === "PM" && hour < 12) hour += 12;
    if (short[6]?.toUpperCase() === "AM" && hour === 12) hour = 0;
    const month = new Date(`${short[1]} 1, 2000`).getMonth();
    return toCentral(year, month + 1, Number(short[2]), hour, minute);
  }

  function parseCoursePage(document, pageUrl) {
    const page = new URL(pageUrl);
    const title = String(document?.querySelector?.("h1")?.textContent || document?.title || page.hostname).replace(/\s+/g, " ").trim();
    const dueNodes = [...(document?.querySelectorAll?.("time[datetime], [data-due-date], tr, li, p, [class*='due'], [id*='due'], [class*='deadline'], [id*='deadline']") || [])];
    const headings = [...(document?.querySelectorAll?.("h1,h2,h3,h4,h5,h6") || [])];
    const rows = [];
    const seen = new Set();
    for (const node of dueNodes) {
      const context = node.closest?.("li, tr, article, [class*='assignment'], [id*='assignment'], [class*='event'], [id*='event']") || (node.matches?.("p") ? node : node.parentElement) || node;
      const text = String(context.textContent || "").replace(/\s+/g, " ").trim();
      const marker = `${node.getAttribute?.("class") || ""} ${node.getAttribute?.("id") || ""}`;
      const isExplicitDueField = node.hasAttribute?.("data-due-date") || /\b(due|deadline)\b/i.test(marker);
      const priorHeadings = headings.filter((heading) => heading !== node && (heading.compareDocumentPosition(node) & 4));
      const activeHeading = priorHeadings[priorHeadings.length - 1];
      const inDeadlineSection = /upcoming\s+(?:deadlines|assignments)|deadlines\s+and\s+events/i.test(String(activeHeading?.textContent || ""));
      if (!isExplicitDueField && !/\b(due|deadline)\b/i.test(text) && !inDeadlineSection) continue;
      const rawDate = node.getAttribute?.("datetime") || node.getAttribute?.("data-due-date") || node.getAttribute?.("content") || node.textContent;
      const dueAt = parseDate(rawDate, pageUrl) || parseDate(text, pageUrl);
      if (!dueAt) continue;
      const titleNode = context.querySelector?.("h3,h4,a,h2,h1") || activeHeading || node;
      let assignmentTitle = String(titleNode.textContent || "").replace(/\s+/g, " ").trim();
      assignmentTitle = assignmentTitle.replace(/\b(due|deadline)\b\s*:?.*$/i, "").trim();
      if (!assignmentTitle || assignmentTitle.length > 180 || assignmentTitle.length < 2) assignmentTitle = text.slice(0, 140);
      const key = `${assignmentTitle.toLowerCase()}|${dueAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ title: assignmentTitle, dueAt, sourceText: text.slice(0, 500) });
      if (rows.length >= MAX_ITEMS_PER_PAGE) break;
    }
    return { courseName: title, rows };
  }

  async function parseWithContext(ctx, html, url) {
    if (ctx?.parseHtml) return ctx.parseHtml("courseweb.page", html, url);
    if (typeof DOMParser !== "undefined") return parseCoursePage(new DOMParser().parseFromString(String(html), "text/html"), url);
    throw new Error("Course page parser is unavailable.");
  }

  function makeItem(row, course, checkedAt) {
    const id = `courseweb:${encodeURIComponent(course.url)}:${encodeURIComponent(row.title.toLowerCase())}:${row.dueAt.slice(0, 10)}`;
    const partial = {
      id, source: "courseweb", kind: "assignment", courseKey: `courseweb:${course.url}`,
      courseName: course.courseName, courseCode: course.courseCode, title: row.title,
      dueAt: row.dueAt, allDay: false, startAt: null, endAt: null, lateDueAt: null,
      location: null, status: "unknown", score: null, url: course.url,
      sourceUrls: [course.url], aliases: [], rawDueText: row.sourceText,
      sourceTimezone: null, fetchedAt: checkedAt,
    };
    return globalThis.PrairieRunModel?.makeDeadlineItem ? globalThis.PrairieRunModel.makeDeadlineItem(partial) : partial;
  }

  async function sync(ctx = {}) {
    const checkedAt = (ctx.now instanceof Date ? ctx.now : new Date()).toISOString();
    const sites = [...new Set((ctx.settings?.courseWebsites || []).map(safeCourseUrl).filter(Boolean))].slice(0, MAX_PAGES);
    if (!sites.length) return { status: "ok", items: [], courses: [], checkedAt };
    const items = [];
    const courses = [];
    const errors = [];
    for (const url of sites) {
      try {
        const response = await ctx.fetchPage(url);
        if (response?.ok === false) throw new Error(`Page request failed (${response.status || "HTTP error"}).`);
        const parsed = await parseWithContext(ctx, response.text, response.url || url);
        const pageUrl = new URL(url);
        const pathCode = pageUrl.pathname.match(/\/([a-z]{2,4}\d{3}[a-z0-9]{0,3})(?:\/|$)/i);
        const hostCode = pageUrl.hostname.match(/\b([a-z]{2,4}\d{3}[a-z0-9]{0,3})\./i);
        const course = {
          url,
          courseName: parsed.courseName || pageUrl.hostname,
          courseCode: courseCodeFrom(pathCode?.[1]) || courseCodeFrom(hostCode?.[1]) || courseCodeFrom(parsed.courseName || ""),
        };
        courses.push({ id: encodeURIComponent(url), courseKey: `courseweb:${url}`, courseCode: course.courseCode, courseName: course.courseName, url, source: "courseweb" });
        (parsed.rows || []).forEach((row) => items.push(makeItem(row, course, checkedAt)));
      } catch (error) {
        errors.push(`${new URL(url).hostname}: ${error?.message || String(error)}`);
      }
    }
    if (errors.length) return { status: "error", items: [], error: errors.join("; "), checkedAt };
    return { status: "ok", items, courses, checkedAt };
  }

  const adapter = {
    id: "courseweb", label: "UIUC course websites", origins: [ORIGIN_PATTERN],
    signInUrl: "https://courses.illinois.edu/", parsers: { page: parseCoursePage },
    isSignedOut: (result) => Boolean(result?.redirected && !/\.illinois\.edu$/i.test(new URL(result.url).hostname)), sync,
  };
  adapter.safeCourseUrl = safeCourseUrl;
  adapter.parseCoursePage = parseCoursePage;
  adapter.parseDate = parseDate;
  adapter.courseCodeFrom = courseCodeFrom;
  globalThis.PrairieRunCourseWebSource = adapter;
  try { globalThis.PrairieRunSources?.register(adapter); } catch { /* test reload */ }
  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
})();

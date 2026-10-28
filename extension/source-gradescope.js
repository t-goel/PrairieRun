// Gradescope source adapter (PR 5 owns internals).
// Read-only: GETs the logged-in account dashboard and each current-term
// student course page, then maps assignment rows to DeadlineItems.
// Never POSTs, never submits forms, never clicks the js-submitAssignment
// buttons (their data-assignment-id attribute is read only).
// Selectors below follow the unofficial nyuoss/gradescope-api and
// Matut-E/gradescope-to-Cal structure; they are UNVERIFIED on a live UIUC
// page, so every selector lives in a named constant near the top.
(function () {
  const ORIGIN = "https://www.gradescope.com";
  const ACCOUNT_URL = `${ORIGIN}/account`;
  const SIGN_IN_URL = `${ORIGIN}/login`;
  const MAX_COURSES = 15;

  // Named selectors (unverified on UIUC; see note above).
  const SEL_ACCOUNT_SHOW = "#account-show";
  const SEL_PAGE_HEADING = ".pageHeading, h1.pageHeading, h2.pageHeading";
  const SEL_COURSE_LIST = "div.courseList";
  const SEL_TERM = ".courseList--term";
  const SEL_COURSES_FOR_TERM = ".courseList--coursesForTerm";
  const SEL_COURSE_BOX = "a.courseBox";
  const SEL_COURSE_BOX_NEW = ".courseBox-new";
  const SEL_SHORT_NAME = ".courseBox--shortname";
  const SEL_FULL_NAME = ".courseBox--name";
  const SEL_COURSE_TITLE = ".courseHeader--title, h1";
  const SEL_DATA_ROW = 'tr[role="row"]';
  const SEL_ROW_FALLBACK = "table tbody tr";
  const SEL_COLUMN_HEADER = '[role="columnheader"], th[scope="col"]';
  const SEL_DROPZONE = ".dropzonePreview";
  const SEL_SUBMISSION_LINK = 'a[href*="/submissions/"]';
  const SEL_SUBMIT_BUTTON = "button.js-submitAssignment[data-assignment-id]";
  const SEL_RELEASE_TIME = "time.submissionTimeChart--releaseDate[datetime]";
  const SEL_DUE_TIME = "time.submissionTimeChart--dueDate[datetime]";

  const COURSE_ID_FROM_HREF = /^\/courses\/(\d+)/;
  const SUBMISSION_ID_FROM_HREF = /^\/courses\/\d+\/assignments\/(\d+)\/submissions\//;
  const SCORE_TEXT = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/;
  // Term designators (e.g. "Fall 2026", "FA2026", "SP26") must not be treated
  // as subject + course code.
  const TERM_SUBJECTS = new Set([
    "FA", "FALL", "SP", "SPRING", "SU", "SUMMER", "WI", "WIN", "WINTER", "AU", "AUTUMN",
  ]);
  // Course codes may sit after a term/prefix and separators that are word
  // characters in JS (`fa26_cs425`), so do not rely on `\b`. Match SUBJ +
  // 3 digits + up to 3 trailing section chars, aligned with
  // deadline-store.normalizeCourseCode / model.courseCodeFromName.
  const COURSE_CODE = /(?:^|[^A-Z0-9])([A-Z]{2,4})[\s_-]*(\d{3}[A-Z0-9]{0,3})(?![A-Z0-9])/;
  const COURSE_CODE_GLOBAL = /(?:^|[^A-Z0-9])([A-Z]{2,4})[\s_-]*(\d{3}[A-Z0-9]{0,3})(?![A-Z0-9])/gi;
  const NO_ASSIGNMENTS_MESSAGE = /no assignments/i;

  function textOf(node) {
    return String(node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  // Gradescope datetime values carry an explicit UTC offset, either ISO
  // ("2026-10-17T23:59:00-05:00") or space-separated
  // ("2026-11-03 23:59:00 -0600"). Normalize the latter to ISO before
  // constructing a Date so parsing never depends on implementation-defined
  // date-string fallback. Returns an ISO-8601 UTC instant or null.
  function parseGradescopeInstant(raw) {
    if (raw == null) return null;
    let value = String(raw).trim();
    if (!value) return null;
    const spaced = value.match(/^(\d{4}-\d{2}-\d{2})[ ](\d{2}:\d{2}(?::\d{2})?)[ ]([+-])(\d{2})(\d{2})$/);
    if (spaced) {
      const clock = spaced[2].length === 5 ? `${spaced[2]}:00` : spaced[2];
      value = `${spaced[1]}T${clock}${spaced[3]}${spaced[4]}:${spaced[5]}`;
    }
    const millis = new Date(value).getTime();
    if (Number.isNaN(millis)) return null;
    return new Date(millis).toISOString();
  }

  function courseIdFromHref(href) {
    const match = String(href || "").match(COURSE_ID_FROM_HREF);
    return match ? match[1] : null;
  }

  function assignmentIdFromSubmissionHref(href) {
    const match = String(href || "").match(SUBMISSION_ID_FROM_HREF);
    return match ? match[1] : null;
  }

  // Section-aware course-box collection: walk headings and course boxes in
  // document order, tracking the current section. Keeps only boxes under a
  // "Student Courses" heading. With no headings at all, everything counts
  // as student.
  function collectStudentBoxes(root) {
    const headings = [...root.querySelectorAll(SEL_PAGE_HEADING)];
    const boxes = [...root.querySelectorAll(SEL_COURSE_BOX)];
    if (!headings.length) return boxes;
    const ordered = [...root.querySelectorAll(`${SEL_PAGE_HEADING}, ${SEL_COURSE_BOX}`)];
    let section = null;
    const kept = [];
    for (const node of ordered) {
      if (node.matches && node.matches(SEL_PAGE_HEADING)) {
        const heading = textOf(node).toLowerCase();
        if (heading.includes("student") || heading.includes("your courses") || heading === "courses") section = "student";
        else if (heading.includes("instructor")) section = "instructor";
        else section = null;
      } else if (section === "student" && boxes.includes(node)) {
        kept.push(node);
      }
    }
    return kept.length ? kept : boxes;
  }

  // Current term only: the first .courseList--term block and its sibling
  // .courseList--coursesForTerm container. Falls back to all student boxes
  // when the page has no term structure (e.g. a test fixture or a layout
  // variant), so a missing term marker can never silently drop courses.
  function collectCurrentTermBoxes(root, studentBoxes) {
    const lists = [...root.querySelectorAll(SEL_COURSE_LIST)];
    if (!lists.length) return { term: null, boxes: studentBoxes };
    const wanted = new Set(studentBoxes);
    const hasStudentBox = (list) =>
      [...list.querySelectorAll(SEL_COURSE_BOX)].some((box) => wanted.has(box));
    for (const list of lists) {
      // Term blocks also exist under "Instructor Courses"; only the student
      // section's first term block is the current term.
      if (!hasStudentBox(list)) continue;
      const termNode = list.querySelector(SEL_TERM);
      if (!termNode) continue;
      const term = textOf(termNode) || null;
      let container = termNode.nextElementSibling;
      while (container && !(container.matches && container.matches(SEL_COURSES_FOR_TERM))) {
        container = container.nextElementSibling;
      }
      if (!container) continue;
      const boxes = [...container.querySelectorAll(SEL_COURSE_BOX)].filter((box) => wanted.has(box));
      return { term, boxes };
    }
    return { term: null, boxes: studentBoxes };
  }

  function parseAccount(document, url) {
    void url;
    const root = document?.querySelector?.(SEL_ACCOUNT_SHOW);
    if (!root) return { signedOut: true, courses: [] };
    const studentBoxes = collectStudentBoxes(root);
    const { term, boxes } = collectCurrentTermBoxes(root, studentBoxes);
    const courses = [];
    for (const box of boxes) {
      if (box.matches && box.matches(SEL_COURSE_BOX_NEW)) continue;
      if (box.querySelector && box.querySelector(SEL_COURSE_BOX_NEW)) continue;
      const id = courseIdFromHref(box.getAttribute && box.getAttribute("href"));
      if (!id) continue;
      const shortName = textOf(box.querySelector ? box.querySelector(SEL_SHORT_NAME) : null);
      const fullName = textOf(box.querySelector ? box.querySelector(SEL_FULL_NAME) : null);
      courses.push({ id, shortName, fullName, term });
    }
    return { signedOut: false, courses };
  }

  function isHeaderRow(row, index) {
    if (row.querySelector && row.querySelector(SEL_COLUMN_HEADER)) return true;
    if (index === 0 && row.querySelectorAll && row.querySelectorAll("th").length >= 2) return true;
    return false;
  }

  function parseCourse(document, url) {
    const courseId = courseIdFromHref(url ? new URL(url).pathname : "") || "unknown";
    const titleNode = document?.querySelector ? document.querySelector(SEL_COURSE_TITLE) : null;
    const courseName = textOf(titleNode);

    let rows = document?.querySelectorAll ? [...document.querySelectorAll(SEL_DATA_ROW)] : [];
    if (!rows.length && document?.querySelectorAll) {
      rows = [...document.querySelectorAll(SEL_ROW_FALLBACK)];
    }

    const parsed = [];
    rows.forEach((row, index) => {
      if (isHeaderRow(row, index)) return;
      if (row.matches && row.matches(SEL_DROPZONE)) return;
      if (row.querySelector && row.querySelector(SEL_DROPZONE)) return;

      const cells = row.children ? [...row.children] : [];
      if (!cells.length) return;

      const titleCell = cells[0];
      const titleLink = titleCell?.querySelector ? titleCell.querySelector("a") : null;
      const submissionLink = row.querySelector ? row.querySelector(SEL_SUBMISSION_LINK) : null;
      const submitButton = row.querySelector ? row.querySelector(SEL_SUBMIT_BUTTON) : null;

      const title = textOf(titleLink || titleCell);
      if (!title) return;

      const submissionHref = (submissionLink || titleLink)?.getAttribute?.("href") || "";
      const assignmentIdFromLink = assignmentIdFromSubmissionHref(submissionHref);
      const assignmentIdFromBtn = submitButton?.getAttribute?.("data-assignment-id") || null;
      const assignmentId = assignmentIdFromLink || assignmentIdFromBtn || null;

      const statusCell = cells.length >= 2 ? cells[1] : null;
      const statusText = textOf(statusCell) || null;

      const dateCell = cells.length >= 3 ? cells[2] : null;
      const dateScope = dateCell || row;
      const releaseNode = dateScope.querySelector ? dateScope.querySelector(SEL_RELEASE_TIME) : null;
      const dueNodes = dateScope.querySelectorAll ? [...dateScope.querySelectorAll(SEL_DUE_TIME)] : [];
      const releaseAt = parseGradescopeInstant(releaseNode?.getAttribute?.("datetime"));
      const dueAt = dueNodes.length ? parseGradescopeInstant(dueNodes[0].getAttribute("datetime")) : null;
      const lateDueAt = dueNodes.length > 1 ? parseGradescopeInstant(dueNodes[1].getAttribute("datetime")) : null;
      const rawDueText = textOf(dateCell) || null;

      parsed.push({ title, assignmentId, statusText, releaseAt, dueAt, lateDueAt, rawDueText, courseId });
    });
    return { courseName, rows: parsed };
  }

  // Extract a course code from a Gradescope short name, full name, or page
  // title. Returns "CS 425" / "CS 425DK" style (space after subject) or null.
  // Skips term designators such as "Fall 2026", "FA2026", "SP 2026", "FA26".
  function courseCodeFromLabel(label) {
    const text = String(label || "").toUpperCase();
    if (!text) return null;
    for (const match of text.matchAll(COURSE_CODE_GLOBAL)) {
      const subj = match[1];
      const num = match[2];
      if (TERM_SUBJECTS.has(subj) && /^20\d{2}$|^\d{2}$/.test(num)) continue;
      return `${subj} ${num}`;
    }
    return null;
  }

  // Prefer shortName, then fullName, then the course-page heading. Title-only
  // short names ("Distributed Systems") still resolve when the full name or
  // page title carries the code.
  function resolveCourseCode(course, pageCourseName) {
    for (const candidate of [course?.shortName, course?.fullName, pageCourseName]) {
      const code = courseCodeFromLabel(candidate);
      if (code) return code;
    }
    return null;
  }

  function resolveCourseName(course, pageCourseName) {
    return String(course?.shortName || course?.fullName || pageCourseName || "").trim();
  }

  // Back-compat alias used by older tests / call sites.
  function courseCodeFromShortName(shortName) {
    return courseCodeFromLabel(shortName);
  }

  function slugifyTitle(title) {
    const slug = String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled";
    return slug;
  }

  function statusFromText(statusText) {
    const text = String(statusText || "");
    const score = text.match(SCORE_TEXT);
    if (score) {
      const earned = Number(score[1]);
      const total = Number(score[2]);
      const value = total > 0 && Number.isFinite(earned) ? (earned / total) * 100 : null;
      return { status: "graded", score: value };
    }
    if (/submitted/i.test(text)) return { status: "submitted", score: null };
    if (/no submission/i.test(text)) return { status: "not_started", score: null };
    return { status: "unknown", score: null };
  }

  function rowToDeadlineItem(row, course, checkedAt, pageCourseName) {
    const courseId = course.id;
    const url = row.assignmentId
      ? `${ORIGIN}/courses/${courseId}/assignments/${row.assignmentId}`
      : `${ORIGIN}/courses/${courseId}`;
    const id = row.assignmentId
      ? `gs:${courseId}:${row.assignmentId}`
      : `gs:${courseId}:t:${slugifyTitle(row.title)}`;
    // Rows without a Gradescope assignment id get a title-derived id that is
    // stable only while the title is unchanged; mark that in rawDueText.
    const rawDueText = row.assignmentId
      ? row.rawDueText
      : (row.rawDueText ? `${row.rawDueText} [unstableId:true]` : "[unstableId:true]");
    const { status, score } = statusFromText(row.statusText);
    const courseName = resolveCourseName(course, pageCourseName);
    const courseCode = resolveCourseCode(course, pageCourseName);
    const model = globalThis.PrairieRunModel;
    const partial = {
      id,
      source: "gradescope",
      kind: "assignment",
      courseKey: `gradescope:${courseId}`,
      courseName,
      courseCode,
      title: row.title,
      dueAt: row.dueAt,
      allDay: false,
      startAt: row.releaseAt,
      endAt: null,
      lateDueAt: row.lateDueAt,
      location: null,
      status,
      score,
      url,
      sourceUrls: [url],
      aliases: [],
      rawDueText,
      sourceTimezone: null,
      fetchedAt: checkedAt,
    };
    if (model?.makeDeadlineItem) return model.makeDeadlineItem(partial);
    return { ...partial, sourceUrls: [...partial.sourceUrls], aliases: [] };
  }

  function isSignedOut(fetchResult) {
    if (!fetchResult) return false;
    try {
      if (new URL(String(fetchResult.url)).pathname === "/login") return true;
    } catch {
      // Fall through to the body sniffing below.
    }
    const text = String(fetchResult.text || "");
    return !/id="account-show"/.test(text) && /action="\/login"/.test(text);
  }

  async function parseWithContext(ctx, parserKey, html, url) {
    if (ctx?.parseHtml) return ctx.parseHtml(parserKey, html, url);
    if (typeof DOMParser !== "undefined") {
      const document = new DOMParser().parseFromString(String(html), "text/html");
      const name = String(parserKey).split(".").pop();
      return adapter.parsers[name](document, url);
    }
    throw new Error(`No HTML parser available for ${parserKey}.`);
  }

  async function sync(ctx) {
    const context = ctx || {};
    const fetchPage = context.fetchPage || globalThis.PrairieRunNet?.fetchPage;
    const now = context.now instanceof Date ? context.now : new Date();
    const checkedAt = now.toISOString();
    const log = context.log || (() => undefined);
    if (typeof fetchPage !== "function") {
      return { status: "error", items: [], error: "GradeScope fetch is unavailable.", checkedAt };
    }
    let accountRes;
    try {
      // GET only. Credentials stay on gradescope.com under its host permission.
      accountRes = await fetchPage(ACCOUNT_URL);
    } catch (error) {
      return { status: "error", items: [], error: error?.message || String(error), checkedAt };
    }
    if (isSignedOut(accountRes)) {
      return { status: "signed_out", items: [], checkedAt };
    }
    let account;
    try {
      account = await parseWithContext(context, "gradescope.account", accountRes.text, accountRes.url);
    } catch (error) {
      return { status: "error", items: [], error: error?.message || String(error), checkedAt };
    }
    if (account?.signedOut) {
      return { status: "signed_out", items: [], checkedAt };
    }
    const courses = (account?.courses || []).slice(0, MAX_COURSES);
    const items = [];
    const discoveredCourses = [];
    let coursesWithRows = 0;
    let coursesWithEmptyMessage = 0;
    for (const course of courses) {
      const courseUrl = `${ORIGIN}/courses/${course.id}`;
      let courseRes;
      try {
        // GET only; one page per course.
        courseRes = await fetchPage(courseUrl);
      } catch (error) {
        log("Gradescope course fetch failed", { courseId: course.id, error: error?.message || String(error) });
        continue;
      }
      if (isSignedOut(courseRes)) {
        return { status: "signed_out", items: [], checkedAt };
      }
      let parsed;
      try {
        parsed = await parseWithContext(context, "gradescope.course", courseRes.text, courseRes.url);
      } catch (error) {
        log("Gradescope course parse failed", { courseId: course.id, error: error?.message || String(error) });
        continue;
      }
      const rows = parsed?.rows || [];
      if (rows.length) coursesWithRows += 1;
      if (NO_ASSIGNMENTS_MESSAGE.test(String(courseRes.text || ""))) coursesWithEmptyMessage += 1;
      const pageCourseName = parsed?.courseName || "";
      discoveredCourses.push({
        id: course.id,
        courseKey: `gradescope:${course.id}`,
        courseCode: resolveCourseCode(course, pageCourseName),
        courseName: resolveCourseName(course, pageCourseName),
        url: courseUrl,
        source: "gradescope",
      });
      for (const row of rows) {
        try {
          items.push(rowToDeadlineItem(row, course, checkedAt, pageCourseName));
        } catch (error) {
          log("Gradescope row skipped", { courseId: course.id, title: row?.title, error: error?.message || String(error) });
        }
      }
    }
    if (courses.length > 0 && coursesWithRows === 0 && coursesWithEmptyMessage === 0) {
      return { status: "error", items: [], error: "Gradescope layout changed", checkedAt };
    }
    return { status: "ok", items, courses: discoveredCourses, checkedAt };
  }

  const adapter = {
    id: "gradescope",
    label: "Gradescope",
    origins: [`${ORIGIN}/*`],
    signInUrl: SIGN_IN_URL,
    parsers: { account: parseAccount, course: parseCourse },
    isSignedOut,
    sync,
  };

  // Test seams: datetime normalization and course-code extraction without a DOM.
  adapter.parseGradescopeInstant = parseGradescopeInstant;
  adapter.courseCodeFromLabel = courseCodeFromLabel;
  adapter.resolveCourseCode = resolveCourseCode;

  try {
    globalThis.PrairieRunSources?.register(adapter);
  } catch {
    // In Node tests the registry may already hold this id; ignore duplicates here.
  }
  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
})();

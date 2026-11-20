// Stage 0 parser prototype for the captured us.prairielearn.com deployment.
// The DOM-facing functions run in a browser/content-script context. The pure
// helpers are exported for Node-based tests.

const COURSE_PATH = /\/pl\/course_instance\/(\d+)(?:\/|$)/;
const ASSESSMENT_PATH = /\/pl\/course_instance\/(\d+)\/(assessment|assessment_instance)\/(\d+)\/?/;

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

function pathParts(url) {
  const match = new URL(url).pathname.match(ASSESSMENT_PATH);
  if (!match) return null;
  return { courseInstanceId: match[1], kind: match[2], id: match[3] };
}

function courseInstanceId(url) {
  return new URL(url).pathname.match(COURSE_PATH)?.[1] || null;
}

function pageType(url, title = "") {
  const parsed = new URL(url);
  if (ASSESSMENT_PATH.test(parsed.pathname)) return "assignment";
  if (/\/pl\/course_instance\/\d+\/assessments(?:\/|$)/.test(parsed.pathname)) return "course";
  if (/home|index|dashboard/i.test(`${parsed.pathname} ${title}`)) return "home";
  return "unknown";
}

function parsePercentage(value) {
  const match = normalizeText(value).match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : null;
}

function completionFromScore(score, threshold = 95) {
  if (score == null || Number.isNaN(score)) return "unknown";
  return score > threshold ? "completed" : "incomplete";
}

function decodeAttributeHtml(value) {
  return String(value || "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function parseDueInfo(visibleText, accessDetailsHtml) {
  const rawVisible = normalizeText(visibleText);
  const rawDetails = decodeAttributeHtml(accessDetailsHtml);
  const cells = [...rawDetails.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
    .map((match) => normalizeText(match[1].replace(/<[^>]+>/g, "")));
  const endCells = [];
  for (let index = 0; index + 2 < cells.length; index += 3) {
    const end = cells[index + 2];
    const match = end.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*\(([^)]+)\)/);
    if (match) endCells.push({ local: match[1], timezone: match[2] });
  }

  const finiteEnd = endCells.length ? endCells[endCells.length - 1] : null;
  const untilMatch = rawVisible.match(/until\s+(.+)$/i);
  const visibleDeadline = rawVisible.match(/until\s+(\d{1,2}):(\d{2}),\s*(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2})/i);
  const monthNumber = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }[visibleDeadline?.[3]?.slice(0, 3).toLowerCase()];
  const year = finiteEnd ? finiteEnd.local.slice(0, 4) : String(new Date().getFullYear());
  const visibleDueAtLocal = visibleDeadline && monthNumber ? `${year}-${String(monthNumber).padStart(2, "0")}-${String(visibleDeadline[4]).padStart(2, "0")} ${String(visibleDeadline[1]).padStart(2, "0")}:${visibleDeadline[2]}:00` : null;

  return {
    dueAtLocal: visibleDueAtLocal || finiteEnd?.local || null,
    timezone: finiteEnd?.timezone || null,
    dueText: untilMatch ? untilMatch[1].replace(/[.\s]+$/, "") : null,
    rawVisible,
    rawDetails: rawDetails || null,
    location: parseLocationFromDetails(rawDetails),
  };
}

// Parse a PrairieLearn exam card (the Access-details HTML) for time window.
// PrairieLearn shows, per row: "Time" (and place/end), e.g. "Start: 13:30, End: 14:00 (Location)".
function parseExamWindow(detailsHtml) {
  const text = decodeAttributeHtml(detailsHtml || "");
  const trimmed = normalizeText(text);
  const startMatch = trimmed.match(/(?:^|\b)Start(?:\s*&nbsp;|:\s*|[—-\s])?(\d{1,2}:\d{2})/i)
    || trimmed.match(/(?:^|\b)At\s*(\d{1,2}:\d{2})/i)
    || trimmed.match(/(?:^|\b)From\s*(\d{1,2}:\d{2})/i)
    || trimmed.match(/(?:^|\b)(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/)
    || trimmed.match(/(?:^|\b)(\d{1,2}:\d{2})\s*(?:am|pm)/i);
  if (startMatch) {
    const endMatch = trimmed.match(/(?:^|\b)End(?:\s*&nbsp;|:\s*|[—-\s])?(\d{1,2}:\d{2})/i)
      || trimmed.match(/[—–]\s*(\d{1,2}:\d{2})/)
      || trimmed.match(/(?:^|\b)To\s+(\d{1,2}:\d{2})/i)
      || trimmed.match(/(\d{1,2}:\d{2})\s*(?:am|pm)\b[^\d]*$/)
      || trimmed.match(/(?:^|\b)(\d{1,2}:\d{2})\s*(?:am|pm)\s*$/);
    return { startLocal: startMatch[1], endLocal: endMatch?.[1] || null, location: trimmed };
  }
  return { startLocal: null, endLocal: null, location: trimmed };
}

function parseExamDurationMinutes(rawVisible, examWindow) {
  const text = normalizeText(rawVisible || "");
  const m = text.match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h)\b/i)
    || text.match(/(\d+(?:\.\d+)?)\s*(minutes?|mins?|m)\b/i)
    || text.match(/(\d+(?:\.\d+)?)\s*(days?|d)\b/i);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2].slice(0, 1).toLowerCase();
  const minutes = unit === "h" ? Math.round(value * 60) : unit === "m" ? Math.round(value) : unit === "d" ? Math.round(value * 1440) : Math.round(value);
  return minutes > 0 && minutes <= 240 ? minutes : null;
}

function parseLocationFromDetails(detailsHtml) {
  const text = decodeAttributeHtml(detailsHtml || "");
  const parts = [...text.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => normalizeText(match[1].replace(/<[^>]+>/g, "")));
  const locCell = [...parts].reverse().find((cell) => cell
    && /[A-Za-z]/.test(cell)
    && !/^\d{1,2}:\d{2}/i.test(cell)
    && !/^\d{4}-\d{2}-\d{2}/i.test(cell)
    && !/^(start|end|time)\b/i.test(cell));
  return locCell || null;
}

function stableAssignmentKey({ courseInstanceId: courseId, assessmentId, fallbackId }) {
  return assessmentId
    ? `pl:${courseId}:assessment:${assessmentId}`
    : `pl:${courseId}:instance:${fallbackId}`;
}

function baseLabel(label) {
  return normalizeText(label).replace(/#\d+$/, "");
}

function normalizeInstanceTitle(title) {
  return normalizeText(title).replace(/\s+instance\s+#\d+$/i, "");
}

function getCourseIdentity(document, location) {
  const id = courseInstanceId(location.href);
  const navCourse = normalizeText(document.querySelector(".navbar-text")?.textContent);
  const titleMatch = document.title.match(/(?:Assessments|[^|]+)\s*[—|-]\s*(.+?)\s*\|\s*PrairieLearn/i);
  return {
    courseInstanceId: id,
    courseName: titleMatch?.[1]?.trim() || navCourse.replace(/,\s*[A-Z]{2}\d+$/, "") || null,
    term: navCourse.match(/,\s*([A-Z]{2}\d+)$/)?.[1] || null,
  };
}

function getCourseLinks(document, location = window.location) {
  const seen = new Set();
  return [...document.querySelectorAll("a[href]")]
    .map((anchor) => {
      const href = absoluteUrl(anchor.getAttribute("href"), location.href);
      const id = href ? courseInstanceId(href) : null;
      return {
        courseInstanceId: id,
        href,
        text: normalizeText(anchor.textContent),
      };
    })
    .filter((link) => link.courseInstanceId && link.href && !seen.has(link.courseInstanceId) && seen.add(link.courseInstanceId));
}

function parseAssessmentRow(row, location, course, threshold = 95) {
  const anchors = [...row.querySelectorAll("a[href]")];
  const candidates = anchors
    .map((anchor) => {
      const href = absoluteUrl(anchor.getAttribute("href"), location.href);
      const parts = href ? pathParts(href) : null;
      return { anchor, href, parts, text: normalizeText(anchor.textContent) };
    })
    .filter((candidate) => candidate.parts);
  const contentCandidate = candidates.find((candidate) => candidate.text.toLowerCase() !== "new instance");
  const newInstanceCandidate = candidates.find((candidate) => candidate.text.toLowerCase() === "new instance");
  if (!contentCandidate && !newInstanceCandidate) return null;

  const cells = [...row.querySelectorAll(":scope > td")];
  const label = normalizeText(row.querySelector('[data-testid="assessment-set-badge"]')?.textContent);
  const titleCell = cells[1];
  const title = normalizeInstanceTitle(contentCandidate?.text || titleCell?.textContent || "");
  const score = parsePercentage(row.querySelector('[data-testid="scorebar"]')?.textContent);
  const accessButton = row.querySelector('[aria-label="Access details"]');
  const due = parseDueInfo(cells[2]?.textContent || row.textContent, accessButton?.getAttribute("data-bs-content"));
  const examWindow = parseExamWindow(accessButton?.getAttribute("data-bs-content"));
  const durationMinutes = parseExamDurationMinutes(due.rawVisible, examWindow);
  const examLocation = due.location || examWindow.location;
  const source = contentCandidate || newInstanceCandidate;
  const instance = contentCandidate?.parts.kind === "assessment_instance";
  const assessmentId = instance ? null : (contentCandidate?.parts.id || newInstanceCandidate?.parts.id || null);

  return {
    courseInstanceId: course.courseInstanceId,
    courseName: course.courseName,
    label,
    baseLabel: baseLabel(label),
    title,
    sourceUrl: source.href,
    assessmentId,
    instanceId: instance ? contentCandidate.parts.id : null,
    score,
    completionStatus: completionFromScore(score, threshold),
    dueAtLocal: due.dueAtLocal,
    dueText: due.dueText,
    timezone: due.timezone,
    rawDueText: due.rawVisible,
    location: examLocation || null,
    durationMinutes: durationMinutes || null,
    kind: instance ? "assessment_instance" : "assessment",
  };
}

function extractAssignments(document, location = window.location, threshold = 95) {
  const course = getCourseIdentity(document, location);
  const raw = [...document.querySelectorAll("tr")]
    .map((row) => parseAssessmentRow(row, location, course, threshold))
    .filter(Boolean);

  const groups = new Map();
  raw.forEach((item) => {
    const key = item.baseLabel || item.assessmentId || item.instanceId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });

  return [...groups.values()].map((items) => {
      const base = items.find((item) => item.assessmentId);
      const attempts = items.filter((item) => item.instanceId);
      const candidates = attempts.length ? attempts : items;
      const completed = candidates.filter((item) => item.completionStatus === "completed");
      // Keep the best completed attempt instead of letting a late attempt
      // downgrade work that is already done. Ties prefer the earlier deadline.
      const item = [...(completed.length ? completed : candidates)].sort((a, b) =>
        (b.score ?? -1) - (a.score ?? -1)
        || String(a.dueAtLocal || "9999").localeCompare(String(b.dueAtLocal || "9999"))
        || String(a.instanceId || "").localeCompare(String(b.instanceId || ""))
      )[0];
      const resolved = resolveAssessmentData(item, base);
      const assessmentId = item.assessmentId || base?.assessmentId || null;
      return {
        id: stableAssignmentKey({
          courseInstanceId: course.courseInstanceId,
          assessmentId,
          fallbackId: item.instanceId,
        }),
        courseInstanceId: course.courseInstanceId,
        courseName: course.courseName,
        title: base?.title || item.title,
        label: item.baseLabel || base?.baseLabel,
        sourceUrl: resolved.sourceUrl,
        sourceUrls: [...new Set(items.map((row) => row.sourceUrl).filter(Boolean))],
        assessmentId,
        instanceId: item.instanceId,
        assignmentAliases: items.map((row) => stableAssignmentKey({
          courseInstanceId: course.courseInstanceId,
          assessmentId: row.assessmentId,
          fallbackId: row.instanceId,
        })),
        score: resolved.score,
        completionStatus: resolved.completionStatus,
        dueAtLocal: resolved.dueAtLocal,
        dueText: resolved.dueText,
        timezone: resolved.timezone,
        rawDueText: resolved.rawDueText,
        location: resolved.location || null,
        durationMinutes: resolved.durationMinutes || null,
      };
    });
}

function resolveAssessmentData(item, base) {
  const baseCompleted = base?.completionStatus === "completed";
  if (baseCompleted) {
    return {
      sourceUrl: base.sourceUrl || item.sourceUrl,
      score: base.score,
      completionStatus: base.completionStatus,
      dueAtLocal: base.dueAtLocal || null,
      dueText: base.dueText || null,
      timezone: base.timezone || null,
      rawDueText: base.rawDueText || null,
    };
  }
  return {
    sourceUrl: item.sourceUrl,
    score: item.score,
    completionStatus: item.completionStatus,
    dueAtLocal: item.dueAtLocal || base?.dueAtLocal || null,
    dueText: item.dueText || base?.dueText || null,
    timezone: item.timezone || base?.timezone || null,
    rawDueText: item.rawDueText || base?.rawDueText || null,
    location: item.location || base?.location || null,
    durationMinutes: item.durationMinutes || base?.durationMinutes || null,
  };
}

function extractAssignmentDetail(document, location = window.location, threshold = 95) {
  const parts = pathParts(location.href);
  if (!parts || parts.kind !== "assessment_instance") return null;
  const course = getCourseIdentity(document, location);
  const score = parsePercentage(document.querySelector('[data-testid="scorebar"]')?.textContent);
  const card = document.querySelector("main .card") || document;
  const accessButton = card.querySelector('[aria-label="Access details"]');
  const due = parseDueInfo(card.textContent, accessButton?.getAttribute("data-bs-content"));
  const title = normalizeInstanceTitle(document.querySelector("main h1")?.textContent);
  const durationMinutes = parseExamDurationMinutes(due.rawVisible, parseExamWindow(accessButton?.getAttribute("data-bs-content")));
  return {
    id: stableAssignmentKey({ courseInstanceId: parts.courseInstanceId, fallbackId: parts.id }),
    courseInstanceId: parts.courseInstanceId,
    courseName: course.courseName,
    title,
    sourceUrl: location.href,
    instanceId: parts.id,
    score,
    completionStatus: completionFromScore(score, threshold),
    dueAtLocal: due.dueAtLocal,
    dueText: due.dueText,
    timezone: due.timezone,
    rawDueText: due.rawVisible,
    location: due.location || parseLocationFromDetails(accessButton?.getAttribute("data-bs-content")) || null,
    durationMinutes: durationMinutes || null,
  };
}

const api = {
  absoluteUrl,
  baseLabel,
  completionFromScore,
  courseInstanceId,
  extractAssignmentDetail,
  extractAssignments,
  getCourseIdentity,
  getCourseLinks,
  normalizeInstanceTitle,
  normalizeText,
  pageType,
  parseDueInfo,
  parseExamWindow,
  parseExamDurationMinutes,
  parseLocationFromDetails,
  parsePercentage,
  pathParts,
  resolveAssessmentData,
  stableAssignmentKey,
};

if (typeof module !== "undefined") module.exports = api;
if (typeof window !== "undefined") window.PrairieLearnAdapter = api;

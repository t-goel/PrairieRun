// PrairieRun DeadlineItem normalized model.
// No bundler: plain IIFE script. Loads in background, offscreen, options, and Node tests.
(function () {
  const SOURCE_IDS = ["prairielearn", "prairietest", "gradescope", "canvas", "manual"];
  const STATUSES = ["not_started", "in_progress", "submitted", "graded", "completed", "unknown"];
  const KINDS = ["assignment", "exam", "quiz", "event"];

  const ABBR_OFFSETS = {
    CST: "-06:00",
    CDT: "-05:00",
    EST: "-05:00",
    EDT: "-04:00",
    MST: "-07:00",
    MDT: "-06:00",
    PST: "-08:00",
    PDT: "-07:00",
  };

  function parseLocalYmdHms(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
    if (!match) throw new Error(`Invalid local date: ${value}`);
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6]),
    };
  }

  // Offset (in minutes) of a tz at a given instant: wall-clock minus UTC.
  function tzOffsetMinutes(timeZone, date) {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = {};
    for (const part of dtf.formatToParts(date)) {
      if (part.type !== "literal") parts[part.type] = part.value;
    }
    // hour can be "24" at midnight in some locales; normalize.
    const hour = Number(parts.hour) % 24;
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      hour,
      Number(parts.minute),
      Number(parts.second)
    );
    return Math.round((asUtc - date.getTime()) / 60000);
  }

  function localToUtcViaIana(localYmdHms, timeZone) {
    const c = parseLocalYmdHms(localYmdHms);
    const wallAsUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
    let utc = wallAsUtc;
    // Fixed-point iteration: U = wall - offset(U). Converges in 2-3 steps,
    // including across the 2026-11-01 CDT->CST switch.
    for (let i = 0; i < 3; i += 1) {
      const offset = tzOffsetMinutes(timeZone, new Date(utc));
      utc = wallAsUtc - offset * 60000;
    }
    return new Date(utc).toISOString();
  }

  function localToUtc(localYmdHms, tz) {
    const zone = String(tz || "America/Chicago");
    if (ABBR_OFFSETS[zone]) {
      const c = parseLocalYmdHms(localYmdHms);
      const pad = (n) => String(n).padStart(2, "0");
      const isoWithOffset = `${c.year}-${pad(c.month)}-${pad(c.day)}T${pad(c.hour)}:${pad(c.minute)}:${pad(c.second)}${ABBR_OFFSETS[zone]}`;
      const date = new Date(isoWithOffset);
      if (Number.isNaN(date.getTime())) throw new Error(`Invalid local date: ${localYmdHms}`);
      return date.toISOString();
    }
    return localToUtcViaIana(localYmdHms, zone);
  }

  function formatCentral(isoUtc) {
    const date = new Date(isoUtc);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid UTC date: ${isoUtc}`);
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    });
    // en-US gives "Fri, Oct 16, 11:59 PM CDT"; spec wants "Fri Oct 16, 11:59 PM CDT".
    return dtf.format(date).replace(/^(\w{3}),/, "$1");
  }

  function courseCodeFromName(courseName) {
    const match = String(courseName || "").match(/^([A-Za-z]{2,4})\s*(\d{3}[A-Za-z]{0,3})/);
    if (!match) return null;
    return `${match[1].toUpperCase()} ${match[2].toUpperCase()}`;
  }

  function makeDeadlineItem(partial = {}) {
    if (!partial || typeof partial !== "object") throw new Error("makeDeadlineItem requires an object.");
    const { id, source, title, url } = partial;
    if (!id || !source || !title || !url) {
      throw new Error("makeDeadlineItem requires id, source, title, url.");
    }
    if (!SOURCE_IDS.includes(source)) throw new Error(`Invalid source: ${source}`);
    const kind = partial.kind || "assignment";
    const status = partial.status || "unknown";
    if (!KINDS.includes(kind)) throw new Error(`Invalid kind: ${kind}`);
    if (!STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);
    const now = new Date().toISOString();
    return {
      id: String(id),
      source,
      kind,
      courseKey: partial.courseKey != null ? String(partial.courseKey) : "",
      courseName: partial.courseName != null ? String(partial.courseName) : "",
      courseCode: partial.courseCode != null ? partial.courseCode : null,
      title: String(title),
      dueAt: partial.dueAt != null ? partial.dueAt : null,
      allDay: Boolean(partial.allDay || false),
      startAt: partial.startAt != null ? partial.startAt : null,
      endAt: partial.endAt != null ? partial.endAt : null,
      lateDueAt: partial.lateDueAt != null ? partial.lateDueAt : null,
      location: partial.location != null ? partial.location : null,
      status,
      score: partial.score != null ? partial.score : null,
      url: String(url),
      sourceUrls: Array.isArray(partial.sourceUrls) ? [...partial.sourceUrls] : [],
      aliases: Array.isArray(partial.aliases) ? [...partial.aliases] : [],
      rawDueText: partial.rawDueText != null ? partial.rawDueText : null,
      sourceTimezone: partial.sourceTimezone != null ? partial.sourceTimezone : null,
      pl: partial.pl != null ? { ...partial.pl } : undefined,
      fetchedAt: partial.fetchedAt || now,
    };
  }

  function statusFromLegacy(legacy) {
    if (legacy?.completionStatus === "completed") return "completed";
    if (legacy?.score != null && !Number.isNaN(Number(legacy.score))) return "in_progress";
    return "unknown";
  }

  function fromLegacyPlAssignment(a = {}) {
    if (!a.id) throw new Error("fromLegacyPlAssignment requires id.");
    const courseInstanceId = String(a.courseInstanceId || parseCanonicalPlId(a.id)?.courseInstanceId || "");
    const dueAt = a.dueAtLocal ? localToUtc(a.dueAtLocal, a.timezone || "America/Chicago") : null;
    const parsedId = parseCanonicalPlId(a.id);
    let assessmentId = a.assessmentId != null ? String(a.assessmentId) : null;
    let instanceId = a.instanceId != null ? String(a.instanceId) : null;
    if (parsedId) {
      if (assessmentId == null && parsedId.kind === "assessment") assessmentId = parsedId.nativeId;
      if (instanceId == null && parsedId.kind === "instance") instanceId = parsedId.nativeId;
    }
    return makeDeadlineItem({
      id: String(a.id),
      source: "prairielearn",
      kind: "assignment",
      courseKey: `prairielearn:${courseInstanceId}`,
      courseName: a.courseName || "",
      courseCode: courseCodeFromName(a.courseName),
      title: a.title || "",
      dueAt,
      allDay: false,
      startAt: null,
      endAt: null,
      lateDueAt: null,
      location: null,
      status: statusFromLegacy(a),
      score: a.score != null ? a.score : null,
      url: a.sourceUrl || "",
      sourceUrls: [...new Set([...(a.sourceUrls || []), ...(a.sourceUrl ? [a.sourceUrl] : [])])],
      aliases: [...(a.assignmentAliases || [])],
      rawDueText: a.rawDueText != null ? a.rawDueText : (a.dueText != null ? a.dueText : null),
      sourceTimezone: a.timezone || null,
      pl: {
        assessmentId,
        instanceId,
        label: a.label != null ? a.label : null,
        baseLabel: a.baseLabel != null ? a.baseLabel : null,
      },
      fetchedAt: new Date().toISOString(),
    });
  }

  function utcToCentralWall(isoUtc) {
    const date = new Date(isoUtc);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid UTC date: ${isoUtc}`);
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    });
    const parts = {};
    for (const part of dtf.formatToParts(date)) {
      if (part.type !== "literal") parts[part.type] = part.value;
    }
    const hour = parts.hour === "24" ? "00" : parts.hour;
    const tzName = String(parts.timeZoneName || "");
    const abbr = /CDT/i.test(tzName) ? "CDT" : /CST/i.test(tzName) ? "CST" : tzName || "America/Chicago";
    return {
      local: `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second}`,
      timezone: abbr,
    };
  }

  function parseCanonicalPlId(id) {
    const match = String(id || "").match(/^pl:(\d+):(assessment|instance):(\d+)$/);
    if (!match) return null;
    return { courseInstanceId: match[1], kind: match[2], nativeId: match[3] };
  }

  function toLegacyPlAssignment(item = {}, existing = {}) {
    if (!item.id) throw new Error("toLegacyPlAssignment requires item.id.");
    const parsed = parseCanonicalPlId(item.id);
    const courseKeyCi = String(item.courseKey || "").match(/^prairielearn:(\d+)$/)?.[1];
    const courseInstanceId = courseKeyCi || parsed?.courseInstanceId || String(existing.courseInstanceId || "");
    let assessmentId = item.pl?.assessmentId != null ? item.pl.assessmentId : null;
    let instanceId = item.pl?.instanceId != null ? item.pl.instanceId : null;
    if ((assessmentId == null || instanceId == null) && parsed) {
      if (parsed.kind === "assessment" && assessmentId == null) assessmentId = parsed.nativeId;
      if (parsed.kind === "instance" && instanceId == null) instanceId = parsed.nativeId;
    }
    let dueAtLocal = existing.dueAtLocal || null;
    let timezone = existing.timezone || null;
    if (item.dueAt) {
      const wall = utcToCentralWall(item.dueAt);
      dueAtLocal = wall.local;
      timezone = wall.timezone;
    } else if (item.dueAt === null) {
      dueAtLocal = null;
      timezone = null;
    }
    const completionStatus = item.status === "completed" ? "completed" : item.status === "unknown" ? "unknown" : "incomplete";
    return {
      ...existing,
      id: String(item.id),
      courseInstanceId,
      courseName: item.courseName || existing.courseName || "",
      title: item.title || existing.title || "",
      label: item.pl?.label ?? existing.label ?? null,
      baseLabel: item.pl?.baseLabel ?? existing.baseLabel ?? null,
      sourceUrl: item.url || existing.sourceUrl || "",
      sourceUrls: Array.isArray(item.sourceUrls) ? [...item.sourceUrls] : (existing.sourceUrls || []),
      assessmentId,
      instanceId,
      assignmentAliases: Array.isArray(item.aliases) ? [...item.aliases] : (existing.assignmentAliases || []),
      score: item.score != null ? item.score : (existing.score ?? null),
      completionStatus,
      dueAtLocal,
      timezone,
      rawDueText: item.rawDueText ?? existing.rawDueText ?? null,
      dueText: item.rawDueText ?? existing.dueText ?? null,
    };
  }

  function fingerprint(item = {}) {
    const picked = {
      title: item.title ?? null,
      dueAt: item.dueAt ?? null,
      lateDueAt: item.lateDueAt ?? null,
      startAt: item.startAt ?? null,
      endAt: item.endAt ?? null,
      status: item.status ?? null,
      location: item.location ?? null,
      url: item.url ?? null,
    };
    const sorted = {};
    for (const key of Object.keys(picked).sort()) sorted[key] = picked[key];
    return JSON.stringify(sorted);
  }

  const api = {
    SOURCE_IDS,
    STATUSES,
    KINDS,
    makeDeadlineItem,
    localToUtc,
    formatCentral,
    fromLegacyPlAssignment,
    toLegacyPlAssignment,
    fingerprint,
    courseCodeFromName,
  };
  globalThis.PrairieRunModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

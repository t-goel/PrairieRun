// Canvas source adapter (PR 4).
// Reads the user-pasted Canvas calendar feed (.../feeds/calendars/user_<token>.ics)
// with credentials:"omit" -- the token in the URL is the auth, so the URL is a
// secret (storage.local prairierunSecrets.canvasFeedUrl, never logged raw).
// Optionally merges submission status from the Canvas planner API using the
// logged-in session (credentials:"include") when
// settings.sources.canvas.plannerApi is on.
// Read-only: GET requests only. No forms, no POSTs.
// Plain IIFE script; no bundler.
(function () {
  const CANVAS_ORIGIN = "https://canvas.illinois.edu";
  const MAX_PLANNER_PAGES = 10;

  function checkedAt() {
    return new Date().toISOString();
  }

  // The feed token must never reach logs, errors, or storage.sync.
  function redactFeedUrl(value) {
    return String(value ?? "").replace(/user_[A-Za-z0-9]+/g, "user_***");
  }

  function safeMessage(error) {
    return redactFeedUrl(error?.message || String(error));
  }

  function log(ctx, message, details) {
    try {
      ctx?.log?.(message, details);
    } catch { /* logging must not break sync */ }
  }

  // SUMMARY: "<title> [<course_code>]" with the code in the last bracket
  // pair; override titles may carry a section suffix "(... CRN12345 ...)".
  // Example: "Quiz 3 (IB 110 ABH Fall 2026 CRN73117) [ib_110_120268_261964]".
  function displayCourseCode(codeRaw) {
    const match = String(codeRaw || "").match(/^([a-z]+)_(\d{3}[a-z]?)_\d+_\d+$/i);
    if (!match) return String(codeRaw || "");
    return `${match[1].toUpperCase()} ${match[2].toUpperCase()}`;
  }

  function parseSummary(rawSummary) {
    const collapsed = globalThis.PrairieRunIcs.unescapeText(rawSummary).replace(/\s+/g, " ").trim();
    let title = collapsed;
    let codeRaw = null;
    const bracket = collapsed.match(/^(.*?)\s*\[([^\[\]]+)\]\s*$/);
    if (bracket) {
      title = bracket[1].trim();
      codeRaw = bracket[2].trim();
    }
    let section = null;
    const sectionMatch = title.match(/^(.*?)\s*\(([^()]*CRN\d+[^()]*)\)$/);
    if (sectionMatch) {
      title = sectionMatch[1].trim();
      section = sectionMatch[2].trim();
    }
    const display = codeRaw ? displayCourseCode(codeRaw) : "";
    return { title: title || collapsed, courseDisplay: display, section };
  }

  function originOf(urlValue, fallbackOrigin) {
    try {
      return new URL(urlValue).origin;
    } catch {
      return fallbackOrigin || CANVAS_ORIGIN;
    }
  }

  // Map one parsed VEVENT to a DeadlineItem. The assignment id always comes
  // from the URL (#assignment_<id>); UID:event-assignment-override-<id> is
  // the override id and must not become the item id.
  function eventToItem(event, feedOrigin, fetchedAt) {
    const ics = globalThis.PrairieRunIcs;
    if (!event.dtstart) throw new Error(`Canvas event has no DTSTART (uid ${event.uid}).`);
    const due = ics.toInstant(event.dtstart, "America/Chicago");
    const urlValue = String(event.url || "");
    const courseMatch = urlValue.match(/[?&]include_contexts=course_(\d+)\b/);
    const assignMatch = urlValue.match(/#assignment_(\d+)\b/);
    const courseId = courseMatch ? courseMatch[1] : null;
    const summary = parseSummary(event.summary || "");
    const origin = originOf(urlValue || feedOrigin, feedOrigin);

    let id;
    let kind;
    let url;
    if (courseId && assignMatch) {
      id = `canvas:${courseId}:assignment:${assignMatch[1]}`;
      kind = "assignment";
      url = `${origin}/courses/${courseId}/assignments/${assignMatch[1]}`;
    } else {
      id = `canvas:event:${event.uid}`;
      kind = /^event-assignment-/i.test(event.uid) ? "assignment" : "event";
      url = urlValue || `${origin}/`;
    }

    const params = event.dtstart.params || {};
    const tzid = (params.TZID || [])[0];
    const sourceTimezone = tzid ? String(tzid) : (/Z$/i.test(event.dtstart.value.trim()) ? "UTC" : "America/Chicago");

    return globalThis.PrairieRunModel.makeDeadlineItem({
      id,
      source: "canvas",
      kind,
      courseKey: `canvas:${courseId || "unknown"}`,
      courseName: summary.courseDisplay || "",
      courseCode: summary.courseDisplay || null,
      title: summary.title,
      dueAt: due.iso,
      allDay: due.allDay,
      startAt: null,
      endAt: null,
      lateDueAt: null,
      location: null,
      status: "unknown",
      score: null,
      url,
      sourceUrls: urlValue && urlValue !== url ? [urlValue] : [],
      aliases: [],
      rawDueText: event.dtstart.value,
      sourceTimezone,
      fetchedAt,
    });
  }

  function plannerWindow(now) {
    const dayMs = 24 * 60 * 60 * 1000;
    const base = now instanceof Date ? now.getTime() : Date.now();
    const start = new Date(base - 7 * dayMs).toISOString().slice(0, 10);
    const end = new Date(base + 60 * dayMs).toISOString().slice(0, 10);
    return { start, end };
  }

  function stripJsonPrefix(text) {
    // Canvas may prefix session-authenticated JSON with while(1); -- handle both.
    return String(text ?? "").replace(/^\s*while\s*\(\s*1\s*\)\s*;/, "");
  }

  function extractNextLink(result) {
    let link = null;
    try {
      const headers = result?.headers;
      if (headers && typeof headers.get === "function") link = headers.get("link") || headers.get("Link");
      else if (headers && typeof headers === "object") link = headers.link || headers.Link || null;
      if (!link && typeof result?.link === "string") link = result.link;
    } catch {
      return null;
    }
    if (!link) return null;
    // NOTE: PR 2's FetchResult may not expose response headers; without a
    // Link header pagination stops after page 1 (Canvas JSON has no next link).
    for (const part of String(link).split(",")) {
      const match = part.match(/<([^>]+)>\s*;\s*[^,]*rel="next"/i);
      if (match) return match[1].trim();
    }
    return null;
  }

  function plannerStatusRank(status) {
    if (status === "graded") return 3;
    if (status === "submitted") return 2;
    if (status === "not_started") return 1;
    return 0;
  }

  function plannerEntryStatus(entry) {
    const submissions = entry?.submissions || {};
    if (submissions.graded) return "graded";
    if (submissions.submitted) return "submitted";
    if (submissions.missing) return "not_started";
    return null;
  }

  async function fetchPlannerStatuses(ctx, feedUrl) {
    const { start, end } = plannerWindow(ctx?.now);
    let origin = CANVAS_ORIGIN;
    try {
      origin = new URL(feedUrl).origin;
    } catch { /* keep default */ }
    const first = `${origin}/api/v1/planner/items?start_date=${start}&end_date=${end}&per_page=100`;
    const statuses = new Map();
    let next = first;
    let signedOut = false;
    for (let page = 0; page < MAX_PLANNER_PAGES && next; page += 1) {
      let result;
      try {
        result = await ctx.fetchPage(next, { accept: "application/json", credentials: "include" });
      } catch (error) {
        log(ctx, "Canvas planner fetch failed.", { error: safeMessage(error) });
        break;
      }
      if (adapter.isSignedOut(result)) {
        signedOut = true;
        break;
      }
      if (!result || result.ok === false) {
        log(ctx, "Canvas planner fetch failed.", { status: result?.status ?? null });
        break;
      }
      let entries;
      try {
        const parsed = JSON.parse(stripJsonPrefix(result.text));
        entries = Array.isArray(parsed) ? parsed : parsed?.items || [];
      } catch (error) {
        log(ctx, "Canvas planner JSON unparseable.", { error: safeMessage(error) });
        break;
      }
      for (const entry of entries) {
        if (!entry || entry.plannable_type !== "assignment") continue;
        if (entry.course_id == null || entry.plannable_id == null) continue;
        const status = plannerEntryStatus(entry);
        if (!status) continue;
        const key = `canvas:${entry.course_id}:assignment:${entry.plannable_id}`;
        if (plannerStatusRank(status) >= plannerStatusRank(statuses.get(key))) {
          statuses.set(key, status);
        }
      }
      next = extractNextLink(result);
    }
    return { statuses, signedOut };
  }

  const adapter = {
    id: "canvas",
    label: "Canvas",
    origins: [CANVAS_ORIGIN],
    signInUrl: `${CANVAS_ORIGIN}/`,
    parsers: {},
    isSignedOut(fetchResult) {
      if (!fetchResult) return false;
      if (fetchResult.status === 401) return true;
      try {
        const path = new URL(fetchResult.url).pathname;
        return /\/login(\/|$)/.test(path);
      } catch {
        return false;
      }
    },
    async sync(ctx) {
      const feedUrl = ctx?.secrets?.canvasFeedUrl;
      if (!feedUrl) {
        return { status: "disabled", items: [], error: "Paste your Canvas Calendar Feed URL in Options", checkedAt: checkedAt() };
      }
      const redacted = redactFeedUrl(feedUrl);
      log(ctx, "Fetching Canvas calendar feed.", { feed: redacted });

      let feed;
      try {
        feed = await ctx.fetchPage(feedUrl, { accept: "text/calendar", credentials: "omit" });
      } catch (error) {
        return { status: "error", items: [], error: `Canvas feed fetch failed: ${safeMessage(error)}`, checkedAt: checkedAt() };
      }
      if (!feed || feed.ok === false) {
        if (feed && (feed.status === 401 || feed.status === 404)) {
          return {
            status: "error",
            items: [],
            error: "Canvas feed URL rejected; re-copy it from Canvas → Calendar → Calendar Feed",
            checkedAt: checkedAt(),
          };
        }
        return {
          status: "error",
          items: [],
          error: `Canvas feed fetch failed (HTTP ${feed?.status ?? "unknown"}).`,
          checkedAt: checkedAt(),
        };
      }

      let events;
      try {
        events = globalThis.PrairieRunIcs.parseIcs(feed.text);
      } catch (error) {
        return { status: "error", items: [], error: `Canvas feed unparseable: ${safeMessage(error)}`, checkedAt: checkedAt() };
      }

      let feedOrigin = CANVAS_ORIGIN;
      try {
        feedOrigin = new URL(feedUrl).origin;
      } catch { /* keep default */ }
      const fetchedAt = ctx?.now instanceof Date ? ctx.now.toISOString() : checkedAt();
      const items = [];
      const byId = new Map();
      let skipped = 0;
      for (const event of events) {
        try {
          const item = eventToItem(event, feedOrigin, fetchedAt);
          items.push(item);
          byId.set(item.id, item);
        } catch (error) {
          skipped += 1;
          log(ctx, "Skipping Canvas event.", { uid: String(event?.uid || "?").slice(0, 80), error: safeMessage(error) });
        }
      }
      log(ctx, "Parsed Canvas calendar feed.", { events: events.length, items: items.length, skipped });

      const plannerOn = Boolean(ctx?.settings?.sources?.canvas?.plannerApi);
      if (!plannerOn) return { status: "ok", items, checkedAt: checkedAt() };

      const { statuses, signedOut } = await fetchPlannerStatuses(ctx, feedUrl);
      let merged = 0;
      for (const [id, status] of statuses) {
        const item = byId.get(id);
        if (item && plannerStatusRank(status) > plannerStatusRank(item.status)) {
          item.status = status;
          merged += 1;
        }
      }
      log(ctx, "Merged Canvas planner statuses.", { plannerEntries: statuses.size, merged });
      if (signedOut) {
        return { status: "ok", items, error: "Canvas session expired; status unavailable", checkedAt: checkedAt() };
      }
      return { status: "ok", items, checkedAt: checkedAt() };
    },
  };

  try {
    globalThis.PrairieRunSources?.register(adapter);
  } catch {
    // In Node tests the registry may already hold this id; ignore duplicates here.
  }
  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
})();

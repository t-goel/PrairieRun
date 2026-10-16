// PrairieTest source adapter (PR 6): upcoming exam reservations as exam DeadlineItems.
// Read-only: exactly one GET to https://us.prairietest.com/pt per sync. Never follows
// reservation, "Make a reservation", "Reserve this session", or "Start exam" links,
// and never POSTs. Only Google Calendar writes (via calendar.js, later PRs) leave the machine.
(function () {
  const PT_HOME_URL = "https://us.prairietest.com/pt";
  const PT_ORIGIN = "https://us.prairietest.com";
  const PT_HOST = "us.prairietest.com";
  const AUTH_URL_PREFIX = "https://us.prairielearn.com/pl/prairietest/auth";
  // Heading text that marks the self-scheduling block whose entries are offers,
  // not booked reservations. Named constant so it is easy to adjust if
  // PrairieTest rewords the heading.
  const AVAILABLE_HEADING_RE = /available for reservation/i;
  const RESERVATION_ID_RE = /\/reservation\/(\d+)/;
  const COURSE_CODE_RE = /^([A-Z]{2,4})\s*(\d{3}[A-Z]?)/;
  const HOURS_RE = /(\d+)\s*h/i;
  const MINUTES_RE = /(\d+)\s*min/i;

  function collapseWhitespace(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function parseDurationMinutes(text) {
    const source = String(text || "");
    const hours = source.match(HOURS_RE);
    const minutes = source.match(MINUTES_RE);
    if (!hours && !minutes) return null;
    return (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  }

  function parseStartAt(raw) {
    let parsed;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return null;
    }
    const date = parsed && parsed.date != null ? String(parsed.date) : "";
    if (!date || Number.isNaN(Date.parse(date))) return null;
    return new Date(date).toISOString();
  }

  // Nearest preceding h1-h6 in document order. Entries whose nearest heading
  // advertises "available for reservation" are offers, not bookings.
  // Implemented as a document-order walk (no compareDocumentPosition, whose
  // linkedom behavior differs from browsers) so tests and runtime agree.
  function nearestPrecedingHeading(li) {
    const doc = li && li.ownerDocument;
    if (!doc) return null;
    let ordered;
    try {
      // querySelectorAll returns document order in browsers and in linkedom.
      ordered = Array.from(doc.querySelectorAll("h1,h2,h3,h4,h5,h6,li.list-group-item"));
    } catch {
      return null;
    }
    let index = ordered.indexOf(li);
    if (index === -1) {
      // The li was located some other way; fall back to a manual walk back
      // through previous siblings and ancestors.
      return nearestPrecedingHeadingByTraversal(li);
    }
    for (let i = index - 1; i >= 0; i -= 1) {
      if (/^H[1-6]$/i.test(ordered[i].tagName || "")) return ordered[i];
    }
    return null;
  }

  // Fallback when the li is not in the combined query (should not normally
  // happen): walk back through previous siblings and up through ancestors,
  // inspecting each subtree's headings in reverse document order.
  function nearestPrecedingHeadingByTraversal(li) {
    let node = li;
    while (node) {
      let sibling = node.previousElementSibling;
      while (sibling) {
        const headings = sibling.querySelectorAll
          ? Array.from(sibling.querySelectorAll("h1,h2,h3,h4,h5,h6"))
          : [];
        if (sibling.matches && sibling.matches("h1,h2,h3,h4,h5,h6")) return sibling;
        if (headings.length) return headings[headings.length - 1];
        sibling = sibling.previousElementSibling;
      }
      node = node.parentElement;
      if (node && node.matches && node.matches("h1,h2,h3,h4,h5,h6")) return node;
    }
    return null;
  }

  // Named, easy-to-adjust exclusion for the "Exams available for reservation"
  // self-scheduling block. Returns true when the entry belongs to that block.
  function isAvailableForReservationEntry(li) {
    const heading = nearestPrecedingHeading(li);
    if (!heading) return false;
    return AVAILABLE_HEADING_RE.test(collapseWhitespace(heading.textContent));
  }

  function parseReservationEntry(li) {
    const exam = li.querySelector('[data-testid="exam"]');
    const anchor = exam ? exam.querySelector("a") : null;
    const name = collapseWhitespace(anchor ? anchor.textContent : exam ? exam.textContent : "");
    if (!name) return null;
    const href = anchor && anchor.getAttribute("href") ? anchor.getAttribute("href") : null;
    const dateNode = li.querySelector('[data-testid="date"] [data-format-date]')
      || li.querySelector("[data-format-date]");
    const startAt = dateNode ? parseStartAt(dateNode.getAttribute("data-format-date")) : null;
    if (!startAt) return null;
    const locationNode = li.querySelector('[data-testid="location"]');
    const locationText = collapseWhitespace(locationNode ? locationNode.textContent : "");
    return {
      name,
      href,
      startAt,
      durationMin: parseDurationMinutes(li.textContent),
      location: locationText ? locationText : null,
    };
  }

  const parsers = {
    home(doc, url) {
      void url;
      const signedOut = Boolean(doc
        && typeof doc.querySelector === "function"
        && doc.querySelector(`a[href^="${AUTH_URL_PREFIX}"]`));
      const reservations = [];
      if (!doc || typeof doc.querySelectorAll !== "function") return { signedOut, reservations };
      const entries = Array.from(doc.querySelectorAll("li.list-group-item"));
      for (const li of entries) {
        if (isAvailableForReservationEntry(li)) continue;
        const reservation = parseReservationEntry(li);
        if (reservation) reservations.push(reservation);
      }
      return { signedOut, reservations };
    },
  };

  function courseCodeFromExamName(name) {
    const match = String(name || "").match(COURSE_CODE_RE);
    if (!match) return null;
    return `${match[1].toUpperCase()} ${match[2].toUpperCase()}`;
  }

  function reservationIdFromHref(href) {
    if (!href) return null;
    const match = String(href).match(RESERVATION_ID_RE);
    return match ? match[1] : null;
  }

  // Deterministic 16-hex-char fallback id for exams without a numeric
  // reservation link. Sync hash of name+startAt so the id is stable across scans.
  function fallbackExamHash(name, startAt) {
    const str = `${name}\0${startAt}`;
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i += 1) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
  }

  function resolveReservationUrl(href) {
    if (!href) return PT_HOME_URL;
    try {
      return new URL(String(href), PT_HOME_URL).href;
    } catch {
      return PT_HOME_URL;
    }
  }

  function toDeadlineItem(reservation, makeItem, fetchedAt) {
    const reservationId = reservationIdFromHref(reservation.href);
    const id = reservationId
      ? `pt:reservation:${reservationId}`
      : `pt:exam:${fallbackExamHash(reservation.name, reservation.startAt)}`;
    const courseCode = courseCodeFromExamName(reservation.name);
    const url = resolveReservationUrl(reservation.href);
    const startAt = reservation.startAt;
    const endAt = reservation.durationMin != null
      ? new Date(new Date(startAt).getTime() + reservation.durationMin * 60000).toISOString()
      : null;
    return makeItem({
      id,
      source: "prairietest",
      kind: "exam",
      courseKey: `prairietest:${courseCode || reservation.name}`,
      courseName: courseCode || reservation.name,
      courseCode,
      title: reservation.name,
      dueAt: startAt,
      allDay: false,
      startAt,
      endAt,
      lateDueAt: null,
      location: reservation.location,
      status: "not_started",
      score: null,
      url,
      sourceUrls: [url],
      aliases: [],
      rawDueText: null,
      sourceTimezone: null,
      fetchedAt,
    });
  }

  function isSignedOut(fetchResult) {
    if (!fetchResult) return false;
    const finalUrl = String(fetchResult.url || "");
    if (finalUrl) {
      try {
        const host = new URL(finalUrl).hostname;
        if (host && host !== PT_HOST) return true;
      } catch { /* ignore unparseable urls */ }
    }
    const text = String(fetchResult.text || "");
    return /prairietest\/auth/.test(text) && !/data-testid="exam"/.test(text);
  }

  async function sync(ctx) {
    // Duck-type ctx.now (not instanceof) so vm-sandbox tests with a host-realm
    // Date still honor the injected clock.
    const checkedAt = ctx && ctx.now && typeof ctx.now.toISOString === "function"
      ? ctx.now.toISOString()
      : new Date().toISOString();
    if (!ctx || typeof ctx.fetchPage !== "function") {
      return { status: "error", items: [], error: "Sync context is unavailable.", checkedAt };
    }
    let response;
    try {
      // The only network read this source ever performs. Never follows
      // reservation, "Make a reservation", or "Start exam" links.
      response = await ctx.fetchPage(PT_HOME_URL);
    } catch (error) {
      return { status: "error", items: [], error: error && error.message ? error.message : String(error), checkedAt };
    }
    if (isSignedOut(response)) {
      return { status: "signed_out", items: [], error: "Sign in to PrairieTest", checkedAt };
    }
    if (response && response.ok === false) {
      return { status: "error", items: [], error: `PrairieTest request failed (HTTP ${response.status}).`, checkedAt };
    }
    const makeItem = globalThis.PrairieRunModel && globalThis.PrairieRunModel.makeDeadlineItem;
    if (typeof makeItem !== "function") {
      return { status: "error", items: [], error: "PrairieRunModel is unavailable.", checkedAt };
    }
    if (typeof ctx.parseHtml !== "function") {
      return { status: "error", items: [], error: "Sync context cannot parse HTML.", checkedAt };
    }
    let parsed;
    try {
      parsed = await ctx.parseHtml("prairietest.home", String(response.text || ""), response.url || PT_HOME_URL);
    } catch (error) {
      return { status: "error", items: [], error: error && error.message ? error.message : String(error), checkedAt };
    }
    if (parsed && parsed.signedOut && (!parsed.reservations || !parsed.reservations.length)) {
      return { status: "signed_out", items: [], error: "Sign in to PrairieTest", checkedAt };
    }
    const items = [];
    for (const reservation of (parsed && parsed.reservations) || []) {
      try {
        items.push(toDeadlineItem(reservation, makeItem, checkedAt));
      } catch { /* skip malformed rows without failing the whole source */ }
    }
    try {
      if (typeof ctx.log === "function") ctx.log("prairietest: parsed reservations", { count: items.length });
    } catch { /* logging must not break sync */ }
    return { status: "ok", items, checkedAt };
  }

  const adapter = {
    id: "prairietest",
    label: "PrairieTest",
    origins: [PT_ORIGIN],
    signInUrl: PT_HOME_URL,
    parsers,
    isSignedOut,
    sync,
  };

  try { globalThis.PrairieRunSources?.register(adapter); } catch { /* ignore duplicates in tests */ }
  if (typeof module !== "undefined" && module.exports) module.exports = adapter;
})();

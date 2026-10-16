// PrairieRun iCalendar (RFC 5545) export writer.
// Pure functions, Node-testable. No extension APIs (no chrome.*, no PrairieRunExt.*).
(function () {
  const SOURCE_LABELS = {
    prairielearn: "PrairieLearn",
    prairietest: "PrairieTest",
    gradescope: "Gradescope",
    canvas: "Canvas",
    manual: "Manual",
  };

  function getByteLength(str) {
    if (typeof Buffer !== "undefined") {
      return Buffer.byteLength(str, "utf8");
    }
    return new TextEncoder().encode(str).length;
  }

  function escapeText(s) {
    if (s == null) return "";
    return String(s)
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r\n|\r|\n/g, "\\n");
  }

  function foldLine(line) {
    const str = String(line ?? "");
    if (getByteLength(str) <= 75) {
      return str;
    }

    const lines = [];
    let current = "";
    let currentBytes = 0;
    let maxBytes = 75;

    for (const ch of str) {
      const chBytes = getByteLength(ch);
      if (currentBytes + chBytes > maxBytes) {
        if (current.length > 0) {
          lines.push(current);
        }
        current = " " + ch;
        currentBytes = 1 + chBytes;
        maxBytes = 75;
      } else {
        current += ch;
        currentBytes += chBytes;
      }
    }

    if (current.length > 0) {
      lines.push(current);
    }

    return lines.join("\r\n");
  }

  function formatUtc(dateOrIso) {
    if (!dateOrIso) return null;
    const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid date for formatUtc: ${dateOrIso}`);
    }
    const pad = (n) => String(n).padStart(2, "0");
    const y = d.getUTCFullYear();
    const m = pad(d.getUTCMonth() + 1);
    const day = pad(d.getUTCDate());
    const h = pad(d.getUTCHours());
    const min = pad(d.getUTCMinutes());
    const s = pad(d.getUTCSeconds());
    return `${y}${m}${day}T${h}${min}${s}Z`;
  }

  function filterWindow(items, now, days) {
    if (!Array.isArray(items)) return [];
    if (days == null || typeof days !== "number" || days <= 0) {
      return items.slice();
    }
    const nowDate = now instanceof Date ? now : (now ? new Date(now) : new Date());
    const nowMs = nowDate.getTime();
    const windowEndMs = nowMs + days * 24 * 60 * 60 * 1000;
    return items.filter((item) => {
      const instant = item?.dueAt || item?.startAt || item?.endAt;
      if (!instant) return false;
      const t = new Date(instant).getTime();
      if (Number.isNaN(t)) return false;
      return t >= nowMs && t <= windowEndMs;
    });
  }

  function fingerprint(item = {}) {
    if (globalThis.PrairieRunModel?.fingerprint) {
      return globalThis.PrairieRunModel.fingerprint(item);
    }
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

  function formatCentral(isoUtc) {
    if (globalThis.PrairieRunModel?.formatCentral) {
      return globalThis.PrairieRunModel.formatCentral(isoUtc);
    }
    const date = new Date(isoUtc);
    if (Number.isNaN(date.getTime())) return String(isoUtc);
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
    return dtf.format(date).replace(/^(\w{3}),/, "$1");
  }

  function getCentralDateParts(isoUtc) {
    const date = new Date(isoUtc);
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = {};
    for (const part of dtf.formatToParts(date)) {
      if (part.type !== "literal") parts[part.type] = part.value;
    }
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    const pad = (n) => String(n).padStart(2, "0");
    const dateStr = `${year}${pad(month)}${pad(day)}`;

    const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
    const nextDateStr = `${nextDate.getUTCFullYear()}${pad(nextDate.getUTCMonth() + 1)}${pad(nextDate.getUTCDate())}`;

    return { dateStr, nextDateStr };
  }

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

  function getCentralNightBeforeUtc(isoUtc, nightBeforeHour = 20) {
    const date = new Date(isoUtc);
    if (Number.isNaN(date.getTime())) return null;
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = {};
    for (const part of dtf.formatToParts(date)) {
      if (part.type !== "literal") parts[part.type] = part.value;
    }
    let year = Number(parts.year);
    let month = Number(parts.month);
    let day = Number(parts.day);
    const hour = Number(parts.hour) % 24;

    if (hour < nightBeforeHour) {
      const prevDate = new Date(Date.UTC(year, month - 1, day - 1));
      year = prevDate.getUTCFullYear();
      month = prevDate.getUTCMonth() + 1;
      day = prevDate.getUTCDate();
    }

    const pad = (n) => String(n).padStart(2, "0");
    const localYmdHms = `${year}-${pad(month)}-${pad(day)} ${pad(nightBeforeHour)}:00:00`;

    if (globalThis.PrairieRunModel?.localToUtc) {
      return globalThis.PrairieRunModel.localToUtc(localYmdHms, "America/Chicago");
    }

    const wallUtc = Date.UTC(year, month - 1, day, nightBeforeHour, 0, 0);
    let utc = wallUtc;
    for (let i = 0; i < 3; i++) {
      const offsetMin = tzOffsetMinutes("America/Chicago", new Date(utc));
      utc = wallUtc - offsetMin * 60000;
    }
    return new Date(utc).toISOString();
  }

  function buildCalendar(items = [], opts = {}) {
    const name = opts.name ?? "PrairieRun";
    const now = opts.now instanceof Date ? opts.now : (opts.now ? new Date(opts.now) : new Date());
    const inputSequences = opts.sequences || {};
    const eventShape = opts.eventShape || "block1h";
    const leadMinutes = opts.leadMinutes !== undefined ? opts.leadMinutes : 240;
    const nightBefore = Boolean(opts.nightBefore);
    const nightBeforeHour = opts.nightBeforeHour != null ? opts.nightBeforeHour : 20;
    const includeCompleted = opts.includeCompleted !== false;
    const windowDays = opts.windowDays ?? null;

    let candidateItems = Array.isArray(items) ? items : [];
    if (windowDays != null) {
      candidateItems = filterWindow(candidateItems, now, windowDays);
    }

    const updatedSequences = { ...inputSequences };
    const lines = [];

    // Header
    lines.push("BEGIN:VCALENDAR");
    lines.push("VERSION:2.0");
    lines.push("PRODID:-//PrairieRun//Deadlines//EN");
    lines.push("CALSCALE:GREGORIAN");
    lines.push("METHOD:PUBLISH");
    lines.push(`X-WR-CALNAME:${escapeText(name)}`);
    lines.push("X-WR-TIMEZONE:America/Chicago");
    lines.push("REFRESH-INTERVAL;VALUE=DURATION:PT1H");
    lines.push("X-PUBLISHED-TTL:PT1H");

    for (const item of candidateItems) {
      if (!item) continue;
      // Per item: skip it if dueAt and startAt are both null, or if it's completed and includeCompleted is false.
      if (item.dueAt == null && item.startAt == null) continue;
      const isCompleted = item.status === "completed";
      if (isCompleted && !includeCompleted) continue;

      const fp = fingerprint(item);
      const prev = inputSequences[item.id];
      let seq = 0;
      if (prev != null) {
        if (typeof prev === "object" && prev !== null) {
          if (prev.fp === fp) {
            seq = typeof prev.n === "number" ? prev.n : 0;
          } else {
            seq = (typeof prev.n === "number" ? prev.n : 0) + 1;
          }
        } else if (typeof prev === "number") {
          seq = prev;
        }
      }
      updatedSequences[item.id] = { n: seq, fp };

      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${item.id}`);
      lines.push(`DTSTAMP:${formatUtc(now)}`);
      lines.push(`LAST-MODIFIED:${formatUtc(item.fetchedAt || now)}`);
      lines.push(`SEQUENCE:${seq}`);

      // SUMMARY: [<course>] <title>, with a ✓ prefix when status is completed or graded.
      const isDone = item.status === "completed" || item.status === "graded";
      const courseTag = item.courseCode || item.courseName || "";
      const prefix = isDone ? "✓ " : "";
      const summary = `${prefix}[${courseTag}] ${item.title}`;
      lines.push(`SUMMARY:${escapeText(summary)}`);

      // DESCRIPTION: source label, status, Late due: <Central> if lateDueAt, and the URL.
      const descParts = [];
      const sourceLabel = SOURCE_LABELS[item.source] || item.source || "";
      if (sourceLabel) descParts.push(sourceLabel);
      if (item.status) descParts.push(item.status);
      if (item.lateDueAt) {
        descParts.push(`Late due: ${formatCentral(item.lateDueAt)}`);
      }
      if (item.url) descParts.push(item.url);
      lines.push(`DESCRIPTION:${escapeText(descParts.join("\n"))}`);

      if (item.url) {
        lines.push(`URL:${item.url}`);
      }
      if (item.source) {
        lines.push(`CATEGORIES:${escapeText(item.source)}`);
      }
      lines.push("STATUS:CONFIRMED");
      lines.push("TRANSP:TRANSPARENT");

      if (item.location) {
        lines.push(`LOCATION:${escapeText(item.location)}`);
      }

      // Shapes
      if (item.allDay) {
        const { dateStr, nextDateStr } = getCentralDateParts(item.dueAt || item.startAt);
        lines.push(`DTSTART;VALUE=DATE:${dateStr}`);
        lines.push(`DTEND;VALUE=DATE:${nextDateStr}`);
      } else if (item.kind === "exam" && (item.startAt || item.endAt)) {
        lines.push(`DTSTART:${formatUtc(item.startAt || item.dueAt)}`);
        lines.push(`DTEND:${formatUtc(item.endAt || item.dueAt || item.startAt)}`);
      } else if (eventShape === "instant") {
        const instant = item.dueAt || item.startAt;
        lines.push(`DTSTART:${formatUtc(instant)}`);
        lines.push(`DTEND:${formatUtc(instant)}`);
      } else {
        // block1h: DTSTART = dueAt − 1h, DTEND = dueAt
        const endIso = item.dueAt || item.endAt || item.startAt;
        const endDate = new Date(endIso);
        const startDate = new Date(endDate.getTime() - 60 * 60 * 1000);
        lines.push(`DTSTART:${formatUtc(startDate)}`);
        lines.push(`DTEND:${formatUtc(endDate)}`);
      }

      // VALARMs only when the item isn't completed
      if (!isCompleted) {
        if (leadMinutes != null && leadMinutes > 0) {
          lines.push("BEGIN:VALARM");
          lines.push("ACTION:DISPLAY");
          lines.push(`DESCRIPTION:${escapeText(summary)}`);
          lines.push(`TRIGGER:-PT${leadMinutes}M`);
          lines.push("END:VALARM");
        }
        if (nightBefore) {
          const triggerUtc = getCentralNightBeforeUtc(item.dueAt || item.startAt, nightBeforeHour);
          if (triggerUtc) {
            lines.push("BEGIN:VALARM");
            lines.push("ACTION:DISPLAY");
            lines.push(`DESCRIPTION:${escapeText(summary)}`);
            lines.push(`TRIGGER;VALUE=DATE-TIME:${formatUtc(triggerUtc)}`);
            lines.push("END:VALARM");
          }
        }
      }

      lines.push("END:VEVENT");
    }

    lines.push("END:VCALENDAR");

    const folded = lines.map((line) => foldLine(line));
    const text = folded.join("\r\n") + "\r\n";
    return { text, sequences: updatedSequences };
  }

  const api = {
    buildCalendar,
    escapeText,
    foldLine,
    formatUtc,
    filterWindow,
  };

  globalThis.PrairieRunIcsWriter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

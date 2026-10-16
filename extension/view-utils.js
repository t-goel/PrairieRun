(function () {
  function pad(value) { return String(value).padStart(2, "0"); }

  function dateKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  // Central (America/Chicago) calendar-day key for a UTC instant, without
  // depending on deadline-model.js (content scripts may not load it yet).
  function centralDateKey(isoUtc) {
    const date = new Date(isoUtc);
    if (Number.isNaN(date.getTime())) return null;
    const parts = {};
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    for (const part of dtf.formatToParts(date)) {
      if (part.type !== "literal") parts[part.type] = part.value;
    }
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function dueDateKey(item) {
    // DeadlineItem (UTC instant) takes precedence; legacy items use dueAtLocal.
    if (item?.dueAt) return centralDateKey(item.dueAt);
    const match = String(item?.dueAtLocal || "").match(/^(\d{4}-\d{2}-\d{2})/);
    return match?.[1] || null;
  }

  function formatDueDate(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
    if (!match) return value ? String(value) : "No due date";
    const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const hour = Number(match[4]);
    const suffix = hour >= 12 ? "PM" : "AM";
    const displayHour = hour % 12 || 12;
    return `${months[Number(match[2]) - 1]} ${Number(match[3])}, ${displayHour}:${match[5]} ${suffix}`;
  }

  // Fallback Central formatting when PrairieRunModel is unavailable.
  // (home-panel.js needs deadline-model.js as a content script; PR 10 adds it.)
  function formatCentralFallback(isoUtc) {
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

  function formatItemDue(item) {
    if (item?.dueAt) {
      try {
        const format = globalThis.PrairieRunModel?.formatCentral;
        if (typeof format === "function") return format(item.dueAt);
      } catch {
        // Fall through to the local fallback.
      }
      return formatCentralFallback(item.dueAt);
    }
    return formatDueDate(item?.dueAtLocal);
  }

  function isCurrent(item, now = new Date()) {
    const due = dueDateKey(item);
    return due ? due >= dateKey(now) : false;
  }

  function isCompleted(item) {
    return (item?.completionStatus ?? item?.status ?? "unknown") === "completed";
  }

  function displayable(item, showUndated, now = new Date()) {
    if (item?.syncState === "stale") return false;
    return isCurrent(item, now) || (showUndated && !dueDateKey(item));
  }

  function dueInstantMs(item) {
    if (item?.dueAt) {
      const ms = Date.parse(item.dueAt);
      if (!Number.isNaN(ms)) return ms;
    }
    return null;
  }

  function compareAssignments(a, b) {
    // Prefer exact instants when both items carry them; otherwise fall back
    // to the legacy day-key + title ordering.
    const aMs = dueInstantMs(a);
    const bMs = dueInstantMs(b);
    if (aMs != null && bMs != null && aMs !== bMs) return aMs - bMs;
    const aDue = dueDateKey(a) || "9999-99-99";
    const bDue = dueDateKey(b) || "9999-99-99";
    return aDue.localeCompare(bDue) || String(a.title || "").localeCompare(String(b.title || ""));
  }

  function statusLabel(item) {
    return item?.syncState === "changed" ? "Changed"
      : item?.syncState === "new" ? "New"
        : item?.syncState === "error" ? "Error"
          : item?.syncState === "synced" ? "Synced"
            : "Not synced";
  }

  const SOURCE_BADGES = { prairielearn: "PL", gradescope: "GS", canvas: "CV", prairietest: "PT" };

  function sourceBadge(item) {
    return SOURCE_BADGES[item?.source] || null;
  }

  function itemUrl(item) {
    return item?.sourceUrl || item?.url || "";
  }

  function itemCourseKey(item) {
    return item?.courseKey || item?.courseInstanceId || item?.courseName || "Unknown class";
  }

  function itemCourseName(item) {
    return item?.courseName || itemCourseKey(item);
  }

  // The "Edit date" flow stays PrairieLearn-only. Legacy scan items predate
  // the source field and are all PrairieLearn, so they remain editable.
  function canEditDate(item) {
    return !item?.source || item.source === "prairielearn";
  }

  const api = { dueDateKey, formatDueDate, formatItemDue, isCurrent, isCompleted, displayable, compareAssignments, statusLabel, sourceBadge, itemUrl, itemCourseKey, itemCourseName, canEditDate };
  globalThis.PrairieRunView = api;
  if (typeof module !== "undefined") module.exports = api;
})();

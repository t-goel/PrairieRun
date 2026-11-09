(function () {
  function pad(value) { return String(value).padStart(2, "0"); }

  function dateKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function dueDateKey(item) {
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

  function isCurrent(item, now = new Date()) {
    const due = dueDateKey(item);
    return due ? due >= dateKey(now) : false;
  }

  function isCompleted(item) {
    return (item?.completionStatus || "unknown") === "completed";
  }

  function displayable(item, showUndated, now = new Date()) {
    if (item?.syncState === "stale") return false;
    return isCurrent(item, now) || (showUndated && !item?.dueAtLocal);
  }

  function compareAssignments(a, b) {
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

  const api = { dueDateKey, formatDueDate, isCurrent, isCompleted, displayable, compareAssignments, statusLabel };
  globalThis.PrairieRunView = api;
  if (typeof module !== "undefined") module.exports = api;
})();

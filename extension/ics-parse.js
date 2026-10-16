// PrairieRun Canvas iCalendar feed parser (PR 4).
// Pure functions, Node-testable. No network, no storage, no chrome.* APIs.
// Observed feed (canvas.illinois.edu, 2026-10-15): HTTP 200 text/calendar,
// CRLF endings, PRODID icalendar-ruby, lines folded at ~75 chars (mid-word
// and mid-URL), one VEVENT per dated item. DTSTART is either UTC
// (20261019T200000Z), all-day DATE (DTSTART;VALUE=DATE[;VALUE=DATE]:20261015
// -- the duplicated param is a Canvas bug, tolerated here), or TZID/floating
// local times (America/Chicago unless TZID says otherwise).
// Plain IIFE script; no bundler.
(function () {
  function localToUtc(localYmdHms, timeZone) {
    const fn = globalThis.PrairieRunModel?.localToUtc;
    if (typeof fn !== "function") throw new Error("PrairieRunModel.localToUtc is unavailable.");
    return fn(localYmdHms, timeZone);
  }

  // Normalize CRLF/CR to LF, then unfold: drop every LF followed by a space
  // or tab (RFC 5545 folding). Canvas folds mid-word and mid-URL.
  function unfold(text) {
    return String(text ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n[ \t]/g, "");
  }

  // Split a raw ";"/":"-aware content line at the first colon that is not
  // inside a quoted param value. Returns { name, params, value } where
  // params maps UPPERCASED names to arrays of values (duplicates kept, so a
  // doubled VALUE=DATE param does not break DATE detection).
  function splitUnquoted(line, delimiter) {
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === delimiter && !inQuotes) return i;
    }
    return -1;
  }

  function unquote(value) {
    const v = String(value ?? "");
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
    return v;
  }

  function parseLine(line) {
    const raw = String(line ?? "");
    const colon = splitUnquoted(raw, ":");
    if (colon < 0) throw new Error(`Invalid ICS content line (no colon): ${raw.slice(0, 80)}`);
    const head = raw.slice(0, colon);
    const value = raw.slice(colon + 1);
    const segments = [];
    let current = "";
    let inQuotes = false;
    for (const ch of head) {
      if (ch === '"') inQuotes = !inQuotes;
      if (ch === ";" && !inQuotes) {
        segments.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    segments.push(current);
    const name = (segments.shift() || "").trim().toUpperCase();
    if (!name) throw new Error(`Invalid ICS content line (no name): ${raw.slice(0, 80)}`);
    const params = {};
    for (const segment of segments) {
      const eq = segment.indexOf("=");
      if (eq < 0) continue;
      const key = segment.slice(0, eq).trim().toUpperCase();
      if (!key) continue;
      const paramValue = unquote(segment.slice(eq + 1).trim());
      if (!params[key]) params[key] = [];
      params[key].push(paramValue);
    }
    return { name, params, value };
  }

  // Unescape RFC 5545 TEXT: \, \; \\ \n \N. Runs in one pass so "\\n"
  // (literal backslash + n) does not double-convert. Unknown escapes are
  // left untouched.
  function unescapeText(value) {
    const input = String(value ?? "");
    let out = "";
    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];
      if (ch === "\\" && i + 1 < input.length) {
        const next = input[i + 1];
        if (next === "n" || next === "N") {
          out += "\n";
          i += 1;
        } else if (next === "," || next === ";" || next === "\\") {
          out += next;
          i += 1;
        } else {
          out += ch;
        }
      } else {
        out += ch;
      }
    }
    return out;
  }

  // Parse a full .ics document into VEVENT property bags:
  // [{ uid, dtstart: { value, params } | null, dtend, summary, url, raw }].
  // DESCRIPTION/X-ALT-DESC/DTSTAMP/SEQUENCE/CLASS are ignored. Events without
  // a UID are dropped; events without DTSTART are kept with dtstart null and
  // left to the caller to skip.
  function parseIcs(text) {
    const events = [];
    const lines = unfold(text).split("\n");
    let buffer = null;
    for (const line of lines) {
      if (line === "BEGIN:VEVENT") {
        buffer = [];
        continue;
      }
      if (line === "END:VEVENT") {
        if (buffer) {
          const event = eventFromLines(buffer);
          if (event) events.push(event);
        }
        buffer = null;
        continue;
      }
      if (buffer !== null && line !== "") buffer.push(line);
    }
    return events;
  }

  function eventFromLines(lines) {
    let uid = null;
    let dtstart = null;
    let dtend = null;
    let summary = null;
    let url = null;
    for (const line of lines) {
      let parsed;
      try {
        parsed = parseLine(line);
      } catch {
        continue;
      }
      if (parsed.name === "UID" && uid === null) uid = parsed.value;
      else if (parsed.name === "DTSTART" && dtstart === null) {
        dtstart = { value: parsed.value, params: parsed.params };
      } else if (parsed.name === "DTEND" && dtend === null) {
        dtend = { value: parsed.value, params: parsed.params };
      } else if (parsed.name === "SUMMARY" && summary === null) summary = parsed.value;
      else if (parsed.name === "URL" && url === null) url = parsed.value;
    }
    if (uid === null || uid === "") return null;
    return { uid, dtstart, dtend, summary: summary ?? "", url: url ?? "", raw: lines.join("\n") };
  }

  function formatBasicDateTime(value) {
    // Basic format 20261019T200000 -> "2026-10-19 20:00:00".
    const match = String(value).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
    if (!match) return null;
    return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
  }

  function formatBasicDate(value) {
    const match = String(value).match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!match) return null;
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  function utcBasicToIso(value) {
    const match = String(value).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i);
    if (!match) return null;
    const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  // Convert a DTSTART/DTEND property to { iso, allDay }.
  // - VALUE=DATE (date-only) -> due 23:59 America/Chicago that day, allDay true.
  //   (Canvas emits all-day for items due 11:59 PM local.)
  // - ...Z suffix -> UTC instant.
  // - TZID param -> convert from that zone.
  // - floating (no Z/TZID) -> defaultTz (America/Chicago).
  function toInstant(prop, defaultTz = "America/Chicago") {
    if (!prop || typeof prop.value !== "string") throw new Error("toInstant requires { value, params }.");
    const value = prop.value.trim();
    const params = prop.params || {};
    const values = (params.VALUE || []).map((v) => String(v).toUpperCase());
    if (values.includes("DATE")) {
      const date = formatBasicDate(value);
      if (!date) throw new Error(`Invalid ICS DATE value: ${value}`);
      return { iso: localToUtc(`${date} 23:59:00`, "America/Chicago"), allDay: true };
    }
    if (/Z$/i.test(value)) {
      // Extended ISO with Z/offset passes straight through; basic needs shaping.
      let iso = null;
      if (value.includes("-") || value.includes("+")) {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) iso = date.toISOString();
      } else {
        iso = utcBasicToIso(value);
      }
      if (!iso) throw new Error(`Invalid ICS UTC value: ${value}`);
      return { iso, allDay: false };
    }
    const tzid = (params.TZID || [])[0];
    const zone = tzid ? String(tzid) : String(defaultTz || "America/Chicago");
    const local = formatBasicDateTime(value);
    if (!local) throw new Error(`Invalid ICS local date-time value: ${value}`);
    return { iso: localToUtc(local, zone), allDay: false };
  }

  const api = { unfold, parseLine, unescapeText, parseIcs, toInstant };
  globalThis.PrairieRunIcs = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

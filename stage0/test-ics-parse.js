// Tests for extension/ics-parse.js (PR 4): Canvas iCalendar feed parsing.
// Synthetic fixtures with CRLF endings, mirroring the observed UIUC feed.
const assert = require("node:assert/strict");
const test = require("node:test");

require("../extension/deadline-model.js");
const Ics = require("../extension/ics-parse.js");

const CRLF = "\r\n";

function vevent(lines) {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join(CRLF);
}

function feed(...events) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:icalendar-ruby",
    "X-WR-CALNAME:Student Calendar (Canvas)",
    ...events,
    "END:VCALENDAR",
    "",
  ].join(CRLF);
}

test("unfold joins folded lines, including mid-URL folds", () => {
  const text = [
    "URL;VALUE=URI:https://canvas.illinois.edu/calendar?include_contexts=course_55&mo",
    " nth=10&year=2026#assignment_123",
    "SUMMARY:Short",
  ].join(CRLF);
  const unfolded = Ics.unfold(text);
  assert.ok(unfolded.includes("course_55&month=10&year=2026#assignment_123"), unfolded);
  assert.equal(Ics.unfold("a\r\nb\rc\nd"), "a\nb\nc\nd");
});

test("parseLine splits params and tolerates duplicate VALUE=DATE", () => {
  const parsed = Ics.parseLine("DTSTART;VALUE=DATE;VALUE=DATE:20261015");
  assert.equal(parsed.name, "DTSTART");
  assert.deepEqual(parsed.params.VALUE, ["DATE", "DATE"]);
  assert.equal(parsed.value, "20261015");

  const url = Ics.parseLine(
    "URL;VALUE=URI:https://canvas.illinois.edu/calendar?include_contexts=course_55#assignment_123"
  );
  assert.deepEqual(url.params.VALUE, ["URI"]);
  assert.ok(url.value.includes("#assignment_123"));

  const quoted = Ics.parseLine('X-PROP;ALTREP="cid:part1.0001:with:colons":value:with:colons');
  assert.equal(quoted.params.ALTREP[0], "cid:part1.0001:with:colons");
  assert.equal(quoted.value, "value:with:colons");
});

test("unescapeText handles ICS escapes", () => {
  assert.equal(Ics.unescapeText("Read\\, discuss\\; reflect"), "Read, discuss; reflect");
  assert.equal(Ics.unescapeText("a\\\\b"), "a\\b");
  assert.equal(Ics.unescapeText("line1\\nline2"), "line1\nline2");
  assert.equal(Ics.unescapeText("line1\\Nline2"), "line1\nline2");
});

test("parseIcs extracts VEVENT fields and drops events without UID", () => {
  const text = feed(
    vevent([
      "UID:event-assignment-111",
      "DTSTART:20261019T200000Z",
      "DTEND:20261019T200000Z",
      "SUMMARY:Homework 5 [cs_425_120268_266229]",
      "URL;VALUE=URI:https://canvas.illinois.edu/calendar?include_contexts=course_266229&month=10&year=2026#assignment_777",
      "DESCRIPTION:ignored",
      "DTSTAMP:20261015T120000Z",
    ]),
    vevent(["DTSTART:20261019T200000Z", "SUMMARY:No uid here"])
  );
  const events = Ics.parseIcs(text);
  assert.equal(events.length, 1);
  assert.equal(events[0].uid, "event-assignment-111");
  assert.equal(events[0].dtstart.value, "20261019T200000Z");
  assert.equal(events[0].summary, "Homework 5 [cs_425_120268_266229]");
  assert.ok(events[0].url.includes("#assignment_777"));
});

test("toInstant converts UTC DTSTART", () => {
  const out = Ics.toInstant({ value: "20261019T200000Z", params: {} });
  assert.deepEqual(out, { iso: "2026-10-19T20:00:00.000Z", allDay: false });
});

test("toInstant maps all-day DATE to 23:59 America/Chicago", () => {
  // October: CDT (-05:00) -> 23:59 local is 04:59Z next day.
  const oct = Ics.toInstant({ value: "20261015", params: { VALUE: ["DATE", "DATE"] } });
  assert.deepEqual(oct, { iso: "2026-10-16T04:59:00.000Z", allDay: true });
  // November: CST (-06:00) -> 23:59 local is 05:59Z next day.
  const nov = Ics.toInstant({ value: "20261105", params: { VALUE: ["DATE"] } });
  assert.deepEqual(nov, { iso: "2026-11-06T05:59:00.000Z", allDay: true });
});

test("toInstant converts TZID and floating times as America/Chicago", () => {
  // 3:30 PM CDT in October.
  const tzid = Ics.toInstant({ value: "20261019T153000", params: { TZID: ["America/Chicago"] } });
  assert.deepEqual(tzid, { iso: "2026-10-19T20:30:00.000Z", allDay: false });
  const floating = Ics.toInstant({ value: "20261019T153000", params: {} });
  assert.deepEqual(floating, { iso: "2026-10-19T20:30:00.000Z", allDay: false });
  // 3:30 PM CST in November shifts the UTC instant.
  const winter = Ics.toInstant({ value: "20261119T153000", params: { TZID: ["America/Chicago"] } });
  assert.deepEqual(winter, { iso: "2026-11-19T21:30:00.000Z", allDay: false });
});

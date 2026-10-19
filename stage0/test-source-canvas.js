// Tests for extension/source-canvas.js (PR 4): feed fetch, VEVENT mapping,
// and the optional planner-API status merge. Synthetic CRLF fixtures only.
const assert = require("node:assert/strict");
const test = require("node:test");

require("../extension/deadline-model.js");
require("../extension/ics-parse.js");
const adapter = require("../extension/source-canvas.js");

const CRLF = "\r\n";
const TOKEN = "abc123TOKENxyz";
const FEED_URL = `https://canvas.illinois.edu/feeds/calendars/user_${TOKEN}.ics`;

function vevent(lines) {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join(CRLF);
}

function feed(...events) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:icalendar-ruby",
    ...events,
    "END:VCALENDAR",
    "",
  ].join(CRLF);
}

const SUMMARY_CASES = vevent([
  "UID:event-assignment-111",
  "DTSTART:20261019T200000Z",
  "DTEND:20261019T200000Z",
  "SUMMARY:Homework 5 [cs_425_120268_266229]",
  "URL;VALUE=URI:https://canvas.illinois.edu/calendar?include_contexts=course_266229&month=10&year=2026#assignment_777",
]);

function makeCtx({ secrets, settings, feedText, planner = null, plannerStatus = 200 } = {}) {
  const calls = [];
  const logs = [];
  const ctx = {
    secrets: secrets ?? { canvasFeedUrl: FEED_URL },
    settings: settings ?? { sources: { canvas: { enabled: true } } },
    now: new Date("2026-10-15T12:00:00.000Z"),
    log: (message, details) => logs.push([message, details]),
    fetchPage: async (url, opts) => {
      calls.push({ url, opts });
      if (String(url).includes("/api/v1/planner/items")) {
        if (plannerStatus === 401) {
          return { ok: false, status: 401, url, redirected: false, contentType: "application/json", text: "" };
        }
        return {
          ok: true, status: 200, url, redirected: false, contentType: "application/json", text: planner ?? "[]",
        };
      }
      return {
        ok: true, status: 200, url, redirected: false, contentType: "text/calendar", text: feedText,
      };
    },
  };
  return { ctx, calls, logs };
}

test("sync is disabled without a feed URL", async () => {
  const { ctx } = makeCtx({ secrets: {} });
  const result = await adapter.sync(ctx);
  assert.equal(result.status, "disabled");
  assert.deepEqual(result.items, []);
  assert.match(result.error, /Paste your Canvas Calendar Feed URL/);
});

test("feed fetch uses credentials omit and maps a UTC assignment", async () => {
  const { ctx, calls } = makeCtx({ feedText: feed(SUMMARY_CASES) });
  const result = await adapter.sync(ctx);
  assert.equal(result.status, "ok");
  assert.equal(calls[0].url, FEED_URL);
  assert.equal(calls[0].opts.credentials, "omit");
  assert.equal(calls[0].opts.accept, "text/calendar");
  const [item] = result.items;
  assert.equal(item.id, "canvas:266229:assignment:777");
  assert.equal(item.source, "canvas");
  assert.equal(item.kind, "assignment");
  assert.equal(item.title, "Homework 5");
  assert.equal(item.courseKey, "canvas:266229");
  assert.equal(item.courseCode, "CS 425");
  assert.equal(item.courseName, "CS 425");
  assert.equal(item.dueAt, "2026-10-19T20:00:00.000Z");
  assert.equal(item.allDay, false);
  assert.equal(item.status, "unknown");
  assert.equal(item.url, "https://canvas.illinois.edu/courses/266229/assignments/777");
  assert.equal(item.rawDueText, "20261019T200000Z");
});

test("override UID takes the assignment id from the URL", async () => {
  const text = feed(vevent([
    "UID:event-assignment-override-999",
    "DTSTART:20261020T150000Z",
    "SUMMARY:Homework 5 (CS 425 AL1 Fall 2026 CRN71234) [cs_425_120268_266229]",
    "URL;VALUE=URI:https://canvas.illinois.edu/calendar?include_contexts=course_55&month=10&year=2026#assignment_123",
  ]));
  const { ctx } = makeCtx({ feedText: text });
  const result = await adapter.sync(ctx);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, "canvas:55:assignment:123");
  assert.equal(result.items[0].url, "https://canvas.illinois.edu/courses/55/assignments/123");
  assert.equal(result.items[0].title, "Homework 5");
});

test("mid-URL folds, escapes, all-day dates, and calendar events", async () => {
  const text = feed(
    vevent([
      "UID:event-assignment-222",
      // Folded mid-URL: continuation line starts with a space.
      "URL;VALUE=URI:https://canvas.illinois.edu/calendar?include_contexts=course_55&mo",
      " nth=10&year=2026#assignment_123",
      "DTSTART:20261019T200000Z",
      "SUMMARY:Week 8: Discussion Activity  [ib_110_120268_261964]",
    ]),
    vevent([
      "UID:event-assignment-333",
      "DTSTART;VALUE=DATE;VALUE=DATE:20261015",
      "SUMMARY:Read\\, discuss\\; reflect [engl_109_120268_265873]",
      "URL;VALUE=URI:https://canvas.illinois.edu/calendar?include_contexts=course_265873#assignment_444",
    ]),
    vevent([
      "UID:event-calendar-event-42",
      "DTSTART:20261105T180000Z",
      "SUMMARY:Review session [cs_425_120268_266229]",
      "URL;VALUE=URI:https://canvas.illinois.edu/calendar?include_contexts=course_266229#calendar_event_42",
    ])
  );
  const { ctx } = makeCtx({ feedText: text });
  const result = await adapter.sync(ctx);
  assert.equal(result.status, "ok");
  assert.equal(result.items.length, 3);

  const folded = result.items.find((i) => i.id === "canvas:55:assignment:123");
  assert.ok(folded, "folded URL parses into the full assignment link");
  assert.equal(folded.url, "https://canvas.illinois.edu/courses/55/assignments/123");
  assert.equal(folded.title, "Week 8: Discussion Activity");
  assert.equal(folded.courseCode, "IB 110");

  const allDay = result.items.find((i) => i.id === "canvas:265873:assignment:444");
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.dueAt, "2026-10-16T04:59:00.000Z");
  assert.equal(allDay.title, "Read, discuss; reflect");
  assert.equal(allDay.courseCode, "ENGL 109");

  const event = result.items.find((i) => i.id === "canvas:event:event-calendar-event-42");
  assert.ok(event, "calendar events keep a canvas:event id");
  assert.equal(event.kind, "event");
});

test("section suffix is stripped from the title", async () => {
  const text = feed(vevent([
    "UID:event-assignment-444",
    "DTSTART:20261019T200000Z",
    "SUMMARY:Quiz 3 (IB 110 ABH Fall 2026 CRN73117) [ib_110_120268_261964]",
    "URL;VALUE=URI:https://canvas.illinois.edu/calendar?include_contexts=course_261964#assignment_555",
  ]));
  const { ctx } = makeCtx({ feedText: text });
  const result = await adapter.sync(ctx);
  assert.equal(result.items[0].title, "Quiz 3");
  assert.equal(result.items[0].courseCode, "IB 110");
});

test("401/404 feed responses explain how to re-copy the URL", async () => {
  for (const status of [401, 404]) {
    const { ctx } = makeCtx({ feedText: "" });
    ctx.fetchPage = async (url) => ({ ok: false, status, url, redirected: false, contentType: "text/plain", text: "" });
    const result = await adapter.sync(ctx);
    assert.equal(result.status, "error");
    assert.match(result.error, /re-copy it from Canvas/);
  }
});

test("planner API merges status and strips the while(1); prefix", async () => {
  const text = feed(
    vevent([
      "UID:event-assignment-1",
      "DTSTART:20261019T200000Z",
      "SUMMARY:A [cs_425_120268_266229]",
      "URL;VALUE=URI:https://canvas.illinois.edu/calendar?include_contexts=course_55&x=1#assignment_123",
    ]),
    vevent([
      "UID:event-assignment-2",
      "DTSTART:20261020T200000Z",
      "SUMMARY:B [cs_425_120268_266229]",
      "URL;VALUE=URI:https://canvas.illinois.edu/calendar?include_contexts=course_55&x=1#assignment_124",
    ])
  );
  const planner = `while(1);${JSON.stringify([
    { plannable_type: "assignment", course_id: 55, plannable_id: 123, submissions: { submitted: true } },
    { plannable_type: "assignment", course_id: 55, plannable_id: 124, submissions: { submitted: true, graded: true } },
    { plannable_type: "planner_note", course_id: 55, plannable_id: 999, submissions: {} },
  ])}`;
  const settings = { sources: { canvas: { enabled: true, plannerApi: true } } };
  const { ctx, calls } = makeCtx({ feedText: text, settings, planner });
  const result = await adapter.sync(ctx);
  assert.equal(result.status, "ok");
  const plannerCall = calls.find((c) => String(c.url).includes("/api/v1/planner/items"));
  assert.ok(plannerCall, "planner API requested");
  assert.equal(plannerCall.opts.credentials, "include");
  assert.ok(plannerCall.url.includes("start_date=2026-10-08"), plannerCall.url);
  assert.ok(plannerCall.url.includes("end_date=2026-12-14"), plannerCall.url);
  const byId = new Map(result.items.map((i) => [i.id, i]));
  assert.equal(byId.get("canvas:55:assignment:123").status, "submitted");
  assert.equal(byId.get("canvas:55:assignment:124").status, "graded");
});

test("planner missing flags map to not_started", async () => {
  const text = feed(vevent([
    "UID:event-assignment-1",
    "DTSTART:20261019T200000Z",
    "SUMMARY:A [cs_425_120268_266229]",
    "URL;VALUE=URI:https://canvas.illinois.edu/calendar?include_contexts=course_55&x=1#assignment_123",
  ]));
  const planner = JSON.stringify([
    { plannable_type: "assignment", course_id: 55, plannable_id: 123, submissions: { missing: true } },
  ]);
  const settings = { sources: { canvas: { enabled: true, plannerApi: true } } };
  const { ctx } = makeCtx({ feedText: text, settings, planner });
  const result = await adapter.sync(ctx);
  assert.equal(result.items[0].status, "not_started");
});

test("expired Canvas session keeps feed items with a status warning", async () => {
  const settings = { sources: { canvas: { enabled: true, plannerApi: true } } };
  const { ctx } = makeCtx({ feedText: feed(SUMMARY_CASES), settings, plannerStatus: 401 });
  const result = await adapter.sync(ctx);
  assert.equal(result.status, "ok");
  assert.equal(result.items.length, 1);
  assert.match(result.error, /session expired; status unavailable/);
});

test("no log entry leaks the feed token", async () => {
  const settings = { sources: { canvas: { enabled: true, plannerApi: true } } };
  const planner = JSON.stringify([
    { plannable_type: "assignment", course_id: 266229, plannable_id: 777, submissions: { submitted: true } },
  ]);
  const { ctx, logs } = makeCtx({ feedText: feed(SUMMARY_CASES), settings, planner });
  await adapter.sync(ctx);
  assert.ok(logs.length > 0, "expected some log entries");
  for (const [, details] of logs) {
    assert.ok(!JSON.stringify(details ?? null).includes(TOKEN), `token leaked: ${JSON.stringify(details)}`);
  }
});

test("isSignedOut detects 401 and /login redirects", () => {
  assert.equal(adapter.isSignedOut({ status: 401, url: FEED_URL }), true);
  assert.equal(adapter.isSignedOut({ status: 200, url: "https://canvas.illinois.edu/login" }), true);
  assert.equal(adapter.isSignedOut({ status: 200, url: "https://canvas.illinois.edu/login/canvas" }), true);
  assert.equal(adapter.isSignedOut({ status: 200, url: "https://canvas.illinois.edu/api/v1/planner/items" }), false);
  assert.equal(adapter.isSignedOut(null), false);
});

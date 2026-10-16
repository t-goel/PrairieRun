// Gradescope source tests (PR 5). Synthetic fixtures shaped like the
// nyuoss/gradescope-api and Matut-E/gradescope-to-Cal structure described in
// the PR brief. Selectors are unverified on a live UIUC page.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { parseHTML } = require("linkedom");

globalThis.PrairieRunModel = require("../extension/deadline-model.js");
const adapter = require("../extension/source-gradescope.js");

const ORIGIN = "https://www.gradescope.com";
const ACCOUNT_URL = `${ORIGIN}/account`;

function docOf(html) {
  return parseHTML(String(html)).document;
}

function courseBox({ id, shortName, fullName, extraClass = "" }) {
  return `<a class="courseBox ${extraClass}" href="/courses/${id}">`
    + `<h3 class="courseBox--shortname">${shortName}</h3>`
    + `<div class="courseBox--name">${fullName}</div>`
    + `<div class="courseBox--assignments"></div></a>`;
}

const ACCOUNT_HTML = `<div id="account-show">`
  + `<h2 class="pageHeading">Instructor Courses</h2>`
  + `<div class="courseList"><div class="courseList--term">Fall 2026</div>`
  + `<div class="courseList--coursesForTerm">`
  + courseBox({ id: "1", shortName: "CS 999", fullName: "Instructor Only" })
  + `</div></div>`
  + `<h2 class="pageHeading">Student Courses</h2>`
  + `<div class="courseList"><div class="courseList--term">Fall 2026</div>`
  + `<div class="courseList--coursesForTerm">`
  + courseBox({ id: "101", shortName: "CS 425", fullName: "Computer Systems" })
  + courseBox({ id: "102", shortName: "CS 411", fullName: "Database Systems" })
  + courseBox({ id: "new", shortName: "Add", fullName: "Add a course", extraClass: "courseBox-new" })
  + `</div><div class="courseList--term">Spring 2026</div>`
  + `<div class="courseList--coursesForTerm">`
  + courseBox({ id: "99", shortName: "CS 100", fullName: "Old Course" })
  + `</div></div></div>`;

const COURSE_HTML = `<h1 class="courseHeader--title">CS 425</h1>`
  + `<table><tbody>`
  + `<tr role="row"><th scope="col">Assignment</th><td>Status</td><td>Dates</td></tr>`
  + `<tr role="row"><th><a href="/courses/101/assignments/111/submissions/999">Homework 1</a></th>`
  + `<td>8.0 / 10.0</td>`
  + `<td><time class="submissionTimeChart--releaseDate" datetime="2026-09-01T09:00:00-05:00" aria-label="Released at Sep 1">Sep 1</time> `
  + `<time class="submissionTimeChart--dueDate" datetime="2026-10-17T23:59:00-05:00" aria-label="Due at Oct 17">Oct 17 at 11:59PM</time></td></tr>`
  + `<tr role="row"><th>Homework 2 <button class="js-submitAssignment" data-assignment-id="555">Submit</button></th>`
  + `<td>No Submission</td>`
  + `<td><time class="submissionTimeChart--releaseDate" datetime="2026-09-01T09:00:00-05:00">Sep 1</time> `
  + `<time class="submissionTimeChart--dueDate" datetime="2026-10-17T23:59:00-05:00" aria-label="Due at Oct 17">Oct 17 at 11:59PM</time></td></tr>`
  + `<tr role="row"><th>Project</th><td>Submitted</td>`
  + `<td><time class="submissionTimeChart--releaseDate" datetime="2026-09-01T09:00:00-05:00">Sep 1</time> `
  + `<time class="submissionTimeChart--dueDate" datetime="2026-10-20T23:59:00-05:00" aria-label="Due at Oct 20">Oct 20</time> `
  + `<time class="submissionTimeChart--dueDate" datetime="2026-10-22T23:59:00-05:00" aria-label="Late Due Date at Oct 22">Oct 22</time></td></tr>`
  + `<tr role="row"><th>Reading</th><td>No Submission</td><td></td></tr>`
  + `<tr role="row"><th>Homework 3 <button class="js-submitAssignment" data-assignment-id="777">Submit</button></th>`
  + `<td>No Submission</td>`
  + `<td><time class="submissionTimeChart--dueDate" datetime="2026-11-03 23:59:00 -0600">Nov 3 at 11:59PM</time></td></tr>`
  + `<tr role="row" class="dropzonePreview"><td colspan="3"><div class="dropzonePreview">Drop files here</div></td></tr>`
  + `</tbody></table>`;

function stubContext(pages) {
  const calls = [];
  async function fetchPage(url, opts = {}) {
    const method = String(opts.method || "GET").toUpperCase();
    calls.push({ url: String(url), method });
    assert.equal(method, "GET", "Gradescope sync must only issue GETs");
    const route = new URL(String(url));
    assert.equal(route.origin, ORIGIN, "Gradescope fetch stays on its own origin");
    assert.match(route.pathname, /^\/account$|^\/courses\/\d+$/, `unexpected Gradescope path: ${route.pathname}`);
    const body = pages[route.pathname];
    if (body === undefined) throw new Error(`No fixture for ${route.pathname}`);
    return { ok: true, status: 200, url: String(url), redirected: false, contentType: "text/html", text: body };
  }
  async function parseHtml(parserKey, html, url) {
    const [, name] = String(parserKey).split(".");
    return adapter.parsers[name](docOf(html), url);
  }
  return { calls, ctx: { fetchPage, parseHtml, settings: {}, secrets: {}, now: new Date("2026-10-16T12:00:00Z"), log: () => undefined } };
}

test("account parser keeps only current-term student courses", () => {
  const parsed = adapter.parsers.account(docOf(ACCOUNT_HTML), ACCOUNT_URL);
  assert.equal(parsed.signedOut, false);
  assert.deepEqual(parsed.courses.map((c) => c.id), ["101", "102"]);
  assert.equal(parsed.courses[0].shortName, "CS 425");
  assert.equal(parsed.courses[0].fullName, "Computer Systems");
  assert.equal(parsed.courses[0].term, "Fall 2026");
});

test("account parser treats heading-less pages as student courses", () => {
  const html = `<div id="account-show"><div class="courseList">`
    + courseBox({ id: "7", shortName: "CS 225", fullName: "Data Structures" })
    + `</div></div>`;
  const parsed = adapter.parsers.account(docOf(html), ACCOUNT_URL);
  assert.equal(parsed.signedOut, false);
  assert.deepEqual(parsed.courses.map((c) => c.id), ["7"]);
});

test("account parser reports signed out without #account-show", () => {
  const parsed = adapter.parsers.account(
    docOf('<html><body><form action="/login"><button>Log In</button></form></body></html>'),
    `${ORIGIN}/`
  );
  assert.equal(parsed.signedOut, true);
  assert.deepEqual(parsed.courses, []);
});

test("course parser maps every fixture row shape", () => {
  const parsed = adapter.parsers.course(docOf(COURSE_HTML), `${ORIGIN}/courses/101`);
  assert.equal(parsed.courseName, "CS 425");
  assert.equal(parsed.rows.length, 5);

  const [submitted, open, late, undated, spaced] = parsed.rows;

  assert.equal(submitted.title, "Homework 1");
  assert.equal(submitted.assignmentId, "111");
  assert.equal(submitted.statusText, "8.0 / 10.0");
  assert.equal(submitted.releaseAt, "2026-09-01T14:00:00.000Z");

  assert.equal(open.assignmentId, "555");
  assert.equal(open.dueAt, "2026-10-18T04:59:00.000Z");

  assert.equal(late.statusText, "Submitted");
  assert.equal(late.dueAt, "2026-10-21T04:59:00.000Z");
  assert.equal(late.lateDueAt, "2026-10-23T04:59:00.000Z");

  assert.equal(undated.title, "Reading");
  assert.equal(undated.dueAt, null);
  assert.equal(undated.releaseAt, null);

  assert.equal(spaced.assignmentId, "777");
  assert.equal(spaced.dueAt, "2026-11-04T05:59:00.000Z");
});

test("course parser falls back to plain tbody rows", () => {
  const html = `<table><tbody><tr><th>HW <button class="js-submitAssignment" data-assignment-id="1">S</button></th>`
    + `<td>No Submission</td><td><time class="submissionTimeChart--dueDate" datetime="2026-10-17T23:59:00-05:00">x</time></td></tr></tbody></table>`;
  const parsed = adapter.parsers.course(docOf(html), `${ORIGIN}/courses/101`);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].assignmentId, "1");
});

test("sync maps rows to DeadlineItems with Central-correct due times", async () => {
  const singleCourseAccount = `<div id="account-show"><h2 class="pageHeading">Student Courses</h2>`
    + `<div class="courseList"><div class="courseList--term">Fall 2026</div>`
    + `<div class="courseList--coursesForTerm">`
    + courseBox({ id: "101", shortName: "CS 425", fullName: "Computer Systems" })
    + `</div></div></div>`;
  const { calls, ctx } = stubContext({ "/account": singleCourseAccount, "/courses/101": COURSE_HTML });
  const result = await adapter.sync(ctx);

  assert.equal(result.status, "ok");
  assert.equal(result.items.length, 5);
  for (const item of result.items) {
    assert.equal(item.source, "gradescope");
    assert.equal(item.kind, "assignment");
    assert.equal(item.courseKey, "gradescope:101");
    assert.equal(item.courseName, "CS 425");
    assert.equal(item.courseCode, "CS 425");
  }

  const byId = new Map(result.items.map((item) => [item.id, item]));
  const graded = byId.get("gs:101:111");
  assert.equal(graded.status, "graded");
  assert.equal(graded.score, 80);
  assert.equal(graded.startAt, "2026-09-01T14:00:00.000Z");
  assert.equal(graded.url, `${ORIGIN}/courses/101/assignments/111`);

  const open = byId.get("gs:101:555");
  assert.equal(open.status, "not_started");
  assert.equal(open.dueAt, "2026-10-18T04:59:00.000Z");

  const late = result.items.find((item) => item.title === "Project");
  assert.equal(late.status, "submitted");
  assert.ok(late.lateDueAt);

  const undated = result.items.find((item) => item.title === "Reading");
  assert.equal(undated.dueAt, null);

  // Safety: only GETs to /account and /courses/<id> ever happened.
  assert.ok(calls.length >= 2);
  for (const call of calls) {
    assert.equal(call.method, "GET");
  }
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname).sort(), ["/account", "/courses/101"]);
});

test("sync gives title-derived ids to rows without an assignment id", async () => {
  const account = `<div id="account-show">`
    + courseBox({ id: "101", shortName: "CS 425", fullName: "Computer Systems" })
    + `</div>`;
  const course = `<table><tbody>`
    + `<tr role="row"><th>Ungraded Survey</th><td>No Submission</td>`
    + `<td><time class="submissionTimeChart--dueDate" datetime="2026-10-17T23:59:00-05:00">x</time></td></tr>`
    + `</tbody></table>`;
  const { ctx } = stubContext({ "/account": account, "/courses/101": course });
  const result = await adapter.sync(ctx);
  assert.equal(result.status, "ok");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, "gs:101:t:ungraded-survey");
  assert.match(result.items[0].rawDueText || "", /unstableId:true/);
});

test("signed-out account page returns signed_out", async () => {
  const { ctx } = stubContext({});
  ctx.fetchPage = async () => ({
    ok: true, status: 200, url: `${ORIGIN}/login`, redirected: true, contentType: "text/html", text: '<form action="/login">x</form>',
  });
  const result = await adapter.sync(ctx);
  assert.equal(result.status, "signed_out");
  assert.deepEqual(result.items, []);
});

test("isSignedOut matches the specified signals only", () => {
  assert.equal(adapter.isSignedOut({ url: `${ORIGIN}/login`, text: "" }), true);
  assert.equal(adapter.isSignedOut({ url: `${ORIGIN}/account`, text: '<form action="/login">x</form>' }), true);
  assert.equal(adapter.isSignedOut({ url: `${ORIGIN}/account`, text: '<div id="account-show">x</div>' }), false);
  assert.equal(adapter.isSignedOut({ url: `${ORIGIN}/account`, text: '<form action="/login"><div id="account-show">x</div>' }), false);
});

test("empty courses without a no-assignments message report a layout change", async () => {
  const account = `<div id="account-show">`
    + courseBox({ id: "101", shortName: "CS 425", fullName: "Computer Systems" })
    + `</div>`;
  const empty = `<h1>CS 425</h1><table><tbody>`
    + `<tr role="row"><th scope="col">Assignment</th></tr></tbody></table>`;
  const { ctx } = stubContext({ "/account": account, "/courses/101": empty });
  const result = await adapter.sync(ctx);
  assert.equal(result.status, "error");
  assert.match(result.error || "", /layout changed/i);

  const withMessage = `${empty}<p>There are no assignments in this course yet.</p>`;
  const okCtx = stubContext({ "/account": account, "/courses/101": withMessage }).ctx;
  const okResult = await adapter.sync(okCtx);
  assert.equal(okResult.status, "ok");
  assert.deepEqual(okResult.items, []);
});

test("submit buttons are read, never dispatched", async () => {
  const { document: doc } = parseHTML(COURSE_HTML);
  let clicked = 0;
  for (const button of doc.querySelectorAll("button.js-submitAssignment")) {
    button.addEventListener("click", () => { clicked += 1; });
  }
  adapter.parsers.course(doc, `${ORIGIN}/courses/101`);
  assert.equal(clicked, 0);

  // Static read-only guard: no writes, no form submission, no clicks.
  const source = fs.readFileSync(path.join(__dirname, "..", "extension", "source-gradescope.js"), "utf8");
  assert.doesNotMatch(source, /method:\s*["']POST["']/i);
  assert.doesNotMatch(source, /\.click\s*\(/);
  assert.doesNotMatch(source, /\.submit\s*\(/);
  assert.doesNotMatch(source, /chrome\./);
  assert.doesNotMatch(source, /browser\./);
});

test("spaced UTC offsets normalize to ISO before Date parsing", () => {
  assert.equal(
    adapter.parseGradescopeInstant("2026-11-03 23:59:00 -0600"),
    "2026-11-04T05:59:00.000Z"
  );
  assert.equal(
    adapter.parseGradescopeInstant("2026-10-17T23:59:00-05:00"),
    "2026-10-18T04:59:00.000Z"
  );
  assert.equal(adapter.parseGradescopeInstant("not a date"), null);
  assert.equal(adapter.parseGradescopeInstant(null), null);
});

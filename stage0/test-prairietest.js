const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { parseHTML } = require("linkedom");

const EXT = path.join(__dirname, "..", "extension");
const model = require("../extension/deadline-model.js");

function loadAdapter() {
  const sandbox = { console, URL };
  sandbox.globalThis = sandbox;
  sandbox.module = { exports: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, "deadline-model.js"), "utf8"), sandbox, { filename: "deadline-model.js" });
  vm.runInContext(fs.readFileSync(path.join(EXT, "source-prairietest.js"), "utf8"), sandbox, { filename: "source-prairietest.js" });
  return sandbox.module.exports;
}

const adapter = loadAdapter();

const HOME_HTML = `<!doctype html><html><body>
<h2>Current and future exam reservations</h2>
<ul class="list-group">
  <li class="list-group-item">
    <div data-testid="exam"><a href="/pt/reservation/42">CS 425 Midterm 1</a></div>
    <div data-testid="date"><span data-format-date='{"date":"2026-10-22T19:00:00.000Z"}'>Oct 22, 2:00 PM</span></div>
    <div data-testid="location">  Siebel   1404 </div>
    <div class="col-xxl-4">1 h 50 min</div>
  </li>
  <li class="list-group-item">
    <div data-testid="exam"><a href="/pt/exam/cs425-midterm-2">CS 425 Midterm 2</a></div>
    <div data-testid="date"><span data-format-date='{"date":"2026-11-03T15:00:00.000Z"}'>Nov 3, 9:00 AM</span></div>
    <div data-testid="location">ECEB 1015</div>
    <div class="col-md-6 col-xs-12">50 min</div>
  </li>
</ul>
<h2>Exams available for reservation</h2>
<ul class="list-group">
  <li class="list-group-item">
    <div data-testid="exam"><a href="/pt/reservation/99">CS 425 Final</a></div>
    <div data-testid="date"><span data-format-date='{"date":"2026-12-10T15:00:00.000Z"}'>Dec 10</span></div>
    <div data-testid="location">ARC</div>
    <div>2 h 0 min</div>
  </li>
</ul>
</body></html>`;

const LOGGED_OUT_HTML = `<!doctype html><html><body>
<nav><a href="https://us.prairielearn.com/pl/prairietest/auth">Login</a></nav>
<h1>PrairieTest</h1>
<p>Please log in to see your current and future exam reservations.</p>
</body></html>`;

function parseDoc(html) {
  return parseHTML(html).document;
}

// Objects built inside the vm sandbox carry that realm's prototypes, so
// strict deepEqual sees them as different. Round-trip through JSON first.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeCtx(html, { calls = [], url = "https://us.prairietest.com/pt" } = {}) {
  return {
    calls,
    fetchPage: async (requestUrl, opts) => {
      calls.push({ url: String(requestUrl), method: String((opts && opts.method) || "GET") });
      return { ok: true, status: 200, url, redirected: false, contentType: "text/html", text: html };
    },
    parseHtml: async (key, text, pageUrl) => {
      assert.equal(key, "prairietest.home");
      return adapter.parsers.home(parseDoc(text), pageUrl);
    },
    settings: {},
    secrets: {},
    now: new Date("2026-10-16T12:00:00.000Z"),
    log: () => {},
  };
}

test("home parser extracts reservations and ignores the available-for-reservation block", () => {
  const parsed = adapter.parsers.home(parseDoc(HOME_HTML), "https://us.prairietest.com/pt");
  assert.equal(parsed.signedOut, false);
  assert.equal(parsed.reservations.length, 2);
  assert.deepEqual(plain(parsed.reservations[0]), {
    name: "CS 425 Midterm 1",
    href: "/pt/reservation/42",
    startAt: "2026-10-22T19:00:00.000Z",
    durationMin: 110,
    location: "Siebel 1404",
  });
  assert.deepEqual(plain(parsed.reservations[1]), {
    name: "CS 425 Midterm 2",
    href: "/pt/exam/cs425-midterm-2",
    startAt: "2026-11-03T15:00:00.000Z",
    durationMin: 50,
    location: "ECEB 1015",
  });
});

test("sync maps reservations to exam DeadlineItems with a single GET to /pt", async () => {
  const calls = [];
  const result = await adapter.sync(makeCtx(HOME_HTML, { calls }));
  assert.equal(result.status, "ok");
  assert.equal(result.items.length, 2);

  const [first, second] = result.items;
  assert.equal(first.id, "pt:reservation:42");
  assert.equal(first.source, "prairietest");
  assert.equal(first.kind, "exam");
  assert.equal(first.courseCode, "CS 425");
  assert.equal(first.courseKey, "prairietest:CS 425");
  assert.equal(first.title, "CS 425 Midterm 1");
  assert.equal(first.startAt, "2026-10-22T19:00:00.000Z");
  assert.equal(first.endAt, "2026-10-22T20:50:00.000Z");
  assert.equal(first.dueAt, "2026-10-22T19:00:00.000Z");
  assert.equal(first.location, "Siebel 1404");
  assert.equal(first.status, "not_started");
  assert.equal(first.url, "https://us.prairietest.com/pt/reservation/42");

  assert.match(second.id, /^pt:exam:[0-9a-f]{16}$/);
  assert.equal(second.endAt, "2026-11-03T15:50:00.000Z");
  assert.equal(second.dueAt, "2026-11-03T15:00:00.000Z");

  // UTC instants display in Central across the 2026 DST switch (CDT -> CST Nov 1).
  assert.match(model.formatCentral(first.startAt), /CDT/);
  assert.match(model.formatCentral(second.startAt), /CST/);

  // Safety: exactly one GET, to /pt. No reservation or auth links are followed.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { url: "https://us.prairietest.com/pt", method: "GET" });
});

test("fallback exam ids are stable across syncs", async () => {
  const first = await adapter.sync(makeCtx(HOME_HTML, { calls: [] }));
  const second = await adapter.sync(makeCtx(HOME_HTML, { calls: [] }));
  const ids = (result) => result.items.map((item) => item.id);
  assert.deepEqual(ids(first), ids(second));
  assert.notEqual(first.items[0].id, first.items[1].id);
});

test("logged-out page reports signed_out", async () => {
  const parsed = adapter.parsers.home(parseDoc(LOGGED_OUT_HTML), "https://us.prairietest.com/pt");
  assert.equal(parsed.signedOut, true);
  assert.deepEqual(plain(parsed.reservations), []);

  const calls = [];
  const result = await adapter.sync(makeCtx(LOGGED_OUT_HTML, { calls }));
  assert.equal(result.status, "signed_out");
  assert.deepEqual(plain(result.items), []);
  assert.equal(calls.length, 1);
});

test("isSignedOut distinguishes auth pages, exam pages, and off-origin redirects", () => {
  const loginLink = '<a href="https://us.prairielearn.com/pl/prairietest/auth">Login</a>';
  assert.equal(adapter.isSignedOut({ url: "https://us.prairietest.com/pt", text: loginLink }), true);
  assert.equal(
    adapter.isSignedOut({ url: "https://us.prairietest.com/pt", text: `${loginLink}<div data-testid="exam">x</div>` }),
    false
  );
  assert.equal(adapter.isSignedOut({ url: "https://us.prairielearn.com/pl/prairietest/auth", text: "login" }), true);
  assert.equal(adapter.isSignedOut(null), false);
});

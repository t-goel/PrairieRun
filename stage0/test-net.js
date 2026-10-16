// PR 2 background-fetch tests: safe GET-only fetching, per-origin spacing,
// redirect visibility, and secret redaction. Modules load in node:vm with a
// fake fetch and fake timers.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const NET_PATH = path.join(__dirname, "..", "extension", "net.js");

function loadNet({ fetchImpl, randomValue = 0 } = {}) {
  const clock = { value: 1_000_000 };
  const delays = [];
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  sandbox.URL = URL;
  sandbox.AbortController = AbortController;
  sandbox.fetch = fetchImpl || (async () => {
    throw new Error("fetch should not have been called");
  });
  // Fake clock: setTimeout fires immediately but advances fake time.
  sandbox.Date = { now: () => clock.value };
  sandbox.setTimeout = (fn, ms) => {
    delays.push(ms);
    clock.value += ms;
    fn();
    return 0;
  };
  sandbox.clearTimeout = () => undefined;
  const math = Object.create(Math);
  math.random = () => randomValue;
  sandbox.Math = math;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(NET_PATH, "utf8"), sandbox, { filename: "net.js" });
  // Record fetch call times on the fake clock.
  const api = sandbox.PrairieRunNet;
  return { api, delays, clock, fetchCalls: [] };
}

function fakeResponse({ status = 200, url, redirected = false, body = "<html></html>" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    redirected,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "text/html" : null) },
    text: async () => body,
  };
}

test("fetchPage rejects POST without fetching", async () => {
  let calls = 0;
  const { api } = loadNet({
    fetchImpl: async () => {
      calls += 1;
      return fakeResponse({});
    },
  });
  await assert.rejects(() => api.fetchPage("https://us.prairielearn.com/pl", { method: "POST" }), /GET/);
  assert.equal(calls, 0);
});

test("an unsafe PrairieLearn URL throws before calling fetch", async () => {
  let calls = 0;
  const { api } = loadNet({
    fetchImpl: async () => {
      calls += 1;
      return fakeResponse({});
    },
  });
  // Assessment start route (no trailing slash, no query): a GET would create
  // an attempt, so it must throw before fetch runs.
  await assert.rejects(
    () => api.fetchPage("https://us.prairielearn.com/pl/course_instance/229304/assessment/2724861"),
    /SafetyError|Unsafe/
  );
  assert.equal(calls, 0);
});

test("two calls to the same origin are spaced apart", async () => {
  const callTimes = [];
  let harness;
  harness = loadNet({
    randomValue: 0, // deterministic 400 ms gap
    fetchImpl: async () => {
      callTimes.push(harness.clock.value);
      return fakeResponse({ url: "https://us.prairielearn.com/pl/" });
    },
  });
  await harness.api.fetchPage("https://us.prairielearn.com/pl");
  await harness.api.fetchPage("https://us.prairielearn.com/pl/course_instance/229304/assessments");
  assert.equal(callTimes.length, 2);
  assert.ok(callTimes[1] - callTimes[0] >= 400, `gap was ${callTimes[1] - callTimes[0]} ms`);
  assert.ok(harness.delays.some((ms) => ms >= 400), "a gap delay was scheduled");
});

test("the result reports the final url and redirect flag", async () => {
  const seen = [];
  const { api } = loadNet({
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return fakeResponse({ url: "https://us.prairielearn.com/pl/", redirected: true });
    },
  });
  const result = await api.fetchPage("https://us.prairielearn.com/pl");
  assert.equal(result.url, "https://us.prairielearn.com/pl/");
  assert.equal(result.redirected, true);
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.equal(typeof result.text, "string");
  assert.equal(seen[0].options.method, "GET");
  assert.equal(seen[0].options.credentials, "include");
  assert.equal(seen[0].options.redirect, "follow");
});

test("redactUrl hides Canvas feed tokens and drops query strings", () => {
  const { api } = loadNet();
  assert.equal(
    api.redactUrl("https://canvas.illinois.edu/feeds/calendars/user_abc123.ics?x"),
    "https://canvas.illinois.edu/feeds/calendars/user_*.ics"
  );
  assert.equal(
    api.redactUrl("https://canvas.illinois.edu/feeds/calendars/user_abc123.ics?until=2026#frag"),
    "https://canvas.illinois.edu/feeds/calendars/user_*.ics"
  );
  assert.equal(api.redactUrl("https://us.prairielearn.com/pl/?x=1"), "https://us.prairielearn.com/pl/");
});

test("extended origins are fetchable; unknown origins throw", async () => {
  const { api } = loadNet({
    fetchImpl: async (url) => fakeResponse({ url }),
  });
  for (const url of [
    "https://canvas.illinois.edu/",
    "https://www.gradescope.com/",
    "https://us.prairietest.com/pt",
  ]) {
    const result = await api.fetchPage(url);
    assert.equal(result.ok, true);
  }
  await assert.rejects(() => api.fetchPage("https://evil.example.com/"), /origin not allowed/);
});

test("more than 40 requests per origin per run are refused", async () => {
  const harness = loadNet({
    randomValue: 0,
    fetchImpl: async (url) => fakeResponse({ url }),
  });
  for (let i = 0; i < harness.api.MAX_REQUESTS_PER_ORIGIN; i += 1) {
    await harness.api.fetchPage("https://www.gradescope.com/");
  }
  await assert.rejects(() => harness.api.fetchPage("https://www.gradescope.com/"), /budget/);
  harness.api.resetBudgets();
  const result = await harness.api.fetchPage("https://www.gradescope.com/");
  assert.equal(result.ok, true);
});

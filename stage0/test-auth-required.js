// Background unattended runs must never open an interactive Google window.
// When no cached token exists and silent auth fails, Calendar calls reject
// with AuthRequiredError; connect() is the only path that uses interactive:true.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const CALENDAR_PATH = path.join(ROOT, "extension", "calendar.js");
const BACKGROUND_PATH = path.join(ROOT, "extension", "background.js");
const AUTH_UTILS = require("../extension/auth-utils.js");

function calendarHarness({ sessionValue = undefined, launchImpl } = {}) {
  const calls = [];
  let session = sessionValue;
  const local = {};
  const context = {
    URL, URLSearchParams, TextEncoder, structuredClone, crypto: webcrypto,
    setTimeout: (fn) => { fn(); },
    console: { log: () => {} },
    PrairieRunOAuthConfig: { clientId: "test-client-id.apps.googleusercontent.com" },
    PrairieRunAuthUtils: AUTH_UTILS,
    PrairieRunExt: {
      isFirefox: false,
      getSessionValue: async () => (session === undefined ? undefined : structuredClone(session)),
      setSessionValue: async (_key, value) => { session = structuredClone(value); },
      removeSessionValue: async () => { session = undefined; },
      clearSessionValues: async () => { session = undefined; },
      storageLocalGet: async () => structuredClone(local),
      storageLocalSet: async (values) => Object.assign(local, structuredClone(values)),
      identityGetRedirectURL: () => "https://test-id.chromiumapp.org/oauth2",
      identityLaunchWebAuthFlow: async (details) => {
        calls.push(details);
        if (launchImpl) return launchImpl(details);
        throw new Error("interaction required");
      },
    },
    fetch: async () => { throw new Error("fetch should not be called during auth"); },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(CALENDAR_PATH, "utf8"), context, { filename: "calendar.js" });
  return { api: context.PrairieRunCalendar, calls, getSession: () => session, context };
}

const assignment = {
  id: "pl:1:assessment:2", courseInstanceId: "1", courseName: "CS", title: "Homework",
  sourceUrl: "https://us.prairielearn.com/pl/course_instance/1/assessment/2/",
  dueAtLocal: "2026-10-20 11:00:00", timezone: "CDT", completionStatus: "unknown",
};

test("exportAssignments without a session token rejects AuthRequiredError without interactive auth", async () => {
  const h = calendarHarness({
    sessionValue: undefined,
    launchImpl: async (details) => {
      assert.equal(details.interactive, false);
      throw new Error("interaction required");
    },
  });
  await assert.rejects(
    h.api.exportAssignments([assignment]),
    (error) => {
      assert.equal(error.name, "AuthRequiredError");
      return true;
    }
  );
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].interactive, false);
  assert.ok(!h.calls.some((call) => call.interactive === true), "no interactive:true call was made");
});

test("connect() uses interactive:true exactly once", async () => {
  const h = calendarHarness({
    sessionValue: undefined,
    launchImpl: async (details) => {
      if (details.interactive === true) {
        return "https://test-id.chromiumapp.org/oauth2#access_token=tok123&expires_in=3600";
      }
      throw new Error("interaction required");
    },
  });
  const status = await h.api.connect();
  assert.equal(h.calls.filter((call) => call.interactive === true).length, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(status.connected, true);
  // A second export now uses the cached token without any auth window.
  h.calls.length = 0;
  h.context.fetch = async (url) => {
    const route = new URL(url);
    const reply = (body, statusCode = 200) => ({ ok: statusCode < 400, status: statusCode,
      json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
    if (route.pathname.endsWith("/calendarList")) return reply({ items: [{ id: "class", summary: "PrairieLearn — CS" }] });
    if (route.pathname.endsWith("/colors")) return reply({ event: { 8: { background: "#888888" }, 1: { background: "#3366cc" } } });
    if (route.pathname.endsWith("/events") && !route.pathname.includes("/events/")) {
      if (route.search) return reply({ items: [] });
      return reply({ id: "prr-test", ...JSON.parse("{}") });
    }
    return reply({});
  };
  // Cached token means getCalendarToken returns without calling identity at all.
  // (Full export covered by test-calendar-dedup; here we only verify no extra auth.)
  const token = await h.api.getCalendarToken();
  assert.equal(token, "tok123");
  assert.equal(h.calls.length, 0);
});

test("daily resync with no token records auth_required instead of opening a window", async () => {
  const local = {
    prairierunAssignments: [{ ...assignment, syncState: "synced" }],
  };
  class AuthRequired extends Error {
    constructor() { super("Connect Google Calendar to sync."); this.name = "AuthRequiredError"; this.code = "auth_required"; }
  }
  const authCalls = [];
  const context = {
    console: { log: () => {} },
    structuredClone,
    setTimeout: (fn) => { fn(); },
    queueMicrotask: (fn) => { fn(); },
    URL,
    PrairieRunCalendar: {
      AuthRequiredError: AuthRequired,
      exportAssignments: async () => { throw new AuthRequired(); },
      inspectAssignmentEvents: async () => { throw new AuthRequired(); },
    },
    PrairieRunExt: {
      storageLocalGet: async () => structuredClone(local),
      storageLocalSet: async (items) => Object.assign(local, structuredClone(items)),
      tabsSendMessage: async () => undefined,
      tabsQuery: async () => [],
      tabsCreate: async () => ({ id: 1 }),
      tabsRemove: async () => undefined,
      tabsGet: async (id) => ({ id, status: "complete" }),
      addRuntimeMessageListener: () => {},
      addStorageChangedListener: () => {},
      addTabsUpdatedListener: () => {},
      removeTabsUpdatedListener: () => {},
      alarmsCreate: async () => undefined,
      addAlarmsListener: () => {},
    },
  };
  // Track identity calls if background ever tried interactive auth (it must not).
  context.PrairieRunExt.identityLaunchWebAuthFlow = async (details) => {
    authCalls.push(details);
    throw new Error("must not open auth window");
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(BACKGROUND_PATH, "utf8"), context, { filename: "background.js" });
  await vm.runInContext("runDailyCalendarSync()", context);
  assert.equal(local.prairierunSyncStatus.state, "auth_required");
  assert.equal(local.prairierunSyncStatus.current, "Connect Google Calendar to sync.");
  assert.equal(authCalls.length, 0);
});

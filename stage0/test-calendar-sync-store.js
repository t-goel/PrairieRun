const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const MODEL_PATH = path.join(EXT, "deadline-model.js");
const BACKGROUND_PATH = path.join(EXT, "background.js");
const model = require(MODEL_PATH);

function createHarness({ local = {}, directGoogleSync = true, exportImpl = null } = {}) {
  const store = { ...local };
  const exportCalls = [];
  let runtimeListener = null;

  class AuthRequiredError extends Error {
    constructor(message = "Connect Google Calendar to sync.") {
      super(message);
      this.name = "AuthRequiredError";
      this.code = "auth_required";
    }
  }

  const context = {
    URL,
    URLSearchParams,
    TextEncoder,
    structuredClone,
    console: { log: () => {} },
    setTimeout: (fn) => { fn(); },
    queueMicrotask: (fn) => { fn(); },
    PRAIRIERUN_DIRECT_GOOGLE_SYNC: directGoogleSync,
    PrairieRunCalendar: {
      AuthRequiredError,
      getAuthStatus: async () => ({ connected: true }),
      connectGoogleCalendar: async () => ({ connected: true }),
      disconnectGoogleCalendar: async () => ({ connected: false }),
      exportAssignments: exportImpl || (async (items) => {
        exportCalls.push(items);
        return items.map((assignment) => ({ assignment, status: "updated", removedDuplicates: 0 }));
      }),
      inspectAssignmentEvents: async () => ({ missingIds: [], duplicateIds: [] }),
    },
    PrairieRunOrchestrator: {
      runSync: async ({ reason, sources } = {}) => ({
        results: {},
        items: store.prairierunDeadlines || [],
        changes: [],
      }),
    },
    PrairieRunExt: {
      storageLocalGet: async (keys) => {
        if (!keys) return structuredClone(store);
        const keyList = Array.isArray(keys) ? keys : [keys];
        const res = {};
        for (const k of keyList) {
          if (store[k] !== undefined) res[k] = structuredClone(store[k]);
        }
        return res;
      },
      storageLocalSet: async (items) => {
        Object.assign(store, structuredClone(items));
      },
      tabsSendMessage: async () => ({ ok: true }),
      tabsQuery: async () => [],
      tabsCreate: async () => ({ id: 1 }),
      tabsRemove: async () => undefined,
      tabsGet: async (id) => ({ id, status: "complete" }),
      addRuntimeMessageListener: (fn) => { runtimeListener = fn; },
      addStorageChangedListener: () => {},
      addTabsUpdatedListener: () => {},
      removeTabsUpdatedListener: () => {},
      alarmsCreate: async () => undefined,
      addAlarmsListener: () => {},
    },
  };

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(MODEL_PATH, "utf8"), context, { filename: "deadline-model.js" });
  vm.runInContext(fs.readFileSync(BACKGROUND_PATH, "utf8"), context, { filename: "background.js" });

  return {
    context,
    store,
    exportCalls,
    AuthRequiredError,
    sendMessage: (msg) => new Promise((resolve) => {
      assert.ok(runtimeListener, "Runtime listener must be registered");
      runtimeListener(msg, { tab: { id: 1 } }, resolve);
    }),
  };
}

test("syncGoogleCalendarFromStore exports dated items from prairierunDeadlines via toLegacyPlAssignment", async () => {
  const sampleDeadline = model.makeDeadlineItem({
    id: "pl:12345:assessment:67890",
    source: "prairielearn",
    kind: "assignment",
    courseKey: "prairielearn:12345",
    courseName: "CS 225",
    title: "Binary Trees",
    dueAt: "2026-10-25T04:59:00.000Z",
    url: "https://us.prairielearn.com/pl/course_instance/12345/assessment/67890/",
  });

  const h = createHarness({
    local: { prairierunDeadlines: [sampleDeadline] },
  });

  const result = await vm.runInContext("PrairieRunBackground.syncGoogleCalendarFromStore('test')", h.context);
  assert.equal(result.ok, true);
  assert.equal(h.exportCalls.length, 1);
  const exported = h.exportCalls[0];
  assert.equal(exported.length, 1);
  assert.equal(exported[0].id, "pl:12345:assessment:67890");
  assert.equal(exported[0].courseName, "CS 225");
  assert.equal(exported[0].title, "Binary Trees");
  assert.ok(exported[0].dueAtLocal);
  assert.equal(h.store.prairierunSyncStatus.state, "complete");
  assert.match(h.store.prairierunSyncStatus.current, /Google Calendar synced/);
});

test("syncGoogleCalendarFromStore falls back to prairierunAssignments when prairierunDeadlines is empty", async () => {
  const legacyItem = {
    id: "pl:1:assessment:2",
    courseInstanceId: "1",
    courseName: "CS 101",
    title: "Intro HW",
    dueAtLocal: "2026-10-20 11:00:00",
    timezone: "CDT",
    syncState: "synced",
  };

  const h = createHarness({
    local: { prairierunAssignments: [legacyItem] },
  });

  const result = await vm.runInContext("PrairieRunBackground.syncGoogleCalendarFromStore('fallback')", h.context);
  assert.equal(result.ok, true);
  assert.equal(h.exportCalls.length, 1);
  assert.equal(h.exportCalls[0][0].id, "pl:1:assessment:2");
});

test("syncGoogleCalendarFromStore skips export when DIRECT_GOOGLE_SYNC_ENABLED is false", async () => {
  const sampleDeadline = model.makeDeadlineItem({
    id: "pl:12345:assessment:67890",
    source: "prairielearn",
    kind: "assignment",
    courseKey: "prairielearn:12345",
    courseName: "CS 225",
    title: "Binary Trees",
    dueAt: "2026-10-25T04:59:00.000Z",
    url: "https://us.prairielearn.com/pl/course_instance/12345/assessment/67890/",
  });

  const h = createHarness({
    local: { prairierunDeadlines: [sampleDeadline] },
    directGoogleSync: false,
  });

  const result = await vm.runInContext("PrairieRunBackground.syncGoogleCalendarFromStore('test')", h.context);
  assert.equal(result.skipped, "disabled");
  assert.equal(h.exportCalls.length, 0);
});

test("PRAIRIERUN_AUTH_CONNECT triggers calendar export from store upon successful connection", async () => {
  const sampleDeadline = model.makeDeadlineItem({
    id: "pl:12345:assessment:67890",
    source: "prairielearn",
    kind: "assignment",
    courseKey: "prairielearn:12345",
    courseName: "CS 225",
    title: "Binary Trees",
    dueAt: "2026-10-25T04:59:00.000Z",
    url: "https://us.prairielearn.com/pl/course_instance/12345/assessment/67890/",
  });

  const h = createHarness({
    local: { prairierunDeadlines: [sampleDeadline] },
  });

  const resp = await h.sendMessage({ type: "PRAIRIERUN_AUTH_CONNECT" });
  assert.equal(resp.ok, true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.exportCalls.length, 1);
  assert.equal(h.exportCalls[0][0].id, "pl:12345:assessment:67890");
});

test("PRAIRIERUN_SYNC_NOW triggers orchestrator sync followed by calendar export from store", async () => {
  const sampleDeadline = model.makeDeadlineItem({
    id: "pl:12345:assessment:67890",
    source: "prairielearn",
    kind: "assignment",
    courseKey: "prairielearn:12345",
    courseName: "CS 225",
    title: "Binary Trees",
    dueAt: "2026-10-25T04:59:00.000Z",
    url: "https://us.prairielearn.com/pl/course_instance/12345/assessment/67890/",
  });

  const h = createHarness({
    local: { prairierunDeadlines: [sampleDeadline] },
  });

  const resp = await h.sendMessage({ type: "PRAIRIERUN_SYNC_NOW" });
  assert.equal(resp.ok, true);
  assert.equal(h.exportCalls.length, 1);
  assert.equal(h.exportCalls[0][0].id, "pl:12345:assessment:67890");
});

test("syncGoogleCalendarFromStore sets auth_required status when export throws AuthRequiredError", async () => {
  const sampleDeadline = model.makeDeadlineItem({
    id: "pl:12345:assessment:67890",
    source: "prairielearn",
    kind: "assignment",
    courseKey: "prairielearn:12345",
    courseName: "CS 225",
    title: "Binary Trees",
    dueAt: "2026-10-25T04:59:00.000Z",
    url: "https://us.prairielearn.com/pl/course_instance/12345/assessment/67890/",
  });

  let authErr;
  const h = createHarness({
    local: { prairierunDeadlines: [sampleDeadline] },
    exportImpl: async () => {
      authErr = new h.AuthRequiredError();
      throw authErr;
    },
  });

  const result = await vm.runInContext("PrairieRunBackground.syncGoogleCalendarFromStore('test')", h.context);
  assert.equal(result.skipped, "auth_required");
  assert.equal(h.store.prairierunSyncStatus.state, "auth_required");
  assert.equal(h.store.prairierunSyncStatus.current, "Connect Google Calendar to sync.");
});

// PR 2 orchestrator tests: session lease locking, permission gating, and
// generic cross-host signed-out detection with previous-item retention.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const EXT = path.join(__dirname, "..", "extension");

function loadOrchestrator({ adapters = [], local = {}, session = {}, fetchImpl = null, permissions = true } = {}) {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  sandbox.URL = URL;
  vm.createContext(sandbox);
  const run = (file) => vm.runInContext(fs.readFileSync(path.join(EXT, file), "utf8"), sandbox, { filename: file });
  run("source-registry.js");
  run("deadline-model.js");
  run("deadline-store.js"); // real merge contract: non-ok statuses keep previous items
  const saved = { ...local };
  const sessionData = { ...session };
  let outputCalls = 0;
  sandbox.PrairieRunOutputs = {
    run: async () => {
      outputCalls += 1;
      return {};
    },
  };
  sandbox.PrairieRunNet = {
    resetBudgets: () => undefined,
    fetchPage: fetchImpl || (async () => {
      throw new Error("fetchPage should not have been called");
    }),
  };
  sandbox.PrairieRunParseHost = { parseHtml: async () => ({}) };
  sandbox.PrairieRunExt = {
    storageLocalGet: async (key) => {
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) out[k] = saved[k];
      return out;
    },
    storageLocalSet: async (items) => Object.assign(saved, items),
    getSessionValue: async (key) => sessionData[key],
    setSessionValue: async (key, value) => {
      sessionData[key] = value;
    },
    removeSessionValue: async (key) => {
      delete sessionData[key];
    },
    permissionsContains: async () => permissions,
  };
  for (const adapter of adapters) sandbox.PrairieRunSources.register(adapter);
  run("sync-orchestrator.js");
  return { api: sandbox.PrairieRunOrchestrator, saved, sessionData, outputCalls: () => outputCalls };
}

function stubAdapter(overrides = {}) {
  return {
    id: "stub",
    label: "Stub",
    origins: ["https://example.com"],
    signInUrl: "https://example.com/login",
    parsers: {},
    isSignedOut: () => false,
    sync: async () => ({ status: "ok", items: [], checkedAt: new Date().toISOString() }),
    ...overrides,
  };
}

test("the lease blocks a second concurrent run", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const harness = loadOrchestrator({
    adapters: [
      stubAdapter({
        id: "slow",
        sync: async () => {
          await gate;
          return { status: "ok", items: [], checkedAt: new Date().toISOString() };
        },
      }),
    ],
  });
  const first = harness.api.runSync({ sources: ["slow"] });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await harness.api.runSync({ sources: ["slow"] });
  assert.equal(second.skipped, "locked");
  release();
  const done = await first;
  assert.ok(done.results.slow, "the first run completes normally");
  assert.equal(done.results.slow.status, "ok");
});

test("an expired lease gets taken over", async () => {
  const harness = loadOrchestrator({
    adapters: [stubAdapter({ id: "a" })],
    session: { prairierunSyncLease: { owner: "stale-owner", expiresAt: Date.now() - 1000 } },
  });
  const result = await harness.api.runSync({ sources: ["a"] });
  assert.ok(!result.skipped, "an expired lease does not block the run");
  assert.equal(result.results.a.status, "ok");
  // The lease is released after the run.
  assert.equal(harness.sessionData.prairierunSyncLease, undefined);
});

test("a cross-host redirect marks the source signed_out and keeps previous items", async () => {
  const previous = {
    id: "x:1",
    source: "weird",
    kind: "assignment",
    courseKey: "weird:c1",
    courseName: "Weird",
    courseCode: null,
    title: "Old homework",
    dueAt: "2026-10-17T04:59:00.000Z",
    allDay: false,
    startAt: null,
    endAt: null,
    lateDueAt: null,
    location: null,
    status: "unknown",
    score: null,
    url: "https://example.com/old",
    sourceUrls: [],
    aliases: [],
    rawDueText: null,
    sourceTimezone: null,
    fetchedAt: new Date().toISOString(),
  };
  const harness = loadOrchestrator({
    adapters: [
      stubAdapter({
        id: "weird",
        label: "Weird",
        origins: ["https://example.com"],
        signInUrl: "https://example.com/login",
        sync: async (ctx) => {
          await ctx.fetchPage("https://example.com/dashboard");
          return { status: "ok", items: [], checkedAt: new Date().toISOString() };
        },
      }),
    ],
    local: { prairierunDeadlines: [previous] },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: "https://login.example-idp.com/",
      redirected: true,
      contentType: "text/html",
      text: "<html>login</html>",
    }),
  });
  const result = await harness.api.runSync({ sources: ["weird"] });
  assert.equal(result.results.weird.status, "signed_out");
  assert.ok(result.items.some((item) => item.id === "x:1"), "previous items are retained");
  const status = harness.saved.prairierunSourceStatus.weird;
  assert.equal(status.status, "signed_out");
  assert.equal(status.signInUrl, "https://example.com/login");
  assert.ok(status.checkedAt, "status carries a check time");
  assert.ok(!("items" in status), "status omits items");
});

test("a missing permission gives disabled without calling the adapter", async () => {
  let syncCalls = 0;
  const harness = loadOrchestrator({
    adapters: [
      stubAdapter({
        id: "gated",
        origins: ["https://gated.example.com"],
        sync: async () => {
          syncCalls += 1;
          return { status: "ok", items: [], checkedAt: new Date().toISOString() };
        },
      }),
    ],
    permissions: false,
  });
  const result = await harness.api.runSync({ sources: ["gated"] });
  assert.equal(syncCalls, 0);
  assert.equal(result.results.gated.status, "disabled");
  assert.equal(result.results.gated.error, "permission");
  assert.equal(harness.saved.prairierunSourceStatus.gated.status, "disabled");
});

test("an adapter-reported signed_out is preserved", async () => {
  const harness = loadOrchestrator({
    adapters: [
      stubAdapter({
        id: "s",
        sync: async () => ({ status: "signed_out", items: [], checkedAt: new Date().toISOString() }),
      }),
    ],
  });
  const result = await harness.api.runSync({ sources: ["s"] });
  assert.equal(result.results.s.status, "signed_out");
  assert.equal(harness.saved.prairierunSourceStatus.s.status, "signed_out");
});

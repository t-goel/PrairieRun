// Tests for the hosted iCal feed pipeline: PrairieRunRelay.publish /
// autoPublish and the PrairieRunOutputs fan-out, against a fake storage
// shim, a mocked relay endpoint, and the real ICS writer.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EXT_PATH = path.join(ROOT, "extension");

function loadExtension(file) {
  require(path.join(EXT_PATH, file));
}

function makeItem(dueAt, id = "ass1", extras = {}) {
  return {
    id,
    title: "HW 1",
    source: "prairielearn",
    dueAt,
    status: "incomplete",
    ...extras,
  };
}

function okPublishResponse(feedId = "feedabc123def") {
  return {
    status: 200,
    ok: true,
    json: async () => ({ ok: true, url: `https://blob.test/feeds/${feedId}.ics` }),
    text: async () => "",
  };
}

function installEnv({ canPublishPermission = true } = {}) {
  const store = new Map();
  globalThis.PrairieRunExt = {
    storageLocalGet: async (keys) => {
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of wanted) {
        if (store.has(key)) out[key] = store.get(key);
      }
      return out;
    },
    storageLocalSet: async (items) => {
      for (const [key, value] of Object.entries(items || {})) store.set(key, value);
    },
    storageLocalClear: async () => store.clear(),
    permissionsContains: async () => canPublishPermission,
  };

  const fetchCalls = [];
  let responses = [];
  const fetchMock = async (...args) => {
    fetchCalls.push({ url: args[0], init: args[1] });
    const next = responses.shift();
    if (next) return next;
    throw new Error("No mocked relay response remaining.");
  };
  return {
    store,
    fetchCalls,
    setResponses(list) {
      responses = list;
    },
    fetchMock,
  };
}

function configureFeed(env, { enabled = true, permissionHit = false } = {}) {
  env.store.set("prairierunSettings", {
    relay: { enabled, relayUrl: "https://relay.test/app/sub", feedId: "feedabc123def" },
  });
  env.store.set("prairierunSecrets", { relayPublishKey: "sekrit" });
  void permissionHit;
}

loadExtension("ics-writer.js");
loadExtension("outputs.js");
loadExtension("relay-push.js");
const relay = globalThis.PrairieRunRelay;
const outputs = globalThis.PrairieRunOutputs;
const optionsFeed = require(path.join(EXT_PATH, "options-feed.js"));

test("normalizeRelayUrl keeps only clean https origins and paths", () => {
  assert.equal(optionsFeed.normalizeRelayUrl("https://relay.test/app//"), "https://relay.test/app");
  assert.equal(optionsFeed.normalizeRelayUrl("http://relay.test"), "");
  assert.equal(optionsFeed.normalizeRelayUrl("not a url"), "");
});

test("courseFeedEntries sorts and drops empty course feed rows", () => {
  assert.deepEqual(optionsFeed.courseFeedEntries(null), []);
  assert.deepEqual(optionsFeed.courseFeedEntries([]), []);
  assert.deepEqual(
    optionsFeed.courseFeedEntries({
      "MATH 241": "https://relay.test/math.ics",
      "": "https://relay.test/empty.ics",
      "CS 225": "https://relay.test/cs.ics",
      blank: "  ",
    }),
    [
      { code: "CS 225", url: "https://relay.test/cs.ics" },
      { code: "MATH 241", url: "https://relay.test/math.ics" },
    ],
  );
});

test("publish without feed config reports disabled then missing config", async () => {
  const env = installEnv();
  globalThis.fetch = env.fetchMock;
  const disabled = await relay.publish([makeItem("2026-11-01T12:00:00")], { settings: {}, secrets: {} });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.status, "disabled");

  configureFeed(env, { enabled: true });
  env.store.delete("prairierunSecrets");
  const missing = await relay.publish(
    [makeItem("2026-11-01T12:00:00")],
    { settings: env.store.get("prairierunSettings"), secrets: {} },
  );
  assert.equal(missing.ok, false);
  assert.match(missing.error, /missing/i);
});

test("publish POSTs the ICS body and records the feed URL", async () => {
  const env = installEnv();
  globalThis.fetch = env.fetchMock;
  configureFeed(env);
  env.setResponses([{ status: 200, ok: true, json: async () => ({ ok: true, url: "https://blob.test/feeds/feedabc123def.ics" }), text: async () => "" }]);

  const result = await relay.publish(
    [makeItem("2026-11-01T12:00:00")],
    { settings: env.store.get("prairierunSettings"), secrets: { relayPublishKey: "sekrit" } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.url, "https://blob.test/feeds/feedabc123def.ics");
  assert.equal(env.fetchCalls.length, 1);
  assert.match(env.fetchCalls[0].url, /^https:\/\/relay\.test\/app\/sub\/api\/publish$/);
  assert.equal(env.fetchCalls[0].init.headers["x-prairierun-key"], "sekrit");
  const body = JSON.parse(env.fetchCalls[0].init.body);
  assert.equal(body.feedId, "feedabc123def");
  assert.match(body.ics, /^BEGIN:VCALENDAR/);

  const status = env.store.get("prairierunRelayStatus");
  assert.equal(status.state, "ok");
  assert.equal(status.url, "https://blob.test/feeds/feedabc123def.ics");
  assert.ok(status.hash);
});

test("unchanged feed content is not re-uploaded", async () => {
  const env = installEnv();
  globalThis.fetch = env.fetchMock;
  configureFeed(env);
  env.setResponses([{ status: 200, ok: true, json: async () => ({ ok: true, url: "https://blob.test/feeds/feedabc123def.ics" }), text: async () => "" }]);
  const items = [makeItem("2026-11-01T12:00:00")];
  const payload = { settings: env.store.get("prairierunSettings"), secrets: { relayPublishKey: "sekrit" } };

  await relay.publish(items, payload);
  assert.equal(env.fetchCalls.length, 1);

  // Rebuild the ICS after running publish again; DTSTAMP shifts, but content
  // is otherwise identical, and the relay must not see a second POST.
  env.setResponses([{ status: 500, text: async () => "should not be called" }]);
  const again = await relay.publish(items, payload);
  assert.equal(again.ok, true);
  assert.equal(env.fetchCalls.length, 1);
  assert.equal(again.url, "https://blob.test/feeds/feedabc123def.ics");
});

test("changed content publishes again", async () => {
  const env = installEnv();
  globalThis.fetch = env.fetchMock;
  configureFeed(env);
  env.setResponses([
    { status: 200, ok: true, json: async () => ({ ok: true, url: "https://blob.test/feeds/feedabc123def.ics" }), text: async () => "" },
    { status: 200, ok: true, json: async () => ({ ok: true, url: "https://blob.test/feeds/feedabc123def.ics" }), text: async () => "" },
  ]);
  const payload = { settings: env.store.get("prairierunSettings"), secrets: { relayPublishKey: "sekrit" } };
  await relay.publish([makeItem("2026-11-01T12:00:00")], payload);
  await relay.publish([makeItem("2026-11-02T09:30:00")], payload);
  assert.equal(env.fetchCalls.length, 2);
});

test("relay 401 keeps the feed in an error state without a follower insert", async () => {
  const env = installEnv();
  globalThis.fetch = env.fetchMock;
  configureFeed(env);
  env.setResponses([{ status: 401, ok: false, json: async () => ({ ok: false }), text: async () => "" }]);
  const result = await relay.publish(
    [makeItem("2026-11-01T12:00:00")],
    { settings: env.store.get("prairierunSettings"), secrets: { relayPublishKey: "wrong" } },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /publish key/i);
  assert.equal(env.store.get("prairierunRelayStatus").state, "error");
});

test("autoPublish requires the feed enabled and the relay permission", async () => {
  const env = installEnv({ canPublishPermission: false });
  globalThis.fetch = env.fetchMock;
  configureFeed(env, { enabled: false });
  const disabled = await relay.autoPublish([makeItem("2026-11-01T12:00:00")], env.store.get("prairierunSettings"));
  assert.equal(disabled.skipped, "disabled");

  env.store.set("prairierunSettings", {
    relay: { enabled: true, relayUrl: "https://relay.test", feedId: "feedabc123def" },
  });
  const blocked = await relay.autoPublish([makeItem("2026-11-01T12:00:00")], env.store.get("prairierunSettings"));
  assert.equal(blocked.skipped, "needs_permission");
  assert.equal(env.store.get("prairierunRelayStatus").state, "needs_permission");

  globalThis.PrairieRunExt.permissionsContains = async () => true;
  // Combined feed + one per-course (uncategorized) publish.
  env.setResponses([
    okPublishResponse(),
    okPublishResponse("feedabc123def-uncategorized"),
  ]);
  const published = await relay.autoPublish([makeItem("2026-11-01T12:00:00")], env.store.get("prairierunSettings"));
  assert.equal(published.ok, true);
  assert.equal(env.fetchCalls.length, 2);
  assert.equal(published.perCourse?.ok, true);
});

test("outputs.run fans the relay auto-publish into every sync", async () => {
  const env = installEnv();
  globalThis.fetch = env.fetchMock;
  configureFeed(env);
  env.setResponses([
    okPublishResponse(),
    okPublishResponse("feedabc123def-uncategorized"),
  ]);
  const results = await outputs.run([makeItem("2026-11-01T12:00:00")], [], env.store.get("prairierunSettings"));
  assert.equal(results.relay.ok, true);
  assert.equal(env.fetchCalls.length, 2);
  assert.equal(env.store.get("prairierunRelayStatus").state, "ok");
});

test("slugCourse and courseFeedId build stable per-course feed ids", () => {
  assert.equal(relay.slugCourse("CS 225"), "cs-225");
  assert.equal(relay.slugCourse("  MATH--241!! "), "math-241");
  assert.equal(relay.courseFeedId("feedabc123def", "cs-225"), "feedabc123def-cs-225");
  assert.equal(relay.courseFeedId("feedabc123def", "a".repeat(40)).length <= 64, true);
});

test("publishPerCourse groups by course and stores prairierunCourseFeeds", async () => {
  const env = installEnv();
  globalThis.fetch = env.fetchMock;
  configureFeed(env);
  env.setResponses([
    okPublishResponse("feedabc123def-cs-225"),
    okPublishResponse("feedabc123def-math-241"),
  ]);
  const items = [
    makeItem("2026-11-01T12:00:00", "a1", { courseCode: "CS 225" }),
    makeItem("2026-11-02T12:00:00", "a2", { courseCode: "CS 225" }),
    makeItem("2026-11-03T12:00:00", "a3", { courseCode: "MATH 241" }),
  ];
  const result = await relay.publishPerCourse(items, {
    settings: env.store.get("prairierunSettings"),
    secrets: { relayPublishKey: "sekrit" },
  });
  assert.equal(result.ok, true);
  assert.equal(env.fetchCalls.length, 2);
  const feedIds = env.fetchCalls.map((call) => JSON.parse(call.init.body).feedId).sort();
  assert.deepEqual(feedIds, ["feedabc123def-cs-225", "feedabc123def-math-241"]);
  const stored = env.store.get("prairierunCourseFeeds");
  assert.equal(stored["CS 225"], "https://blob.test/feeds/feedabc123def-cs-225.ics");
  assert.equal(stored["MATH 241"], "https://blob.test/feeds/feedabc123def-math-241.ics");
});

test("autoPublish and publishFromUserGesture also publish per-course feeds", async () => {
  const env = installEnv();
  globalThis.fetch = env.fetchMock;
  configureFeed(env);
  const items = [
    makeItem("2026-11-01T12:00:00", "a1", { courseCode: "CS 225" }),
    makeItem("2026-11-02T12:00:00", "a2", { courseCode: "MATH 241" }),
  ];
  env.setResponses([
    okPublishResponse(),
    okPublishResponse("feedabc123def-cs-225"),
    okPublishResponse("feedabc123def-math-241"),
  ]);
  const auto = await relay.autoPublish(items, env.store.get("prairierunSettings"));
  assert.equal(auto.ok, true);
  assert.equal(auto.perCourse?.ok, true);
  assert.equal(env.fetchCalls.length, 3);

  env.fetchCalls.length = 0;
  env.store.delete("prairierunRelayStatus");
  env.store.delete("prairierunCourseFeeds");
  env.setResponses([
    okPublishResponse(),
    okPublishResponse("feedabc123def-cs-225"),
    okPublishResponse("feedabc123def-math-241"),
  ]);
  const gestured = await relay.publishFromUserGesture(
    items,
    env.store.get("prairierunSettings"),
    { relayPublishKey: "sekrit" },
  );
  assert.equal(gestured.ok, true);
  assert.equal(gestured.perCourse?.ok, true);
  assert.equal(env.fetchCalls.length, 3);
  assert.equal(env.store.get("prairierunCourseFeeds")["CS 225"], "https://blob.test/feeds/feedabc123def-cs-225.ics");
});

test("formatPublishedAt formats timestamp into America/Chicago date-time without status prefixes", () => {
  const ts = new Date("2026-10-19T22:45:00Z").getTime();
  const formatted = optionsFeed.formatPublishedAt(ts);
  assert.match(formatted, /Oct 19.*5:45\s*PM/i);
  assert.ok(!formatted.includes("Feed up to date"));
  assert.ok(!formatted.includes("Last published"));
});

test("makeCalendarIcon creates an accessible inline SVG calendar icon", () => {
  const prevDoc = global.document;
  try {
    const createdElements = [];
    global.document = {
      createElementNS: (_ns, tag) => {
        const el = {
          tag,
          attrs: {},
          children: [],
          setAttribute: (k, v) => { el.attrs[k] = String(v); },
          append: (...args) => el.children.push(...args),
        };
        createdElements.push(el);
        return el;
      },
    };
    const icon = optionsFeed.makeCalendarIcon();
    assert.equal(icon.tag, "svg");
    assert.equal(icon.attrs.class, "prr-calendar-icon");
    assert.equal(icon.attrs["aria-hidden"], "true");
    assert.equal(icon.children.length, 4);
  } finally {
    global.document = prevDoc;
  }
});

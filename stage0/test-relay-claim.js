// Tests for one-click feed activation: the relay's /api/claim endpoint, the
// per-feed HMAC key accepted by /api/publish, and PrairieRunRelay.claimFeed
// plus a claim -> save -> publish flow against mocked storage/fetch.
//
// @vercel/blob is not installed in this repo, so relay/api/publish.js is
// loaded through a CommonJS-shaped wrapper with a stubbed blob module.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createHmac } = require("crypto");

const ROOT = path.join(__dirname, "..");
const EXT_PATH = path.join(ROOT, "extension");
const MASTER_KEY = "test-master-key";

const originalPublishKey = process.env.PUBLISH_KEY;
process.env.PUBLISH_KEY = MASTER_KEY;
test.after(() => {
  if (originalPublishKey === undefined) delete process.env.PUBLISH_KEY;
  else process.env.PUBLISH_KEY = originalPublishKey;
});

// Minimal CommonJS loader so @vercel/blob can be stubbed.
function loadHandler(relFile, { stubs = {} } = {}) {
  const filename = path.join(ROOT, relFile);
  const source = fs.readFileSync(filename, "utf8");
  const mod = { exports: {} };
  const implRequire = (name) => {
    if (Object.prototype.hasOwnProperty.call(stubs, name)) return stubs[name];
    if (name === "crypto") return require("crypto");
    throw new Error(`Unexpected require in test: ${name}`);
  };
  const wrapper = new Function("exports", "require", "module", "__filename", "__dirname", source);
  wrapper(mod.exports, implRequire, mod, filename, path.dirname(filename));
  return mod.exports;
}

function stubRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(key, value) { this.headers[key] = value; },
    end(chunk) { if (chunk !== undefined) this.body += chunk; },
  };
}

function stubReq(method, { headers = {}, body = "", ip = "" } = {}) {
  return { method, headers, body, socket: { remoteAddress: ip } };
}

function feedKey(feedId) {
  return createHmac("sha256", MASTER_KEY).update(feedId).digest("hex");
}

function makeBlobStub() {
  const puts = [];
  const blob = {
    put: async (pathname, body, opts) => {
      puts.push({ pathname, body, opts });
      return { url: `https://blob.test/${pathname}` };
    },
  };
  return { blob, puts };
}

const claimHandler = loadHandler("relay/api/claim.js");

test("claim mints a lowercase-hex feedId and the matching per-feed HMAC key", async () => {
  const res = stubRes();
  await claimHandler(stubReq("GET", { headers: { "x-forwarded-for": "198.51.100.1" } }), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.match(data.feedId, /^feed-[a-f0-9]{16}$/);
  assert.equal(data.key, feedKey(data.feedId));
  assert.notEqual(data.key, MASTER_KEY);
});

test("claim fails with a 500 when PUBLISH_KEY is missing", async () => {
  const saved = process.env.PUBLISH_KEY;
  delete process.env.PUBLISH_KEY;
  try {
    const res = stubRes();
    await claimHandler(stubReq("GET", { headers: { "x-forwarded-for": "198.51.100.2" } }), res);
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /PUBLISH_KEY/);
  } finally {
    process.env.PUBLISH_KEY = saved;
  }
});

test("claim rate-limits one claim per IP per 60s window (best effort)", async () => {
  const ip = "203.0.113.7";
  const first = stubRes();
  await claimHandler(stubReq("GET", { headers: { "x-forwarded-for": ip } }), first);
  assert.equal(first.statusCode, 200);

  const second = stubRes();
  await claimHandler(stubReq("GET", { headers: { "x-forwarded-for": ip } }), second);
  assert.equal(second.statusCode, 429);

  const otherIp = stubRes();
  await claimHandler(stubReq("GET", { headers: { "x-forwarded-for": "203.0.113.8" } }), otherIp);
  assert.equal(otherIp.statusCode, 200);
});

test("publish accepts the per-feed key for its own feedId", async () => {
  const { blob, puts } = makeBlobStub();
  const publishHandler = loadHandler("relay/api/publish.js", { stubs: { "@vercel/blob": blob } });
  const feedId = "feed-a1b2c3d4e5f6a7b8";
  const res = stubRes();
  await publishHandler(stubReq("POST", {
    headers: { "x-prairierun-key": feedKey(feedId) },
    body: JSON.stringify({ feedId, ics: "BEGIN:VCALENDAR\nEND:VCALENDAR" }),
  }), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.equal(data.url, `https://blob.test/feeds/${feedId}.ics`);
  assert.equal(puts[0].pathname, `feeds/${feedId}.ics`);
  assert.equal(puts[0].opts.access, "public");
  assert.equal(puts[0].opts.addRandomSuffix, false);
});

test("publish rejects the per-feed key paired with a different feedId", async () => {
  const { blob, puts } = makeBlobStub();
  const publishHandler = loadHandler("relay/api/publish.js", { stubs: { "@vercel/blob": blob } });
  const ownFeedId = "feed-aaaa1111bbbb2222";
  const otherFeedId = "feed-cccc3333dddd4444";
  const res = stubRes();
  await publishHandler(stubReq("POST", {
    headers: { "x-prairierun-key": feedKey(ownFeedId) },
    body: JSON.stringify({ feedId: otherFeedId, ics: "BEGIN:VCALENDAR\nEND:VCALENDAR" }),
  }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(puts.length, 0);
});

test("publish still accepts the master key for any feedId", async () => {
  const { blob, puts } = makeBlobStub();
  const publishHandler = loadHandler("relay/api/publish.js", { stubs: { "@vercel/blob": blob } });
  for (const feedId of ["feed-1234abcd5678ef90", "feed-dcba4321"]) {
    const res = stubRes();
    await publishHandler(stubReq("POST", {
      headers: { "x-prairierun-key": MASTER_KEY },
      body: JSON.stringify({ feedId, ics: "BEGIN:VCALENDAR\nEND:VCALENDAR" }),
    }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).url, `https://blob.test/feeds/${feedId}.ics`);
  }
  assert.equal(puts.length, 2);
});

test("publish rejects an unrelated key regardless of feedId", async () => {
  const { blob } = makeBlobStub();
  const publishHandler = loadHandler("relay/api/publish.js", { stubs: { "@vercel/blob": blob } });
  const res = stubRes();
  await publishHandler(stubReq("POST", {
    headers: { "x-prairierun-key": "not-the-key" },
    body: JSON.stringify({ feedId: "feed-9876fedc5432ba10", ics: "BEGIN:VCALENDAR\nEND:VCALENDAR" }),
  }), res);
  assert.equal(res.statusCode, 401);
});

// ---- Extension side ----

function installEnv({ responses = [] } = {}) {
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
  };
  const fetchCalls = [];
  let pending = [...responses];
  globalThis.fetch = async (...args) => {
    const next = pending.shift();
    fetchCalls.push({ url: args[0], init: args[1] });
    if (!next) throw new Error("No mocked response remaining.");
    return next;
  };
  return { store, fetchCalls, setNext(list) { pending = list; } };
}

function loadExtension(file) {
  require(path.join(EXT_PATH, file));
}

function makeItem(dueAt, id = "ass1") {
  return { id, title: "HW 1", source: "prairielearn", dueAt, status: "incomplete" };
}

loadExtension("ics-writer.js");
loadExtension("relay-push.js");
const relayApi = globalThis.PrairieRunRelay;

test("claimFeed resolves a feedId/key pair from a 200 claim response", async () => {
  const env = installEnv({
    responses: [{ status: 200, ok: true, json: async () => ({ ok: true, feedId: "feed-9f8e7d6c5b4a3210", key: "abcd1234" }) }],
  });
  const claimed = await relayApi.claimFeed("https://feed.test");
  assert.equal(claimed.ok, true);
  assert.equal(claimed.feedId, "feed-9f8e7d6c5b4a3210");
  assert.equal(claimed.key, "abcd1234");
  assert.equal(claimed.error, "");
  assert.equal(env.fetchCalls[0].url, "https://feed.test/api/claim");
});

test("claimFeed answers politely to a 500 and a network failure", async () => {
  installEnv({
    responses: [{ status: 500, ok: false, json: async () => ({ ok: false }), text: async () => "" }],
  });
  const serverError = await relayApi.claimFeed("https://feed.test");
  assert.equal(serverError.ok, false);
  assert.equal(serverError.feedId, "");
  assert.equal(serverError.key, "");
  assert.match(serverError.error, /Could not (create|reach)/i);

  installEnv({}); // fetch mock throws when no response is queued
  await assert.doesNotReject(() => relayApi.claimFeed("https://feed.test"));
  const unreachable = await relayApi.claimFeed("https://feed.test");
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.error, /Could not reach the PrairieRun feed relay/);
});

test("DEFAULT_RELAY_URL is exported for the one-click path", () => {
  assert.equal(relayApi.DEFAULT_RELAY_URL, "https://prairierun-feed.vercel.app");
});

test("claim -> save settings -> publish end-to-end flow", async () => {
  const env = installEnv({
    responses: [
      { status: 200, ok: true, json: async () => ({ ok: true, feedId: "feed-0011feed2233feed", key: "feedkey01" }) },
      { status: 200, ok: true, json: async () => ({ ok: true, url: "https://blob.test/feeds/feed-0011feed2233feed.ics" }), text: async () => "" },
    ],
  });
  const claimed = await relayApi.claimFeed("https://feed.test");
  assert.equal(claimed.ok, true);
  env.store.set("prairierunSettings", {
    relay: { enabled: true, relayUrl: "https://feed.test", feedId: claimed.feedId },
  });
  env.store.set("prairierunSecrets", { relayPublishKey: claimed.key });

  const result = await relayApi.publish(
    [makeItem("2026-11-01T12:00:00")],
    { settings: env.store.get("prairierunSettings"), secrets: env.store.get("prairierunSecrets") },
  );
  assert.equal(result.ok, true);
  assert.equal(result.url, "https://blob.test/feeds/feed-0011feed2233feed.ics");

  assert.equal(env.fetchCalls.length, 2);
  assert.equal(env.fetchCalls[0].url, "https://feed.test/api/claim");
  assert.equal(env.fetchCalls[1].url, "https://feed.test/api/publish");
  assert.equal(env.fetchCalls[1].init.method, "POST");
  assert.equal(env.fetchCalls[1].init.headers["x-prairierun-key"], claimed.key);
  assert.equal(JSON.parse(env.fetchCalls[1].init.body).feedId, claimed.feedId);
  assert.match(JSON.parse(env.fetchCalls[1].init.body).ics, /^BEGIN:VCALENDAR/);

  const status = env.store.get("prairierunRelayStatus");
  assert.equal(status.state, "ok");
  assert.equal(status.url, result.url);
});

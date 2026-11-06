// Unit tests for extension/feed-auth.js: Convex Auth Google flow,
// anonymous feed migration, second-device hydration, and sign-out.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const EXT_PATH = path.join(__dirname, "..", "extension");

function installMockExt() {
  const store = new Map();
  const sessionStore = new Map();

  globalThis.PrairieRunExt = {
    runtime: { id: "test-prairierun-ext" },
    storageLocalGet: async (keys) => {
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of wanted) {
        if (store.has(key)) out[key] = store.get(key);
      }
      return out;
    },
    storageLocalSet: async (items) => {
      for (const [key, value] of Object.entries(items || {})) {
        store.set(key, value);
      }
    },
    identityGetRedirectURL: (path = "") => {
      return `https://test-prairierun-ext.chromiumapp.org/${path}`;
    },
    identityLaunchWebAuthFlow: async ({ url, interactive }) => {
      assert.ok(url);
      assert.ok(interactive);
      // Simulate successful Google OAuth redirect back to extension with a verification code
      return "https://test-prairierun-ext.chromiumapp.org/convex?code=mock_auth_code_12345";
    },
    getSessionValue: async (key) => sessionStore.get(key) || null,
    setSessionValue: async (key, val) => sessionStore.set(key, val),
    removeSessionValue: async (key) => sessionStore.delete(key),
  };

  return { store, sessionStore };
}

// Load extension/feed-auth.js
require(path.join(EXT_PATH, "feed-auth.js"));
const feedAuth = globalThis.PrairieRunFeedAuth;

test("resolveConvexUrls parses site and cloud URLs correctly", () => {
  const fromSite = feedAuth.resolveConvexUrls("https://my-app.convex.site");
  assert.equal(fromSite.siteUrl, "https://my-app.convex.site");
  assert.equal(fromSite.cloudUrl, "https://my-app.convex.cloud");

  const fromCloud = feedAuth.resolveConvexUrls("https://my-app.convex.cloud/");
  assert.equal(fromCloud.siteUrl, "https://my-app.convex.site");
  assert.equal(fromCloud.cloudUrl, "https://my-app.convex.cloud");

  const fallback = feedAuth.resolveConvexUrls("");
  assert.equal(fallback.siteUrl, feedAuth.DEFAULT_CONVEX_SITE_URL);
  assert.equal(fallback.cloudUrl, feedAuth.DEFAULT_CONVEX_CLOUD_URL);
});

test("authenticateAndHydrate migrates existing anonymous feed on first sign-in", async () => {
  const env = installMockExt();

  // Populate local storage with existing anonymous feed
  const legacyFeedId = "feed-anonymous12345";
  const legacyKey = "hmac_key_legacy_secret";
  env.store.set("prairierunSettings", {
    relay: { enabled: true, feedId: legacyFeedId, relayUrl: "https://prairierun-feed.vercel.app" },
  });
  env.store.set("prairierunSecrets", {
    relayPublishKey: legacyKey,
  });

  const mutationCalls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body || "{}");
    if (url.includes("/api/action") && body.path === "auth:signIn") {
      assert.equal(body.args.params.code, "mock_auth_code_12345");
      return {
        ok: true,
        json: async () => ({ status: "success", value: { tokens: { token: "jwt_token_user_1" } } }),
      };
    }
    if (url.includes("/api/mutation")) {
      mutationCalls.push({ path: body.path, args: body.args, auth: init.headers.Authorization });
      if (body.path === "feeds:linkLegacyFeed") {
        return {
          ok: true,
          json: async () => ({
            status: "success",
            value: { feedId: body.args.legacyFeedId, key: body.args.legacyKey, migrated: true },
          }),
        };
      }
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };

  const result = await feedAuth.authenticateAndHydrate();
  assert.equal(result.ok, true);
  assert.equal(result.feedId, legacyFeedId);
  assert.equal(result.key, legacyKey);
  assert.equal(result.migrated, true);

  // Verifies linkLegacyFeed was invoked
  assert.equal(mutationCalls.length, 1);
  assert.equal(mutationCalls[0].path, "feeds:linkLegacyFeed");
  assert.equal(mutationCalls[0].args.legacyFeedId, legacyFeedId);
  assert.equal(mutationCalls[0].auth, "Bearer jwt_token_user_1");

  // Verifies local storage hydration
  const updatedSettings = env.store.get("prairierunSettings");
  assert.equal(updatedSettings.relay.feedId, legacyFeedId);
  assert.equal(updatedSettings.relay.authAccount, "google");
  assert.equal(updatedSettings.relay.enabled, true);

  const updatedSecrets = env.store.get("prairierunSecrets");
  assert.equal(updatedSecrets.relayPublishKey, legacyKey);

  // Verifies JWT token is stored only in session, NEVER in local storage
  assert.equal(env.sessionStore.get("prairierunFeedAuthToken"), "jwt_token_user_1");
  assert.equal(env.store.get("prairierunFeedAuthToken"), undefined);
});

test("authenticateAndHydrate invokes getOrCreateFeed on a second device without anonymous feed", async () => {
  const env = installMockExt();

  // Fresh device: no pre-existing feed
  const mutationCalls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body || "{}");
    if (url.includes("/api/action") && body.path === "auth:signIn") {
      return {
        ok: true,
        json: async () => ({ status: "success", value: { tokens: { token: "jwt_token_user_2" } } }),
      };
    }
    if (url.includes("/api/mutation") && body.path === "feeds:getOrCreateFeed") {
      mutationCalls.push({ path: body.path, args: body.args });
      return {
        ok: true,
        json: async () => ({
          status: "success",
          value: { feedId: "feed-from-convex-acct", key: "derived_feed_key_123" },
        }),
      };
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };

  const result = await feedAuth.authenticateAndHydrate();
  assert.equal(result.ok, true);
  assert.equal(result.feedId, "feed-from-convex-acct");
  assert.equal(result.key, "derived_feed_key_123");

  // Verifies getOrCreateFeed was called
  assert.equal(mutationCalls.length, 1);
  assert.equal(mutationCalls[0].path, "feeds:getOrCreateFeed");

  // Verifies local storage now shares the same feedId and key
  const updatedSettings = env.store.get("prairierunSettings");
  assert.equal(updatedSettings.relay.feedId, "feed-from-convex-acct");
  assert.equal(updatedSettings.relay.authAccount, "google");

  const updatedSecrets = env.store.get("prairierunSecrets");
  assert.equal(updatedSecrets.relayPublishKey, "derived_feed_key_123");
});

test("signOut clears session token and removes authAccount tag", async () => {
  const env = installMockExt();
  env.store.set("prairierunSettings", {
    relay: { enabled: true, feedId: "feed-123", authAccount: "google" },
  });
  env.store.set("prairierunFeedAuth", { signedIn: true, authAccount: "google" });
  env.sessionStore.set("prairierunFeedAuthToken", "jwt_token_123");

  let signOutCalled = false;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body || "{}");
    if (body.path === "auth:signOut") {
      signOutCalled = true;
      return { ok: true, json: async () => ({ status: "success" }) };
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };

  const res = await feedAuth.signOut();
  assert.equal(res.ok, true);
  assert.equal(signOutCalled, true);

  // Verifies session token is wiped
  assert.equal(env.sessionStore.get("prairierunFeedAuthToken"), undefined);

  // Verifies authAccount is removed from relay settings
  const settings = env.store.get("prairierunSettings");
  assert.equal(settings.relay.authAccount, undefined);
  assert.equal(settings.relay.feedId, "feed-123"); // Keeps feedId

  // Auth status now reports not signed in
  const status = await feedAuth.getAuthStatus();
  assert.equal(status.signedIn, false);
});

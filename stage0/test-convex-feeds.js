// Unit tests for convex/feeds.ts: key derivation, timing-safe equality,
// getOrCreateFeed, and linkLegacyFeed mutations with mock Convex DB context.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("crypto");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const MASTER_KEY = "test-publish-key-999";

// Load convex/feeds.ts logic
// Minimal mock loader for TS export functions
function loadConvexFeeds() {
  const file = path.join(ROOT, "convex", "feeds.ts");
  const code = fs.readFileSync(file, "utf8");

  // Transpile / evaluate export functions in Node context
  // Strip TypeScript annotations and export keywords for evaluation
  const cleanCode = code
    .replace(/^import\s+.*$/gm, "// $&")
    .replace(/export\s+const\s+/g, "const ")
    .replace(/export\s+function\s+/g, "function ")
    .replace(/export\s+async\s+function\s+/g, "async function ")
    .replace(/:\s*Promise<[^>]+>/g, "")
    .replace(/:\s*boolean/g, "")
    .replace(/:\s*string/g, "")
    .replace(/:\s*any/g, "");

  const scope = {
    TextEncoder,
    Uint8Array,
    crypto: globalThis.crypto,
    require,
    module: { exports: {} },
    process,
    mutation: (def) => def,
    v: { string: () => ({}) },
    getAuthUserId: async () => null,
  };

  const fn = new Function(
    "scope",
    `with(scope) {
      ${cleanCode}
      return {
        deriveFeedKey,
        timingSafeEqual,
        generateFeedId,
        handleGetOrCreateFeed,
        handleLinkLegacyFeed,
        getOrCreateFeed,
        linkLegacyFeed,
        FEED_ID_RE
      };
    }`
  );
  return fn(scope);
}

const {
  deriveFeedKey,
  timingSafeEqual,
  generateFeedId,
  handleGetOrCreateFeed,
  handleLinkLegacyFeed,
  FEED_ID_RE,
} = loadConvexFeeds();

function makeMockCtx() {
  const dbStore = [];
  return {
    dbStore,
    db: {
      query: (tableName) => {
        assert.equal(tableName, "feeds");
        return {
          withIndex: (indexName, queryBuilder) => {
            let filterField = "";
            let filterValue = "";
            const q = {
              eq: (field, val) => {
                filterField = field;
                filterValue = val;
              },
            };
            queryBuilder(q);
            return {
              first: async () => {
                return (
                  dbStore.find((row) => row[filterField] === filterValue) || null
                );
              },
            };
          },
        };
      },
      insert: async (tableName, record) => {
        assert.equal(tableName, "feeds");
        // Verify database NEVER stores publish keys or derived keys
        assert.equal(record.publishKey, undefined);
        assert.equal(record.key, undefined);
        assert.equal(record.derivedKey, undefined);
        assert.ok(record.userId);
        assert.ok(record.feedId);
        assert.ok(record.createdAt);
        const row = { _id: `feed_id_${dbStore.length + 1}`, ...record };
        dbStore.push(row);
        return row._id;
      },
    },
  };
}

test("deriveFeedKey matches HMAC-SHA256(PUBLISH_KEY, feedId)", async () => {
  const feedId = "feed-1234567890abcdef";
  const expected = createHmac("sha256", MASTER_KEY).update(feedId).digest("hex");
  const derived = await deriveFeedKey(MASTER_KEY, feedId);
  assert.equal(derived, expected);
});

test("timingSafeEqual performs constant-time comparison correctly", () => {
  assert.equal(timingSafeEqual("abc123def", "abc123def"), true);
  assert.equal(timingSafeEqual("abc123def", "abc123deg"), false);
  assert.equal(timingSafeEqual("abc123def", "abc123de"), false);
  assert.equal(timingSafeEqual("abc123def", ""), false);
  assert.equal(timingSafeEqual(null, "abc"), false);
});

test("generateFeedId produces valid feed-[a-f0-9]{16} format", () => {
  for (let i = 0; i < 5; i++) {
    const id = generateFeedId();
    assert.match(id, /^feed-[a-f0-9]{16}$/);
    assert.ok(FEED_ID_RE.test(id));
  }
});

test("handleGetOrCreateFeed creates new feed for first-time user and derives key", async () => {
  const ctx = makeMockCtx();
  const userId = "user_1";
  const result = await handleGetOrCreateFeed(ctx, userId, MASTER_KEY);

  assert.match(result.feedId, /^feed-[a-f0-9]{16}$/);
  const expectedKey = createHmac("sha256", MASTER_KEY).update(result.feedId).digest("hex");
  assert.equal(result.key, expectedKey);

  // DB contains exactly 1 row with userId and feedId, no key
  assert.equal(ctx.dbStore.length, 1);
  assert.equal(ctx.dbStore[0].userId, userId);
  assert.equal(ctx.dbStore[0].feedId, result.feedId);
  assert.equal(ctx.dbStore[0].key, undefined);
});

test("handleGetOrCreateFeed retrieves existing feed on second device without inserting new row", async () => {
  const ctx = makeMockCtx();
  const userId = "user_1";
  const first = await handleGetOrCreateFeed(ctx, userId, MASTER_KEY);
  assert.equal(ctx.dbStore.length, 1);

  // Call again for same user (e.g. from second device)
  const second = await handleGetOrCreateFeed(ctx, userId, MASTER_KEY);
  assert.equal(second.feedId, first.feedId);
  assert.equal(second.key, first.key);
  assert.equal(ctx.dbStore.length, 1); // No new insertion
});

test("handleLinkLegacyFeed successfully migrates anonymous feed on first sign-in", async () => {
  const ctx = makeMockCtx();
  const userId = "user_migrating";
  const legacyFeedId = "feed-a1b2c3d4e5f60718";
  const legacyKey = createHmac("sha256", MASTER_KEY).update(legacyFeedId).digest("hex");

  const result = await handleLinkLegacyFeed(ctx, userId, MASTER_KEY, legacyFeedId, legacyKey);
  assert.equal(result.feedId, legacyFeedId);
  assert.equal(result.key, legacyKey);
  assert.equal(result.migrated, true);

  assert.equal(ctx.dbStore.length, 1);
  assert.equal(ctx.dbStore[0].userId, userId);
  assert.equal(ctx.dbStore[0].feedId, legacyFeedId);
  assert.equal(ctx.dbStore[0].key, undefined); // Never in DB
});

test("handleLinkLegacyFeed rejects forged or mismatched legacyKey", async () => {
  const ctx = makeMockCtx();
  const userId = "user_attacker";
  const legacyFeedId = "feed-a1b2c3d4e5f60718";
  const badKey = "0000000000000000000000000000000000000000000000000000000000000000";

  await assert.rejects(
    async () => {
      await handleLinkLegacyFeed(ctx, userId, MASTER_KEY, legacyFeedId, badKey);
    },
    /Invalid legacy feed key/
  );
  assert.equal(ctx.dbStore.length, 0);
});

test("handleLinkLegacyFeed rejects malformed feedId", async () => {
  const ctx = makeMockCtx();
  const userId = "user_1";
  await assert.rejects(
    async () => {
      await handleLinkLegacyFeed(ctx, userId, MASTER_KEY, "../bad-id", "any-key");
    },
    /Invalid legacy feedId format/
  );
});

test("handleLinkLegacyFeed retains existing account feed if user already has one", async () => {
  const ctx = makeMockCtx();
  const userId = "user_with_feed";
  // User already has a feed in Convex
  const existing = await handleGetOrCreateFeed(ctx, userId, MASTER_KEY);
  assert.equal(ctx.dbStore.length, 1);

  // User attempts to link another legacy feed
  const otherLegacyId = "feed-9999888877776666";
  const otherLegacyKey = createHmac("sha256", MASTER_KEY).update(otherLegacyId).digest("hex");

  const result = await handleLinkLegacyFeed(ctx, userId, MASTER_KEY, otherLegacyId, otherLegacyKey);
  // Returns user's existing account feed, does not overwrite
  assert.equal(result.feedId, existing.feedId);
  assert.equal(result.key, existing.key);
  assert.equal(result.migrated, false);
  assert.equal(ctx.dbStore.length, 1);
});

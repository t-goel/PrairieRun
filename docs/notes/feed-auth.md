# Feed multi-device auth

## Problem

- Shared relay host `https://prairierun-feed.vercel.app` is correct (one deploy).
- `/api/claim` already mints a unique `feedId` + HMAC publish key per activation.
- Those credentials are stored only in extension `storage.local`, so a second
  device claims a **different** feed and calendar URL.

## Decision (research complete)

**Convex Auth (Google) + Convex `feeds` table.** Not Better Auth on the relay,
not raw Google ID-token verification on the relay alone.

### Why

1. No SQL DB to bolt onto the tiny Blob relay.
2. One GCP Web client → Convex callback; Convex redirects to the extension
   redirect URI (avoids Chrome vs Firefox OAuth client split for this path).
3. Relay stays a stateless ICS Blob host; publish HMAC unchanged.

### Flow

1. Extension `launchWebAuthFlow` → Convex Google sign-in → JWT back to ext.
2. `getOrCreateFeed()` or `linkLegacyFeed({ legacyFeedId, legacyKey })`.
3. Convex returns `{ feedId, key, feedUrl }` where
   `key = HMAC-SHA256(PUBLISH_KEY, feedId)` (same secret as Vercel relay).
4. Write into `prairierunSettings.relay` + `prairierunSecrets.relayPublishKey`.
5. Existing `relay-push.js` publish path unchanged.

### Schema

```ts
feeds: defineTable({
  userId: v.id("users"),
  feedId: v.string(), // feed-[a-f0-9]{16}
  createdAt: v.number(),
})
  .index("by_user", ["userId"])
  .index("by_feedId", ["feedId"])
```

Plus `authTables` from `@convex-dev/auth`.

### Migration

- First signed-in device with a local anonymous feed → `linkLegacyFeed` after
  HMAC ownership check (calendar subscription URL stays valid).
- Second device → Sign in → `getOrCreateFeed` recovers the same credentials.
- Conflict (local anonymous ≠ account feed): prefer account feed; optional UI
  prompt later.

### Env

- Vercel + Convex: identical `PUBLISH_KEY`.
- Convex: Google OAuth client credentials for Auth (`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `SITE_URL`).
- Extension: Convex deployment URL / site URL for sign-in (`DEFAULT_CONVEX_SITE_URL` / `convexUrl`).

## Implementation Details

Scaffolded backend files:
- `convex/schema.ts`: `feeds` table (`userId`, `feedId`, `createdAt`) with `by_user` and `by_feedId` indexes + `authTables`.
- `convex/auth.ts`: Convex Auth with `@auth/core/providers/google` and redirect callback supporting `.chromiumapp.org` and Firefox extension redirect URLs.
- `convex/http.ts`: HTTP router exposing `auth.addHttpRoutes(http)`.
- `convex/feeds.ts`: Mutations `getOrCreateFeed` and `linkLegacyFeed` with HMAC-SHA256 verification and derivation using `PUBLISH_KEY`. Master key and derived keys are never stored in the database.
- `convex/README.md`: Setup instructions and environment configuration guide.

Extension files:
- `extension/feed-auth.js`: `PrairieRunFeedAuth` client handling Google OAuth via `PrairieRunExt.identityLaunchWebAuthFlow`, code exchange, mutation execution, hydration, migration, and sign out.
- `extension/options-feed.js`: Calendar feed card UI with "Sign in with Google" (primary), "Get anonymous feed URL" (secondary), "Sign out", inline status, and collapsible custom relay/auth fields.
- `extension/options.html`: Added `<script src="feed-auth.js"></script>`.

Test coverage:
- `stage0/test-convex-feeds.js`: 9/9 passing tests for key derivation, constant-time equality, `getOrCreateFeed`, `linkLegacyFeed`, HMAC verification, and DB key omission.
- `stage0/test-feed-auth.js`: 4/4 passing tests for URL parsing, migration of local anonymous feeds, second-device hydration, and sign-out.
- `stage0/test-relay-feed.js` and `stage0/test-relay-claim.js`: 21/21 passing tests for ICS publishing, claim, and feed state.

## Status

- Research: complete.
- Implementation: complete.

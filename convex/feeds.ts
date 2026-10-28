// Convex feed identity service for PrairieRun.
//
// Maps an authenticated user (via Convex Auth Google) to a unique feedId.
// Per-feed HMAC publish key is derived on the fly:
//   key = HMAC-SHA256(process.env.PUBLISH_KEY, feedId)
// The master PUBLISH_KEY and derived keys are NEVER stored in the database.
//
// The relay PUBLISH_KEY env var and Convex PUBLISH_KEY env var must match.

import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

export const FEED_ID_RE = /^[a-z0-9][a-z0-9-]{5,63}$/;

/**
 * Computes HMAC-SHA256(publishKey, feedId) in hex format.
 * Uses Web Crypto (native to Convex runtime and browsers) with Node crypto fallback.
 */
export async function deriveFeedKey(publishKey: string, feedId: string): Promise<string> {
  if (!publishKey) {
    throw new Error("Convex backend is missing PUBLISH_KEY environment variable.");
  }
  const encoder = new TextEncoder();
  const keyData = encoder.encode(publishKey);
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle) {
    throw new Error("Web Crypto API is required for HMAC key derivation.");
  }
  const key = await cryptoObj.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await cryptoObj.subtle.sign("HMAC", key, encoder.encode(feedId));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string equality check to prevent timing attacks.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Generates a random feed slug matching feed-[a-f0-9]{16}.
 */
export function generateFeedId(): string {
  let hex = "";
  try {
    if (globalThis.crypto?.randomUUID) {
      hex = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    }
  } catch {
    hex = "";
  }
  while (hex.length < 16) {
    hex += Math.floor(Math.random() * 16).toString(16);
  }
  return `feed-${hex.toLowerCase()}`;
}

/**
 * Pure handler for getOrCreateFeed:
 * Returns the user's existing feedId + derived key, or mints a new one.
 */
export async function handleGetOrCreateFeed(ctx: any, userId: string, publishKey: string) {
  if (!userId) {
    throw new Error("Unauthenticated: must be signed in to access feed identity.");
  }
  if (!publishKey) {
    throw new Error("Convex backend is missing PUBLISH_KEY environment variable.");
  }

  const existing = await ctx.db
    .query("feeds")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .first();

  if (existing) {
    const key = await deriveFeedKey(publishKey, existing.feedId);
    return { feedId: existing.feedId, key };
  }

  const feedId = generateFeedId();
  await ctx.db.insert("feeds", {
    userId,
    feedId,
    createdAt: Date.now(),
  });

  const key = await deriveFeedKey(publishKey, feedId);
  return { feedId, key };
}

/**
 * Pure handler for linkLegacyFeed:
 * Validates HMAC ownership of an anonymous feed and links it to the user's account.
 */
export async function handleLinkLegacyFeed(
  ctx: any,
  userId: string,
  publishKey: string,
  legacyFeedId: string,
  legacyKey: string
) {
  if (!userId) {
    throw new Error("Unauthenticated: must be signed in to link legacy feed.");
  }
  if (!publishKey) {
    throw new Error("Convex backend is missing PUBLISH_KEY environment variable.");
  }

  const feedId = String(legacyFeedId || "").trim().toLowerCase();
  if (!FEED_ID_RE.test(feedId)) {
    throw new Error("Invalid legacy feedId format.");
  }

  // HMAC ownership check: verify the caller actually possessed the legitimate per-feed publish key
  const expectedKey = await deriveFeedKey(publishKey, feedId);
  if (!timingSafeEqual(legacyKey, expectedKey)) {
    throw new Error("Invalid legacy feed key.");
  }

  // Check if this user already has an assigned feed
  const existing = await ctx.db
    .query("feeds")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .first();

  if (existing) {
    if (existing.feedId === feedId) {
      return { feedId: existing.feedId, key: legacyKey, migrated: false };
    }
    // User already has a feed from another device: return account's primary feed
    const accountKey = await deriveFeedKey(publishKey, existing.feedId);
    return { feedId: existing.feedId, key: accountKey, migrated: false };
  }

  // Check if this feedId is already owned by someone else
  const taken = await ctx.db
    .query("feeds")
    .withIndex("by_feedId", (q: any) => q.eq("feedId", feedId))
    .first();

  if (taken) {
    // Taken by another account; generate a brand new feed for this user
    const newFeedId = generateFeedId();
    await ctx.db.insert("feeds", {
      userId,
      feedId: newFeedId,
      createdAt: Date.now(),
    });
    const key = await deriveFeedKey(publishKey, newFeedId);
    return { feedId: newFeedId, key, migrated: false };
  }

  // User has no feed and legacyFeedId is unattached: attach it!
  await ctx.db.insert("feeds", {
    userId,
    feedId,
    createdAt: Date.now(),
  });

  return { feedId, key: legacyKey, migrated: true };
}

/**
 * Convex mutation: getOrCreateFeed
 */
export const getOrCreateFeed = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Unauthenticated: must be signed in to access feed identity.");
    }
    const publishKey = process.env.PUBLISH_KEY;
    if (!publishKey) {
      throw new Error("Convex backend is missing PUBLISH_KEY environment variable.");
    }
    return handleGetOrCreateFeed(ctx, userId, publishKey);
  },
});

/**
 * Convex mutation: linkLegacyFeed
 */
export const linkLegacyFeed = mutation({
  args: {
    legacyFeedId: v.string(),
    legacyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Unauthenticated: must be signed in to link legacy feed.");
    }
    const publishKey = process.env.PUBLISH_KEY;
    if (!publishKey) {
      throw new Error("Convex backend is missing PUBLISH_KEY environment variable.");
    }
    return handleLinkLegacyFeed(ctx, userId, publishKey, args.legacyFeedId, args.legacyKey);
  },
});

// PrairieRun iCal relay — claim endpoint.
//
// GET /api/claim mints a new feed identity for a client with zero dashboard
// setup: the response is { ok, feedId, key }. The key is
// HMAC-SHA256(process.env.PUBLISH_KEY, feedId); it only authorizes publishing
// (and overwriting) that one feedId through /api/publish, so the master
// PUBLISH_KEY itself never leaves the server.
//
// Best-effort rate limit: one claim per client IP per 60s window, tracked in
// an in-memory Map. Serverless instances reset it on cold start and each
// instance keeps its own, so this is a last-resort guard, not a guarantee.
const { createHmac, randomUUID } = require("crypto");

const CLAIM_WINDOW_MS = 60 * 1000;
const lastClaimAt = new Map(); // ip -> epoch ms of the last claim

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Method not allowed." }));
    return;
  }
  const publishKey = process.env.PUBLISH_KEY;
  if (!publishKey) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: "Relay is missing PUBLISH_KEY env var." }));
    return;
  }

  const forwarded = String(req.headers["x-forwarded-for"] || "");
  const ip = forwarded.split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "unknown";
  const now = Date.now();
  const last = lastClaimAt.get(ip) || 0;
  if (now - last < CLAIM_WINDOW_MS) {
    res.statusCode = 429;
    res.end(JSON.stringify({ ok: false, error: "Too many feed requests. Try again in a minute." }));
    return;
  }
  lastClaimAt.set(ip, now);

  // Lowercase hex slug: randomUUID is already hex, so 16 of its 32 nibbles
  // give /feed-[a-f0-9]{16}/, which passes the publish.js feedId regex.
  const slug = randomUUID().replace(/-/g, "").slice(0, 16);
  const feedId = `feed-${slug}`;
  const key = createHmac("sha256", publishKey).update(feedId).digest("hex");
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, feedId, key }));
};

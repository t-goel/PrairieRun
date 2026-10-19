// PrairieRun iCal relay — publish endpoint.
//
// The extension POSTs { feedId, ics } here with header x-prairierun-key
// matching the relay's PUBLISH_KEY env var. The body is stored as a public
// blob at feeds/<feedId>.ics; the returned blob URL is the stable
// subscription URL (same pathname on every publish, so subscribers
// auto-update).
//
// Required env vars when deploying (Vercel dashboard or `vercel env add`):
//   PUBLISH_KEY              - shared publish secret set once by the owner
//   BLOB_READ_WRITE_TOKEN    - auto-injected after linking a Blob store
//
// CORS is permissive so the extension's options page can publish directly,
// even before the relay host is granted as an optional host permission
// (background auto-publishes use the granted permission and skip silently).
const { put } = require("@vercel/blob");

const FEED_ID_RE = /^[a-z0-9][a-z0-9-]{5,63}$/;
const MAX_ICS_BYTES = 2 * 1024 * 1024;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-prairierun-key");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
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
  const provided = req.headers["x-prairierun-key"] || "";
  // Constant-time-ish comparison without extra deps.
  if (provided.length !== publishKey.length || provided.split("").reduce((a, c, i) => a | (c.charCodeAt(0) ^ publishKey.charCodeAt(i)), 0) !== 0) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: "Unauthorized." }));
    return;
  }

  let body = {};
  try {
    body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: "Invalid JSON body." }));
    return;
  }
  const feedId = typeof body.feedId === "string" ? body.feedId.toLowerCase() : "";
  const ics = typeof body.ics === "string" ? body.ics : "";
  if (!FEED_ID_RE.test(feedId)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: "Invalid feedId." }));
    return;
  }
  if (!/^\s*BEGIN:VCALENDAR/.test(ics) || ics.length > MAX_ICS_BYTES) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: "Not a valid iCalendar body." }));
    return;
  }

  try {
    const { url } = await put(`feeds/${feedId}.ics`, ics, {
      access: "public",
      addRandomSuffix: false,
      contentType: "text/calendar; charset=utf-8",
      cacheControlMaxAge: 120,
    });
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, url }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: error?.message || "Blob upload failed." }));
  }
};

# PR 4 notes — Canvas source: iCal feed parser + optional planner API status

Implements `extension/ics-parse.js`, `extension/source-canvas.js`, and
`extension/options-canvas.js` on top of the PR 1 scaffold (branch based on
`exp`, i.e. main + PR 0 + PR 1). No shared load lists, manifest, background,
popup, or orchestrator changes.

## What works

- `PrairieRunIcs`: `unfold` (CRLF + space/tab continuation, incl. mid-URL
  folds), `parseLine` (quoted-param-aware split; duplicate params kept as
  arrays so Canvas's doubled `VALUE=DATE` is tolerated), `unescapeText`
  (single-pass `\, \; \\ \n \N`), `parseIcs` (VEVENT bags; UID/DTSTART/DTEND/
  SUMMARY/URL only), `toInstant` (UTC `Z`, TZID via `PrairieRunModel.localToUtc`,
  floating as America/Chicago, `VALUE=DATE` as 23:59 America/Chicago all-day).
- `source-canvas` adapter: feed fetch with `credentials:"omit"`; 401/404 maps
  to the re-copy-URL error; missing URL maps to `disabled`. Assignment ids
  always come from `#assignment_<id>` in the URL (override UIDs never become
  item ids); direct links are rebuilt as
  `<origin>/courses/<cid>/assignments/<aid>`. SUMMARY parsing collapses
  whitespace, takes the last `[...]` code (`cs_425_…` → `CS 425`), strips
  `(… CRN…)` section suffixes from titles. Non-assignment URLs keep kind
  `event` and id `canvas:event:<uid>`. No time-window filtering (output time
  owns that).
- Planner API (only when `settings.sources.canvas.plannerApi`): window
  [today−7d, today+60d], `while(1);` prefix stripped, graded > submitted >
  missing(not_started) merge by `canvas:<cid>:assignment:<pid>`, aliases left
  empty. Planner 401//login keeps feed items `ok` with the session-expired
  error. Planner origin derives from the feed URL origin (falls back to
  canvas.illinois.edu).
- Safety: GET only via `ctx.fetchPage`; feed token redacted (`user_***`) in
  every log call and in error strings (incl. wrapped SafetyErrors); options
  page shows only `…/user_***.ics`; secret lives in storage.local
  `prairierunSecrets.canvasFeedUrl`.
- `options-canvas.js` self-renders into `#canvas-settings` on
  DOMContentLoaded (idempotent; removes PR 1's "Coming soon" note locally so
  no shared `options.js` edit was needed): enable toggle, password field with
  Save/Clear, planner checkbox.

## Deviations / needs-PR-description items

- `extension/compat.js`: added `permissionsRequest(origins)` and
  `permissionsContains(origins)` — the code-style rule allows adding missing
  helpers there; runtime must not call `chrome.permissions` directly.
- `package.json`: added `test-ics-parse.js`, `test-source-canvas.js`, and
  `test-options-canvas.js` (extra coverage beyond the brief) to `npm test`.
- Pagination gap: `extractNextLink` reads `Link: <…>; rel="next"` from
  `FetchResult.headers` (Headers-like `.get`, plain object, or `result.link`).
  Current `net.js fetchPage` returns no headers, so pagination stops after
  page 1 until PR 2's full net layer exposes them. `per_page=100` + the 60-day
  window makes multi-page results unlikely; cap is 10 pages regardless.
- DeadlineItem has no section field, so the parsed `(… CRN…)` section suffix
  is verified only via the stripped title in tests.

## Verification

- `npm test`: 73 tests, 71 pass, 0 fail, 2 skip (pre-existing gitignored
  capture-bundle skips).
- `node build-manifest.js --target=chrome --check` + manifest JSON parse ok.
- Manual (needs reviewer): paste a real feed URL in Options → Sync now fills
  Canvas items; next-14-day Central view matches Canvas incl. all-day items
  upcoming until 23:59 CT; no URL → disabled message; planner checkbox with a
  logged-out Canvas session → feed ok + "session expired" note.

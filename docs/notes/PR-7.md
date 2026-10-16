# PR 7 notes — deadline store merge, course linking, cross-source dedupe

## What changed

- `extension/deadline-store.js` (`PrairieRunDeadlineStore`): full implementation.
  `mergeSourceResults(prev, results, links, settings?)` keeps the PR 1
  contract (orchestrator still calls it with 3 args): per-source replacement
  on `status === 'ok'`, previous items kept for `signed_out`/`error`/`disabled`
  or missing sources, optional 4th `settings` arg drops sources with
  `sources[id].enabled === false`. Alias-aware `changes` diff (an id absorbed
  into a winner's `aliases` is a change, never an add+remove pair), so
  re-merging identical results yields empty changes. Also exports
  `suggestCourseLinks`, `dedupe(items, links)`, `normTitle`,
  `normalizeCourseCode`.
- Dedupe rule: different sources + same confirmed link + equal `normTitle` +
  both `dueAt` within 5 min. Winner precedence
  prairielearn > gradescope > prairietest > canvas; winner keeps its id,
  absorbs loser id into `aliases`, loser url into `sourceUrls`, and loser
  status when its own is `unknown`. Same-title pairs in linked courses with
  Δ > 5 min go to `nearMisses` (`{a, b, deltaMinutes}`), never merged.
  Same-source pairs never merge and never near-miss.
- `normTitle`: lowercase, drop trailing `(… CRN\d+ …)` (covers Canvas
  `"HW 3 (CS 425 AL1 Fall 2026 CRN12345)"`), strip `[^\p{L}\p{N} ]`,
  collapse whitespace. `normalizeCourseCode`: uppercase, single spaces,
  core `SUBJ NNN` prefix extraction.
- `extension/options-courses.js`: renders the suggested-links table into
  `#course-links` (code → per-source course names), per-row confirm checkbox
  persisted to `prairierunCourseLinks`, and the near-miss list via `dedupe()`
  on `prairierunDeadlines`.
- `extension/view-utils.js`: handles both legacy (`dueAtLocal`,
  `completionStatus`) and `DeadlineItem` (`dueAt` UTC → Central day key,
  `status`). New helpers: `formatItemDue`, `sourceBadge` (PL/GS/CV/PT),
  `itemUrl`, `itemCourseKey/Name`, `canEditDate` (PL-only). Legacy outputs
  unchanged.
- `extension/home-panel.js`: reads `prairierunDeadlines` when present, falls
  back to `prairierunAssignments`; shows source badge + exam location; hides
  Edit for non-PL items; PL edits in deadline mode rewrite `dueAt` via
  `PrairieRunModel.localToUtc` (guarded) and persist to `prairierunDeadlines`.
- `extension/home-panel.css`: `.prr-badge`, `.prr-location` (compact).
- `stage0/test-deadline-store.js`: 10 tests covering every spec case.
  `package.json` test script extended with the new file.

## Follow-ups for PR 10 (needs shared-list edits — not done here)

- `extension/options.html` needs `<script src="deadline-store.js">` (before
  `options-courses.js`). Until then `options-courses.js` lazy-loads the flat
  extension script at runtime and degrades with a message if unavailable.
- Content scripts need `deadline-model.js` for exact `formatCentral` output;
  until then the panel uses the guarded `Intl` fallback (same format string).
- `background.js` still mirrors legacy scans into `prairierunDeadlines`; PR 9
  (`outputs.js`/calendar) owns the write path for merged deadlines.

## Verification

- `npm test`: 56 pass, 2 skip (gitignored capture fixture), 0 fail.
- `node build-manifest.js --target=chrome --check`: ok.
- Manual still needed: reload unpacked in Chrome/Brave, enable Canvas +
  Gradescope, confirm the course link in Options → Course links, check the
  panel shows each assignment once; same pass in Firefox via `about:debugging`.

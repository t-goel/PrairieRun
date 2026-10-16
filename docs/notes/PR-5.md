# PR 5 notes — Gradescope source (read-only)

Implements `extension/source-gradescope.js` (`id: 'gradescope'`) per the PR 5
brief. No shared files touched: no load-list, manifest, compat, or doc edits.

## What it does

- `parsers.account(doc, url)` → `{ signedOut, courses: [{ id, shortName,
  fullName, term }] }`. Section-aware walk keeps only boxes under a
  "Student Courses" `h2.pageHeading` (heading-less pages count as student),
  skips `.courseBox-new`, and uses the student section's first
  `.courseList--term` block only.
- `parsers.course(doc, url)` → `{ courseName, rows: [{ title, assignmentId,
  statusText, releaseAt, dueAt, lateDueAt, rawDueText }] }` with all times as
  ISO UTC. Skips the header row (explicit `columnheader`/`scope="col"`, else
  first row with no times/links/buttons) and `dropzonePreview` tail rows;
  falls back to `table tbody tr` when no `tr[role="row"]` exists.
- `parseGradescopeInstant` normalizes `YYYY-MM-DD HH:MM:SS ±HHMM` to ISO
  before `new Date`, so parsing never relies on date-string fallback.
- `sync(ctx)` GETs `/account`, then one GET per course (cap 15) via
  `ctx.fetchPage`, parsing via `ctx.parseHtml` (`gradescope.account` /
  `gradescope.course`). Maps rows with `PrairieRunModel.makeDeadlineItem`:
  `gs:<courseId>:<aid>` (title-slug `gs:<courseId>:t:<slug>` plus
  `[unstableId:true]` in `rawDueText` when no id), `courseCode` from
  `/\b([A-Z]{2,4})\s*(\d{3}[A-Z]?)\b/`, score `x / y` → graded
  `100*x/y`, `Submitted` → submitted, `No Submission` → not_started.
  Non-empty course list with zero rows everywhere and no "no assignments"
  message returns `{ status: 'error', error: 'Gradescope layout changed' }`.
- `isSignedOut(r)`: final pathname `/login`, or no `id="account-show"` plus
  `action="/login"` in the body.

## Safety

- GET only (fake `fetchPage` in tests rejects non-GET and pins paths to
  `/account` and `/courses/<id>` on the Gradescope origin).
- Submit buttons: `data-assignment-id` is read; never clicked/submitted
  (click-listener test + static no-`POST`/`.click(`/`.submit(` guard).
- No `chrome.*`/`browser.*` references; no cookies/tokens touched.

## Status

- `selectors unverified on UIUC` — fixtures follow the unofficial
  nyuoss/gradescope-api and Matut-E/gradescope-to-Cal structure from the
  brief. Every selector is a named constant at the top of
  `extension/source-gradescope.js` for one-spot fixes after a live check.
- Tests: `node --test stage0/test-gradescope.js` — 12 pass (linkedom).
- Full suite (`npm test`) and `node build-manifest.js --target=chrome --check`
  pass; no manifest/load-list changes needed (PR 1 pre-registered everything).

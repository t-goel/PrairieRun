# PR 6 notes — PrairieTest source (exam reservations)

Turns booked PrairieTest exam reservations into `kind: 'exam'` DeadlineItems
with start, end, and location. No user-visible wiring yet (orchestrator/output
wiring lands in later PRs); the adapter is registered and unit-tested.

## What changed

- `extension/source-prairietest.js` (was the PR 1 stub; PR 6 owns internals):
  - `parsers.home(doc, url)` returns `{ signedOut, reservations }` where each
    reservation is `{ name, href|null, startAt, durationMin, location }`.
    - Entries: `li.list-group-item`; name/link from `[data-testid="exam"] a`;
      start from `[data-testid="date"] [data-format-date]` (JSON `date`
      field, normalized to an ISO UTC instant); location from
      `[data-testid="location"]` (whitespace collapsed, else `null`);
      duration from `/(\d+)\s*h/i` + `/(\d+)\s*min/i` over the row text
      (`null` when absent).
    - `signedOut` = presence of
      `a[href^="https://us.prairielearn.com/pl/prairietest/auth"]`.
    - `isAvailableForReservationEntry(li)` (named, easy-to-adjust) skips the
      "Exams available for reservation" self-scheduling block by checking the
      nearest preceding `h1`-`h6` against `/available for reservation/i`.
      Implemented as a document-order walk, not `compareDocumentPosition`
      (linkedom inverts preceding/following, so the walk keeps tests and
      browsers in agreement). A traversal fallback covers `li`s found outside
      the combined query.
  - `sync(ctx)`: exactly one `ctx.fetchPage("https://us.prairietest.com/pt")`,
    parsed via `ctx.parseHtml("prairietest.home", ...)`, mapped with
    `PrairieRunModel.makeDeadlineItem`:
    - `id`: `pt:reservation:<n>` when the link matches `/\/reservation\/(\d+)/`,
      else `pt:exam:<16-hex>` (deterministic sync hash of name+startAt, stable
      across scans).
    - `kind: 'exam'`, `courseCode` from `/^([A-Z]{2,4})\s*(\d{3}[A-Z]?)/`
      (e.g. `CS 425`), `courseKey: 'prairietest:' + (courseCode || name)`,
      `courseName: courseCode || name`, `title: name`.
    - `startAt`, `endAt = startAt + durationMin` (`null` when unknown),
      `dueAt = startAt` (exams sort by when you must show up).
    - `location`, `status: 'not_started'`, `url` = absolute href resolved
      against `https://us.prairietest.com/pt`, else the home URL.
    - Signed out -> `{ status: 'signed_out', error: 'Sign in to PrairieTest' }`.
  - `isSignedOut(fetchResult)`: `/prairietest\/auth/` in text without any
    `data-testid="exam"` markup, or a final host other than
    `us.prairietest.com`.
  - Never fetches anything but GET `/pt`; never follows reservation,
    "Make a reservation", "Reserve this session", or "Start exam" links.
- `stage0/test-prairietest.js` (linkedom, synthetic fixtures): two reservations
  (`1 h 50 min` + `/pt/reservation/42`, `50 min` with a non-numeric link),
  one ignored available-for-reservation block, logged-out page, `isSignedOut`
  cases, single-GET safety assertion, stable fallback ids, and Central display
  across the 2026 DST switch (`CDT` Oct 22, `CST` Nov 3).
- `package.json`: added the new test file to `npm test`.

## What was deliberately NOT changed

- Shared load lists (`importScripts`, `FIREFOX_BACKGROUND_SCRIPTS`,
  `offscreen.html` scripts), manifest permissions, `AGENTS.md`,
  `systemdesign.md`, `ux.md` — untouched per parallel-work rules.

## Needs from other PRs (for the PR description, not this diff)

- `net.js` (PR 2 owns) currently only allows the PrairieLearn origin; the
  orchestrator's `fetchPage` must permit GET `https://us.prairietest.com/pt`
  before this source can run in production. Tests stub `ctx.fetchPage`.
- Emitting these items to Calendar/ICS/relay is PR 8/9/11's job.

## Verification

- `node --test stage0/test-prairietest.js` — 5 pass.
- `npm test` — green.
- `for file in extension/*.js ...; node --check` — clean.
- `node build-manifest.js --target=chrome --check` — passes.
- Manual (needs owner): load unpacked, enable the PrairieTest source when the
  settings UI lands, confirm reservations show correct Central start/end +
  location; log out of PrairieLearn and confirm "Sign in to PrairieTest".

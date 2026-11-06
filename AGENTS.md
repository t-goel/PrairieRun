# PrairieRun Agent Instructions

## Project Context

PrairieRun is a Chrome/Brave extension that scans PrairieLearn course pages,
stores normalized assignment data locally, and syncs eligible assignments to
Google Calendar.

The owner approved multi-site expansion: PrairieLearn, PrairieTest,
Gradescope, and Canvas, plus a "Sync now" button. That approval
overrides the "no manual scan button" rule below for the multi-source work.

The current product surface is the embedded PrairieRun panel on the
PrairieLearn home page plus the full-page dashboard (`extension/options.html`).
There is no toolbar popup; clicking the extension's toolbar button opens the
dashboard page in a new tab. The old standalone staging page has been removed.

## Current Architecture

```text
PrairieLearn page
  -> content.js
      -> prairielearn-adapter.js  (page extraction)
      -> home-panel.js            (embedded display/edit surface)
      -> view-utils.js            (shared filtering/sorting/status helpers)

Dashboard page (options.html) -> background.js
           -> scans course assessment tabs (background.js)
           -> fetches enabled sources (sync-orchestrator.js)
           -> stores normalized assignment state
           -> invokes outputs.js -> relay-push.js (iCal feed publish)
           -> notifies the home panel

calendar.js -> Google Calendar API (optional direct sync)
relay/      -> Vercel relay that hosts the auto-updating iCal feed
convex/     -> Convex backend for multi-device feed identity (Convex Auth Google)
```

`extension/options.html` is the full dashboard page (no popup). The toolbar
button opens it via `action.onClicked` (`PrairieRunExt
.addActionClickedListener`); `options-dashboard.js` drives settings, auth,
source rows, and Sync now; section scripts render Canvas setup, course links,
and the Calendar feed card (multi-device activation via Convex Auth Google,
one-click anonymous activation via `/api/claim`, custom relays in a collapsed
details; manual `.ics` export buttons were removed — the auto-updating feed
supersedes them).

`extension/background.js` imports `extension/oauth-config.js`,
`extension/auth-utils.js`, then `extension/calendar.js`; `calendar.js` is a
live dependency even though it is not loaded as a content script.
`oauth-config.js` holds the one build-time Google OAuth client ID (one-line
per-project change). `auth-utils.js` is the pure error-classification helper
(shared by the extension and `stage0/test-auth-errors.js`).

## Cross-Browser Support (Chrome/Brave + Firefox 115+)

- One codebase, two generated manifests. `extension/manifest.base.json` is
  the shared source of truth; `node build-manifest.js --target=chrome`
  regenerates `extension/manifest.json`, and
  `node build-manifest.js --target=firefox [--out=dist-firefox]
  [--gecko-id=...]` emits the Firefox distribution (scripts-array
  background plus `browser_specific_settings.gecko`). Chrome keeps the
  single-file `service_worker` background; Firefox uses `scripts`
  (`service_worker` is only enabled on Firefox 121+, and 115 ESR must work).
  Minimum Firefox is 115 (`storage.session` floor; the shim falls back to
  memory without it).
- `extension/compat.js` loads first in every context (service worker via a
  guarded `importScripts`, content scripts via manifest order, HTML pages via
  script-tag order) and exposes `PrairieRunExt`. All runtime code must use
  `PrairieRunExt` instead of `chrome.*`/`browser.*` directly. Firefox is
  identified from its user agent because Brave may also expose a `browser`
  namespace; Brave must continue using the Chrome OAuth client.
- Google access tokens live in `storage.session` with an in-memory
  browser-session fallback (`PrairieRunExt.get/set/clearSessionValue`) and
  are never written to `storage.local`.
- Firefox needs a separate Google OAuth client (its redirect origin differs
  from Chrome's); see `extension/google-calendar-setup.md`. The client ID
  default is the Chrome client; a `googleClientId` settings override selects
  the Firefox client until the settings UI owns this (Plan 2 follow-up).
- `dist-firefox/` is a generated artifact (gitignored). Firefox dev flow is
  `about:debugging → This Firefox → Load Temporary Add-on`; real
  distribution needs AMO signing with a permanent `gecko.id` you own.

## Core Behavior Rules

- Automatic PrairieLearn scanning and automatic Google Calendar sync are the
  default behavior.
- The toolbar button opens the full dashboard page (there is no popup). The
  only manual scan trigger is the approved "Sync now" button; opening or
  refreshing the PrairieLearn home page starts scanning automatically.
- Calendar reconciliation runs on the first successful scan and then at least
  once every 24 hours, including assignments that have not changed.
- The embedded home panel should stay directly below the PrairieLearn course
  links.
- Do not reintroduce the removed standalone staging page unless explicitly
  requested.
- Do not reintroduce per-assignment checkboxes, deselect-all controls, or manual
  selection/export UX unless explicitly requested.
- Only assignments with due dates are eligible for Google Calendar sync.
- Sources are default-off except PrairieLearn. The dashboard Sources card owns
  the per-source enable toggles, host-permission grants, and sign-in actions
  (toggle click is the permission gesture, then an immediate sync runs);
  disabled sources must show "off", never "pending". Host permission checks
  always use match patterns (`https://host/*`); a failed/thrown
  `permissions.contains` must fail closed (never enable into a CORS fetch).
  Brave often suppresses `permissions.request` — keep the toggle off, guide
  Site access (`brave://extensions` → Details), and re-sync on
  `permissions.onAdded`.
- Assignments without due dates are hidden by default, but users can reveal
  them and add/edit a due date.
- If a due date is added to a previously undated assignment, it becomes eligible
  for sync.
- Calendar events should be one-hour blocks ending at the assignment due date.
- The hosted iCal feed (Calendar feed card + `relay/` Vercel scaffold +
  `convex/` multi-device auth) is the first-class, no-setup calendar
  integration: "Sign in with Google" associates an account with a feedId in
  Convex and syncs it across devices, while "Get anonymous feed URL" preserves
  one-click activation via `/api/claim`. First sign-in migrates any existing
  local feed via `linkLegacyFeed` (HMAC verification). The master `PUBLISH_KEY`
  is shared between Convex and the relay; keys are derived on the fly and never
  stored in the database. The extension publishes the full ICS after every
  successful sync via `outputs.js` -> `relay-push.js` (`prairierunSettings.relay`,
  `prairierunSecrets.relayPublishKey`, `prairierunRelayStatus`), and the feed
  URL is the subscription target for any calendar app. Never send users
  through Google Cloud Console as part of normal setup.
- Direct Google Calendar sync (OAuth) is temporarily hidden in the UI
  (`#auth-card` on the dashboard, home-panel Connect footer) and skipped in
  the background (`DIRECT_GOOGLE_SYNC_ENABLED = false` in `background.js`).
  The Calendar feed card is the only calendar path. Flip the flag and unhide
  the card/footer when re-enabling OAuth. Setup docs in
  `extension/google-calendar-setup.md` remain for that later restore.
- Only sync new assignments or materially changed assignments.
- Every successful page scan also checks marked Calendar events for missing
  copies or duplicates. Those are repair work even when assignment data is
  unchanged or past due. Healthy unchanged events get no writes; inspection
  errors must report failure without blindly creating replacements.
- A score increase below the completion threshold is not a material calendar
  change by itself.
- Completion means score is strictly greater than 95 percent. Exactly 95 percent
  is not complete.
- Completed events should use grey. Incomplete events should retain their
  class/calendar color.
- Preserve duplicate prevention via stable PrairieRun identifiers in calendar
  event metadata/descriptions.
- Google sign-in (when re-enabled) is per-user `launchWebAuthFlow` (implicit
  flow): the dashboard page and the home-panel footer offer Connect/Disconnect,
  status shows `Not connected` / `Connected, expires <time>`, and Disconnect
  revokes at `oauth2.googleapis.com/revoke` and clears the session token.
  While `DIRECT_GOOGLE_SYNC_ENABLED` is false those surfaces stay hidden.
- Tokens live only in `storage.session`/memory (via `PrairieRunExt`
  get/set/remove session helpers); re-prompt only on expiry, revocation, or
  Disconnect. On Calendar 401, clear the cached token once and retry with a
  fresh token before failing.
- `redirect_uri_mismatch` / `invalid_client` / cancellation each produce a
  distinct human-readable message; the dashboard page has a copy-redirect-URI
  affordance
  for registering the install in the GCP OAuth client.
- Background runs never open a Google window. `getCalendarToken()` defaults to
  non-interactive; without a cached token it tries silent auth once and throws
  `AuthRequiredError` on failure. Only the Connect button passes
  `interactive:true` (via `PrairieRunCalendar.connect()`). Background Calendar
  callers catch `AuthRequiredError` and set sync status
  `{ state: "auth_required", source: "google", current: "Connect Google Calendar to sync." }`.
- Full `calendar` scope is required for per-class calendar creation; Testing
  mode is dev-only (test users, ~7-day grants) and Production + verification
  is required before real users.
- If a user deletes a mapped class calendar in Google Calendar, the next
  eligible synchronization must recreate or reuse the class calendar instead
  of failing on the stale local calendar ID.
- When an original assessment is completed, a later numbered extension must not
  replace its completed state or original due date for Calendar scheduling.
- The parser emits one assignment per assessment group, prioritizes completed
  attempts, and retains verified assignmentAliases for legacy event migration.
- All Calendar writes share the calendar.js queue. New event IDs are derived
  from canonical assignment IDs; retries must reuse them and recover 409s.
- Google may retain deleted event IDs. On a confirmed cancelled event or HTTP
  410 from the conflicted ID, advance a deterministic per-calendar/assignment
  generation, persisted in prairierunCalendarEventGenerations before insertion.
  Network uncertainty, HTTP 404, or unrelated active conflicts must not rotate
  IDs. inspectAssignmentEvents is read-only and reports missing/duplicate IDs.
- Duplicate repair may delete only PrairieRun-marked events with the exact
  assignment ID or verified parser aliases, after the retained event updates.
  Never merge or delete events solely by title or due date.
- Parser sourceUrls records assessment and attempt links seen in a single
  group. Marked legacy events can also match these exact verified source routes
  in their private sourceUrl or PrairieLearn-source description. Different
  numeric IDs are never linked by resemblance. Unmarked events remain intact.
- Preserve verified source links and aliases across scans of the same canonical
  ID. Newly discovered identities schedule repair even for past-due work, and
  remain pending until the Calendar update succeeds. Repair version is now 2.
- Instance-only scans can recover a parent assessment from a unique historical
  record with the same course, label, and exact title. Ambiguous matches and
  title-only matches are rejected. After history is cleared, users may supply
  explicit instance-to-assessment IDs via prairierunAssignmentLinks local
  storage; validate same-course IDs. Never probe assessment URLs automatically:
  a GET to an unstarted homework can create an attempt in PrairieLearn.
- identity-resolver.js may verify existing attempts through the unused
  /assessment/{id}/__prairierun_identity__ subpath, which reaches PrairieLearn's
  redirect middleware but never its GET '/' start handler. Follow only exact
  same-origin/course/instance redirects; errors or unsupported servers leave
  identities unresolved. Never substitute the bare assessment route.
- Automatic scans inspect marked Calendar events for unresolved instance-only
  assignments, then ask the PrairieLearn content script to verify candidates.
  Titles narrow candidates but never authorize merging; only exact server
  redirects establish new links. Persist verified links in
  prairierunAssignmentLinks and reuse them without user input.
- Dashboard status listens for sync-status storage updates and distinguishes
  Calendar syncing from completed scanning. A completed Calendar repair reports
  the actual number of removed duplicates after the API calls succeed.
- The repair-version marker forces a full reconciliation on the next scan
  after upgrading. Advance it and the daily-success timestamp only when all
  exported assignments succeed; expose partial failures in the page status.

## UI Rules

- Assignment rows should not show redundant `unknown`, `incomplete`, or
  `complete` text labels when those states are already represented by dropdown
  grouping.
- Keep existing synced assignments collapsed according to the current panel
  rules.
- Keep new or materially changed assignments visible when user review is needed.
- Keep PrairieLearn assignment source links working.
- Preserve compact, scan-friendly UI. Avoid bringing back clutter removed in the
  cleanup pass.
- Keep the home-panel view switch compact: use button-like corner rounding and
  keep its blue track, white active tab, and contrasting labels synchronized
  with the tab animation.
- Keep the home-panel header count concise; it should show only the number of
  current assignments and not repeat the product name.

## Files To Treat Carefully

- `extension/background.js`: scanner, state manager, auto-sync coordinator.
- `extension/calendar.js`: OAuth, calendar creation, duplicate markers, event
  creation/update, calendar colors, token lifecycle (401 retry, revoke,
  AuthRequiredError, no background interactive auth). Owned by PR 0, then PR 9.
- `extension/oauth-config.js`: single build-time OAuth client ID (one-line
  per-project change; never commit secrets/tokens).
- `extension/auth-utils.js`: pure auth error classifier (`stage0/test-auth-errors.js` covers it).
- `extension/compat.js`: cross-browser `PrairieRunExt` shim (namespace
  promises, session-token store). Loads first everywhere; all runtime code
  must go through it, never `chrome.*`/`browser.*` directly.
- `extension/manifest.base.json` + `build-manifest.js`: manifest source of
  truth and per-browser generator. Never hand-edit `extension/manifest.json`
  or `dist-firefox/manifest.json`; edit the base and rebuild. `dist-firefox/`
  is gitignored build output.
- `extension/home-panel.js` and `extension/home-panel.css`: current embedded UI.
- `extension/prairielearn-adapter.js`: runtime PrairieLearn parser.
- `extension/view-utils.js`: shared home-panel helpers; `statusLabel` is live.
- `stage0/` and `capture-helper/`: development/testing assets. Do not delete
  them unless explicitly requested.

## Multi-source scaffold (PR 1)

PR 1 lays down the DeadlineItem model and module stubs so later PRs can work
in parallel without touching shared files. No user-visible behavior change.

- `extension/deadline-model.js` (`PrairieRunModel`): `SOURCE_IDS`, `STATUSES`,

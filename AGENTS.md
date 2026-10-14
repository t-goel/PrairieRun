# PrairieRun Agent Instructions

## Project Context

PrairieRun is a Chrome/Brave extension that scans PrairieLearn course pages,
stores normalized assignment data locally, and syncs eligible assignments to
Google Calendar.

The current product surface is the embedded PrairieRun panel on the
PrairieLearn home page plus the extension popup. The old standalone staging
page has been removed.

## Current Architecture

```text
PrairieLearn page
  -> content.js
      -> prairielearn-adapter.js  (page extraction)
      -> home-panel.js            (embedded display/edit surface)
      -> view-utils.js            (shared filtering/sorting/status helpers)

Popup -> background.js
           -> scans course assessment tabs
           -> stores normalized assignment state
           -> invokes calendar.js
           -> notifies the home panel

calendar.js -> Google Calendar API
```

`extension/background.js` imports `extension/calendar.js`; `calendar.js` is a
live dependency even though it is not loaded as a content script.

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
  guarded `importScripts`, content scripts via manifest order, popup via
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
- Do not add a manual scan button to the popup; opening or refreshing the
  PrairieLearn home page starts scanning automatically.
- Calendar reconciliation runs on the first successful scan and then at least
  once every 24 hours, including assignments that have not changed.
- The embedded home panel should stay directly below the PrairieLearn course
  links.
- Do not reintroduce the removed standalone staging page unless explicitly
  requested.
- Do not reintroduce per-assignment checkboxes, deselect-all controls, or manual
  selection/export UX unless explicitly requested.
- Only assignments with due dates are eligible for Google Calendar sync.
- Assignments without due dates are hidden by default, but users can reveal
  them and add/edit a due date.
- If a due date is added to a previously undated assignment, it becomes eligible
  for sync.
- Calendar events should be one-hour blocks ending at the assignment due date.
- Only sync new assignments or materially changed assignments.
- A score increase below the completion threshold is not a material calendar
  change by itself.
- Completion means score is strictly greater than 95 percent. Exactly 95 percent
  is not complete.
- Completed events should use grey. Incomplete events should retain their
  class/calendar color.
- Preserve duplicate prevention via stable PrairieRun identifiers in calendar
  event metadata/descriptions.
- If a user deletes a mapped class calendar in Google Calendar, the next
  eligible synchronization must recreate or reuse the class calendar instead
  of failing on the stale local calendar ID.
- When an original assessment is completed, a later numbered extension must not
  replace its completed state or original due date for Calendar scheduling.
- The parser emits one assignment per assessment group, prioritizes completed
  attempts, and retains verified assignmentAliases for legacy event migration.

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
  creation/update, calendar colors.
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

The runtime adapter and `stage0/prairielearn-adapter.js` are duplicated parser
implementations. Consolidating them is a future improvement, not a casual
cleanup.

## Documentation Discipline

- After every meaningful code or behavior change, update this `AGENTS.md` file
  if the change affects architecture, workflow, testing, project rules, or
  future-agent context.
- Also update `systemdesign.md` for architecture/dependency changes.
- Also update `ux.md` for user-facing behavior changes.
- Historical stage planning documents were removed at the user's request.
  Keep current setup documentation, systemdesign.md, ux.md, and test assets.

## Commit Discipline

- Commit after every logical change.
- Keep commits focused and descriptive.
- Do not push unless the user explicitly asks.
- Do not revert user changes unless the user explicitly requests it.

## Verification

For extension changes, run checks proportional to the risk. Common baseline:

```bash
node --check extension/*.js stage0/*.js capture-helper/*.js
node build-manifest.js --target=chrome --check
node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json', 'utf8')); console.log('manifest ok')"
node stage0/test-adapter-core.js
node stage0/test-capture-bundle.js
node --test stage0/test-firefox-support.js
```

When UI or sync behavior changes, also ask the user to reload the unpacked
extension and verify in Chrome/Brave because this environment cannot fully
exercise PrairieLearn login state or Google OAuth. Firefox changes need the
same manual pass via `about:debugging` temporary load plus the Firefox OAuth
client in `extension/google-calendar-setup.md`.

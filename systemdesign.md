# PrairieRun System Design and Dead-Code Audit

## Scope

This document reflects the repository after the cleanup completed on
2026-09-11. The original audit findings are preserved below, with each item
marked by its current disposition. Future agent-facing project rules live in
`AGENTS.md`.

## Current runtime architecture

Assessment extraction groups base rows and numbered attempts into one record.
Completed attempts take precedence over incomplete late attempts. Verified
instance IDs are carried as assignmentAliases for Calendar event migration.

```text
PrairieLearn page
  └─ content.js
      ├─ prairielearn-adapter.js  (page extraction)
      ├─ home-panel.js             (embedded display/edit surface)
      └─ view-utils.js             (shared filtering/sorting/status helpers)

Popup ──> background.js
             ├─ scans course assessment tabs
             ├─ stores normalized assignment state
             ├─ invokes calendar.js
             ├─ schedules 24-hour Calendar reconciliation
             └─ notifies the home panel

calendar.js ──> Google Calendar API
```

The manifest loads the content scripts on PrairieLearn and loads
`background.js` as the service worker. `background.js` imports `calendar.js`, so
the calendar module is a live dependency even though it is not listed in the
manifest's content-script array.

The popup is status/settings-only. PrairieLearn scanning begins from the home
page automatically, and a named extension alarm runs a full Calendar
reconciliation at least once per 24-hour interval. The daily reconciliation
includes stored assignments with due dates even when their normalized data is
unchanged. Calendar export falls back to finding or recreating a class calendar
when its locally stored Google Calendar ID no longer exists.

When PrairieLearn exposes both a base assessment and a numbered extension for
the same assessment set, a completed base assessment takes precedence for the
normalized assignment's score, completion state, source link, and due date.
This prevents an extension deadline from creating a later Calendar event for
work that was already completed before the extension.

## Cross-browser support (Chrome/Brave + Firefox 115+)

One codebase, two generated manifests. `extension/manifest.base.json` is the
shared source of truth and `build-manifest.js` (repo root) generates each
target: `--target=chrome` regenerates `extension/manifest.json` (single-file
`service_worker` background), and `--target=firefox` emits a `dist-firefox/`
directory whose manifest swaps in a `scripts`-array background (`compat.js`,
`calendar.js`, `background.js` in order) and adds
`browser_specific_settings.gecko` (stable add-on ID plus
`strict_min_version: "115.0"`). The scripts array is required because
Firefox only enables `service_worker` on 121+; the `typeof importScripts ===
"function"` guard at the top of `background.js` loads the modules only when
the manifest has not already done so.

The compatibility shim identifies Firefox from the user agent rather than from
the presence of a `browser` namespace. This matters for Brave, which can expose
that namespace while still requiring the Chrome extension OAuth client.

`extension/compat.js` is the only module that touches `browser.*` /
`chrome.*` directly. It loads first in every context and exposes
`PrairieRunExt`: promise-based storage/tabs/runtime/identity helpers plus a
session-token store that prefers `storage.session` and falls back to
in-memory for the browser session, never persisting tokens to
`storage.local`. The Firefox Google OAuth client is separate from the Chrome
client (different redirect origin); `calendar.js` keeps the Chrome client ID
as default and honors a `googleClientId` settings override for Firefox.
`dist-firefox/` is gitignored build output.

## Findings

| Item | Evidence | Assessment | Proposed action |
|---|---|---|---|
| `extension/staging.html` | No manifest entry, popup link, background tab creation, or current UI link referenced it | Dead/unreachable legacy UI | Removed |
| `extension/staging.js` | Only loaded by `staging.html`; duplicated home-panel rendering/edit behavior | Dead as part of the current product path | Removed |
| `extension/staging.css` | Only referenced by `staging.html` | Dead with the legacy page removed | Removed |
| `PrairieRunView.currentDateKeys` | Exported but no call sites found | Unused helper | Removed |
| `PrairieRunView.isPending` | Exported but no call sites found after selection removal | Unused helper | Removed |
| `PrairieRunView.statusLabel` | Called by `home-panel.js` for unsynced/error badges | Live helper | Retain |
| `runScan` parameter `openWhenNew` | Passed by callers and logged, but never controlled behavior | Dead parameter | Removed |
| `runScan` result field `newOrChanged` | Constructed and returned; callers used only `assignments` or ignored the result | Dead result data | Removed |
| `home-panel.css` `.prr-sync--done` | No matching current markup | Dead style | Removed |
| `home-panel.css` `.prr-check-spacer` | Only a zero-width placeholder from the removed checkbox layout | Obsolete layout shim | Removed with spacer markup |
| `popup.css` `.stats*` rules | No `.stats` markup in current `popup.html` | Dead styles | Removed |
| `popup.js` `#status` branch | Current popup has `#context`, not `#status` | Defensive branch with no current DOM target | Removed; `#context` is used consistently |
| `extension/prairielearn-adapter.js` and `stage0/prairielearn-adapter.js` | Two parser implementations exist; one is runtime and one is test-only | Duplication risk, not immediately dead | Consolidate around one canonical parser/test boundary |
| `extension/README.md` and `extension/google-calendar-setup.md` | Describe the former staging/export-preview workflow | Documentation drift | Update or consolidate; do not treat as runtime dead code |

## Files that should not be removed in the first cleanup pass

- `extension/background.js`: live scanner, state, and automatic-sync coordinator.
- `extension/calendar.js`: imported by the background service worker and owns
  OAuth, calendar creation, duplicate markers, event updates, and colors.
- `extension/home-panel.js`, `home-panel.css`, `content.js`, and
  `prairielearn-adapter.js`: current embedded PrairieLearn surface and its data
  path.
- `extension/view-utils.js`: still needed by the home panel even after the
  staging page is removed; only its unused exports should be reconsidered.
- `stage0/test-adapter-core.js`, `stage0/test-capture-bundle.js`, the capture
  JSON fixture, and `capture-helper/`: development/testing assets. They are not
  shipped runtime code. The capture bundle test has been aligned with the
  current one-course fixture.

## Historical documentation

`stage-0.md` through `stage-3.md` and portions of `ux.md` contain historical
planning language for staging, selection, and manual export. They are not code
dependencies. Consolidation or archival remains optional now that current
behavior is represented in the system design and cleanup checklist.

## Agent instructions

`AGENTS.md` is the current repo-level instruction file for OpenAI/Codex agents.
Update it after meaningful changes that affect architecture, behavior, testing,
workflow, or future-agent context.

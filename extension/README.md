# PrairieRun extension

## Current functionality

- Scans the logged-in `us.prairielearn.com` home page and discovered course assessment pages.
- Automatically scans when the logged-in PrairieLearn home page is opened.
- Automatically synchronizes actionable assignments to Google Calendar after each scan.
- Reconciles stored assignments with Google Calendar at least once every 24 hours, even when they have not changed.
- Extracts assignments, course names, scores, source URLs, due timestamps, and time zones.
- Merges base assessments and numbered assessment instances.
- Prevents duplicate creation during overlapping syncs and network retries.
- Checks for missing or duplicate Calendar events on each scan and restores deleted dated assignments without waiting for the daily reconciliation.
- Repairs confirmed duplicate PrairieRun events on the first scan after this update; no data reset is needed.
- Automatically links original assessment events to existing attempts through verified PrairieLearn redirects, including when local assignment history was cleared.
- Stores assignments locally in Chrome.
- Shows an embedded assignment panel directly below the PrairieLearn course links, grouped by class.
- Shows assignments due today or later; full Calendar reconciliation also updates dated past assignments.
- Shows the next three uncompleted assignments, with additional upcoming work and completed work in separate dropdowns.
- Uses PrairieLearn completion status and the strict-greater-than-95% score rule.
- Sorts incomplete assignments first and puts completed assignments in a dropdown.
- Adds a Google Calendar popup reminder to each uncompleted assignment; the default lead time is four hours and can be changed in the extension popup. Completed assignments have reminders removed.
- Keeps undated assignments hidden by default, with an extension setting to reveal them.
- Lets the user add or edit a due date for an undated assignment from the embedded panel.
- Previews one-hour calendar blocks ending at the due time.

## Load and test

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `extension` directory.
5. Log in to `https://us.prairielearn.com/`.
6. Review the assignment panel below the PrairieLearn course links. Scanning and Calendar synchronization start automatically.

## Firefox (same codebase, generated manifest)

The extension runs in Firefox 121+ with full functionality: PrairieLearn
scan, embedded home panel, popup, and automatic Google Calendar sync. The
only per-browser delta is the manifest, generated from
`extension/manifest.base.json`:

```bash
# Chrome/Brave manifest (regenerates extension/manifest.json)
node build-manifest.js --target=chrome

# Firefox distribution directory (stable add-on ID included)
node build-manifest.js --target=firefox
```

Then, for development:

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select any file inside `dist-firefox/` (e.g. `dist-firefox/manifest.json`).
4. Log in to `https://us.prairielearn.com/` and verify scan → panel →
   Calendar sync as in Chrome.

For distribution beyond development, the build must be signed through
addons.mozilla.org (AMO); see `google-calendar-setup.md` for the separate
Firefox Google OAuth client this requires. Pass `--gecko-id=` to
`build-manifest.js` to stamp a permanent add-on ID you own before
submitting to AMO.

## Google Calendar export

The extension requests Calendar access via an explicit Connect step. Use the extension popup (or the Connect button in the PrairieRun panel) to connect or disconnect Google Calendar at any time. Disconnect revokes the token at `oauth2.googleapis.com/revoke` and clears the cached session token. Synchronization creates or reuses a `PrairieLearn — {class}` calendar and stores a private assignment marker plus Google event ID for duplicate-safe updates.

Background runs never open a Google window: without a cached session token, automatic scans and the daily alarm record `auth_required` ("Connect Google Calendar to sync.") and wait for the user to Connect. Only the Connect button uses interactive auth.

For a different extension ID or a published build, set the client ID once in `extension/oauth-config.js` (see `extension/google-calendar-setup.md`). Prefer sharing one stable extension ID via manifest `key` pinning so both developers use the same OAuth client. Firefox needs a separate OAuth client (different redirect origin); see `google-calendar-setup.md`. Issue #6 (Firefox client-ID settings UI) remains open.

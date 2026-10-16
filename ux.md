# PrairieLearn Calendar Extension — UX Map

## Implementation audit: dead-code and cleanup candidates

This audit records implementation findings after the cleanup completed on
2026-09-11. The current product surface is the PrairieLearn home-page panel plus
the extension popup. The standalone staging page was not linked by the current
manifest, popup, content script, or background service worker, and has now been
removed.

### UX code that is no longer represented in the current product

- `extension/staging.html`, `extension/staging.js`, and `extension/staging.css`
  implemented the former standalone staging page. They were not reachable from
  the current UI and duplicated the home-page panel's assignment rendering and
  due date editing, so they have been removed.
- The old per-assignment selection workflow is no longer part of the current
  UX. Source searches found no active checkboxes, selected-assignment export,
  “deselect all,” or manual sync controls in the extension. Historical planning
  text in this file and the stage documents should be treated as design history,
  not as current requirements.
- The popup stylesheet's obsolete `.stats` rules and the unreachable `#status`
  fallback have been removed. The popup now uses `#context` consistently.
- The home-panel stylesheet's obsolete `.prr-sync--done` and
  `.prr-check-spacer` rules have been removed.

### UX behavior that must be preserved during cleanup

- The home panel remains directly below PrairieLearn's course links.
- Automatic scanning and automatic calendar synchronization remain the default.
- The extension popup does not offer a manual scan action. Opening or
  refreshing the PrairieLearn home page starts the scan automatically.
- Calendar synchronization runs after the first successful scan and is also
  reconciled at least once every 24 hours, even when assignments are unchanged.
- Assignments without due dates remain hidden by default and can be revealed or
  edited through the existing undated-assignment control.
- Existing synced assignments remain collapsed according to the current panel
  rules; new or changed assignments remain visible when the product needs the
  user to review them.
- The home-panel Due Date / By Class switch uses compact button-like corners.
  Its active tab moves over a blue track, with white text on the track and
  PrairieLearn-blue text on the white tab.
- The home-panel header uses a concise current-assignment count without
  repeating the PrairieRun product name.
- Calendar links, class-specific calendars, completion state, duplicate
  prevention, and the strict-greater-than-95% (not equal to 95%) completion rule
  must not regress.
- Google Connect/Disconnect stays understandable: popup card plus a one-line
  home-panel footer, `Not connected` / `Connected, expires <time>` status,
  distinct cancellation vs. misconfiguration messages, and a collapsed
  copy-redirect-URI troubleshooter. No client-ID settings field in the UI.
  With no sign-in, background syncs show "Connect Google Calendar to sync."
  instead of opening a window; only Connect uses interactive auth.
- If an assignment was already completed before a late extension was added,
  the extension deadline is not shown or scheduled as new work.

See `systemdesign.md` for implementation evidence and `AGENTS.md` for current
agent-facing project rules.

## Product promise

When an eligible assignment event is recreated after manual deletion, it uses
the current completion color and reminders. Deleted Google event IDs are
handled explicitly so restoration does not silently fail on an ID conflict.
Refreshing PrairieLearn checks for externally deleted assignment events and
restores them during the same scan. The popup reports the number restored.
Healthy unchanged events are checked without being rewritten. Removing an
assignment's date in PrairieRun still excludes it from Calendar sync.

Calendar sync repairs confirmed duplicate PrairieRun events automatically:
one event retains the assignment's latest date, completion color, and reminders.
Extra marked copies are removed only after that event is successfully updated.
An original assessment link and its attempt link can identify the same work
when PrairieLearn exposes both in one assessment group. Older marked events
are matched using those verified links even if their stored identifiers differ.
Personal events and assignments with merely similar titles are left alone.

Reloading this update and opening PrairieLearn triggers the initial duplicate
repair automatically. There is no need to clear data or delete calendars.
The popup reports failed assignments so a partial repair is not shown as a
successful synchronization.
During Calendar writes the popup says "Synchronizing Google Calendar…" and
updates live. Completed repairs report how many duplicate events were removed;
Google sign-in or a completed page scan alone does not mean repair succeeded.
This source-link repair runs again after updating, even if the earlier repair
finished. Newly discovered attempt links also trigger repair automatically.
When an original link disappears after starting work, a unique historical
course/label/title match can restore its relationship to the attempt. With no
history, PrairieRun automatically verifies original links from old Calendar
events against the logged-in PrairieLearn session. Users do not need to enter
each pair manually. Unsupported redirects or login failures leave the events
alone; titles alone never authorize deleting Calendar events.
The popup completion control says "Complete above" the threshold to make the
strict comparison clear; exactly 95% is incomplete at the default threshold.

Multiple attempts at one assessment appear as one assignment. A completed
attempt is not downgraded by a lower-scoring late attempt.

“Scan my PrairieLearn classes, let me review everything in one place, and publish due dates to Google Calendar without duplicates.”

The core interaction should be a short, reversible flow:

```text
PrairieLearn home → Scan classes → Review staging area → Preview export → Sync to Google Calendar
```

## Primary user journey

### 1. Popup on PrairieLearn home

When the active tab is a supported PrairieLearn page, the popup shows:

- Product name: PrairieRun
- Connection status: “PrairieLearn detected” or “Log in to PrairieLearn”
- Last scan time
- Number of staged assignments
- Automatic scan and Calendar synchronization status
- Small link: **Settings**

If the user is on another site, show: “Open PrairieLearn to scan assignments,” with an **Open PrairieLearn** action if a configured URL exists.

### 2. Scan setup and progress

Clicking **Scan all classes** starts a scan confirmation state:

- Detected course count, if available
- Toggle: **Refresh existing assignments** (on by default)
- Button: **Show undated assignments** (off by default)
- Button: **Start scan**

During scanning, show a compact progress view:

- Current course and page
- Progress, e.g. “2 of 5 classes”
- Assignment count found so far
- Status labels: “Scanning,” “Waiting for page,” “Partial result,” or “Complete”
- **Pause** and **Cancel** actions

The user can leave the popup; progress continues in the extension. A badge shows the number of new staged items.

### 3. Scan completion

Show a completion summary:

- “42 assignments found across 5 classes”
- New: 18
- Already staged: 20
- Changed: 3
- Missing due date: 1
- Warning link for partial or unsupported pages

Primary action: **Review assignments**.

If a scan partially fails, use “31 assignments found; 2 classes need attention” and provide **Review issues** plus **Retry failed classes**.

## Staging dashboard

The staging dashboard is the main product surface. It should be usable without sending anything to Google Calendar.

### Header

- Page title: **Assignment staging area**
- Last scanned timestamp
- Primary button: **Add new and changed with due dates**
- Less prominent actions: **Scan again**, **Connect Google Calendar**
- Summary chips: `18 new`, `20 synced`, `3 changed`, `1 needs a date`

### Filters and organization

- Course grouping
- Due-date range
- Status filter: New, Changed, Synced, Missing date, Stale, Error
- Search by title or course
- Sort by due date, course, title, or discovery time
- Group toggle: Course / Flat list

Remember filters between visits, but include **Clear filters**.

### Default staging view

Keep the initial staging view compact and low-clutter:

- Show assignments grouped by course with a course total and sync summary.
- Treat only new and changed assignments with due dates as eligible for synchronization by default.
- Show automatic synchronization status.
- Keep assignment details and per-assignment actions visible without per-assignment selection controls.
- If there are missing dates or errors, show a concise warning count and let the user review those items without expanding every row. Missing-date assignments are excluded from the bulk action by default.

### Assignment detail view

The assignment detail view shows the following:

- Row-level assignment details
- Search and filters
- New/changed/synced status indicators
- Per-assignment edit, exclude, and source-link actions
- Automatic synchronization status

### Assignment row/card

Each assignment displays:

- Assignment status
- Course color marker
- Assignment title
- Course name
- Due date/time or “No due date”
- Sync status
- Source link: **View in PrairieLearn**
- Overflow actions: Edit, Exclude, Reset changes

For changed or synced items, show a small status explanation rather than color alone. Color should supplement text, not be the only signal.

### Bulk actions

In the default bulk view, show only the essential actions:

- Automatic synchronization status

In the assignment detail view, show:

- **Set calendar**
- **Set class calendar**
- **Set reminder**
- Automatic synchronization status

The default synchronization set should be “new and changed assignments with due dates.” A missing-date assignment can be edited in staging to add a due date/time; after saving, it becomes eligible. It remains excluded from synchronization until it has a valid due date.

## Assignment edit flow

Use an inline drawer or modal so the user does not lose their place.

Fields:

- Title
- Course
- Due date
- Due time
- Time zone
- Event duration, defaulting to one hour ending at the due time
- Calendar
- Reminder
- Description preview

Show a note when a field is manually overridden: “This value will be preserved during future scans until you reset it.”

Actions: **Save changes**, **Cancel**, **Reset to PrairieLearn value**.

## Google Calendar connection flow

### Before connection

Show a short explanation:

“PrairieRun needs permission to create and update calendar events you choose. Your assignments stay on this device; PrairieRun does not need your Google password.”

Button: **Connect Google Calendar**.

### Calendar setup

After authorization:

- Calendar dropdown with writable calendars
- Default calendar selector
- Course-to-calendar mapping section
- Option to create a separate calendar for each class
- Color strategy selector:
  - “Use separate calendars by course” (recommended)
  - “Use one shared calendar”
- Default reminder selector

If color support is limited, explain the behavior immediately beside the choice rather than after export.

## Completion status

During each scan, the extension checks assignment completion. An assignment is considered completed when PrairieLearn explicitly marks it complete or when its score is strictly above 95% by default.

Each assignment has a compact completion control:

- Completed
- Incomplete
- Use PrairieLearn status

Manual changes are labeled **Manual status** and remain in effect until the user chooses **Reset to PrairieLearn status**. Completion status never changes PrairieLearn; it only affects staging and calendar presentation.

Each class keeps its own calendar color. Completed assignments use grey when event-level colors are supported. Incomplete and unknown assignments retain their class color. No red incomplete state is used.

## Export preview

Before the final action, show:

- “Ready to add 12 new or changed events”
- “Events run from one hour before each due time through the due time”
- Calendar destination
- Course color mapping
- Date/time zone
- Reminder behavior
- List of any skipped items and reasons
- Missing-date assignments excluded by default
- Warning for items that will update existing calendar events
- Completion changes that will update existing events to grey or restore their class color

Primary action: **Add to Google Calendar**.

Use explicit language for idempotency: “Previously synced assignments will be updated, not duplicated.”

## Export result

Show a result screen with item-level outcomes:

- Added: 15
- Updated: 2
- Already up to date: 1
- Skipped: 0
- Failed: 0

Actions:

- **Open Google Calendar**
- **Retry failed items**
- **Back to staging area**

For failures, preserve assignment edits. Never discard staged data because of a calendar error.

## Duplicate and conflict UX

### Existing PrairieRun event

Show the item as **Synced** and offer **View event** and **Update on next export**. Do not create a second event.

### Event found after local data was cleared

Show: “Matching PrairieRun event found in Google Calendar. We will update it.”

### Similar event without a PrairieRun marker

Do not automatically merge based only on title/date. Show a possible match prompt:

“A similar calendar event already exists. Add a new PrairieRun event, or skip this assignment?”

Default: skip and let the user decide.

### Assignment removed from PrairieLearn

Mark it **Stale** in staging. Explain: “This assignment was not found in the latest scan.” Offer **Keep calendar event** as the default and a separate, explicit **Delete calendar event** action.

## Empty, loading, and error states

- **No assignments yet**: “Scan PrairieLearn to build your staging area.”
- **No matching filters**: “No assignments match these filters.” with **Clear filters**.
- **No due dates**: show the items and explain that they need review before timed export.
- **Not logged in**: link back to the PrairieLearn login page.
- **Unsupported page structure**: keep discovered data, show a diagnostic message, and provide a retry action.
- **Google authorization expired**: “Reconnect Google Calendar”; keep all staged records.
- **Offline**: allow local review and editing; disable export with a clear reason.

## Settings and trust cues

Settings should include:

- PrairieLearn domain(s)
- Default calendar
- Course color strategy
- Default reminder
- Missing-date behavior
- Include past/closed assignments
- Scan limits
- **Clear local PrairieRun data**
- Connected Google account and **Disconnect**

The extension should display the active PrairieLearn domain and the connected Google account before export. This reduces the risk of scanning one account and exporting to another user's calendar.

## Accessibility and interaction requirements

- Full keyboard navigation for popup and staging dashboard.
- Visible focus states.
- Semantic buttons, labels, table/list semantics, and screen-reader status announcements for scan/export progress.
- Do not communicate status by color alone.
- Confirm destructive or consequential actions such as deleting a calendar event or clearing local data.
- Keep scan/export actions available at the top of long lists.

## MVP versus later UX

### MVP

- One-click scan from PrairieLearn home
- Course grouping
- Staging list with basic editing
- Separate Google Calendar mapping for each class
- Create/update events with duplicate protection
- Scan/export progress and error states

### Later

- Advanced recurring scan reminders
- Import existing calendar assignments into staging
- Bulk date transformations
- Course-specific templates and colors
- Diagnostic export for unsupported PrairieLearn layouts

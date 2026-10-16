# PR 8 iCal export notes

Pure RFC 5545 iCalendar (`.ics`) writer with stable UIDs, sequence increments, reminder alarms, and options-page download UI.

## Summary of Changes
- **`extension/ics-writer.js`**:
  - `buildCalendar(items, opts)`: generates RFC 5545 `VCALENDAR` document with calendar header (`PRODID:-//PrairieRun//Deadlines//EN`, `CALSCALE:GREGORIAN`, `METHOD:PUBLISH`, `X-WR-CALNAME`, `X-WR-TIMEZONE:America/Chicago`, refresh duration headers).
  - Skips items without `dueAt` and `startAt`, or completed items when `includeCompleted: false`.
  - Emits UTC timestamps `YYYYMMDDTHHMMSSZ` (no `TZID` needed for UTC instants).
  - Event shapes:
    - `assignment`, `block1h` (default): `DTSTART = dueAt - 1h`, `DTEND = dueAt`.
    - `instant`: `DTSTART = DTEND = dueAt`.
    - `allDay` (Canvas): `DTSTART;VALUE=DATE:<Central YYYYMMDD>`, `DTEND;VALUE=DATE:<next day>`.
    - `exam`: `DTSTART = startAt`, `DTEND = endAt`, `LOCATION`.
  - `SUMMARY`: `[<course>] <title>`, prefixed with `✓ ` for `completed` or `graded` items.
  - `DESCRIPTION`: source label, status, `Late due: <Central>` if `lateDueAt`, and assignment URL.
  - `CATEGORIES`: source id; `STATUS:CONFIRMED`; `TRANSP:TRANSPARENT`.
  - Reminders (`VALARM`): omitted for completed items. Emits display alarm for `leadMinutes` (default 240m), and if `nightBefore: true`, a second absolute alarm for 8 PM Central on the eve of the due date.
  - Note on VALARMs: Google Calendar ignores `VALARM` components in imported or subscribed feeds (widely reported / inferred behavior); alarms function as expected in Apple Calendar and Microsoft Outlook.
  - RFC 5545 formatting:
    - `escapeText(s)`: escapes `\`, `;`, `,`, and newlines (`\n`).
    - `foldLine(line)`: strictly enforces max 75 octets (UTF-8 bytes) per physical line, never splits surrogate pairs or multi-byte code points (e.g. emoji `🎓`), continuation lines begin with a single space `" "`. All lines joined with CRLF `\r\n`, file ends with trailing CRLF.
    - `filterWindow(items, now, days)`: filters items falling within the next `days` window.
    - Stable sequences: returns updated sequence map `{ [uid]: { n, fp } }`, incrementing `n` only when `fingerprint(item)` changes.
- **`extension/options-export.js`**:
  - Renders into `<section id="export">`.
  - Dynamically loads `ics-writer.js` if not already present in the runtime environment.
  - Note for future manifest/load-list updates: `options.html` will eventually include `<script src="ics-writer.js"></script>` ahead of `options-export.js`. Until then, dynamic loading ensures seamless standalone operation without modifying shared load lists.
  - UI offers "Download all (.ics)" and individual buttons for each enabled source.
  - Exports `downloadIcs(items, filename)` for reuse by PR 9 (per-course export).
  - Downloads via `URL.createObjectURL(new Blob([text], {type: "text/calendar;charset=utf-8"}))` and temporary `<a>` element, requiring no `downloads` permission.
- **`stage0/test-ics-writer.js`**:
  - Golden output comparison for 4 canonical items (PrairieLearn, Gradescope with `lateDueAt`, Canvas all-day, PrairieTest exam with `LOCATION`).
  - Strict line-length validation: all physical lines $\le 75$ octets, only `\r\n` line endings, zero bare `\n`.
  - Unicode/emoji folding test: ensures lines with multi-byte code points fold without corruption and unfold to identical original.
  - Sequence stability and bump tests across multiple builds and property updates.
  - VALARM omission for completed items and accurate Central time eve computation.
  - Options export UI rendering and download flow tests.
  - Optional round-trip test against PR 4's `ics-parse.js` when available.

## RFC 5545 Validation
- Output verified against RFC 5545 standards: CRLF line endings, $\le 75$ UTF-8 bytes per line, valid property escaping, and clean import structure.
- `npm test`: 55 passing tests, 0 failures, 3 skipped.
- `node build-manifest.js --target=chrome --check`: passes.

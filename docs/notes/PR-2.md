# PR 2 notes — background fetch infrastructure

Branch: `pr2-background-fetch` (this worktree: `t3/background-fetch-sync`).
No user-visible behavior change yet: sources still return their stub
results; PR 3–6 make them real. With no PrairieLearn tab open,
`prairierun-sync` fires (or Sync now is clicked) and the popup shows
per-source statuses with Central times.

## What changed

- `extension/net.js` (full version): `fetchPage` is GET-only,
  `redirect:"follow"`, `AbortController` timeout (default 20 s), returns
  `{ok, status, url, redirected, contentType, text}`. `assertSafeUrl` keeps
  the PR 1 PrairieLearn path allowlist unchanged and additionally allows
  same-origin GETs on `us.prairietest.com`, `www.gradescope.com`, and
  `canvas.illinois.edu` (only PL has attempt-creating GET routes).
  Per-origin serialization (one at a time, 400–800 ms jittered gap, max 40
  requests/origin/run, `resetBudgets()` per run), metadata-only logging via
  an optional `log` callback, and `redactUrl()` (Canvas `user_*` token +
  query-string stripping).
- `extension/parse-host.js`: `parseHtml` parses in place when `DOMParser`
  exists (Firefox event page, tests); otherwise (Chrome SW) it serializes
  `offscreenEnsure()` behind a module-level promise and forwards
  `{type:"PRAIRIERUN_PARSE", parserKey, html, url}`, returning
  `response.data` or throwing `response.error`.
- `extension/offscreen.js`: handles `PRAIRIERUN_PARSE` via
  `PrairieRunExt.addRuntimeMessageListener`, runs
  `PrairieRunSources.get(id).parsers[name](doc, url)`, replies
  `{ok:true, data}` (JSON round-tripped) or `{ok:false, error}`.
  Never fetches.
- `extension/compat.js`: added `offscreenEnsure()` (Chrome only; memoized,
  tolerates an already-existing document; Firefox resolves immediately),
  `addStartupListener`, `addInstalledListener`,
  `permissionsContains(origins)`, `permissionsRequest(origins)`, and
  `tabsCreateForeground(url)`.
- `extension/sync-orchestrator.js`: same contract
  (`runSync → adapter.sync → mergeSourceResults → save → Outputs.run`).
  Added a session-storage lease (`prairierunSyncLease`, 5 min TTL) plus an
  in-process guard; concurrent calls return `{skipped:"locked"}`.
  `resetBudgets()` per run. Missing host permission → `disabled` with
  `error:"permission"` (adapter never runs). `ctx.fetchPage` is wrapped so
  every response is seen; `adapter.isSignedOut(lastFetch)` plus a generic
  cross-host-redirect check (login bounces leave the adapter origins)
  produce `signed_out`. `prairierunSourceStatus[id]` is
  `{status, error, checkedAt, signInUrl}`.
- `extension/background.js`: `prairierun-sync` alarm with
  `periodInMinutes: settings.syncIntervalMinutes || 60` (default 60 added
  to `defaultSettings`), recreated when the setting changes; `onStartup` /
  `onInstalled` ensure the alarm and run one sync; `PRAIRIERUN_SYNC_NOW`
  `{sources?}` runs a sync and responds with the summary;
  `PRAIRIERUN_GET_STATE` also returns `sourceStatus` and the source
  `{id, label, origins, signInUrl}` list. Tab-based PL scan and the daily
  Calendar alarm are untouched.
- Popup: new Sources card lists one row per source (label, chip, last
  checked in Central) with `Sign in to X` (`tabsCreateForeground`) for
  `signed_out`, `Grant access` (`permissionsRequest`, from the click
  gesture) for `needs permission`, and a `Sync now` button. Labels come
  from `GET_STATE`, so no new `<script>` tags. Refreshes on
  `prairierunSourceStatus` changes.

## Tests

- `stage0/test-net.js`: POST throws; unsafe PL URL throws before fetch;
  same-origin spacing (fake timers); result has final url + redirected;
  `redactUrl` case; extended origins fetchable / unknown origin throws;
  40-request budget + reset.
- `stage0/test-orchestrator.js`: lease blocks concurrent runs; expired
  lease takeover; cross-host redirect → `signed_out` with previous items
  retained (real deadline-store merge); missing permission → `disabled`
  without adapter call; adapter-reported `signed_out` preserved.
- `stage0/test-parse-host.js`: linkedom `DOMParser`; registered parser
  receives a Document; unknown source/parser/key rejected.
- `npm test` green (60 pass, 2 pre-existing capture skips);
  `node build-manifest.js --target=chrome --check` passes.

## For PR 10 / follow-ups

- No shared load-list or manifest changes were needed (PR 1 preloaded
  everything; the offscreen permission is already in the base manifest).
- Manual pass still needed: reload unpacked in Chrome (offscreen doc
  created once, Sync now with no PL tab, popup chips/times) and Firefox
  temporary add-on (in-place parsing, no offscreen), plus the Firefox OAuth
  client per `extension/google-calendar-setup.md`.
- PR 3 replaces the tab-based PL scan with orchestrator fetching; until
  then both paths write `prairierunDeadlines`.

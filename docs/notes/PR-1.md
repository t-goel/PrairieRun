# PR 1 scaffold notes

Scaffold multi-source sync: DeadlineItem model, source registry, module stubs.

- No behavior change: PL scanning, panel, and Google sync work as before.
- `prairierunAssignments` stays authoritative; `saveScanResult` also mirrors
  `prairierunDeadlines` via `PrairieRunModel.fromLegacyPlAssignment`.
- `oauth-config.js` / `auth-utils.js` content matches `origin/user-auth`
  (PR 0 owns them). They are referenced by the final load lists so
  `test-scaffold.js` stays green before/after stacking onto `pr0-google-auth`.
- Firefox manifest drops `offscreen` and merges `optional_host_permissions`
  into `host_permissions` (verify on 115 ESR + current Firefox).
- Timezone: `localToUtc` handles abbreviations via fixed offsets and IANA via
  `Intl.DateTimeFormat` iteration (covers the 2026-11-01 CDT->CST switch).
- Safety: `assertSafeUrl` allows only `/pl`, `/pl/course_instance/<ci>`,
  `/assessments`, `/assessment_instance/<iid>`, and the
  `__prairierun_identity__` probe. Start routes (with/without slash/query)
  throw `SafetyError`. `fetchPage` enforces GET.
- Stacking: branch `pr1-scaffold` stacks onto `pr0-google-auth`. Expected
  conflict on rebase is only the `importScripts` /
  `FIREFOX_BACKGROUND_SCRIPTS` lists; keep PR 1's full list.

Tests: `npm test` green (46 pass, 2 skip for missing gitignored capture).
`node build-manifest.js --target=chrome --check` passes.
Manual: reload unpacked in Chrome + Firefox temporary add-on; confirm panel
and Google sync unchanged and `prairierunDeadlines` appears after a scan.

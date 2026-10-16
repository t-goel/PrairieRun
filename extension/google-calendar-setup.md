# Google Calendar setup for PrairieRun

PrairieLearn scanning and the embedded assignment panel work without Google OAuth. Calendar sync needs a Google Cloud (GCP) project you own with the Calendar API enabled.

Decision: use a new PrairieRun GCP project owned by the current maintainer (not the original author's project). End users never touch this setup; they install the extension and click Connect.

## One-time owner setup (do this once)

1. Create a new GCP project (e.g. `prairierun`).
2. Enable the Google Calendar API (APIs & Services → Library).
3. Configure the OAuth consent screen:
   - App name, support email, homepage URL, privacy policy URL (required for verification).
   - Scope: `https://www.googleapis.com/auth/calendar` (full calendar scope — required for per-class calendar creation via `calendars.insert` + `calendarList.list`; the narrower `calendar.events` scope cannot create calendars).
   - Stay in Testing mode while developing; move to Production + verification before inviting real users.
4. Create an OAuth client: APIs & Services → Credentials → Create Credentials → OAuth client ID → Application type: Chrome Extension. Enter the extension ID from `chrome://extensions`.
5. Put the client ID in one place: `extension/oauth-config.js` (`PrairieRunOAuthConfig.clientId`). That is the only per-project code change. No secret belongs in the repo; the client ID is public. Never commit tokens.
6. Reload the extension (`chrome://extensions` → Reload) and open PrairieLearn. Scans run automatically; sync waits for Connect (see End-user flow below).

## Testing mode vs Production (important for real users)

- Testing mode: only Google accounts you add under "Test users" can consent, and grants expire after ~7 days (re-consent is normal). Good for the two developers, unusable for real users.
- Production (verified): any Google account can connect and grants persist. Requires sensitive-scope review for the `calendar` scope, brand verification, and a privacy policy. Plan this before inviting non-technical users.

## Two developers, one client (fix for redirect_uri_mismatch)

Each `Load unpacked` install has its own extension ID, and the redirect URI looks like `https://<extension-id>.chromiumapp.org/oauth2`. If that URI isn't registered on the OAuth client, Google fails with `redirect_uri_mismatch`.

Preferred fix (one time): share one stable extension ID via manifest `key` pinning:

1. One developer copies the `key` value from their installed manifest (or packs once to generate a `.pem`, keeping the `.pem` private and out of git).
2. Add that `key` to `extension/manifest.json` and commit it (the `key` is public; the `.pem` stays private — see `extension/key.pem` staying gitignored).
3. Both developers reload: `chrome://extensions` now shows the same ID, so the single Chrome-extension OAuth client covers both checkouts.

Fallback (no shared key): create one Chrome-extension OAuth client per developer extension ID inside the same GCP project. Each checkout then sets its own client ID in `extension/oauth-config.js` as a local-only change (don't commit the other dev's ID). Prefer the shared `key` so both checkouts use the one committed client ID.

When a mismatch still happens, the popup shows a human-readable error with the exact redirect URI and a Copy button ("Having trouble connecting?"). Paste that URI into the client's allowed list, reload, and Connect again.

## End-user flow (nothing to configure)

1. Install the extension (production build already contains the production client ID).
2. Click the extension icon → Connect Google Calendar (or use Connect in the PrairieRun panel on PrairieLearn).
3. Grant Calendar access with their own Google account.
4. Status shows `Connected, expires <time>`. The token lives only in session/memory and silently reuses until expiry; re-prompts happen only on expiry, revocation, or Disconnect — not every export. On Calendar 401, the cached token is cleared once and retried with a fresh token.
5. Disconnect any time from the popup or panel: this revokes the token at `https://oauth2.googleapis.com/revoke` and clears the cached session token.
6. Cancellation (`authorization cancelled`) is reported as "Sign-in was cancelled, click Connect to try again" — distinct from configuration errors.
7. Background runs never open a Google window. With session storage cleared, the daily alarm and automatic scans record `auth_required` ("Connect Google Calendar to sync.") and the popup offers Connect. Only the Connect button uses interactive auth.

## Brave note

Brave uses the Chrome OAuth client. It must not be routed through the Firefox-only `googleClientId` path; that path is only for Firefox builds. In Brave, allow cookies for `accounts.google.com` and `googleapis.com` if sign-in prompts recur.

## Scope justification (for verification)

PrairieRun keeps the full `calendar` scope because it creates one calendar per class (`POST /calendars`), lists writable calendars, reads event colors, and inserts/updates/deletes events with duplicate-prevention markers. Narrowing to `calendar.events` later would mean giving up per-class calendars (sync to one user-picked calendar instead) and re-testing creation, lookup, colors, and dedup.

## Firefox OAuth setup

Firefox cannot reuse the Chrome-extension-type OAuth client: its redirect origin is `https://<add-on-id>.extensions.allizom.org/...` (or the signed AMO variant), not `https://<id>.chromiumapp.org/oauth2`, and Google will reject the mismatched redirect. Firefox needs a **separate** OAuth client.

1. Build and temporary-load the Firefox distribution: `node build-manifest.js --target=firefox`, then `about:debugging → This Firefox → Load Temporary Add-on` with any file in `dist-firefox/`. The pinned `gecko.id` in the generated manifest keeps the add-on ID (and therefore the redirect URI) stable across temporary installs.
2. Spike: in the Firefox extension console, log the exact redirect URI: `browser.identity.getRedirectURL("oauth2")`. This one value decides the registration below; also confirm `browser.storage.session` exists on your target Firefox version (115+ desktop expected).
3. In the same Google Cloud project, create a separate OAuth client for Firefox. If Google accepts the `extensions.allizom.org` redirect from step 2, register it as a Web-application-type client with that exact redirect URI; otherwise use the documented loopback form (`http://127.0.0.1/mozoauth2/...`, Firefox 86+). Do not reuse the Chrome-extension-type client.
4. Point the Firefox build at the new client by storing its ID in extension settings as `googleClientId` (for example, from the background-page console: `await browser.storage.local.set({ prairierunSettings: { ...(await browser.storage.local.get("prairierunSettings")).prairierunSettings, googleClientId: "YOUR-FIREFOX-CLIENT-ID" } })`). A popup settings field for this is deferred — issue #6 remains open.
5. Verify in Firefox: Connect via the popup/panel, no re-prompt on every export (token cache hit), re-prompt after expiry, per-class calendar creation, grey-completed vs. class-color events, and duplicate-safe updates via the `extendedProperties` marker.

Token hygiene is the same in both browsers: access tokens live in `storage.session` with an in-memory fallback for the browser session and are never written to `storage.local`.

Supersedes PR #4 (`user-auth` branch): Firefox support already landed via PR #1, so only the auth work (oauth-config, auth-utils, Connect/Disconnect, 401 retry, no background interactive auth) is taken here. Issue #6 (Firefox client-ID settings UI) stays open.

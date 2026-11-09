# Google Calendar setup for PrairieRun

PrairieLearn scanning and the embedded assignment panel can be tested without Google OAuth. To enable automatic Calendar synchronization:

1. Create or select a Google Cloud project.
2. Enable the Google Calendar API.
3. Configure the OAuth consent screen for the test account.
4. Create a Chrome Extension OAuth client using the unpacked extension ID shown in `chrome://extensions`.
5. Add the OAuth client ID and exact `chromiumapp.org` redirect URI to the extension's OAuth flow configuration.
6. Reload the extension and open PrairieLearn. A scan runs automatically; the first actionable assignment synchronization will request consent.

Required scope for the automatic synchronization flow:

```text
https://www.googleapis.com/auth/calendar
```

Do not commit client secrets or tokens. Chrome extension OAuth uses the public client ID; the user's Google password and refresh credentials must never be stored by PrairieRun.

PrairieRun caches the temporary Google access token in Chrome's session storage and first attempts silent authorization. You normally should not be prompted on every export. The token expires periodically, so Google may still ask for authorization again after expiration, after clearing extension data, or if Brave blocks the Google sign-in session. In Brave, allow cookies for `accounts.google.com` and `googleapis.com` if prompts recur.

Brave uses the Chrome OAuth client. It must not be routed through the
Firefox-only `googleClientId` path; that path is only for Firefox builds.

## Firefox OAuth setup

Firefox cannot reuse the Chrome-extension-type OAuth client: its redirect
origin is `https://<add-on-id>.extensions.allizom.org/...` (or the signed
AMO variant), not `https://<id>.chromiumapp.org/oauth2`, and Google will
reject the mismatched redirect. Firefox needs a **separate** OAuth client.

1. Build and temporary-load the Firefox distribution:
   `node build-manifest.js --target=firefox`, then `about:debugging → This
   Firefox → Load Temporary Add-on` with any file in `dist-firefox/`.
   The pinned `gecko.id` in the generated manifest keeps the add-on ID (and
   therefore the redirect URI) stable across temporary installs.
2. Spike: in the Firefox extension console, log the exact redirect URI:
   `browser.identity.getRedirectURL("oauth2")`. This one value decides the
   registration below; also confirm `browser.storage.session` exists on your
   target Firefox version (115+ desktop expected).
3. In the same Google Cloud project, create a separate OAuth client for
   Firefox. If Google accepts the `extensions.allizom.org` redirect from
   step 2, register it as a Web-application-type client with that exact
   redirect URI; otherwise use the documented loopback form
   (`http://127.0.0.1/mozoauth2/...`, Firefox 86+). Do not reuse the
   Chrome-extension-type client.
4. Point the Firefox build at the new client by storing its ID in extension
   settings as `googleClientId` (for example, from the background-page
   console: `await browser.storage.local.set({ prairierunSettings:
   { ...(await browser.storage.local.get("prairierunSettings")).prairierunSettings,
   googleClientId: "YOUR-FIREFOX-CLIENT-ID" } })`). A popup settings field
   for this is deferred to the settings-plan follow-up.
5. Verify in Firefox: consent popup on first sync, no re-prompt on every
   export (token cache hit), re-prompt after expiry, per-class calendar
   creation, grey-completed vs. class-color events, and duplicate-safe
   updates via the `extendedProperties` marker.

Token hygiene is the same in both browsers: access tokens live in
`storage.session` with an in-memory fallback for the browser session and are
never written to `storage.local`.

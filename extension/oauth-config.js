// PrairieRun Google OAuth client configuration.
//
// One-time developer setup (not end-user setup): replace CLIENT_ID with the
// Chrome-extension OAuth client ID from the PrairieRun GCP project you own.
// End users never edit this file -- production builds ship with the
// production client ID already in place, and users just click Connect.
//
// The value below is the original author's development client. It only works
// with redirect URIs registered on that GCP project, so a fresh checkout
// with a different unpacked extension ID will fail with
// redirect_uri_mismatch until CLIENT_ID points at your own project (see
// extension/google-calendar-setup.md). No client secret belongs here: Chrome
// extension OAuth uses the public client ID only. Never commit tokens.
(function () {
  globalThis.PrairieRunOAuthConfig = {
    clientId: "284599557855-m80j0r9kf52uou6n232ekslrrrpmdc9r.apps.googleusercontent.com",
  };
})();

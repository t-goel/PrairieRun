// Pure Google auth error helpers. No chrome APIs, so this file loads both in
// the extension (via importScripts) and in Node unit tests.
(function () {
  function classifyAuthError(input) {
    const message = String(input?.message || input || "").toLowerCase();
    if (!message) return "other";
    if (message.includes("redirect_uri_mismatch") || (message.includes("redirect") && message.includes("mismatch"))) {
      return "redirect_mismatch";
    }
    if (message.includes("invalid_client")) return "invalid_client";
    if (
      message.includes("cancel") ||
      message.includes("user closed") ||
      message.includes("user dismissed") ||
      message.includes("authorization was cancelled")
    ) {
      return "cancelled";
    }
    if (
      message.includes("(401)") ||
      (message.includes("401") && message.includes("calendar")) ||
      message.includes("invalid_credentials") ||
      message.includes("invalid_grant") ||
      message.includes("token expired") ||
      message.includes("token has expired") ||
      message.includes("unauthorized")
    ) {
      return "unauthorized";
    }
    return "other";
  }

  function formatAuthError(kind, details = {}) {
    const redirectUri = details.redirectUri ? ` Exact redirect URI for this install: ${details.redirectUri}` : "";
    switch (kind) {
      case "redirect_mismatch":
        return (
          "This install's extension ID + redirect URI isn't registered on the Google OAuth client." +
          " Open extension/google-calendar-setup.md, add the redirect URI to the OAuth client, then reload the extension." +
          redirectUri
        );
      case "invalid_client":
        return (
          "The configured Google OAuth client ID is wrong or not a Chrome-extension client." +
          " Check extension/oauth-config.js points at your GCP project's client ID, then reload the extension." +
          redirectUri
        );
      case "cancelled":
        return "Google sign-in was cancelled. Click Connect Google Calendar to try again.";
      case "unauthorized":
        return "Google rejected the saved sign-in (expired or revoked). Click Connect Google Calendar to sign in again.";
      default:
        return details.message || "Google sign-in failed. Try Connect again.";
    }
  }

  const api = { classifyAuthError, formatAuthError };
  globalThis.PrairieRunAuthUtils = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

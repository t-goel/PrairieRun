const assert = require("node:assert/strict");
const test = require("node:test");
const { classifyAuthError, formatAuthError } = require("../extension/auth-utils.js");

test("mismatch, invalid_client, cancellation, and expiry classify distinctly", () => {
  assert.equal(classifyAuthError("Error: redirect_uri_mismatch"), "redirect_mismatch");
  assert.equal(classifyAuthError("The redirect URI in the request is not registered (mismatch)."), "redirect_mismatch");
  assert.equal(classifyAuthError("invalid_client: unauthorized"), "invalid_client");
  assert.equal(classifyAuthError("Google authorization was cancelled."), "cancelled");
  assert.equal(classifyAuthError("User closed the popup"), "cancelled");
  assert.equal(classifyAuthError("Google Calendar request failed (401): invalid credentials"), "unauthorized");
  assert.equal(classifyAuthError("Token has expired"), "unauthorized");
  assert.equal(classifyAuthError("some network flake"), "other");
});

test("mismatch and cancellation messages stay human-readable", () => {
  const mismatch = formatAuthError("redirect_mismatch", { redirectUri: "https://abc.chromiumapp.org/oauth2" });
  assert.match(mismatch, /redirect URI/i);
  assert.match(mismatch, /abc\.chromiumapp\.org/);
  assert.match(formatAuthError("cancelled"), /cancelled.*Connect/i);
  assert.match(formatAuthError("unauthorized"), /sign in again/i);
});

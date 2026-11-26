// PrairieRun Convex Feed Auth: Multi-device feed identity client.
//
// Authenticates via Convex Auth (Google) and synchronizes feed identity
// across devices. All extension APIs go through PrairieRunExt.
(function () {
  const SETTINGS_KEY = "prairierunSettings";
  const SECRETS_KEY = "prairierunSecrets";
  const FEED_AUTH_KEY = "prairierunFeedAuth";
  const SESSION_TOKEN_KEY = "prairierunFeedAuthToken";

  const DEFAULT_CONVEX_SITE_URL = "https://moonlit-mink-208.convex.site";
  const DEFAULT_CONVEX_CLOUD_URL = "https://moonlit-mink-208.convex.cloud";
  const DEFAULT_RELAY_URL = "https://prairierun-feed.vercel.app";

  // A disabled Convex deployment answers every request with an opaque
  // `[Request ID: ...] Server Error`. Treat that (and network failure) as an
  // outage: return a result instead of throwing, show it in the dashboard, and
  // leave locally stored feed data untouched so the ICS feed keeps working.
  const OUTAGE_RE = /exceeded the free plan limits|deployments? (?:have been |has been )?disabled|Server Error|Request ID/i;
  const NETWORK_RE = /failed to fetch|networkerror|load failed|could not reach|timeout|aborted/i;
  const OUTAGE_MESSAGE = "Live feed sync is paused: the PrairieRun sign-in service is unavailable. Your existing feed keeps working.";
  const NETWORK_MESSAGE = "Could not reach the PrairieRun sign-in service. Your existing feed keeps working.";

  const outageState = { active: false, message: null, reason: null, checkedAt: 0 };
  const outageListeners = new Set();

  function ext() {
    return globalThis.PrairieRunExt || null;
  }

  // Classify a Convex failure without ever throwing. Raw request IDs and stack
  // detail never reach the UI; callers get one short, actionable sentence.
  function classifyConvexFailure(error) {
    const text = String(error?.message || error || "");
    if (NETWORK_RE.test(text)) {
      return { outage: true, message: NETWORK_MESSAGE };
    }
    if (OUTAGE_RE.test(text)) {
      return { outage: true, message: OUTAGE_MESSAGE };
    }
    return {
      outage: false,
      message: text.trim() && text.length <= 160 ? text.trim() : "Something went wrong. Try again in a minute.",
    };
  }

  function emitOutage() {
    const snapshot = getOutageState();
    for (const listener of [...outageListeners]) {
      try {
        listener(snapshot);
      } catch { /* listeners are best effort */ }
    }
  }

  function getOutageState() {
    return {
      active: outageState.active,
      message: outageState.message,
      reason: outageState.reason,
      checkedAt: outageState.checkedAt,
    };
  }

  function reportOutage(error, fallbackMessage) {
    const info = classifyConvexFailure(error);
    if (info.outage) {
      outageState.active = true;
      outageState.message = fallbackMessage || info.message;
      outageState.reason = String(error?.message || error || "");
      outageState.checkedAt = Date.now();
      emitOutage();
    }
    return info;
  }

  function clearOutage() {
    if (!outageState.active) return;
    outageState.active = false;
    outageState.message = null;
    outageState.reason = null;
    outageState.checkedAt = Date.now();
    emitOutage();
  }

  function subscribeToOutage(listener) {
    if (typeof listener !== "function") return () => {};
    outageListeners.add(listener);
    return () => outageListeners.delete(listener);
  }

  // The shared non-throwing boundary for Convex calls. `call` is a zero-arg
  // function so callers can pass either an action or a mutation. Success and
  // failure both come back as data; UI code never needs a try/catch.
  async function safeConvexRequest(call, fallbackMessage) {
    try {
      const data = await call();
      return { ok: true, data };
    } catch (error) {
      const info = reportOutage(error, fallbackMessage);
      return { ok: false, outage: info.outage, error: info.message };
    }
  }

  function resolveConvexUrls(input) {
    const raw = String(input || "").trim().replace(/\/+$/, "");
    if (!raw) {
      return {
        siteUrl: DEFAULT_CONVEX_SITE_URL,
        cloudUrl: DEFAULT_CONVEX_CLOUD_URL,
      };
    }
    let url;
    try {
      url = new URL(raw);
    } catch {
      return {
        siteUrl: DEFAULT_CONVEX_SITE_URL,
        cloudUrl: DEFAULT_CONVEX_CLOUD_URL,
      };
    }

    const host = url.hostname;
    if (host.endsWith(".convex.site")) {
      const base = host.slice(0, -".convex.site".length);
      return {
        siteUrl: `${url.protocol}//${host}`,
        cloudUrl: `${url.protocol}//${base}.convex.cloud`,
      };
    }
    if (host.endsWith(".convex.cloud")) {
      const base = host.slice(0, -".convex.cloud".length);
      return {
        siteUrl: `${url.protocol}//${base}.convex.site`,
        cloudUrl: `${url.protocol}//${host}`,
      };
    }

    return {
      siteUrl: `${url.protocol}//${host}`,
      cloudUrl: `${url.protocol}//${host}`,
    };
  }

  function getRedirectUrl() {
    const api = ext();
    if (api && typeof api.identityGetRedirectURL === "function") {
      try {
        const u = api.identityGetRedirectURL("convex");
        if (u) return u;
      } catch { /* fall through */ }
      try {
        const u = api.identityGetRedirectURL();
        if (u) return u;
      } catch { /* fall through */ }
    }
    return `https://${api?.runtime?.id || "prairierun"}.chromiumapp.org/convex`;
  }

  async function callConvexAction(cloudUrl, path, args) {
    const response = await fetch(`${cloudUrl}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path,
        args,
        format: "json",
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Convex action ${path} failed (${response.status}): ${body.slice(0, 150)}`);
    }
    const data = await response.json();
    if (data.status === "error") {
      throw new Error(data.errorMessage || `Convex action ${path} failed.`);
    }
    return data.value !== undefined ? data.value : data;
  }

  async function callConvexMutation(cloudUrl, token, path, args) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const response = await fetch(`${cloudUrl}/api/mutation`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        path,
        args,
        format: "json",
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Convex mutation ${path} failed (${response.status}): ${body.slice(0, 150)}`);
    }
    const data = await response.json();
    if (data.status === "error") {
      throw new Error(data.errorMessage || `Convex mutation ${path} failed.`);
    }
    return data.value !== undefined ? data.value : data;
  }

  async function signInWithGoogle({ convexUrl } = {}) {
    const api = ext();
    if (!api || typeof api.identityLaunchWebAuthFlow !== "function") {
      throw new Error("Web authentication flow is unavailable in this environment.");
    }
    const { siteUrl, cloudUrl } = resolveConvexUrls(convexUrl);
    const redirectUrl = getRedirectUrl();

    const signinUrl = new URL(`${siteUrl}/api/auth/signin/google`);
    signinUrl.searchParams.set("redirectTo", redirectUrl);

    let responseUrl;
    try {
      responseUrl = await api.identityLaunchWebAuthFlow({
        url: signinUrl.toString(),
        interactive: true,
      });
    } catch (err) {
      const msg = String(err?.message || err || "");
      if (/user closed|cancelled|user dismissed|window was closed/i.test(msg)) {
        throw new Error("Google sign-in was cancelled.");
      }
      throw err;
    }

    if (!responseUrl) {
      throw new Error("Google sign-in was cancelled or returned no response.");
    }

    const parsed = new URL(responseUrl);
    const code = parsed.searchParams.get("code");
    if (!code) {
      const errParam = parsed.searchParams.get("error_description") || parsed.searchParams.get("error");
      throw new Error(errParam ? `Sign-in failed: ${errParam}` : "Convex did not return an authorization code.");
    }

    // Exchange the verification code for session tokens
    const exchange = await callConvexAction(cloudUrl, "auth:signIn", {
      params: { code },
      provider: "google",
    });

    const token = exchange?.tokens?.token || exchange?.token;
    if (!token) {
      throw new Error("Convex Auth did not return a session token.");
    }

    return { token, cloudUrl, siteUrl };
  }

  // Never reject to callers: a disabled backend must leave the local feed
  // intact and report a degraded result the dashboard can display.
  async function authenticateAndHydrate(options = {}) {
    try {
      return await hydrateFeedAuth(options);
    } catch (error) {
      const info = reportOutage(error);
      return { ok: false, degraded: true, outage: info.outage, error: info.message };
    }
  }

  async function hydrateFeedAuth({ convexUrl, relayUrl } = {}) {
    const api = ext();
    if (!api) throw new Error("PrairieRunExt is unavailable.");

    const { token, cloudUrl } = await signInWithGoogle({ convexUrl });

    // Read existing local settings & secrets to see if we have an anonymous feed to migrate
    const stored = (await api.storageLocalGet?.([SETTINGS_KEY, SECRETS_KEY])) || {};
    const settings = stored[SETTINGS_KEY] && typeof stored[SETTINGS_KEY] === "object" ? stored[SETTINGS_KEY] : {};
    const secrets = stored[SECRETS_KEY] && typeof stored[SECRETS_KEY] === "object" ? stored[SECRETS_KEY] : {};

    const currentRelay = settings.relay && typeof settings.relay === "object" ? settings.relay : {};
    const legacyFeedId = currentRelay.feedId;
    const legacyKey = secrets.relayPublishKey;
    const isAnonymous = Boolean(legacyFeedId && legacyKey && !currentRelay.authAccount);

    let feedData;
    let migrated = false;

    if (isAnonymous) {
      // First sign-in: attempt to adopt existing anonymous feed
      try {
        const linkResult = await callConvexMutation(cloudUrl, token, "feeds:linkLegacyFeed", {
          legacyFeedId,
          legacyKey,
        });
        feedData = linkResult;
        migrated = Boolean(linkResult.migrated);
      } catch (_err) {
        // If legacy linking fails (e.g. key mismatch or conflict), fall back to getOrCreateFeed
        feedData = await callConvexMutation(cloudUrl, token, "feeds:getOrCreateFeed", {});
      }
    } else {
      // Second device or new activation: load or create feed for signed-in user
      feedData = await callConvexMutation(cloudUrl, token, "feeds:getOrCreateFeed", {});
    }

    const feedId = feedData?.feedId;
    const key = feedData?.key;
    if (!feedId || !key) {
      throw new Error("Convex backend did not return feed credentials.");
    }

    // Hydrate local relay settings & secrets
    const nextRelay = {
      ...currentRelay,
      enabled: true,
      feedId,
      relayUrl: currentRelay.relayUrl || relayUrl || DEFAULT_RELAY_URL,
      authAccount: "google",
    };
    await api.storageLocalSet?.({
      [SETTINGS_KEY]: { ...settings, relay: nextRelay },
      [SECRETS_KEY]: { ...secrets, relayPublishKey: key },
      [FEED_AUTH_KEY]: {
        signedIn: true,
        authAccount: "google",
        signedInAt: Date.now(),
      },
    });

    // Save session token in memory / storage.session (never storage.local per AGENTS.md)
    if (typeof api.setSessionValue === "function") {
      try {
        await api.setSessionValue(SESSION_TOKEN_KEY, token);
      } catch { /* best effort */ }
    }

    return {
      ok: true,
      feedId,
      key,
      migrated,
      relayUrl: nextRelay.relayUrl,
    };
  }

  // Re-read feed credentials with the cached session token (no Google popup).
  // Used when a signed-in publish fails with a stale key. On a Convex outage it
  // returns a result object and does not touch the existing feed credentials,
  // so options-feed.js can fall back to the anonymous relay path.
  async function refreshFeedCredentials({ convexUrl, relayUrl } = {}) {
    const api = ext();
    if (!api) return { ok: false, error: "PrairieRun is unavailable in this context." };
    if (typeof api.getSessionValue !== "function") {
      return { ok: false, error: "Sign in with Google to refresh your feed." };
    }

    let token;
    try {
      token = await api.getSessionValue(SESSION_TOKEN_KEY);
    } catch {
      return { ok: false, error: "Could not read your sign-in session." };
    }
    if (!token) return { ok: false, error: "Sign in with Google to refresh your feed." };

    const { cloudUrl } = resolveConvexUrls(convexUrl);
    const result = await safeConvexRequest(
      () => callConvexMutation(cloudUrl, token, "feeds:getOrCreateFeed", {}),
      "Could not refresh your feed. Your existing feed stays available."
    );
    if (!result.ok) {
      return { ok: false, degraded: true, outage: Boolean(result.outage), error: result.error };
    }

    const feedId = result.data?.feedId;
    const key = result.data?.key;
    if (!feedId || !key) {
      return { ok: false, error: "The feed service did not return credentials. Your existing feed stays available." };
    }

    try {
      const stored = (await api.storageLocalGet?.([SETTINGS_KEY, SECRETS_KEY])) || {};
      const settings = stored[SETTINGS_KEY] && typeof stored[SETTINGS_KEY] === "object" ? stored[SETTINGS_KEY] : {};
      const secrets = stored[SECRETS_KEY] && typeof stored[SECRETS_KEY] === "object" ? stored[SECRETS_KEY] : {};
      const currentRelay = settings.relay && typeof settings.relay === "object" ? settings.relay : {};
      const nextRelay = {
        ...currentRelay,
        enabled: true,
        feedId,
        relayUrl: currentRelay.relayUrl || relayUrl || DEFAULT_RELAY_URL,
        authAccount: "google",
      };
      await api.storageLocalSet?.({
        [SETTINGS_KEY]: { ...settings, relay: nextRelay },
        [SECRETS_KEY]: { ...secrets, relayPublishKey: key },
        [FEED_AUTH_KEY]: {
          signedIn: true,
          authAccount: "google",
          signedInAt: Date.now(),
        },
      });
      clearOutage();
      return { ok: true, feedId, key, relayUrl: nextRelay.relayUrl };
    } catch (error) {
      const info = reportOutage(error);
      return { ok: false, degraded: true, outage: info.outage, error: info.message };
    }
  }

  async function signOut({ convexUrl } = {}) {
    const api = ext();
    if (!api) return { ok: true };

    const { cloudUrl } = resolveConvexUrls(convexUrl);

    // Attempt server sign-out if token is in session
    if (typeof api.getSessionValue === "function") {
      try {
        const token = await api.getSessionValue(SESSION_TOKEN_KEY);
        if (token) {
          await callConvexAction(cloudUrl, "auth:signOut", {}).catch(() => {});
        }
      } catch { /* best effort */ }
    }

    // Clear session token
    if (typeof api.removeSessionValue === "function") {
      try {
        await api.removeSessionValue(SESSION_TOKEN_KEY);
      } catch { /* best effort */ }
    }

    // Update settings: remove authAccount tag from relay settings
    const stored = (await api.storageLocalGet?.([SETTINGS_KEY, FEED_AUTH_KEY])) || {};
    const settings = stored[SETTINGS_KEY] && typeof stored[SETTINGS_KEY] === "object" ? stored[SETTINGS_KEY] : {};
    if (settings.relay && typeof settings.relay === "object") {
      const nextRelay = { ...settings.relay };
      delete nextRelay.authAccount;
      await api.storageLocalSet?.({ [SETTINGS_KEY]: { ...settings, relay: nextRelay } });
    }

    // Clear feed auth record
    try {
      await api.storageLocalSet?.({ [FEED_AUTH_KEY]: { signedIn: false } });
    } catch { /* best effort */ }

    return { ok: true };
  }

  async function getAuthStatus() {
    const api = ext();
    if (!api) return { signedIn: false };
    const stored = (await api.storageLocalGet?.([SETTINGS_KEY, FEED_AUTH_KEY])) || {};
    const settings = stored[SETTINGS_KEY] && typeof stored[SETTINGS_KEY] === "object" ? stored[SETTINGS_KEY] : {};
    const authState = stored[FEED_AUTH_KEY] && typeof stored[FEED_AUTH_KEY] === "object" ? stored[FEED_AUTH_KEY] : {};
    const relay = settings.relay && typeof settings.relay === "object" ? settings.relay : {};

    const signedIn = Boolean(authState.signedIn && relay.authAccount === "google");
    return {
      signedIn,
      authAccount: relay.authAccount || null,
      feedId: relay.feedId || null,
      relayUrl: relay.relayUrl || DEFAULT_RELAY_URL,
    };
  }

  const api = {
    DEFAULT_CONVEX_SITE_URL,
    DEFAULT_CONVEX_CLOUD_URL,
    DEFAULT_RELAY_URL,
    resolveConvexUrls,
    getRedirectUrl,
    classifyConvexFailure,
    getOutageState,
    subscribeToOutage,
    clearOutage,
    safeConvexRequest,
    signInWithGoogle,
    authenticateAndHydrate,
    refreshFeedCredentials,
    signOut,
    getAuthStatus,
    callConvexAction,
    callConvexMutation,
  };

  globalThis.PrairieRunFeedAuth = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

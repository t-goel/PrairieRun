// PrairieRun Calendar feed card: multi-device Convex Auth (Google) activation,
// one-click anonymous feed activation fallback, collapsed custom-relay form,
// on-demand publishing, and the stable subscription URL.
// The feed auto-updates after every successful source sync via outputs.js -> PrairieRunRelay.autoPublish.
// All extension APIs go through PrairieRunExt; nothing here touches chrome.*.
(function () {
  const SETTINGS_KEY = "prairierunSettings";
  const SECRETS_KEY = "prairierunSecrets";
  const DEADLINES_KEY = "prairierunDeadlines";
  const COURSE_FEEDS_KEY = "prairierunCourseFeeds";
  const FALLBACK_RELAY_URL = "https://prairierun-feed.vercel.app";
  const CLAIM_HELP = "Could not reach the PrairieRun feed relay; try again or set a custom relay below.";

  function ext() {
    return globalThis.PrairieRunExt || null;
  }
  function relay() {
    return globalThis.PrairieRunRelay || null;
  }
  function auth() {
    return globalThis.PrairieRunFeedAuth || null;
  }

  function make(tag, attrs = {}, text = null) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "className") node.className = value;
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else if (value !== null && value !== undefined) node.setAttribute(key, String(value));
    }
    if (text !== null && text !== undefined) node.textContent = text;
    return node;
  }

  // Fallback feed identity for the custom-relay path (the one-click path
  // receives a feedId from the relay's /api/claim or Convex auth instead).
  function makeFeedId() {
    let hex = "";
    try {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
        hex = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      }
    } catch { hex = ""; }
    while (hex.length < 16) hex += Math.floor(Math.random() * 16).toString(16);
    return `feed-${hex}`;
  }

  function normalizeRelayUrl(value) {
    const trimmed = String(value || "").trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    let parsed = null;
    try {
      parsed = new URL(trimmed);
    } catch {
      return "";
    }
    if (parsed.protocol !== "https:") return "";
    return `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  }

  function originOf(url) {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }

  async function loadAll() {
    const stored = (await ext()?.storageLocalGet?.([SETTINGS_KEY, SECRETS_KEY, DEADLINES_KEY])) || {};
    return {
      settings: stored[SETTINGS_KEY] && typeof stored[SETTINGS_KEY] === "object" ? stored[SETTINGS_KEY] : {},
      secrets: stored[SECRETS_KEY] && typeof stored[SECRETS_KEY] === "object" ? stored[SECRETS_KEY] : {},
      items: Array.isArray(stored[DEADLINES_KEY]) ? stored[DEADLINES_KEY] : [],
    };
  }

  async function writeRelaySettings(settings, patch) {
    const next = settings.relay && typeof settings.relay === "object" ? settings.relay : {};
    await ext().storageLocalSet({ prairierunSettings: { ...settings, relay: { ...next, ...patch } } });
  }

  async function writeRelayKey(secrets, key) {
    const next = { ...secrets };
    if (key) next.relayPublishKey = key;
    else delete next.relayPublishKey;
    await ext().storageLocalSet({ [SECRETS_KEY]: next });
  }

  function makeCalendarIcon() {
    if (typeof document === "undefined") return null;
    const create = typeof document.createElementNS === "function"
      ? (tag) => document.createElementNS("http://www.w3.org/2000/svg", tag)
      : (tag) => document.createElement(tag);
    const svg = create("svg");
    svg.setAttribute("class", "prr-calendar-icon");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "13");
    svg.setAttribute("height", "13");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");

    const rect = create("rect");
    rect.setAttribute("x", "2");
    rect.setAttribute("y", "3");
    rect.setAttribute("width", "12");
    rect.setAttribute("height", "11");
    rect.setAttribute("rx", "2");

    const line1 = create("line");
    line1.setAttribute("x1", "2");
    line1.setAttribute("y1", "7");
    line1.setAttribute("x2", "14");
    line1.setAttribute("y2", "7");

    const line2 = create("line");
    line2.setAttribute("x1", "5");
    line2.setAttribute("y1", "1.5");
    line2.setAttribute("x2", "5");
    line2.setAttribute("y2", "3.5");

    const line3 = create("line");
    line3.setAttribute("x1", "11");
    line3.setAttribute("y1", "1.5");
    line3.setAttribute("x2", "11");
    line3.setAttribute("y2", "3.5");

    svg.append(rect, line1, line2, line3);
    return svg;
  }

  function formatPublishedAt(timestamp) {
    if (!timestamp) return "";
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
    } catch {
      return date.toLocaleString();
    }
  }

  // Normalize prairierunCourseFeeds map -> sorted { code, url } rows for the card.
  function courseFeedEntries(map) {
    if (!map || typeof map !== "object" || Array.isArray(map)) return [];
    return Object.entries(map)
      .filter(([code, url]) => String(code || "").trim() && String(url || "").trim())
      .map(([code, url]) => ({ code: String(code).trim(), url: String(url).trim() }))
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { sensitivity: "base" }));
  }

  async function loadCourseFeeds(relayApi) {
    if (relayApi && typeof relayApi.readCourseFeeds === "function") {
      try {
        const feeds = await relayApi.readCourseFeeds();
        if (feeds && typeof feeds === "object" && !Array.isArray(feeds)) return feeds;
      } catch { /* fall through to storage */ }
    }
    try {
      const stored = (await ext()?.storageLocalGet?.([COURSE_FEEDS_KEY])) || {};
      const value = stored[COURSE_FEEDS_KEY];
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  function wireCopyButton(button, getUrl) {
    button.addEventListener("click", async () => {
      const url = typeof getUrl === "function" ? getUrl() : getUrl;
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Copy failed";
      }
      setTimeout(() => { button.textContent = "Copy"; }, 1500);
    });
  }

  async function render(section) {
    if (!section || typeof document === "undefined") return;
    section.querySelectorAll("[data-prr-feed]").forEach((node) => node.remove());
    for (const note of section.querySelectorAll("p.muted")) {
      if (/coming soon/i.test(note.textContent || "")) note.remove();
    }
    const root = make("div", { "data-prr-feed": "1" });
    section.appendChild(root);

    const relayApi = relay();
    if (!relayApi || typeof relayApi.readState !== "function") {
      root.appendChild(make("p", { className: "muted" }, "The feed module is unavailable."));
      return;
    }
    const feedAuthApi = auth();
    const defaultRelayUrl = relayApi.DEFAULT_RELAY_URL || FALLBACK_RELAY_URL;

    // Controls first, then subscription URL (+ per-course rows), then status line.
    // Heading-only chrome: no subtitle under the card h2.
    const actions = make("div", { className: "prr-feed-actions" });
    const urlRow = make("div", { className: "auth-redirect-row prr-feed-url-row", hidden: "hidden" });
    const urlLabel = make("span", { className: "prr-feed-url-label", hidden: "hidden" }, "All courses");
    const urlCode = make("code", {});
    const copyButton = make("button", { className: "secondary", type: "button" }, "Copy");
    wireCopyButton(copyButton, () => urlCode.textContent || "");
    urlRow.append(urlLabel, urlCode, copyButton);

    const courseFeedsList = make("div", {
      className: "prr-course-feeds",
      "data-prr-course-feeds": "1",
      hidden: "hidden",
    });

    const statusLine = make("p", { className: "muted", "data-prr-feed-status": "1" });

    root.append(urlRow, courseFeedsList, actions, statusLine);

    // Primary multi-device sign-in button
    const signInButton = make("button", { type: "button", className: "primary" }, "Sign in with Google");
    signInButton.addEventListener("click", async () => {
      signInButton.disabled = true;
      try {
        if (!feedAuthApi || typeof feedAuthApi.authenticateAndHydrate !== "function") {
          throw new Error("Feed authentication module is unavailable.");
        }
        statusLine.textContent = "Signing in with Google…";
        const customConvex = normalizeRelayUrl(convexInput.value);
        const customRelay = normalizeRelayUrl(urlInput.value);
        const authResult = await feedAuthApi.authenticateAndHydrate({
          convexUrl: customConvex || undefined,
          relayUrl: customRelay || undefined,
        });

        const relayUrl = authResult.relayUrl || defaultRelayUrl;
        try {
          if (!(await relayApi.hasRelayPermission(relayUrl))) {
            await ext().permissionsRequest([`${originOf(relayUrl)}/*`]);
          }
        } catch { /* CORS handles page publish */ }

        await publishNow();
      } catch (error) {
        statusLine.textContent = error?.message || "Could not sign in with Google.";
      } finally {
        signInButton.disabled = false;
      }
    });

    // Sign out button
    const signOutButton = make("button", { type: "button", className: "secondary" }, "Sign out");
    signOutButton.addEventListener("click", async () => {
      signOutButton.disabled = true;
      try {
        statusLine.textContent = "Signing out…";
        if (feedAuthApi && typeof feedAuthApi.signOut === "function") {
          const customConvex = normalizeRelayUrl(convexInput.value);
          await feedAuthApi.signOut({ convexUrl: customConvex || undefined });
        }
        await refresh();
      } catch (error) {
        statusLine.textContent = error?.message || "Could not sign out.";
      } finally {
        signOutButton.disabled = false;
      }
    });

    // One-click anonymous activation: preserves the no-account activation path
    const claimButton = make("button", { type: "button", className: "secondary" }, "Get anonymous feed URL");
    claimButton.addEventListener("click", async () => {
      claimButton.disabled = true;
      try {
        const loaded = await loadAll();
        const relaySettings = loaded.settings.relay && typeof loaded.settings.relay === "object" ? loaded.settings.relay : {};
        const savedUrl = normalizeRelayUrl(relaySettings.relayUrl);
        const base = savedUrl || defaultRelayUrl;
        const alreadyReady = Boolean(savedUrl && relaySettings.feedId && loaded.secrets.relayPublishKey);
        if (!alreadyReady) {
          statusLine.textContent = "Creating your anonymous feed…";
          const claim = await relayApi.claimFeed(base);
          if (!claim.ok) {
            statusLine.textContent = claim.error || CLAIM_HELP;
            customDetails.open = true;
            return;
          }
          await writeRelaySettings(loaded.settings, { enabled: true, relayUrl: base, feedId: claim.feedId });
          await writeRelayKey(loaded.secrets, claim.key);
        }
        try {
          if (!(await relayApi.hasRelayPermission(base))) {
            await ext().permissionsRequest([`${originOf(base)}/*`]);
          }
        } catch { /* CORS handles page publish */ }
        await publishNow();
      } catch (error) {
        statusLine.textContent = error?.message || "Could not activate anonymous feed.";
      } finally {
        claimButton.disabled = false;
      }
    });

    // Publish + off buttons (visible when configured)
    const publishButton = make("button", { type: "button", className: "secondary" }, "Publish now");
    publishButton.addEventListener("click", async () => {
      publishButton.disabled = true;
      try {
        await publishNow();
      } catch (error) {
        statusLine.textContent = error.message || "Could not publish the feed.";
      } finally {
        publishButton.disabled = false;
      }
    });

    const enableButton = make("button", { type: "button", className: "secondary" }, "Turn on auto-update");
    enableButton.addEventListener("click", async () => {
      enableButton.disabled = true;
      try {
        try {
          const url = relayInfo.relayUrl;
          if (url && !(await relayApi.hasRelayPermission(url))) {
            await ext().permissionsRequest([`${originOf(url)}/*`]);
          }
        } catch { /* CORS publishing still works */ }
        await writeRelaySettings(currentSettings, { enabled: true });
        await refresh();
      } catch (error) {
        statusLine.textContent = error.message || "Could not update the feed.";
      } finally {
        enableButton.disabled = false;
      }
    });

    const offButton = make("button", { type: "button", className: "secondary" }, "Turn off auto-update");
    offButton.addEventListener("click", async () => {
      offButton.disabled = true;
      try {
        await writeRelaySettings(currentSettings, { enabled: false });
        await refresh();
      } catch (error) {
        statusLine.textContent = error.message || "Could not update the feed.";
      } finally {
        offButton.disabled = false;
      }
    });

    // Advanced custom-relay & auth setup, collapsed by default
    const customDetails = make("details", { className: "prr-feed-custom" });
    customDetails.appendChild(make("summary", {}, "Use a custom relay / auth backend"));
    const configCover = make("div", { className: "prr-feed-config" });
    const urlInput = make("input", { type: "url", placeholder: "Feed relay URL (https://your-relay.vercel.app)", spellcheck: "false", autocomplete: "off" });
    const convexInput = make("input", { type: "url", placeholder: "Convex auth URL (https://your-app.convex.site)", spellcheck: "false", autocomplete: "off" });
    const keyInput = make("input", { type: "password", placeholder: "Manual publish key", autocomplete: "off", spellcheck: "false" });
    const configMessage = make("p", { className: "muted", "data-prr-feed-config-msg": "1" });
    const connectButton = make("button", { type: "button", className: "secondary" }, "Save & publish");

    for (const input of [urlInput, convexInput, keyInput]) {
      input.addEventListener("focus", () => { configMessage.textContent = ""; });
    }

    connectButton.addEventListener("click", async () => {
      const url = normalizeRelayUrl(urlInput.value);
      const convexUrl = normalizeRelayUrl(convexInput.value);
      const key = keyInput.value.trim();
      if (!url) {
        configMessage.textContent = "The relay URL must be an https:// address.";
        return;
      }
      if (!key) {
        configMessage.textContent = "Paste the relay's publish key.";
        return;
      }
      connectButton.disabled = true;
      let permissionHint = "";
      try {
        const [{ settings, secrets }, hasPermission] = await Promise.all([
          loadAll(),
          relayApi.hasRelayPermission(url),
        ]);
        let granted = hasPermission;
        if (!granted) {
          try {
            granted = await ext().permissionsRequest([`${originOf(url)}/*`]);
          } catch {
            granted = false;
          }
          if (!granted) permissionHint = "Relay access was not granted: publishing will only happen when you open this page and press Publish now.";
        }
        const patch = {
          relayUrl: url,
          feedId: settings.relay?.feedId || makeFeedId(),
          enabled: true,
        };
        if (convexUrl) patch.convexUrl = convexUrl;
        await writeRelaySettings(settings, patch);
        await writeRelayKey(secrets, key);
        const result = await publishNow();
        if (result.ok && permissionHint) {
          configMessage.textContent = permissionHint;
        }
      } catch (error) {
        configMessage.textContent = error.message || "Could not activate the feed.";
      } finally {
        connectButton.disabled = false;
      }
    });

    configCover.append(urlInput, convexInput, keyInput, configMessage, connectButton);
    customDetails.appendChild(configCover);
    root.appendChild(customDetails);

    let currentSettings = {};
    let relayInfo = {};
    let feedState = null;

    // Publish the stored deadlines with the key currently saved for the card
    async function publishNow() {
      statusLine.textContent = "Publishing feed…";
      await refresh();
      const latest = await loadAll();
      const result = await relayApi.publishFromUserGesture(latest.items, latest.settings, latest.secrets);
      await refresh();
      if (!result.ok && result.error) statusLine.textContent = result.error;
      return result;
    }

    function renderCourseFeeds(map) {
      const entries = courseFeedEntries(map);
      courseFeedsList.textContent = "";
      const hasCourses = entries.length > 0;
      courseFeedsList.hidden = !hasCourses;
      urlLabel.hidden = !hasCourses;
      if (!hasCourses) return;
      for (const { code, url } of entries) {
        const row = make("div", { className: "auth-redirect-row prr-course-feed-row" });
        const label = make("span", { className: "prr-course-feed-label" }, code);
        const codeEl = make("code", {});
        codeEl.textContent = url;
        const copy = make("button", { className: "secondary", type: "button" }, "Copy");
        wireCopyButton(copy, () => url);
        row.append(label, codeEl, copy);
        courseFeedsList.appendChild(row);
      }
    }

    async function refresh() {
      const [loaded, state, courseFeeds] = await Promise.all([
        loadAll(),
        relayApi.readState(),
        loadCourseFeeds(relayApi),
      ]);
      currentSettings = loaded.settings;
      relayInfo = loaded.settings.relay && typeof loaded.settings.relay === "object" ? loaded.settings.relay : {};
      feedState = state;
      const configured = Boolean(relayInfo.relayUrl && relayInfo.feedId);
      const isGoogleAuth = relayInfo.authAccount === "google";

      // The subscription URL row is shown when an actual URL exists
      const publishReady = Boolean(state?.url);
      urlRow.hidden = !publishReady;
      urlCode.textContent = publishReady ? state.url : "";
      renderCourseFeeds(publishReady ? courseFeeds : {});

      // Stale validation text never survives a refresh
      configMessage.textContent = "";

      // Only pre-fill while the fields are untouched; the user may be typing
      if (!urlInput.value) urlInput.value = relayInfo.relayUrl || "";
      if (!convexInput.value && relayInfo.convexUrl) convexInput.value = relayInfo.convexUrl;
      void feedState;

      actions.textContent = "";

      if (!configured || (state?.state === "error" && !state?.url)) {
        if (!configured) {
          // Fresh activation: show Sign in with Google (primary) and Get anonymous feed URL (secondary)
          actions.append(signInButton, claimButton);
          statusLine.textContent = "Sign in to sync your calendar feed across devices, or claim an anonymous feed.";
        } else {
          actions.appendChild(publishButton);
          if (state?.error) statusLine.textContent = state.error;
        }
        return;
      }

      if (relayInfo.enabled === true) {
        if (isGoogleAuth) {
          // Signed in with Google
          actions.append(publishButton, offButton, signOutButton);
          if (state?.state === "error" && state?.error) {
            statusLine.textContent = state.error;
          } else if (state?.publishedAt) {
            statusLine.textContent = "";
            const icon = makeCalendarIcon();
            if (icon) statusLine.appendChild(icon);
            statusLine.appendChild(document.createTextNode(`${formatPublishedAt(state.publishedAt)} • Multi-device feed active`));
          } else {
            statusLine.textContent = "Multi-device feed active. Publishes after every scan.";
          }
        } else {
          // Anonymous feed active: allow syncing to Google account or publishing
          actions.append(publishButton, offButton, signInButton);
          if (state?.state === "error" && state?.error) {
            statusLine.textContent = state.error;
          } else if (state?.publishedAt) {
            statusLine.textContent = "";
            const icon = makeCalendarIcon();
            if (icon) statusLine.appendChild(icon);
            statusLine.appendChild(document.createTextNode(`${formatPublishedAt(state.publishedAt)} (anonymous)`));
          } else {
            statusLine.textContent = "Anonymous feed active. Sign in with Google to sync across devices.";
          }
        }
      } else {
        statusLine.textContent = isGoogleAuth ? "Feed off (Google account connected)." : "Feed off.";
        actions.append(enableButton, isGoogleAuth ? signOutButton : signInButton);
      }
    }

    await refresh();
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => {
      const section = document.getElementById("calendar-feed");
      if (section) render(section);
    });
  }

  const api = { render, normalizeRelayUrl, formatPublishedAt, makeCalendarIcon, courseFeedEntries };
  globalThis.PrairieRunOptionsFeed = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

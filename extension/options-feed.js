// PrairieRun Calendar card's ICS export: one-click anonymous .ics activation,
// on-demand publishing, the stable subscription URL. Google sign-in/status/
// layout radios live in options-dashboard.js; the Google section is the other
// Calendar option and device linking is not offered here anymore.
// Feed errors stay in this section's own status line, never in the Google auth
// error slot. The feed auto-updates after every successful source sync via
// outputs.js -> PrairieRunRelay.autoPublish.
// All extension APIs go through PrairieRunExt; nothing here touches chrome.*.
(function () {
  const SETTINGS_KEY = "prairierunSettings";
  const SECRETS_KEY = "prairierunSecrets";
  const DEADLINES_KEY = "prairierunDeadlines";
  const COURSE_FEEDS_KEY = "prairierunCourseFeeds";
  const FALLBACK_RELAY_URL = "https://prairierun-feed.vercel.app";
  const CLAIM_HELP = "Could not reach the PrairieRun feed relay. Try again in a minute.";

  function isSubscriptionUrl(value) {
    const url = String(value || "").trim();
    if (!/^https:\/\//i.test(url)) return false;
    // Real calendar targets are the published blob .ics files, never the relay host.
    return /\.ics(?:$|\?)/i.test(url) || /blob\.vercel-storage\.com\/feeds\//i.test(url);
  }

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
    // Called with the dedicated mount inside the Calendar card; tolerate being
    // handed the card itself so both call shapes render into the same place.
    const mount = section.id === "calendar-feed"
      ? section
      : (section.querySelector("#calendar-feed") || section);
    mount.querySelectorAll("[data-prr-feed]").forEach((node) => node.remove());
    for (const note of mount.querySelectorAll("p.muted")) {
      if (/coming soon/i.test(note.textContent || "")) note.remove();
    }
    const root = make("div", { "data-prr-feed": "1", className: "prr-feed" });
    mount.appendChild(root);

    const relayApi = relay();
    if (!relayApi || typeof relayApi.readState !== "function") {
      root.appendChild(make("p", { className: "muted" }, "The feed module is unavailable."));
      return;
    }
    const feedAuthApi = auth();
    const defaultRelayUrl = relayApi.DEFAULT_RELAY_URL || FALLBACK_RELAY_URL;

    // ICS export: subscription URL, Copy feed URL action, and this
    // section's own status line. The Google sign-in lives in the dashboard's
    // auth controls above; device linking is not offered here.
    const actions = make("div", { className: "prr-feed-actions" });
    const urlRow = make("div", { className: "auth-redirect-row prr-feed-url-row", hidden: "hidden" });
    const urlLabel = make("span", { className: "prr-feed-url-label", hidden: "hidden" }, "All courses");
    const urlCode = make("code", {});
    urlRow.append(urlLabel, urlCode);

    const courseFeedsList = make("div", {
      className: "prr-course-feeds",
      "data-prr-course-feeds": "1",
      hidden: "hidden",
    });

    const statusLine = make("p", { className: "muted", "data-prr-feed-status": "1" });

    // The ICS option is the anonymous subscribe path: Google sign-in is the
    // other option on the Google Calendar section above; device linking is
    // not offered here.
    const label = make("p", { className: "muted calendar-feed-label" }, "Anonymous ICS export");
    root.append(label, urlRow, courseFeedsList, actions, statusLine);

    // Mint/repair feed credentials, publish, return subscription URL or "".
    async function ensureFeedUrl() {
      let loaded = await loadAll();
      const relaySettings = loaded.settings.relay && typeof loaded.settings.relay === "object" ? loaded.settings.relay : {};
      const base = normalizeRelayUrl(relaySettings.relayUrl) || defaultRelayUrl;
      const authAccount = relaySettings.authAccount === "google" ? "google" : undefined;
      const alreadyReady = Boolean(
        normalizeRelayUrl(relaySettings.relayUrl)
        && relaySettings.feedId
        && loaded.secrets.relayPublishKey
      );

      if (!alreadyReady) {
        statusLine.textContent = "Creating your feed…";
        const claim = await relayApi.claimFeed(base);
        if (!claim.ok) {
          statusLine.textContent = claim.error || CLAIM_HELP;
          return "";
        }
        await writeRelaySettings(loaded.settings, {
          enabled: true,
          relayUrl: base,
          feedId: claim.feedId,
          ...(authAccount ? { authAccount } : {}),
        });
        await writeRelayKey(loaded.secrets, claim.key);
      } else if (relaySettings.enabled !== true) {
        await writeRelaySettings(loaded.settings, { enabled: true });
      }

      try {
        if (!(await relayApi.hasRelayPermission(base))) {
          await ext().permissionsRequest([`${originOf(base)}/*`]);
        }
      } catch { /* Page publish still works via CORS */ }

      statusLine.textContent = "Publishing feed…";
      loaded = await loadAll();
      let result = await relayApi.publishFromUserGesture(loaded.items, loaded.settings, loaded.secrets);

      // Stale key after Google account linking: refresh from Convex, then hard-claim if needed.
      if (!result?.ok && /Copy feed URL|401|rejected|publish key/i.test(String(result?.error || ""))) {
        if (
          authAccount === "google"
          && feedAuthApi
          && typeof feedAuthApi.refreshFeedCredentials === "function"
        ) {
          try {
            await feedAuthApi.refreshFeedCredentials({ relayUrl: defaultRelayUrl });
            loaded = await loadAll();
            result = await relayApi.publishFromUserGesture(loaded.items, loaded.settings, loaded.secrets);
          } catch { /* fall through to re-claim */ }
        }
      }
      if (!result?.ok && /Copy feed URL|401|rejected|publish key/i.test(String(result?.error || ""))) {
        statusLine.textContent = "Repairing feed…";
        const claim = await relayApi.claimFeed(base);
        if (claim.ok) {
          loaded = await loadAll();
          await writeRelaySettings(loaded.settings, {
            enabled: true,
            relayUrl: base,
            feedId: claim.feedId,
            ...(authAccount ? { authAccount } : {}),
          });
          await writeRelayKey(loaded.secrets, claim.key);
          loaded = await loadAll();
          result = await relayApi.publishFromUserGesture(loaded.items, loaded.settings, loaded.secrets);
        }
      }

      await refresh();
      if (isSubscriptionUrl(result?.url)) return String(result.url).trim();
      if (isSubscriptionUrl(feedState?.url)) return String(feedState.url).trim();
      if (result?.error) statusLine.textContent = result.error;
      return "";
    }

    // Ensure a blob .ics URL exists (claim + publish), then copy it.
    const copyFeedButton = make("button", { type: "button", className: "secondary" }, "Copy feed URL");
    copyFeedButton.addEventListener("click", async () => {
      copyFeedButton.disabled = true;
      try {
        let url = isSubscriptionUrl(feedState?.url) ? String(feedState.url).trim() : "";
        if (!url) url = await ensureFeedUrl();
        if (!url) {
          if (!statusLine.textContent) statusLine.textContent = "Could not create your feed URL.";
          return;
        }

        try {
          await navigator.clipboard.writeText(url);
          copyFeedButton.textContent = "Copied";
        } catch {
          urlRow.hidden = false;
          urlCode.textContent = url;
          copyFeedButton.textContent = "Copy failed";
        }
        statusLine.textContent = "";
        setTimeout(() => { copyFeedButton.textContent = "Copy feed URL"; }, 1500);
      } catch (error) {
        statusLine.textContent = error?.message || "Could not copy your feed URL.";
      } finally {
        copyFeedButton.disabled = false;
      }
    });

    let relayInfo = {};
    let feedState = null;
    let autoPublishAttempted = false;

    // Publish the stored deadlines with the key currently saved for the card
    async function publishNow() {
      statusLine.textContent = "Publishing feed…";
      const latest = await loadAll();
      const result = await relayApi.publishFromUserGesture(latest.items, latest.settings, latest.secrets);
      await refresh();
      if (!result.ok && result.error) statusLine.textContent = result.error;
      return result;
    }

    function renderCourseFeeds(map) {
      const entries = courseFeedEntries(map).filter((entry) => isSubscriptionUrl(entry.url));
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
      relayInfo = loaded.settings.relay && typeof loaded.settings.relay === "object" ? loaded.settings.relay : {};
      feedState = state;
      const configured = Boolean(relayInfo.relayUrl && relayInfo.feedId && loaded.secrets.relayPublishKey);

      // Copy only ever shows a published blob .ics URL — never the relay host.
      const publishReady = isSubscriptionUrl(state?.url);
      urlRow.hidden = !publishReady;
      urlCode.textContent = publishReady ? String(state.url).trim() : "";
      renderCourseFeeds(publishReady ? courseFeeds : {});

      actions.textContent = "";
      actions.appendChild(copyFeedButton);

      const noisy = /already exists|allowOverwrite/i.test(state?.error || "");
      const showError = state?.state === "error" && state?.error && !noisy;

      if (!publishReady) {
        if (showError) {
          statusLine.textContent = state.error;
        } else if (!configured) {
          statusLine.textContent = "";
        } else if (!autoPublishAttempted) {
          autoPublishAttempted = true;
          statusLine.textContent = "Creating your feed…";
          void publishNow();
        } else {
          statusLine.textContent = "";
        }
        return;
      }

      if (showError) {
        statusLine.textContent = state.error;
      } else {
        // Success is visible via the Copy feed URL action; no extra text.
        statusLine.textContent = "";
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

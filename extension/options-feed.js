// PrairieRun Calendar feed card: configures the hosted iCal feed (relay URL +
// publish key), publishes on demand, shows the subscription URL. The feed
// auto-updates after every successful source sync via outputs.js ->
// PrairieRunRelay.autoPublish.
// All extension APIs go through PrairieRunExt; nothing here touches chrome.*.
(function () {
  const SETTINGS_KEY = "prairierunSettings";
  const SECRETS_KEY = "prairierunSecrets";
  const DEADLINES_KEY = "prairierunDeadlines";

  function ext() {
    return globalThis.PrairieRunExt || null;
  }
  function relay() {
    return globalThis.PrairieRunRelay || null;
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

  async function render(section) {
    if (!section || typeof document === "undefined") return;
    section.querySelectorAll("[data-prr-feed]").forEach((node) => node.remove());
    for (const note of section.querySelectorAll("p.muted")) {
      if (/coming soon/i.test(note.textContent || "")) note.remove();
    }
    const root = make("div", { "data-prr-feed": "1" });
    section.appendChild(root);

    if (!relay() || typeof relay().readState !== "function") {
      root.appendChild(make("p", { className: "muted" }, "The feed module is unavailable."));
      return;
    }

    const statusLine = make("p", { className: "muted", "data-prr-feed-status": "1" });
    const urlRow = make("div", { className: "auth-redirect-row prr-feed-url-row", hidden: "hidden" });
    const urlCode = make("code", {});
    const copyButton = make("button", { className: "secondary", type: "button" }, "Copy");
    copyButton.addEventListener("click", async () => {
      const url = urlCode.textContent || "";
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        copyButton.textContent = "Copied";
      } catch {
        copyButton.textContent = "Copy failed";
      }
      setTimeout(() => { copyButton.textContent = "Copy"; }, 1500);
    });
    urlRow.append(urlCode, copyButton);
    root.append(statusLine, urlRow);

    const actions = make("div", { className: "prr-feed-actions" });
    root.appendChild(actions);

    // Relay connection configuration.
    const configCover = make("div", { className: "prr-feed-config" });
    const urlInput = make("input", { type: "url", placeholder: "Feed relay URL (https://your-relay.vercel.app)", spellcheck: "false", autocomplete: "off" });
    const keyInput = make("input", { type: "password", placeholder: "Publish key", autocomplete: "off", spellcheck: "false" });
    const configMessage = make("p", { className: "muted", "data-prr-feed-config-msg": "1" });
    const connectButton = make("button", { type: "button", className: "primary" }, "Activate feed");
    connectButton.addEventListener("click", async () => {
      const url = normalizeRelayUrl(urlInput.value);
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
      try {
        const [{ settings, secrets, items }, hasPermission] = await Promise.all([
          loadAll(),
          relay().hasRelayPermission(url),
        ]);
        // The activate click is the gesture for the optional permission the
        // background needs to auto-publish later.
        let granted = hasPermission;
        if (!granted) {
          try {
            granted = await ext().permissionsRequest([`${originOf(url)}/*`]);
          } catch {
            granted = false;
          }
          if (!granted) {
            configMessage.textContent = "Relay access was not granted: publishing will only happen when you open this page and press Publish now.";
          }
        }
        await writeRelaySettings(settings, { relayUrl: url, feedId: settings.relay?.feedId || makeFeedId(), enabled: true });
        await writeRelayKey(secrets, key);
        statusLine.textContent = "Publishing feed…";
        await refresh();
        const latest = await loadAll();
        const result = await relay().publishFromUserGesture(latest.items, latest.settings, latest.secrets);
        await refresh();
        if (!result.ok && result.error) {
          statusLine.textContent = result.error;
        }
        void items;
      } catch (error) {
        configMessage.textContent = error.message || "Could not activate the feed.";
      } finally {
        connectButton.disabled = false;
      }
    });
    configCover.append(urlInput, keyInput, configMessage, connectButton);
    root.appendChild(configCover);

    // Publish + off buttons (visible when configured).
    const publishButton = make("button", { type: "button", className: "secondary" }, "Publish now");
    publishButton.addEventListener("click", async () => {
      publishButton.disabled = true;
      try {
        statusLine.textContent = "Publishing feed…";
        const latest = await loadAll();
        const result = await relay().publishFromUserGesture(latest.items, latest.settings, latest.secrets);
        await refresh();
        if (!result.ok && result.error) statusLine.textContent = result.error;
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
          if (url && !(await relay().hasRelayPermission(url))) {
            await ext().permissionsRequest([`${originOf(url)}/*`]);
          }
        } catch { /* optional; CORS publishing still works from the page */ }
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

    let currentSettings = {};
    let relayInfo = {};
    let feedState = null;

    async function refresh() {
      const [loaded, state] = await Promise.all([loadAll(), relay().readState()]);
      currentSettings = loaded.settings;
      relayInfo = loaded.settings.relay && typeof loaded.settings.relay === "object" ? loaded.settings.relay : {};
      feedState = state;
      const configured = Boolean(relayInfo.relayUrl && relayInfo.feedId);

      // Only pre-fill while the fields are untouched; the user may be typing.
      if (!urlInput.value) urlInput.value = relayInfo.relayUrl || "";
      if (keyInput.value === "") keyInput.value = loaded.secrets.relayPublishKey || "";
      void feedState;

      actions.textContent = "";
      if (!configured || (state?.state === "error" && !state?.url)) {
        configCover.hidden = false;
        actions.appendChild(connectButton);
        if (!configured) {
          statusLine.textContent = "One subscribable URL for every calendar app, updated after every scan. No Google setup.";
        } else if (state?.error) {
          statusLine.textContent = state.error;
        }
        return;
      }

      const publishReady = configured && Boolean(state?.url);
      urlRow.hidden = !publishReady;
      if (publishReady) urlCode.textContent = state.url;

      if (relayInfo.enabled === true) {
        actions.append(publishButton, offButton);
        if (state?.state === "error" && state?.error) {
          statusLine.textContent = state.error;
        } else if (state?.publishedAt) {
          statusLine.textContent = `Feed up to date. Last published ${formatPublishedAt(state.publishedAt)}.`;
        } else {
          statusLine.textContent = "Feed on. Publishes after every scan.";
        }
      } else {
        configMessage.textContent = "";
        statusLine.textContent = "Feed off.";
        actions.append(enableButton, offButton);
      }
      configCover.hidden = true;
    }

    await refresh();
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => {
      const section = document.getElementById("calendar-feed");
      if (section) render(section);
    });
  }

  const api = { render, normalizeRelayUrl };
  globalThis.PrairieRunOptionsFeed = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

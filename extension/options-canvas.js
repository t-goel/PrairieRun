// PrairieRun Canvas options section (PR 4).
// Renders into #canvas-settings: an Enable toggle (requests the optional
// canvas.illinois.edu host permission from the click), a password field for
// the secret calendar feed URL (storage.local prairierunSecrets.canvasFeedUrl,
// displayed masked), and the optional planner-API checkbox.
// Before a feed URL is saved, shows the paste/save setup form. After it is
// saved, shows a compact connected status with Change/Clear instead of the
// onboarding form. All extension APIs go through PrairieRunExt; nothing here
// touches chrome.*. Plain IIFE script; no bundler.
(function () {
  const CANVAS_PERMISSION = "https://canvas.illinois.edu/*";
  const ILLINOIS_FEED_RE = /^https:\/\/canvas\.illinois\.edu\/feeds\/calendars\/user_[A-Za-z0-9]+\.ics$/;
  // Real Canvas feed URLs may carry signed query parameters (e.g.
  // "?ex=...&xs=..."), so allow an optional query string after ".ics".
  const GENERIC_FEED_RE = /^https:\/\/[^/\s]+\/feeds\/calendars\/user_[A-Za-z0-9]+\.ics(?:\?\S*)?$/;
  const RESYNC_TIMEOUT_MS = 5000;

  function ext() {
    return globalThis.PrairieRunExt || null;
  }

  function maskFeedUrl(url) {
    const masked = String(url ?? "").replace(/user_[A-Za-z0-9]+/g, "user_***");
    const idx = masked.indexOf("/user_");
    return idx >= 0 ? `…${masked.slice(idx)}` : masked;
  }

  async function loadCanvasSettings() {
    const fallback = { enabled: false, plannerApi: false };
    try {
      const stored = await ext()?.storageLocalGet?.("prairierunSettings");
      const entry = stored?.prairierunSettings?.sources?.canvas;
      if (!entry || typeof entry !== "object") return { ...fallback };
      return {
        enabled: entry.enabled === true,
        plannerApi: entry.plannerApi === true,
      };
    } catch {
      return { ...fallback };
    }
  }

  async function saveCanvasSettings(patch) {
    const api = ext();
    if (!api) throw new Error("Extension storage is unavailable.");
    const stored = (await api.storageLocalGet("prairierunSettings")) || {};
    const settings = stored.prairierunSettings && typeof stored.prairierunSettings === "object"
      ? stored.prairierunSettings
      : {};
    const sources = settings.sources && typeof settings.sources === "object" ? settings.sources : {};
    const canvas = sources.canvas && typeof sources.canvas === "object" ? { ...sources.canvas } : {};
    Object.assign(canvas, patch);
    await api.storageLocalSet({ prairierunSettings: { ...settings, sources: { ...sources, canvas } } });
  }

  async function loadFeedUrl() {
    try {
      const stored = await ext()?.storageLocalGet?.("prairierunSecrets");
      const url = stored?.prairierunSecrets?.canvasFeedUrl;
      return typeof url === "string" ? url : "";
    } catch {
      return "";
    }
  }

  // Best-effort: after a feed URL save/clear, ask the background to re-sync the
  // enabled sources so the Sources card row reflects reality immediately. Only
  // runs when Canvas is enabled (a sync while disabled would not change the
  // stored status anyway). Failures and slow responses are ignored.
  async function triggerResync() {
    try {
      const canvas = await loadCanvasSettings();
      if (!canvas.enabled) return;
      const api = ext();
      const send = api?.runtimeSendMessage;
      if (typeof send !== "function") return;
      await Promise.race([
        Promise.resolve(send.call(api, { type: "PRAIRIERUN_SYNC_NOW" })),
        new Promise((resolve) => setTimeout(resolve, RESYNC_TIMEOUT_MS)),
      ]);
    } catch {
      // Best-effort only; the next natural sync will pick up the change.
    }
  }

  async function saveFeedUrl(url) {
    const api = ext();
    if (!api) throw new Error("Extension storage is unavailable.");
    const stored = (await api.storageLocalGet("prairierunSecrets")) || {};
    const secrets = stored.prairierunSecrets && typeof stored.prairierunSecrets === "object"
      ? stored.prairierunSecrets
      : {};
    if (url) {
      await api.storageLocalSet({ prairierunSecrets: { ...secrets, canvasFeedUrl: url } });
    } else {
      const next = { ...secrets };
      delete next.canvasFeedUrl;
      await api.storageLocalSet({ prairierunSecrets: next });
    }
  }

  function make(tag, attrs = {}, text = null) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "className") node.className = value;
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2), value);
      } else if (value !== null && value !== undefined) node.setAttribute(key, String(value));
    }
    if (text !== null && text !== undefined) node.textContent = text;
    return node;
  }

  function setMessage(node, text, kind) {
    node.textContent = text || "";
    node.className = kind === "error" ? "pr-canvas-error" : kind === "warn" ? "pr-canvas-warn" : "muted";
  }

  function setHidden(node, hidden) {
    if (hidden) node.setAttribute("hidden", "hidden");
    else node.removeAttribute("hidden");
  }

  async function render(section) {
    if (!section || typeof document === "undefined") return;
    // Idempotent: drop our previous render and PR 1's "Coming soon" note.
    section.querySelectorAll("[data-pr-canvas]").forEach((node) => node.remove());
    section.querySelectorAll("p.muted").forEach((node) => node.remove());

    const root = make("div", { "data-pr-canvas": "1" });
    const message = make("p", { className: "muted", "data-pr-canvas-message": "1" });
    // Connected summary (shown when a feed URL is already saved).
    const connected = make("div", { className: "auth-row pr-canvas-connected", "data-pr-canvas-connected": "1" });
    const savedLine = make("p", { className: "muted", "data-pr-canvas-saved": "1" });
    const connectedButtons = make("div", { className: "auth-buttons" });
    const changeButton = make("button", { type: "button", className: "secondary", "data-pr-canvas-change": "1" }, "Change");
    const clearButton = make("button", { type: "button", className: "secondary", "data-pr-canvas-clear": "1" }, "Clear");
    connectedButtons.append(changeButton, clearButton);
    connected.append(savedLine, connectedButtons);

    // First-time / change setup form.
    const setup = make("div", { className: "pr-canvas-setup", "data-pr-canvas-setup": "1" });
    const feedInput = make("input", {
      type: "password",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "Paste Canvas calendar feed URL (…/feeds/calendars/user_….ics)",
      "data-pr-canvas-feed": "1",
    });
    const setupButtons = make("div", { className: "pr-canvas-setup-actions" });
    const saveButton = make("button", { type: "button", "data-pr-canvas-save": "1" }, "Save feed URL");
    const cancelButton = make("button", {
      type: "button",
      className: "secondary",
      "data-pr-canvas-cancel": "1",
      hidden: "hidden",
    }, "Cancel");
    setupButtons.append(saveButton, cancelButton);
    setup.append(feedInput, setupButtons);

    const plannerLabel = make("label", {});
    const plannerBox = make("input", { type: "checkbox", "data-pr-canvas-planner": "1" });
    plannerLabel.append(plannerBox, document.createTextNode(" Use Canvas session for submission status (planner API)"));

    root.append(connected, setup, plannerLabel, message);
    section.appendChild(root);

    let editing = false;

    async function applyView() {
      const current = await loadFeedUrl();
      const configured = Boolean(current);
      if (configured && !editing) {
        savedLine.textContent = `Feed connected · ${maskFeedUrl(current)}`;
        setHidden(connected, false);
        setHidden(setup, true);
        setHidden(cancelButton, true);
        feedInput.value = "";
      } else {
        setHidden(connected, true);
        setHidden(setup, false);
        // Cancel only when replacing an already-saved feed.
        setHidden(cancelButton, !(configured && editing));
        if (!configured) {
          savedLine.textContent = "";
          editing = false;
        }
      }
    }

    const canvas = await loadCanvasSettings();
    plannerBox.checked = canvas.plannerApi;
    await applyView();

    changeButton.addEventListener("click", async () => {
      editing = true;
      feedInput.value = "";
      setMessage(message, "", null);
      await applyView();
      try { feedInput.focus(); } catch { /* fake DOM has no focus */ }
    });

    cancelButton.addEventListener("click", async () => {
      editing = false;
      feedInput.value = "";
      setMessage(message, "", null);
      await applyView();
    });

    saveButton.addEventListener("click", async () => {
      const url = feedInput.value.trim();
      if (!url) {
        setMessage(message, "Paste your Canvas calendar feed URL first (Canvas → Calendar → Calendar Feed).", "error");
        return;
      }
      if (!GENERIC_FEED_RE.test(url)) {
        setMessage(message, "That does not look like a Canvas calendar feed URL (…/feeds/calendars/user_….ics).", "error");
        return;
      }
      try {
        await saveFeedUrl(url);
        feedInput.value = "";
        editing = false;
        await applyView();
        await triggerResync();
        if (ILLINOIS_FEED_RE.test(url)) {
          setMessage(message, "Feed URL saved.", null);
        } else {
          setMessage(message, "Feed URL saved. Note: this is not a canvas.illinois.edu feed, so planner status may not work.", "warn");
        }
      } catch {
        setMessage(message, "Could not save the feed URL.", "error");
      }
    });

    clearButton.addEventListener("click", async () => {
      try {
        await saveFeedUrl("");
        feedInput.value = "";
        editing = false;
        await applyView();
        await triggerResync();
        setMessage(message, "Feed URL cleared.", null);
      } catch {
        setMessage(message, "Could not clear the feed URL.", "error");
      }
    });

    plannerBox.addEventListener("change", async () => {
      const want = plannerBox.checked;
      try {
        await saveCanvasSettings({ plannerApi: want });
        setMessage(message, want ? "Planner status on." : "Planner status off.", null);
      } catch {
        plannerBox.checked = !want;
        setMessage(message, "Could not save the planner setting.", "error");
      }
    });
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("DOMContentLoaded", () => {
      const section = document.getElementById("canvas-setup");
      if (section) {
        section.removeAttribute("hidden");
        render(section);
      }
    });
  }

  const api = { render, maskFeedUrl };
  globalThis.PrairieRunOptionsCanvas = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

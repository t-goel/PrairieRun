// PrairieRun Canvas options section (PR 4).
// Renders into #canvas-settings: an Enable toggle (requests the optional
// canvas.illinois.edu host permission from the click), a password field for
// the secret calendar feed URL (storage.local prairierunSecrets.canvasFeedUrl,
// displayed masked), and the optional planner-API checkbox.
// All extension APIs go through PrairieRunExt; nothing here touches chrome.*.
// Plain IIFE script; no bundler.
(function () {
  const CANVAS_PERMISSION = "https://canvas.illinois.edu/*";
  const ILLINOIS_FEED_RE = /^https:\/\/canvas\.illinois\.edu\/feeds\/calendars\/user_[A-Za-z0-9]+\.ics$/;
  const GENERIC_FEED_RE = /^https:\/\/[^/\s]+\/feeds\/calendars\/user_[A-Za-z0-9]+\.ics$/;

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

  async function render(section) {
    if (!section || typeof document === "undefined") return;
    // Idempotent: drop our previous render and PR 1's "Coming soon" note.
    section.querySelectorAll("[data-pr-canvas]").forEach((node) => node.remove());
    section.querySelectorAll("p.muted").forEach((node) => node.remove());

    const root = make("div", { "data-pr-canvas": "1" });
    const message = make("p", { className: "muted", "data-pr-canvas-message": "1" });
    const enableLabel = make("label", {});
    const enableBox = make("input", { type: "checkbox", "data-pr-canvas-enabled": "1" });
    enableLabel.append(enableBox, document.createTextNode(" Enable Canvas"));
    const enableHint = make("p", { className: "muted" },
      "Reads your Canvas calendar feed. Enabling requests permission for https://canvas.illinois.edu/*.");

    const savedLine = make("p", { className: "muted", "data-pr-canvas-saved": "1" });
    const feedInput = make("input", {
      type: "password",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "Paste Canvas calendar feed URL (…/feeds/calendars/user_….ics)",
      "data-pr-canvas-feed": "1",
    });
    feedInput.style.width = "100%";
    const saveButton = make("button", { type: "button" }, "Save feed URL");
    const clearButton = make("button", { type: "button" }, "Clear");
    const buttonRow = make("div", {});
    buttonRow.append(saveButton, document.createTextNode(" "), clearButton);

    const plannerLabel = make("label", {});
    const plannerBox = make("input", { type: "checkbox", "data-pr-canvas-planner": "1" });
    plannerLabel.append(plannerBox, document.createTextNode(" Use Canvas session for submission status (planner API)"));
    const plannerHint = make("p", { className: "muted" },
      "Optional. Fetches planner items with your Canvas login to mark submitted / graded work. The feed alone never needs your login.");

    root.append(enableLabel, enableHint, savedLine, feedInput, buttonRow, plannerLabel, plannerHint, message);
    section.appendChild(root);

    async function refreshSaved() {
      const current = await loadFeedUrl();
      savedLine.textContent = current ? `Saved feed: ${maskFeedUrl(current)}` : "No feed URL saved.";
    }

    const canvas = await loadCanvasSettings();
    enableBox.checked = canvas.enabled;
    plannerBox.checked = canvas.plannerApi;
    await refreshSaved();

    enableBox.addEventListener("change", async () => {
      const want = enableBox.checked;
      if (want) {
        let granted = false;
        try {
          granted = await ext()?.permissionsRequest?.([CANVAS_PERMISSION]);
        } catch {
          granted = false;
        }
        if (!granted) {
          enableBox.checked = false;
          setMessage(message, "Canvas needs the canvas.illinois.edu permission; the toggle stays off until it is granted.", "error");
          return;
        }
      }
      try {
        await saveCanvasSettings({ enabled: want });
        setMessage(message, want ? "Canvas enabled." : "Canvas disabled.", null);
      } catch {
        enableBox.checked = !want;
        setMessage(message, "Could not save the Canvas setting.", "error");
      }
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
        await refreshSaved();
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
        await refreshSaved();
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
      const section = document.getElementById("canvas-settings");
      if (section) render(section);
    });
  }

  const api = { render, maskFeedUrl };
  globalThis.PrairieRunOptionsCanvas = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

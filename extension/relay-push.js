// PrairieRun relay push: publishes the current deadlines as an auto-updating
// iCalendar feed to a small relay host (the bundled Vercel scaffold under
// /relay). Every eligible calendar app subscribes to one stable URL; each
// successful sync overwrites the same feed file, so subscribers always see
// the latest due dates.
//
// Feed config lives in prairierunSettings.relay: { enabled, relayUrl, feedId }.
// The relay publish key lives in prairierunSecrets.relayPublishKey; the
// one-click activation path (claimFeed) receives that key from the relay's
// /api/claim rather than asking the user to paste it.
// Push-state lives in prairierunRelayStatus: { state, url, publishedAt, error }.
(function () {
  const STATUS_KEY = "prairierunRelayStatus";
  const SEQUENCES_KEY = "prairierunIcsSequences";
  const SETTINGS_KEY = "prairierunSettings";
  // Bundled relay scaffold's default deployment; used when the user has not
  // configured a custom relay URL.
  const DEFAULT_RELAY_URL = "https://prairierun-feed.vercel.app";

  function ext() {
    return globalThis.PrairieRunExt || null;
  }

  function readFeedConfig(settings, stored) {
    const relay = settings && typeof settings.relay === "object" ? settings.relay : {};
    const key = stored?.prairierunSecrets?.relayPublishKey;
    const feedId = typeof relay.feedId === "string" ? relay.feedId : "";
    const relayUrl = typeof relay.relayUrl === "string" ? relay.relayUrl.replace(/\/+$/, "") : "";
    return {
      enabled: relay.enabled === true,
      relayUrl,
      feedId,
      publishKey: typeof key === "string" ? key : "",
      configured: Boolean(relayUrl && feedId && key),
    };
  }

  function originOf(value) {
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  }

  function buildIcs(items, settings, storedSequences) {
    const writer = globalThis.PrairieRunIcsWriter;
    if (!writer || typeof writer.buildCalendar !== "function") {
      throw new Error("PrairieRunIcsWriter is unavailable.");
    }
    const outputSettings = settings?.output || {};
    return writer.buildCalendar(items, {
      name: "PrairieRun",
      now: new Date(),
      sequences: storedSequences || {},
      eventShape: outputSettings.eventShape || "block1h",
      leadMinutes: outputSettings.leadMinutes !== undefined ? outputSettings.leadMinutes : 240,
      nightBefore: Boolean(outputSettings.nightBefore),
      nightBeforeHour: outputSettings.nightBeforeHour != null ? outputSettings.nightBeforeHour : 20,
      includeCompleted: outputSettings.includeCompleted !== false,
      windowDays: outputSettings.windowDays ?? null,
    });
  }

  async function readState() {
    let stored = {};
    try {
      stored = (await ext()?.storageLocalGet?.([STATUS_KEY])) || {};
    } catch { /* read errors behave like no state */ }
    return stored[STATUS_KEY] && typeof stored[STATUS_KEY] === "object" ? stored[STATUS_KEY] : null;
  }

  async function writeState(patch) {
    await ext()?.storageLocalSet?.({ [STATUS_KEY]: { ...(await readState()), ...patch } });
  }

  // Publish one ICS body. Never throws; resolves a result object so both the
  // background auto-publish and the options page can render it.
  async function publish(items, { settings, secrets } = {}) {
    const config = readFeedConfig(settings, { prairierunSecrets: secrets });
    if (!config.enabled) return { ok: false, status: "disabled" };
    if (!config.configured) {
      return { ok: false, status: "error", error: "Feed relay URL, feed ID, or publish key is missing." };
    }

    // UID sequences are shared with the manual export path so calendar apps
    // do not observe a shuffled identifier on the same assignment.
    const stored = (await ext()?.storageLocalGet?.([SEQUENCES_KEY])) || {};
    const { text, sequences } = buildIcs(items, settings, stored[SEQUENCES_KEY]);
    if (ext()?.storageLocalSet && sequences) {
      try {
        await ext().storageLocalSet({ [SEQUENCES_KEY]: sequences });
      } catch { /* sequence persistence is best-effort */ }
    }

    const previous = await readState();
    const currentHash = simpleHash(text);
    if (previous?.hash && previous.hash === currentHash && previous.url) {
      const publishedAt = previous.publishedAt || new Date().toISOString();
      await writeState({ state: "ok", url: previous.url, hash: currentHash, publishedAt });
      return { ok: true, url: previous.url, unchanged: true, publishedAt };
    }

    let response;
    try {
      response = await fetch(`${config.relayUrl}/api/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-prairierun-key": config.publishKey,
        },
        body: JSON.stringify({ feedId: config.feedId, ics: text }),
      });
    } catch (error) {
      const message = originOf(config.relayUrl)
        ? `Could not reach the feed relay (${originOf(config.relayUrl)}). Grant the relay access in the Calendar feed card or publish again.`
        : "Feed relay URL is invalid.";
      await writeState({ state: "error", error: message });
      return { ok: false, status: "error", error: message };
    }
    if (!response.ok) {
      const code = response.status;
      const body = await response.text().catch(() => "");
      const message = code === 401
        ? "The feed relay rejected the publish key. Re-check it in the Calendar feed card."
        : `Feed publish failed (${code}).${body ? ` ${sliceForDisplay(body)}` : ""}`;
      await writeState({ state: "error", error: message });
      return { ok: false, status: "error", error: message };
    }
    let data = null;
    try {
      data = await response.json();
    } catch { /* fall through to body validation below */ }
    const url = typeof data?.url === "string" ? data.url : "";
    if (!url) {
      const message = "Feed relay response did not include a feed URL.";
      await writeState({ state: "error", error: message });
      return { ok: false, status: "error", error: message };
    }
    const publishedAt = new Date().toISOString();
    const result = { ok: true, url, status: "ok", publishedAt };
    await writeState({ state: "ok", url, hash: currentHash, publishedAt, error: null });
    return result;
  }

  function sliceForDisplay(text) {
    return String(text).replace(/\s+/g, " ").slice(0, 180);
  }

  function simpleHash(text) {
    // Timestamp lines (DTSTAMP/LAST-MODIFIED) change on every build; ignore
    // them so unchanged feed content is not re-uploaded.
    const stripped = String(text)
      .split(/\r\n|\n/)
      .filter((line) => !/^DTSTAMP[:;]/i.test(line) && !/^LAST-MODIFIED[:;]/i.test(line))
      .join("\n")
      .replace(/\r/g, "");
    let hash = 0;
    for (let i = 0; i < stripped.length; i += 1) {
      hash = (Math.imul(hash, 31) + stripped.charCodeAt(i)) | 0;
    }
    return `h${(hash >>> 0).toString(16)}`;
  }

  // Background auto-publish, called from PrairieRunOutputs.run after every
  // successful source sync. Silent: missing permission or config is recorded
  // but never interrupts the sync pipeline.
  async function autoPublish(items, settings = {}) {
    const api = ext();
    if (!api || !globalThis.PrairieRunIcsWriter) return { skipped: "unavailable" };
    let stored = {};
    try {
      stored = (await api.storageLocalGet([SETTINGS_KEY])) || {};
    } catch {
      return { skipped: "no-storage" };
    }
    let secrets = {};
    try {
      secrets = (await api.storageLocalGet("prairierunSecrets")) || {};
    } catch { /* no key available */ }

    const config = readFeedConfig(stored[SETTINGS_KEY] || settings, secrets);
    if (!config.enabled) return { skipped: "disabled" };
    if (!config.configured) {
      await writeState({ state: "error", error: "Feed relay URL, feed ID, or publish key is missing." });
      return { skipped: "not_configured" };
    }

    // The relay host is user-configured, so it rides the optional host
    // permissions. Without a granted origin the background cannot fetch it.
    if (api.permissionsContains && config.relayUrl) {
      let allowed = true;
      try {
        allowed = await api.permissionsContains([`${originOf(config.relayUrl)}/*`]);
      } catch {
        allowed = true;
      }
      if (!allowed) {
        await writeState({
          state: "needs_permission",
          url: config.relayUrl,
          error: "Grant the Calendar feed relay access so background syncs can publish.",
        });
        return { skipped: "needs_permission" };
      }
    }
    return publish(items, { settings: stored[SETTINGS_KEY] || settings, secrets: secrets.prairierunSecrets || {} });
  }

  // One-click activation: mints { feedId, key } from the relay's /api/claim.
  // Never throws; always resolves { ok, feedId, key, error } with a short
  // human-readable error on any failure.
  async function claimFeed(baseUrl) {
    const fail = (error) => ({ ok: false, feedId: "", key: "", error });
    const base = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!/^https:\/\//i.test(base)) {
      return fail("The relay URL must be an https:// address.");
    }
    let response;
    try {
      response = await fetch(`${base}/api/claim`);
    } catch {
      return fail("Could not reach the PrairieRun feed relay; try again or set a custom relay below.");
    }
    if (!response.ok) {
      const code = response.status;
      return fail(code === 429
        ? "The feed relay is rate-limiting new feeds right now; try again in a minute."
        : `Could not create a new feed (${code}). Try again or set a custom relay below.`);
    }
    let data = null;
    try {
      data = await response.json();
    } catch { /* fall through to field validation below */ }
    const feedId = typeof data?.feedId === "string" ? data.feedId : "";
    const key = typeof data?.key === "string" ? data.key : "";
    if (!feedId || !key) {
      return fail("The feed relay returned incomplete data; try again.");
    }
    return { ok: true, feedId, key, error: "" };
  }

  // Options-page helper: does a granted optional permission cover the relay?
  async function hasRelayPermission(relayUrl) {
    const api = ext();
    const origin = originOf(relayUrl);
    if (!origin) return false;
    if (!api || !api.permissionsContains) return true;
    try {
      return Boolean(await api.permissionsContains([`${origin}/*`]));
    } catch {
      return true;
    }
  }

  async function publishFromUserGesture(items, settings, secrets) {
    // Publish from the options page: allowed via the relay's permissive CORS
    // even without host permission. Requires PrairieRunIcsWriter. `secrets`
    // is the prairierunSecrets object ({ relayPublishKey: "..." }).
    if (!globalThis.PrairieRunIcsWriter) return { ok: false, status: "error", error: "ICS writer unavailable." };
    return publish(items, { settings, secrets: secrets || {} });
  }

  const api = { publish, autoPublish, hasRelayPermission, publishFromUserGesture, claimFeed, readState, readFeedConfig, DEFAULT_RELAY_URL };
  globalThis.PrairieRunRelay = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

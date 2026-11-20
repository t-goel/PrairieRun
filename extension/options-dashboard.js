// PrairieRun dashboard controller: drives the full-page options.html surface
// (settings, Google sign-in controls mounted in the unified Calendar card,
// source status, Sync now). The feed copy/link controls live in
// options-feed.js. Lives on the same message contract as the removed popup
// (PRAIRIERUN_GET_STATE / PRAIRIERUN_AUTH_* / PRAIRIERUN_SYNC_NOW).
const notificationLeadElement = typeof document !== "undefined" ? document.querySelector("#notification-lead-hours") : null;
const completionThresholdElement = typeof document !== "undefined" ? document.querySelector("#completion-threshold") : null;
const authStatusElement = typeof document !== "undefined" ? document.querySelector("#auth-status") : null;
const authConnectButton = typeof document !== "undefined" ? document.querySelector("#auth-connect") : null;
const authDisconnectButton = typeof document !== "undefined" ? document.querySelector("#auth-disconnect") : null;
const authErrorElement = typeof document !== "undefined" ? document.querySelector("#auth-error") : null;
const authRedirectElement = typeof document !== "undefined" ? document.querySelector("#auth-redirect") : null;
const authCopyButton = typeof document !== "undefined" ? document.querySelector("#auth-copy-redirect") : null;
const sourcesListElement = typeof document !== "undefined" ? document.querySelector("#sources-list") : null;
const syncNowButton = typeof document !== "undefined" ? document.querySelector("#sync-now") : null;
const syncStatusElement = typeof document !== "undefined" ? document.querySelector("#sync-status") : null;
let authRedirectUri = "";
let settings = { notificationLeadMinutes: 240, completionThreshold: 95 };
let cachedSources = [];
let cachedSourceStatus = {};

// All dashboard notices share the Sources card status line; the old header
// status chip is gone.
function showStatus(text, error = false) {
  showSyncStatus(text, error);
}
// Firefox-only client-ID setup noise stays off the Sources status line.
function isSuppressedSyncMessage(text) {
  return /googleClientId|Firefox needs its own Google OAuth client|Google direct sync needs the Firefox client ID/i.test(text || "");
}
function friendlySyncMessage(text) {
  if (isSuppressedSyncMessage(text)) return "";
  return text || "";
}
function showSyncStatus(text, error = false) {
  if (!syncStatusElement) return;
  syncStatusElement.hidden = !text;
  syncStatusElement.textContent = text;
  syncStatusElement.classList.toggle("error", error);
}
function applySettings(nextSettings = {}) {
  settings = { ...settings, ...nextSettings };
  if (settings.googleCalendarLayout !== "single") settings.googleCalendarLayout = "per_course";
  const minutes = Number(settings.notificationLeadMinutes);
  if (notificationLeadElement) notificationLeadElement.value = Number.isFinite(minutes) ? String(minutes / 60) : "4";
  if (completionThresholdElement) completionThresholdElement.value = Number.isFinite(Number(settings.completionThreshold)) ? String(settings.completionThreshold) : "95";
}
function saveSettings() {
  delete settings.timezone;
  return PrairieRunExt.storageLocalSet({ prairierunSettings: settings });
}
function sendRuntimeMessage(message, timeoutMs = 10000) {
  return Promise.race([
    PrairieRunExt.runtimeSendMessage(message),
    new Promise((_, reject) => setTimeout(() => reject(new Error("PrairieRun background did not respond. Reload the extension and try again.")), timeoutMs)),
  ]);
}
function refreshState() {
  sendRuntimeMessage({ type: "PRAIRIERUN_GET_STATE" }).then((response) => {
    if (!response?.ok) return;
    applySettings(response.settings);
    cachedSources = Array.isArray(response.sources) ? response.sources : [];
    cachedSourceStatus = response.sourceStatus || {};
    renderSources();
    const raw = response.sync?.current || "";
    if (isSuppressedSyncMessage(raw)) {
      showStatus("");
    } else if (response.sync?.state === "scanning") {
      showStatus(`${raw || "Scanning…"} (${response.sync.found || 0} found)`);
    } else if (response.sync?.state === "syncing") {
      const msg = friendlySyncMessage(raw || "Synchronizing…");
      showStatus(msg);
    } else if (response.sync?.state === "auth_required") {
      showStatus(raw ? friendlySyncMessage(raw) : "");
    } else if (response.sync?.state === "error") {
      showStatus(raw || "Sync failed.", true);
    } else {
      showStatus("");
    }
  }).catch((error) => showStatus(error.message, true));
}
function refreshAuthStatus() {
  if (!authStatusElement) return;
  sendRuntimeMessage({ type: "PRAIRIERUN_AUTH_STATUS" }).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "Could not read sign-in status.");
    renderAuthStatus(response.status);
  }).catch((error) => {
    authStatusElement.textContent = "Connection unknown.";
    showAuthError(error.message, false);
  });
}
function calendarLayoutRow() {
  return typeof document !== "undefined" ? document.getElementById("google-calendar-layout") : null;
}

function applyCalendarLayoutUi(connected) {
  const row = calendarLayoutRow();
  if (!row) return;
  row.hidden = !connected;
  const mode = settings.googleCalendarLayout === "single" ? "single" : "per_course";
  for (const input of row.querySelectorAll('input[name="google-calendar-layout"]')) {
    input.checked = input.value === mode;
  }
}

function renderAuthStatus(status = {}) {
  if (!authStatusElement) return;
  authRedirectUri = status.redirectUri || "";
  if (authRedirectElement) authRedirectElement.textContent = authRedirectUri;
  if (!status.clientConfigured) {
    authStatusElement.textContent = "No Google Calendar integration";
    if (authConnectButton) authConnectButton.hidden = true;
    if (authDisconnectButton) authDisconnectButton.hidden = true;
    applyCalendarLayoutUi(false);
    showAuthError("Google Calendar sign-in is not available in this build.", true);
    return;
  }
  if (status.connected) {
    authStatusElement.textContent = "Signed in";
    if (authConnectButton) authConnectButton.hidden = true;
    if (authDisconnectButton) authDisconnectButton.hidden = false;
    applyCalendarLayoutUi(true);
    showAuthError("", false);
  } else {
    authStatusElement.textContent = "No Google Calendar integration";
    if (authConnectButton) authConnectButton.hidden = false;
    if (authDisconnectButton) authDisconnectButton.hidden = true;
    applyCalendarLayoutUi(false);
    showAuthError("", false);
  }
}
function showAuthError(text, isError) {
  if (!authErrorElement) return;
  authErrorElement.hidden = !text;
  authErrorElement.textContent = text || "";
  authErrorElement.classList.toggle("error", Boolean(isError));
}

// ---- Multi-source status ----

function renderSources() {
  if (!sourcesListElement) return;
  sourcesListElement.textContent = "";
  if (!cachedSources.length) {
    showSyncStatus("No sources registered.");
    return;
  }
  showSyncStatus("");
  for (const source of cachedSources) {
    const entry = cachedSourceStatus[source.id];
    rowForSource(source, entry);
  }
}

function sourceEnabled(source) {
  const entry = settings?.sources?.[source.id];
  if (entry && typeof entry.enabled === "boolean") return entry.enabled;
  return source.id === "prairielearn";
}

function chipFor(entry) {
  if (!entry) return { text: "pending", className: "pending", action: null };
  if (entry.status === "ok") return { text: "ok", className: "ok", action: null };
  if (entry.status === "signed_out") return { text: "signed out", className: "signed-out", action: "signin" };
  if (entry.status === "disabled" && entry.error === "permission") {
    return { text: "needs permission", className: "permission", action: "grant" };
  }
  if (entry.status === "disabled") return { text: "disabled", className: "disabled", action: null };
  return { text: "error", className: "error", action: null };
}

function rowForSource(source, entry) {
  const enabled = sourceEnabled(source);
  const chip = enabled ? chipFor(entry) : { text: "off", className: "disabled", action: null };
  const row = document.createElement("li");
  row.className = "source-row";

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "source-toggle";
  toggle.checked = enabled;
  toggle.setAttribute("aria-label", `Include ${source.label || source.id} scans`);
  toggle.addEventListener("change", () => toggleSource(source, toggle));
  row.appendChild(toggle);

  const info = document.createElement("div");
  info.className = "source-info";
  const label = document.createElement("span");
  label.className = "source-label";
  label.textContent = source.label || source.id;
  info.appendChild(label);
  const status = document.createElement("span");
  status.className = "source-checked";
  status.textContent = !enabled
    ? "off"
    : entry?.error && entry.status !== "signed_out" && entry.status !== "disabled"
      ? entry.error
      : formatCentralCheckedAt(entry?.checkedAt);
  info.appendChild(status);
  row.appendChild(info);

  const badge = document.createElement("span");
  badge.className = `chip ${chip.className}`;
  badge.textContent = chip.text;
  row.appendChild(badge);

  if (chip.action === "signin" && (source.signInUrl || entry?.signInUrl)) {
    const button = document.createElement("button");
    button.className = "secondary source-action";
    button.textContent = "Sign in";
    button.addEventListener("click", () => {
      PrairieRunExt.tabsCreateForeground(source.signInUrl || entry.signInUrl).catch((error) => showStatus(error.message, true));
    });
    row.appendChild(button);
  }
  if (chip.action === "grant") {
    const button = document.createElement("button");
    button.className = "secondary source-action";
    button.textContent = "Grant access";
    // This click counts as the user gesture the permissions API requires.
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const granted = await grantSourcePermission(source);
        if (!granted) showStatus(permissionHelpMessage(source), true);
        else syncNowButton?.click();
      } catch (error) {
        showStatus(error.message, true);
      } finally {
        button.disabled = false;
        refreshState();
      }
    });
    row.appendChild(button);
  }
  sourcesListElement.appendChild(row);
}

function hostLabelForSource(source) {
  const raw = Array.isArray(source?.origins) && source.origins[0] ? String(source.origins[0]) : "";
  try {
    if (raw.includes("*")) {
      // https://*.illinois.edu/* → *.illinois.edu
      const match = raw.match(/^https?:\/\/([^/]+)/i);
      return match ? match[1] : raw;
    }
    return new URL(raw.includes("://") ? raw : `https://${raw}`).host;
  } catch {
    return raw || "this site";
  }
}

function permissionHelpMessage(source) {
  const label = source.label || source.id;
  const host = hostLabelForSource(source);
  if (PrairieRunExt.isBrave) {
    return `${label}: Brave blocked the permission popup. Open brave://extensions → PrairieRun → Details → Site access, allow ${host} (or On all sites), then click Grant access again.`;
  }
  return `${label} needs access to ${host}. If no prompt appeared, open chrome://extensions → PrairieRun → Details → Site access and allow ${host}, then try Grant access again.`;
}

async function grantSourcePermission(source) {
  if (!source.origins?.length) return false;
  try {
    const granted = await PrairieRunExt.permissionsRequest(source.origins);
    if (granted) return true;
  } catch {
    // Fall through to the site-tab / host-access-request path.
  }

  // Brave (and Chrome with withheld hosts) often suppress permissions.request.
  // Open the site and, when available, show the toolbar "Allow" chip
  // (permissions.addHostAccessRequest, Chrome 133+).
  const siteUrl = source.signInUrl
    || (typeof source.origins?.[0] === "string" && !String(source.origins[0]).includes("*")
      ? String(source.origins[0]).replace(/\/?$/, "/")
      : null);
  if (siteUrl && typeof PrairieRunExt.tabsCreate === "function") {
    try {
      const tab = await PrairieRunExt.tabsCreate({ url: siteUrl, active: true });
      if (tab?.id != null && typeof PrairieRunExt.permissionsAddHostAccessRequest === "function") {
        await PrairieRunExt.permissionsAddHostAccessRequest({
          tabId: tab.id,
          pattern: source.origins[0],
        });
      }
    } catch {
      // Opening the site is best-effort; the Site access message still helps.
    }
  }

  try {
    return Boolean(await PrairieRunExt.permissionsContains(source.origins));
  } catch {
    return false;
  }
}

async function toggleSource(source, toggle) {
  const want = toggle.checked;
  const save = async () => {
    const stored = (await PrairieRunExt.storageLocalGet("prairierunSettings")) || {};
    const current = stored.prairierunSettings && typeof stored.prairierunSettings === "object"
      ? stored.prairierunSettings
      : {};
    const sources = current.sources && typeof current.sources === "object" ? { ...current.sources } : {};
    sources[source.id] = { ...(sources[source.id] || {}), enabled: want };
    await PrairieRunExt.storageLocalSet({ prairierunSettings: { ...current, sources } });
  };

  // Enabling a source first needs its host permission; the toggle click is
  // the user gesture that lets us ask.
  if (want && source.origins?.length) {
    let granted = false;
    try {
      granted = await PrairieRunExt.permissionsContains(source.origins);
    } catch {
      granted = false;
    }
    if (!granted) {
      granted = await grantSourcePermission(source);
      if (!granted) {
        // Prompt dismissed or Brave suppressed it; keep the toggle off and
        // surface Site access guidance. A later sync still records
        // disabled:permission for the Grant access button.
        toggle.checked = false;
        showStatus(permissionHelpMessage(source), true);
        return;
      }
    }
  }
  try {
    await save();
  } catch (error) {
    toggle.checked = !want;
    showStatus(error.message || "Could not save the source setting.", true);
    return;
  }
  refreshState();
  // Kick an immediate check so the row's status becomes real right away.
  syncNowButton?.click();
}

function formatCentralCheckedAt(checkedAt) {
  if (!checkedAt) return "never checked";
  const date = new Date(checkedAt);
  if (Number.isNaN(date.getTime())) return "never checked";
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

function runManualSync() {
  if (!syncNowButton) return;
  syncNowButton.disabled = true;
  showSyncStatus("Syncing…");
  sendRuntimeMessage({ type: "PRAIRIERUN_SYNC_NOW" }, 120000).then((response) => {
    syncNowButton.disabled = false;
    if (!response?.ok) {
      showSyncStatus(response?.error || "Sync failed.", true);
      return;
    }
    if (response.summary?.skipped === "locked") showSyncStatus("A sync is already running.");
    else showSyncStatus("");
    refreshState();
  }).catch((error) => {
    syncNowButton.disabled = false;
    showSyncStatus(error.message, true);
  });
}

if (syncNowButton) syncNowButton.addEventListener("click", runManualSync);

function monitorRefresh(attempt = 0) {
  refreshState();
  if (attempt < 120) setTimeout(() => monitorRefresh(attempt + 1), 500);
}

if (typeof document !== "undefined") {
  refreshState();
  refreshAuthStatus();
}

const layoutRow = calendarLayoutRow();
if (layoutRow) {
  layoutRow.addEventListener("change", async (event) => {
    const input = event.target;
    if (!input || input.name !== "google-calendar-layout") return;
    const value = input.value === "single" ? "single" : "per_course";
    settings.googleCalendarLayout = value;
    await saveSettings();
    showStatus(value === "single" ? "Using one PrairieRun calendar. Syncing…" : "Using one calendar per course. Syncing…");
    runManualSync();
  });
}

if (typeof PrairieRunExt !== "undefined" && typeof PrairieRunExt.addStorageChangedListener === "function") {
  PrairieRunExt.addStorageChangedListener((changes, areaName) => {
    if (areaName === "local" && changes.prairierunSyncStatus) {
      refreshState();
    }
    if (areaName === "local" && changes.prairierunSourceStatus) {
      refreshState();
    }
  });
}

if (notificationLeadElement) {
  notificationLeadElement.addEventListener("change", async () => {
    const hours = Number(notificationLeadElement.value);
    if (!Number.isFinite(hours) || hours < 0 || hours > 168) {
      notificationLeadElement.value = String(settings.notificationLeadMinutes / 60);
      return;
    }
    settings.notificationLeadMinutes = Math.round(hours * 60);
    await saveSettings();
  });
}

if (completionThresholdElement) {
  completionThresholdElement.addEventListener("change", async () => {
    const threshold = Number(completionThresholdElement.value);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      completionThresholdElement.value = String(settings.completionThreshold);
      return;
    }
    settings.completionThreshold = Math.round(threshold);
    await saveSettings();
    showStatus("Refreshing assignments…");
    monitorRefresh();
  });
}

if (authConnectButton) authConnectButton.addEventListener("click", () => {
  authConnectButton.disabled = true;
  if (authStatusElement) authStatusElement.textContent = "Waiting for Google…";
  showAuthError("", false);
  sendRuntimeMessage({ type: "PRAIRIERUN_AUTH_CONNECT" }, 120000).then((response) => {
    authConnectButton.disabled = false;
    if (!response?.ok) {
      const cancelled = response?.code === "cancelled" || /cancel/i.test(response?.error || "");
      const mismatch = /redirect_uri_mismatch|redirect_mismatch|Helium|OAuth redirect/i.test(
        `${response?.error || ""} ${response?.code || ""}`,
      );
      if (authStatusElement) authStatusElement.textContent = "Not connected.";
      applyCalendarLayoutUi(false);
      if (response?.redirectUri) authRedirectUri = response.redirectUri;
      else if (response?.status?.redirectUri) authRedirectUri = response.status.redirectUri;
      if (authRedirectElement) authRedirectElement.textContent = authRedirectUri || "";
      // Helium needs the exact redirect string registered on a Web OAuth client.
      if (mismatch && authRedirectUri) {
        if (authRedirectElement) authRedirectElement.hidden = false;
        if (authCopyButton) authCopyButton.hidden = false;
      }
      const busy = response?.code === "auth_busy" || /only one web auth flow/i.test(response?.error || "");
      showAuthError(
        busy
          ? "Another Google sign-in is already open. Close that window, wait a second, then try again."
          : (response?.error || "Google sign-in failed."),
        !cancelled,
      );
      return;
    }
    if (authRedirectElement) authRedirectElement.hidden = true;
    if (authCopyButton) authCopyButton.hidden = true;
    renderAuthStatus(response.status);
    showStatus("Syncing Google Calendar…");
    runManualSync();
  }).catch((error) => {
    authConnectButton.disabled = false;
    if (authStatusElement) authStatusElement.textContent = "Not connected.";
    applyCalendarLayoutUi(false);
    if (error?.redirectUri) {
      authRedirectUri = error.redirectUri;
      if (authRedirectElement) {
        authRedirectElement.textContent = authRedirectUri;
        authRedirectElement.hidden = false;
      }
      if (authCopyButton) authCopyButton.hidden = false;
    }
    showAuthError(error.message, true);
  });
});

if (authDisconnectButton) authDisconnectButton.addEventListener("click", async () => {
  authDisconnectButton.disabled = true;
  try {
    const response = await sendRuntimeMessage({ type: "PRAIRIERUN_AUTH_DISCONNECT" });
    if (!response?.ok) throw new Error(response?.error || "Could not sign out.");
    renderAuthStatus(response.status);
    showAuthError("Signed out. Google access was revoked.", false);
  } catch (error) {
    showAuthError(error.message, true);
  } finally {
    authDisconnectButton.disabled = false;
  }
});

if (authCopyButton) authCopyButton.addEventListener("click", async () => {
  if (!authRedirectUri) return;
  try {
    await navigator.clipboard.writeText(authRedirectUri);
    authCopyButton.textContent = "Copied";
  } catch (_error) {
    authCopyButton.textContent = "Copy failed";
  }
  setTimeout(() => { authCopyButton.textContent = "Copy"; }, 1500);
});

if (typeof module !== "undefined" && module.exports) {
  module.exports = { isSuppressedSyncMessage, friendlySyncMessage };
}

const contextElement = document.querySelector("#context");
const notificationLeadElement = document.querySelector("#notification-lead-hours");
const completionThresholdElement = document.querySelector("#completion-threshold");
const resetDataButton = document.querySelector("#reset-data");
const authStatusElement = document.querySelector("#auth-status");
const authConnectButton = document.querySelector("#auth-connect");
const authDisconnectButton = document.querySelector("#auth-disconnect");
const authErrorElement = document.querySelector("#auth-error");
const authRedirectElement = document.querySelector("#auth-redirect");
const authCopyButton = document.querySelector("#auth-copy-redirect");
const sourcesListElement = document.querySelector("#sources-list");
const syncNowButton = document.querySelector("#sync-now");
const syncStatusElement = document.querySelector("#sync-status");
let authRedirectUri = "";
let settings = { notificationLeadMinutes: 240, completionThreshold: 95 };
let cachedSources = [];
let cachedSourceStatus = {};

function showStatus(text, error = false) {
  contextElement.textContent = text;
  contextElement.classList.toggle("error", error);
}
function applySettings(nextSettings = {}) {
  settings = { ...settings, ...nextSettings };
  const minutes = Number(settings.notificationLeadMinutes);
  notificationLeadElement.value = Number.isFinite(minutes) ? String(minutes / 60) : "4";
  completionThresholdElement.value = Number.isFinite(Number(settings.completionThreshold)) ? String(settings.completionThreshold) : "95";
}
function saveSettings() {
  delete settings.timezone;
  return PrairieRunExt.storageLocalSet({ prairierunSettings: settings });
}
function sendRuntimeMessage(message, timeoutMs = 10000) {
  return Promise.race([
    PrairieRunExt.runtimeSendMessage(message),
    new Promise((_, reject) => setTimeout(() => reject(new Error("PrairieRun background scanner did not respond. Reload the extension and try again.")), timeoutMs)),
  ]);
}
function refreshState() {
  console.log("[PrairieRun] Popup refreshing state");
  sendRuntimeMessage({ type: "PRAIRIERUN_GET_STATE" }).then((response) => {
    if (!response?.ok) return;
    applySettings(response.settings);
    cachedSources = Array.isArray(response.sources) ? response.sources : [];
    cachedSourceStatus = response.sourceStatus || {};
    renderSources();
    if (response.sync?.state === "scanning") showStatus(`${response.sync.current || "Scanning…"} (${response.sync.found || 0} found)`);
    if (response.sync?.state === "syncing") showStatus(response.sync.current || "Synchronizing Google Calendar…");
    if (response.sync?.state === "complete") showStatus(response.sync.current || "PrairieLearn detected.");
    if (response.sync?.state === "auth_required") showStatus(response.sync.current || "Connect Google Calendar to sync.");
    if (response.sync?.state === "error") showStatus(response.sync.current || "Scan failed.", true);
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
function renderAuthStatus(status = {}) {
  if (!authStatusElement) return;
  authRedirectUri = status.redirectUri || "";
  if (authRedirectElement) authRedirectElement.textContent = authRedirectUri;
  if (!status.clientConfigured) {
    authStatusElement.textContent = "Not connected.";
    if (authConnectButton) authConnectButton.hidden = true;
    if (authDisconnectButton) authDisconnectButton.hidden = true;
    showAuthError("The Google OAuth client ID is not configured. See extension/google-calendar-setup.md.", true);
    return;
  }
  if (status.connected) {
    const expiry = status.expiresAt ? `, expires ${new Date(status.expiresAt).toLocaleString()}` : "";
    authStatusElement.textContent = `Connected${expiry}.`;
    if (authConnectButton) authConnectButton.hidden = true;
    if (authDisconnectButton) authDisconnectButton.hidden = false;
    showAuthError("", false);
  } else {
    authStatusElement.textContent = "Not connected.";
    if (authConnectButton) authConnectButton.hidden = false;
    if (authDisconnectButton) authDisconnectButton.hidden = true;
  }
}
function showAuthError(text, isError) {
  if (!authErrorElement) return;
  authErrorElement.hidden = !text;
  authErrorElement.textContent = text || "";
  authErrorElement.classList.toggle("error", Boolean(isError));
}
function monitorRefresh(attempt = 0) {
  refreshState();
  if (attempt < 120) setTimeout(() => monitorRefresh(attempt + 1), 500);
}

// ---- Multi-source status (PR 2) ----

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

function renderSources() {
  if (!sourcesListElement) return;
  sourcesListElement.textContent = "";
  if (!cachedSources.length) {
    if (syncStatusElement) syncStatusElement.textContent = "No sources registered.";
    return;
  }
  if (syncStatusElement) syncStatusElement.textContent = "Last checked (Central):";
  for (const source of cachedSources) {
    const entry = cachedSourceStatus[source.id];
    const chip = chipFor(entry);
    const row = document.createElement("li");
    row.className = "source-row";

    const info = document.createElement("div");
    info.className = "source-info";
    const label = document.createElement("span");
    label.className = "source-label";
    label.textContent = source.label || source.id;
    info.appendChild(label);
    const checked = document.createElement("span");
    checked.className = "source-checked";
    checked.textContent = formatCentralCheckedAt(entry?.checkedAt);
    info.appendChild(checked);
    row.appendChild(info);

    const badge = document.createElement("span");
    badge.className = `chip ${chip.className}`;
    badge.textContent = chip.text;
    row.appendChild(badge);

    if (chip.action === "signin" && source.signInUrl) {
      const button = document.createElement("button");
      button.className = "secondary source-action";
      button.textContent = `Sign in to ${source.label || source.id}`;
      button.addEventListener("click", () => {
        PrairieRunExt.tabsCreateForeground(source.signInUrl).catch((error) => showStatus(error.message, true));
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
          await PrairieRunExt.permissionsRequest(source.origins || []);
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
}

function runManualSync() {
  if (!syncNowButton) return;
  syncNowButton.disabled = true;
  if (syncStatusElement) syncStatusElement.textContent = "Syncing…";
  sendRuntimeMessage({ type: "PRAIRIERUN_SYNC_NOW" }, 120000).then((response) => {
    syncNowButton.disabled = false;
    if (!response?.ok) {
      if (syncStatusElement) syncStatusElement.textContent = response?.error || "Sync failed.";
      return;
    }
    const summary = response.summary || {};
    if (summary.skipped === "locked" && syncStatusElement) {
      syncStatusElement.textContent = "A sync is already running.";
    }
    refreshState();
  }).catch((error) => {
    syncNowButton.disabled = false;
    if (syncStatusElement) syncStatusElement.textContent = error.message;
  });
}

if (syncNowButton) syncNowButton.addEventListener("click", runManualSync);

PrairieRunExt.tabsQuery({ active: true, currentWindow: true }).then(([tab]) => {
  contextElement.textContent = tab?.url?.startsWith("https://us.prairielearn.com/") ? "PrairieLearn detected." : "Open us.prairielearn.com to scan assignments.";
}).catch(() => undefined);

refreshState();
refreshAuthStatus();

PrairieRunExt.addStorageChangedListener((changes, areaName) => {
  if (areaName === "local" && changes.prairierunSyncStatus) {
    refreshState();
    refreshAuthStatus();
  }
  if (areaName === "local" && changes.prairierunSourceStatus) {
    refreshState();
  }
});

notificationLeadElement.addEventListener("change", async () => {
  const hours = Number(notificationLeadElement.value);
  if (!Number.isFinite(hours) || hours < 0 || hours > 168) {
    notificationLeadElement.value = String(settings.notificationLeadMinutes / 60);
    return;
  }
  settings.notificationLeadMinutes = Math.round(hours * 60);
  await saveSettings();
});

completionThresholdElement.addEventListener("change", async () => {
  const threshold = Number(completionThresholdElement.value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    completionThresholdElement.value = String(settings.completionThreshold);
    return;
  }
  settings.completionThreshold = Math.round(threshold);
  await saveSettings();
  contextElement.textContent = "Refreshing assignments…";
  monitorRefresh();
});

resetDataButton.addEventListener("click", async () => {
  if (!confirm("Clear PrairieRun assignments, sync state, calendar mappings, settings, and cached authorization?")) return;
  resetDataButton.disabled = true;
  await PrairieRunExt.storageLocalClear();
  await PrairieRunExt.clearSessionValues();
  resetDataButton.disabled = false;
  applySettings({ notificationLeadMinutes: 240, completionThreshold: 95 });
  showStatus("Test data cleared. Refresh PrairieLearn to scan again.");
  refreshAuthStatus();
});

if (authConnectButton) authConnectButton.addEventListener("click", () => {
  authConnectButton.disabled = true;
  if (authStatusElement) authStatusElement.textContent = "Waiting for Google…";
  showAuthError("", false);
  sendRuntimeMessage({ type: "PRAIRIERUN_AUTH_CONNECT" }, 120000).then((response) => {
    authConnectButton.disabled = false;
    if (!response?.ok) {
      const cancelled = response?.code === "cancelled" || /cancel/i.test(response?.error || "");
      if (authStatusElement) authStatusElement.textContent = "Not connected.";
      showAuthError(response?.error || "Google sign-in failed.", !cancelled);
      return;
    }
    renderAuthStatus(response.status);
  }).catch((error) => {
    authConnectButton.disabled = false;
    if (authStatusElement) authStatusElement.textContent = "Not connected.";
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

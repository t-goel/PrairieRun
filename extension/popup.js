const contextElement = document.querySelector("#context");
const notificationLeadElement = document.querySelector("#notification-lead-hours");
const completionThresholdElement = document.querySelector("#completion-threshold");
const resetDataButton = document.querySelector("#reset-data");
let settings = { notificationLeadMinutes: 240, completionThreshold: 95 };

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
    if (response.sync?.state === "scanning") showStatus(`${response.sync.current || "Scanning…"} (${response.sync.found || 0} found)`);
    if (response.sync?.state === "syncing") showStatus(response.sync.current || "Synchronizing Google Calendar…");
    if (response.sync?.state === "complete") showStatus(response.sync.current || "PrairieLearn detected.");
    if (response.sync?.state === "error") showStatus(response.sync.current || "Scan failed.", true);
  }).catch((error) => showStatus(error.message, true));
}
function monitorRefresh(attempt = 0) {
  refreshState();
  if (attempt < 120) setTimeout(() => monitorRefresh(attempt + 1), 500);
}

PrairieRunExt.tabsQuery({ active: true, currentWindow: true }).then(([tab]) => {
  contextElement.textContent = tab?.url?.startsWith("https://us.prairielearn.com/") ? "PrairieLearn detected." : "Open us.prairielearn.com to scan assignments.";
}).catch(() => undefined);

refreshState();

PrairieRunExt.addStorageChangedListener((changes, areaName) => {
  if (areaName === "local" && changes.prairierunSyncStatus) refreshState();
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
});

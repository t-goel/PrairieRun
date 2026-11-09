// In Chrome's service-worker background, pull in the compat shim and the
// calendar module. In Firefox's scripts-array background page (or any context
// where the manifest already loaded them in order) `importScripts` is either
// undefined or the modules already exist, so this is a no-op there.
if (typeof importScripts === "function" && !globalThis.PrairieRunCalendar) importScripts("compat.js", "calendar.js");

const ASSIGNMENTS_KEY = "prairierunAssignments";
const SYNC_KEY = "prairierunSyncStatus";
const SETTINGS_KEY = "prairierunSettings";
const BACKGROUND_CALENDAR_SYNC_KEY = "prairierunCalendarSync";
const DAILY_CALENDAR_SYNC_KEY = "prairierunLastDailyCalendarSync";
const CALENDAR_REPAIR_VERSION_KEY = "prairierunCalendarRepairVersion";
const CALENDAR_REPAIR_VERSION = 2;
const ASSIGNMENT_LINKS_KEY = "prairierunAssignmentLinks";
const DAILY_CALENDAR_SYNC_ALARM = "prairierun-daily-calendar-sync";
const DAILY_CALENDAR_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEBUG_LOG_KEY = "prairierunDebugLog";
const defaultSettings = { prairieLearnOrigin: "https://us.prairielearn.com", completionThreshold: 95, defaultReminderMinutes: 10, notificationLeadMinutes: 240, showUndatedAssignments: false, assignmentView: "class" };
let scanInFlight = false;
let dailySyncInFlight = false;
let queuedScan = false;
let queuedScanTabId = null;
const debugEntries = [];

function debugLog(message, details) {
  const entry = { at: new Date().toISOString(), message, ...(details === undefined ? {} : { details }) };
  debugEntries.push(entry);
  if (debugEntries.length > 100) debugEntries.shift();
  console.log(`[PrairieRun] ${message}`, details ?? "");
  try {
    const pending = PrairieRunExt.storageLocalSet({ [DEBUG_LOG_KEY]: debugEntries });
    pending?.catch?.(() => undefined);
  } catch (_error) {
    // Logging must never interrupt scanning.
  }
}

debugLog("Background service worker loaded");

function localDateKey(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isCurrentAssignment(assignment) {
  const dueDate = String(assignment?.dueAtLocal || "").match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  if (!dueDate) return false;
  const today = new Date();
  return dueDate >= localDateKey(today);
}

async function getSettings() {
  const stored = await PrairieRunExt.storageLocalGet(SETTINGS_KEY);
  return { ...defaultSettings, ...(stored[SETTINGS_KEY] || {}) };
}

function assignmentIdentity(assignment, existing) {
  return {
    assignmentAliases: [...new Set([assignment.id, ...(existing?.assignmentAliases || []), ...(assignment.assignmentAliases || [])])].sort(),
    sourceUrls: [...new Set([existing?.sourceUrl, assignment.sourceUrl, ...(existing?.sourceUrls || []), ...(assignment.sourceUrls || [])].filter(Boolean))].sort(),
  };
}

function normalizeStoredAssignment(assignment, existing, now, syncedCompletion) {
  const referenceCompletion = syncedCompletion || existing?.completionStatus;
  const completionChanged = Boolean(existing && assignment.completionStatus && referenceCompletion && referenceCompletion !== assignment.completionStatus);
  const isNew = !existing;
  const existingClean = { ...(existing || {}) };
  delete existingClean.manualCompletionStatus;
  delete existingClean.sourceCompletionStatus;
  const manuallyEnteredDueAt = existing?.manuallyEnteredDueAt || null;
  const dueAtLocal = manuallyEnteredDueAt || assignment.dueAtLocal || null;
  const sourceFingerprint = JSON.stringify({ title: assignment.title, dueAtLocal, timezone: assignment.timezone || null });
  const sourceChanged = Boolean(existing && existing.sourceFingerprint !== sourceFingerprint);
  const identity = assignmentIdentity(assignment, existing);
  const identityChanged = Boolean(existing && JSON.stringify(identity) !== JSON.stringify(assignmentIdentity(existing)));
  const identityRepairPending = identityChanged || Boolean(existing?.identityRepairPending);
  const changed = isNew || completionChanged || sourceChanged || identityRepairPending;
  return {
    ...existingClean, ...assignment, id: assignment.id, dueAtLocal, manuallyEnteredDueAt,
    ...identity, identityRepairPending,
    score: assignment.score ?? existing?.score ?? null,
    completionStatus: assignment.completionStatus || existing?.completionStatus || "unknown",
    sourceFingerprint,
    discoveredAt: existing?.discoveredAt || now, updatedAt: now,
    syncState: changed ? (isNew ? "new" : "changed") : (existing?.syncState === "error" ? "error" : "synced"),
  };
}

async function saveScanResult(assignments, sourceTabId) {
  const stored = await PrairieRunExt.storageLocalGet([ASSIGNMENTS_KEY, BACKGROUND_CALENDAR_SYNC_KEY, ASSIGNMENT_LINKS_KEY]);
  const previous = new Map((stored[ASSIGNMENTS_KEY] || []).map((item) => [item.id, item]));
  let resolvedAssignments = resolveHistoricalIdentities(assignments, stored[ASSIGNMENTS_KEY] || [], stored[ASSIGNMENT_LINKS_KEY] || {});
  if (sourceTabId && resolvedAssignments.some((item) => !item.assessmentId && item.instanceId && item.dueAtLocal)) {
    try {
      const candidates = await PrairieRunCalendar.findParentCandidates(resolvedAssignments);
      if (candidates.length) {
        const response = await PrairieRunExt.tabsSendMessage(sourceTabId, { type: "PRAIRIERUN_RESOLVE_IDENTITIES", candidates });
        if (!response?.ok) throw new Error(response?.error || "Could not verify assessment identities.");
        const links = { ...(stored[ASSIGNMENT_LINKS_KEY] || {}), ...(response.links || {}) };
        await PrairieRunExt.storageLocalSet({ [ASSIGNMENT_LINKS_KEY]: links });
        resolvedAssignments = resolveHistoricalIdentities(resolvedAssignments, stored[ASSIGNMENTS_KEY] || [], links);
        debugLog("Automatic assessment identity verification", { candidates: candidates.length, verified: Object.keys(response.links || {}).length });
      }
    } catch (error) {
      debugLog("Automatic assessment identity verification unavailable", { error: error.message });
    }
  }
  const calendarSync = stored[BACKGROUND_CALENDAR_SYNC_KEY] || {};
  const now = new Date().toISOString();
  const detectedIds = new Set();
  const merged = resolvedAssignments.map((item) => {
    const existing = previous.get(item.id) || (item.assignmentAliases || []).map((id) => previous.get(id)).find(Boolean);
    const syncedCompletion = calendarSync[item.id]?.completionStatus;
    const normalized = normalizeStoredAssignment(item, existing, now, syncedCompletion);
    if (["new", "changed", "error"].includes(normalized.syncState)) detectedIds.add(item.id);
    return normalized;
  });
  const scannedIds = new Set(merged.map((item) => item.id));
  const stale = (stored[ASSIGNMENTS_KEY] || []).filter((item) => !scannedIds.has(item.id)).map((item) => ({ ...item, syncState: "stale" }));
  await PrairieRunExt.storageLocalSet({ [ASSIGNMENTS_KEY]: [...merged, ...stale] });
  return { merged, detectedIds };
}

function resolveHistoricalIdentities(assignments, history, confirmedLinks) {
  return assignments.map((item) => {
    if (item.assessmentId || !item.instanceId) return item;
    const course = String(item.courseInstanceId);
    const originalId = item.id;
    const configured = confirmedLinks[originalId];
    const configuredMatch = typeof configured === "string" && configured.match(/^pl:(\d+):assessment:(\d+)$/);
    const candidates = history.filter((old) => old.assessmentId
      && String(old.courseInstanceId) === course && item.label && old.label === item.label
      && item.title && old.title === item.title);
    const ids = [...new Set(candidates.map((old) => String(old.assessmentId)))];
    const assessmentId = configuredMatch && configuredMatch[1] === course
      ? configuredMatch[2] : ids.length === 1 ? ids[0] : null;
    if (!assessmentId) return item;
    const canonicalId = `pl:${course}:assessment:${assessmentId}`;
    // A currently visible, separately grouped assessment makes this ambiguous.
    if (assignments.some((other) => other !== item && other.id === canonicalId)) return item;
    let source;
    try {
      const url = new URL(item.sourceUrl);
      if (url.pathname !== `/pl/course_instance/${course}/assessment_instance/${item.instanceId}/`
        && url.pathname !== `/pl/course_instance/${course}/assessment_instance/${item.instanceId}`) return item;
      source = `${url.origin}/pl/course_instance/${course}/assessment/${assessmentId}/`;
    } catch { return item; }
    debugLog("Recovered parent assessment identity", { instanceId: item.instanceId, assessmentId,
      evidence: configuredMatch && configuredMatch[1] === course ? "verified identity link" : "historical course, label and title" });
    return { ...item, id: canonicalId, assessmentId,
      assignmentAliases: [...new Set([originalId, canonicalId, ...(item.assignmentAliases || [])])],
      sourceUrls: [...new Set([source, item.sourceUrl, ...(item.sourceUrls || [])])],
    };
  });
}

async function setSyncStatus(status) { await PrairieRunExt.storageLocalSet({ [SYNC_KEY]: status }); }

function waitForTabComplete(tabId) {
  debugLog("Waiting for tab to finish loading", { tabId });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      PrairieRunExt.removeTabsUpdatedListener(listener);
      if (error) { debugLog("Tab load failed", { tabId, error: error.message }); reject(error); }
      else { debugLog("Tab finished loading", { tabId }); resolve(); }
    };
    const timeout = setTimeout(() => finish(new Error("Timed out loading PrairieLearn.")), 30000);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      finish();
    };
    PrairieRunExt.addTabsUpdatedListener(listener);
    PrairieRunExt.tabsGet(tabId).then((tab) => {
      if (tab?.status === "complete") finish();
    }).catch((error) => finish(error instanceof Error ? error : new Error(String(error?.message || error))));
  });
}

function readPage(tabId) {
  debugLog("Requesting page data", { tabId });
  return PrairieRunExt.tabsSendMessage(tabId, { type: "PRAIRIERUN_READ_PAGE" }).then((response) => {
    if (!response?.ok) {
      const error = new Error(response?.error || "Could not read the PrairieLearn page.");
      debugLog("Page returned an error", { tabId, error: error.message });
      throw error;
    }
    debugLog("Page data received", { tabId, pageType: response.data?.pageType, assignmentCount: response.data?.assignments?.length || 0 });
    return response.data;
  }).catch((error) => {
    const wrapped = error instanceof Error ? error : new Error(String(error?.message || error));
    debugLog("Page data request failed", { tabId, error: wrapped.message });
    throw wrapped;
  });
}

async function readPageWhenReady(tabId) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await readPage(tabId);
    } catch (error) {
      lastError = error;
      debugLog("Retrying page read", { tabId, attempt: attempt + 1, error: error.message });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError || new Error("Could not read the PrairieLearn page.");
}

async function scanCourse(url, progress, index, total) {
  debugLog("Opening course tab", { url, index: index + 1, total });
  const tab = await PrairieRunExt.tabsCreate({ url, active: false });
  debugLog("Course tab created", { tabId: tab.id, url });
  try {
    await waitForTabComplete(tab.id);
    const data = await readPageWhenReady(tab.id);
    if (data.pageType !== "course") {
      debugLog("Unexpected page type in course tab", { tabId: tab.id, pageType: data.pageType, url });
      throw new Error(`Expected a course page but received ${data.pageType}.`);
    }
    debugLog("Course assignments extracted", { tabId: tab.id, count: data.assignments?.length || 0 });
    await setSyncStatus({ state: "scanning", current: `Scanning ${data.course?.courseName || url}`, completed: index, total, found: progress.found });
    return data.assignments || [];
  } finally { await PrairieRunExt.tabsRemove(tab.id).catch(() => undefined); }
}

async function startScan(sourceTabId) {
  debugLog("Scan started", { sourceTabId });
  await setSyncStatus({ state: "scanning", current: "Reading PrairieLearn home page…", completed: 0, total: 1, found: 0 });
  const home = await readPage(sourceTabId);
  debugLog("Source page classified", { sourceTabId, pageType: home.pageType, courseLinkCount: home.courseLinks?.length || 0, assignmentCount: home.assignments?.length || 0 });
  if (home.pageType === "course") {
    const result = await saveScanResult(home.assignments || [], sourceTabId);
    await setSyncStatus({ state: "complete", completed: 1, total: 1, found: result.merged.length, current: "Ready" });
    return result;
  }
  if (home.pageType !== "home") throw new Error("Open the PrairieLearn home page or a class assessment page before scanning.");
  const settings = await getSettings();
  const courseLinks = (home.courseLinks || []).filter((link) => link.href?.startsWith(settings.prairieLearnOrigin));
  debugLog("Course links filtered", { discovered: home.courseLinks?.length || 0, usable: courseLinks.length, origin: settings.prairieLearnOrigin });
  if (!courseLinks.length) throw new Error("No PrairieLearn classes were found. Confirm that you are logged in.");
  const allAssignments = [];
  for (let index = 0; index < courseLinks.length; index += 1) {
    const url = `${courseLinks[index].href.replace(/\/$/, "")}/assessments`;
    const assignments = await scanCourse(url, { found: allAssignments.length }, index, courseLinks.length);
    allAssignments.push(...assignments);
    await setSyncStatus({ state: "scanning", current: `Scanned ${index + 1} of ${courseLinks.length} classes`, completed: index + 1, total: courseLinks.length, found: allAssignments.length });
  }
  const result = await saveScanResult(allAssignments, sourceTabId);
  debugLog("Scan results saved", { assignmentCount: result.merged.length, detectedCount: result.detectedIds.size });
  await setSyncStatus({ state: "complete", completed: courseLinks.length, total: courseLinks.length, found: result.merged.length, current: "Ready" });
  return result;
}

function applyExportResults(results, assignments) {
  results.forEach((result) => {
    const item = assignments.find((entry) => entry.id === result.assignment.id);
    if (!item) return;
    if (["added", "updated"].includes(result.status)) { item.syncState = "synced"; item.errorMessage = null; item.identityRepairPending = false; }
    if (result.status === "failed") { item.syncState = "error"; item.errorMessage = result.reason; }
  });
}

async function sendHomeUpdate(tabId, assignments, exportResults = []) {
  PrairieRunExt.tabsSendMessage(tabId, { type: "PRAIRIERUN_HOME_SCAN_RESULT", assignments, exportResults }).catch((error) => debugLog("Could not update PrairieLearn page", { tabId, error: error.message }));
}

async function notifyHomeTab(tabId, assignments, detectedIds) {
  await sendHomeUpdate(tabId, assignments);
  const stored = await PrairieRunExt.storageLocalGet([DAILY_CALENDAR_SYNC_KEY, CALENDAR_REPAIR_VERSION_KEY]);
  const lastDailySync = Number(stored[DAILY_CALENDAR_SYNC_KEY]) || 0;
  const repairDue = stored[CALENDAR_REPAIR_VERSION_KEY] !== CALENDAR_REPAIR_VERSION;
  const dailySyncDue = repairDue || !lastDailySync || Date.now() - lastDailySync >= DAILY_CALENDAR_SYNC_INTERVAL_MS;
  const eventRepairIds = new Set();
  const missingIds = new Set();
  if (!dailySyncDue && assignments.some((item) => item.dueAtLocal && item.syncState !== "stale")) {
    await setSyncStatus({ state: "syncing", current: "Checking Google Calendar events…", found: assignments.length });
    try {
      const inspection = await PrairieRunCalendar.inspectAssignmentEvents(assignments);
      for (const id of inspection.missingIds) { eventRepairIds.add(id); missingIds.add(id); }
      for (const id of inspection.duplicateIds) eventRepairIds.add(id);
      debugLog("Calendar event presence checked", { missing: inspection.missingIds.length, duplicates: inspection.duplicateIds.length });
    } catch (error) {
      await setSyncStatus({ state: "error", current: `Could not check Google Calendar: ${error.message}` });
      debugLog("Calendar event presence check failed", { error: error.message });
      return;
    }
  }
  const eligible = assignments.filter((item) => (dailySyncDue || detectedIds.has(item.id) || eventRepairIds.has(item.id)) && item.dueAtLocal && item.syncState !== "stale" && (dailySyncDue || item.identityRepairPending || eventRepairIds.has(item.id) || isCurrentAssignment(item)));
  if (eligible.length) {
    debugLog(dailySyncDue ? "Running daily Calendar synchronization" : "Automatically synchronizing Calendar assignments", { count: eligible.length });
    await setSyncStatus({ state: "syncing", current: "Synchronizing Google Calendar…", found: assignments.length });
    try {
      const exportResults = await PrairieRunCalendar.exportAssignments(eligible);
      debugLog("Calendar reconciliation results", exportResults.map((result) => ({
        assignmentId: result.assignment.id,
        sourceUrls: result.assignment.sourceUrls || [result.assignment.sourceUrl],
        aliases: result.assignment.assignmentAliases || [],
        status: result.status, removedDuplicates: result.removedDuplicates || 0,
        ...(result.reason ? { reason: result.reason } : {}),
      })));
      applyExportResults(exportResults, assignments);
      const updates = { [ASSIGNMENTS_KEY]: assignments };
      const failed = exportResults.filter((result) => result.status === "failed");
      if (dailySyncDue && !failed.length) {
        updates[DAILY_CALENDAR_SYNC_KEY] = Date.now();
        updates[CALENDAR_REPAIR_VERSION_KEY] = CALENDAR_REPAIR_VERSION;
      }
      await PrairieRunExt.storageLocalSet(updates);
      if (failed.length) await setSyncStatus({ state: "error", current: `${failed.length} Calendar assignment(s) could not sync: ${failed[0].reason}` });
      else {
        const removed = exportResults.reduce((total, result) => total + (result.removedDuplicates || 0), 0);
        const restored = exportResults.filter((result) => missingIds.has(result.assignment.id) && ["added", "updated"].includes(result.status)).length;
        const messages = ["Google Calendar synced."];
        if (restored) messages.push(`Restored ${restored} missing event(s).`);
        if (removed) messages.push(`Removed ${removed} duplicate event(s).`);
        await setSyncStatus({ state: "complete", current: messages.join(" "),
          found: assignments.length, removedDuplicates: removed, restoredEvents: restored });
      }
      await sendHomeUpdate(tabId, assignments, exportResults);
    } catch (error) {
      debugLog("Automatic Calendar synchronization failed", { error: error.message });
      await setSyncStatus({ state: "error", current: error.message });
      await sendHomeUpdate(tabId, assignments);
    }
  } else await setSyncStatus({ state: "complete", current: assignments.some((item) => item.dueAtLocal && item.syncState !== "stale")
    ? "Google Calendar checked. No changes needed." : "No dated assignments to sync.", found: assignments.length });
}

async function scanOnce(sourceTabId) {
  const scan = await startScan(sourceTabId);
  const assignments = scan.merged;
  await notifyHomeTab(sourceTabId, assignments, scan.detectedIds);
  return { assignments };
}

async function runScan(sourceTabId) {
  if (scanInFlight) {
    queuedScan = true;
    queuedScanTabId = sourceTabId;
    debugLog("Scan queued because another scan is already running", { sourceTabId });
    return { assignments: [], queued: true };
  }
  scanInFlight = true;
  debugLog("Scan lock acquired", { sourceTabId });
  try {
    return await scanOnce(sourceTabId);
  } finally {
    scanInFlight = false;
    debugLog("Scan lock released");
    if (queuedScan && queuedScanTabId) {
      const nextTabId = queuedScanTabId;
      queuedScan = false;
      queuedScanTabId = null;
      queueMicrotask(() => runScan(nextTabId));
    }
  }
}

PrairieRunExt.addRuntimeMessageListener((message, sender, sendResponse) => {
  if (message?.type === "PRAIRIERUN_HOME_READY" && sender.tab?.id) {
    debugLog("PrairieLearn home reported ready", { tabId: sender.tab.id });
    runScan(sender.tab.id).catch(async (error) => { await setSyncStatus({ state: "error", current: error.message }); });
    return true;
  }
  if (message?.type === "PRAIRIERUN_ASSIGNMENT_UPDATED" && sender.tab?.id) {
    const assignment = message.assignment;
    if (!assignment?.id || !["new", "changed", "error"].includes(assignment.syncState)) {
      sendResponse({ ok: true, skipped: true });
      return true;
    }
    if (!assignment.dueAtLocal) {
      PrairieRunCalendar.removeAssignmentEvent(assignment).then((result) => sendResponse({ ok: true, results: [result], assignments: [assignment] })).catch((error) => sendResponse({ ok: false, error: error?.message || "Could not remove the Calendar event." }));
      return true;
    }
    PrairieRunCalendar.exportAssignments([assignment]).then(async (results) => {
      const stored = await PrairieRunExt.storageLocalGet(ASSIGNMENTS_KEY);
      const current = stored[ASSIGNMENTS_KEY] || [];
      applyExportResults(results, current);
      await PrairieRunExt.storageLocalSet({ [ASSIGNMENTS_KEY]: current });
      sendResponse({ ok: true, results, assignments: current });
    }).catch((error) => sendResponse({ ok: false, error: error?.message || "Automatic calendar synchronization failed." }));
    return true;
  }
  if (message?.type === "PRAIRIERUN_GET_STATE") {
    PrairieRunExt.storageLocalGet([ASSIGNMENTS_KEY, SYNC_KEY, SETTINGS_KEY]).then((stored) => sendResponse({ ok: true, assignments: stored[ASSIGNMENTS_KEY] || [], sync: stored[SYNC_KEY] || { state: "idle" }, settings: { ...defaultSettings, ...(stored[SETTINGS_KEY] || {}) } }));
    return true;
  }
});

async function findPrairieLearnHomeTab() {
  const tabs = await PrairieRunExt.tabsQuery({ url: "https://us.prairielearn.com/*" });
  return tabs.find((tab) => !/\/pl\/course_instance\/\d+/.test(tab.url || "")) || null;
}

async function resyncStoredAssignments() {
  const stored = await PrairieRunExt.storageLocalGet(ASSIGNMENTS_KEY);
  const assignments = (stored[ASSIGNMENTS_KEY] || []).filter((item) => item.dueAtLocal && item.syncState !== "stale");
  if (!assignments.length) return;
  debugLog("Resynchronizing Calendar assignments after reminder setting change", { count: assignments.length });
  const results = await PrairieRunCalendar.exportAssignments(assignments);
  applyExportResults(results, assignments);
  const current = stored[ASSIGNMENTS_KEY] || [];
  applyExportResults(results, current);
  const failed = results.filter((result) => result.status === "failed");
  const updates = { [ASSIGNMENTS_KEY]: current };
  if (!failed.length) {
    updates[DAILY_CALENDAR_SYNC_KEY] = Date.now();
    updates[CALENDAR_REPAIR_VERSION_KEY] = CALENDAR_REPAIR_VERSION;
  }
  await PrairieRunExt.storageLocalSet(updates);
  if (failed.length) await setSyncStatus({ state: "error", current: `${failed.length} Calendar assignment(s) could not sync: ${failed[0].reason}` });
  const tabs = await PrairieRunExt.tabsQuery({ url: "https://us.prairielearn.com/*" });
  await Promise.all(tabs.filter((tab) => tab.id).map((tab) => sendHomeUpdate(tab.id, current, results)));
}

async function runDailyCalendarSync() {
  if (dailySyncInFlight) return;
  dailySyncInFlight = true;
  try {
    const stored = await PrairieRunExt.storageLocalGet(ASSIGNMENTS_KEY);
    const assignments = (stored[ASSIGNMENTS_KEY] || []).filter((item) => item.dueAtLocal && item.syncState !== "stale");
    if (!assignments.length) return;
    debugLog("Running scheduled daily Calendar synchronization", { count: assignments.length });
    await resyncStoredAssignments();
  } catch (error) {
    debugLog("Scheduled daily Calendar synchronization failed", { error: error.message });
    await setSyncStatus({ state: "error", current: error.message });
  } finally {
    dailySyncInFlight = false;
  }
}

PrairieRunExt.addStorageChangedListener((changes, areaName) => {
  const settingChange = changes[SETTINGS_KEY];
  if (areaName !== "local" || !settingChange) return;
  const oldSettings = settingChange.oldValue || {};
  const newSettings = settingChange.newValue || {};
  if (oldSettings.completionThreshold !== newSettings.completionThreshold) {
    findPrairieLearnHomeTab().then((homeTab) => homeTab?.id ? runScan(homeTab.id) : undefined).catch((error) => debugLog("Could not refresh after completion threshold change", { error: error.message }));
  }
  if (oldSettings.notificationLeadMinutes !== newSettings.notificationLeadMinutes) {
    resyncStoredAssignments().catch((error) => debugLog("Could not resynchronize Calendar reminders", { error: error.message }));
  }
});

PrairieRunExt.addAlarmsListener?.((alarm) => {
  if (alarm?.name === DAILY_CALENDAR_SYNC_ALARM) runDailyCalendarSync().catch((error) => debugLog("Daily Calendar alarm failed", { error: error.message }));
});
PrairieRunExt.alarmsCreate?.(DAILY_CALENDAR_SYNC_ALARM, { delayInMinutes: 24 * 60, periodInMinutes: 24 * 60 }).catch((error) => debugLog("Could not schedule daily Calendar synchronization", { error: error.message }));

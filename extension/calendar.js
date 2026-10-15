(function () {
const CALENDAR_MAPPINGS_KEY = "prairierunCalendarMappings";
const CALENDAR_SYNC_KEY = "prairierunCalendarSync";
const CALENDAR_TOKEN_KEY = "prairierunCalendarToken";
const CALENDAR_COLOR_KEY = "prairierunCalendarColors";
const CALENDAR_GENERATIONS_KEY = "prairierunCalendarEventGenerations";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
let writeQueue = Promise.resolve();

function queueWrite(operation) {
  const pending = writeQueue.then(operation);
  writeQueue = pending.catch(() => undefined);
  return pending;
}

async function stableEventId(assignmentId, generation = 0) {
  const value = generation ? `${assignmentId}:generation:${generation}` : assignmentId;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return "prr" + [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
// Chrome/Brave OAuth client (Chrome-app type). Firefox must use a separate
// client: register its exact redirect URI (see google-calendar-setup.md) and
// either replace this ID in a Firefox-only build or set `googleClientId` in
// extension settings storage to override it without code changes.
const CHROME_OAUTH_CLIENT_ID = "284599557855-m80j0r9kf52uou6n232ekslrrrpmdc9r.apps.googleusercontent.com";

async function getOAuthClientId() {
  const stored = await PrairieRunExt.storageLocalGet("prairierunSettings");
  const override = stored.prairierunSettings?.googleClientId;
  if (override) return override;
  if (PrairieRunExt.isFirefox) {
    throw new Error("Firefox needs its own Google OAuth client. Add your Firefox client ID as `googleClientId` in PrairieRun settings (see extension/google-calendar-setup.md).");
  }
  return CHROME_OAUTH_CLIENT_ID;
}

async function getCalendarToken() {
  const cached = await PrairieRunExt.getSessionValue(CALENDAR_TOKEN_KEY);
  if (cached?.accessToken && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }
  const client_id = await getOAuthClientId();
  const redirectUri = PrairieRunExt.identityGetRedirectURL("oauth2");
  const params = new URLSearchParams({
    client_id,
    response_type: "token",
    redirect_uri: redirectUri,
    scope: "https://www.googleapis.com/auth/calendar",
    include_granted_scopes: "true",
  });
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  let responseUrl;
  try {
    responseUrl = await PrairieRunExt.identityLaunchWebAuthFlow({ url, interactive: false });
  } catch (_silentError) {
    responseUrl = await PrairieRunExt.identityLaunchWebAuthFlow({ url, interactive: true });
  }
  if (!responseUrl) throw new Error("Google authorization was cancelled.");
  const fragment = new URL(responseUrl).hash.slice(1);
  const result = new URLSearchParams(fragment);
  if (result.get("error")) throw new Error(`Google authorization failed: ${result.get("error_description") || result.get("error")}`);
  const token = result.get("access_token");
  if (!token) throw new Error("Google did not return an access token.");
  const expiresIn = Number(result.get("expires_in")) || 3600;
  await PrairieRunExt.setSessionValue(CALENDAR_TOKEN_KEY, { accessToken: token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

async function calendarRequest(path, options = {}, token, attempt = 0) {
  try {
    const response = await fetch(`${CALENDAR_API}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    });
    if (response.ok) return response.status === 204 ? null : response.json();
    const body = await response.text();
    const retrySafe = options.method !== "POST" || Boolean(options.body && JSON.parse(options.body).id);
    if (retrySafe && (response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
      return calendarRequest(path, options, token, attempt + 1);
    }
    const error = new Error(`Google Calendar request failed (${response.status}): ${body.slice(0, 240)}`);
    error.status = response.status;
    throw error;
  } catch (error) {
    const message = String(error?.message || "");
    const retrySafe = options.method !== "POST" || Boolean(options.body && JSON.parse(options.body).id);
    if (retrySafe && attempt < 2 && !message.startsWith("Google Calendar request failed (4") && !message.startsWith("Google Calendar request failed (5")) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
      return calendarRequest(path, options, token, attempt + 1);
    }
    throw error;
  }
}

async function listWritableCalendars(token) {
  const calendars = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ minAccessRole: "writer", showHidden: "true" });
    if (pageToken) params.set("pageToken", pageToken);
    const result = await calendarRequest(`/users/me/calendarList?${params}`, {}, token);
    calendars.push(...(result.items || []));
    pageToken = result.nextPageToken;
  } while (pageToken);
  return calendars;
}

async function getOrCreateClassCalendar(courseName, calendars, token) {
  const summary = `PrairieLearn — ${courseName || "Class"}`;
  const existing = calendars.find((calendar) => calendar.summary === summary);
  if (existing) return existing;
  const created = await calendarRequest("/calendars", { method: "POST", body: JSON.stringify({ summary, description: `Assignments imported from PrairieLearn for ${courseName || "this class"}` }) }, token);
  calendars.push(created);
  return created;
}

function timezoneOffset(timezone) {
  return ({ CST: "-06:00", CDT: "-05:00", EST: "-05:00", EDT: "-04:00", MST: "-07:00", MDT: "-06:00", PST: "-08:00", PDT: "-07:00" })[timezone] || null;
}

function eventDateTime(local, timezone) {
  const value = String(local || "").replace(" ", "T");
  const offset = timezoneOffset(timezone);
  if (offset && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return `${value}${offset}`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid due date: ${local}`);
  return date.toISOString();
}

function eventResource(assignment, calendarId, colorId, reminderMinutes) {
  const end = eventDateTime(assignment.dueAtLocal, assignment.timezone);
  const endDate = new Date(end);
  const startDate = new Date(endDate.getTime() - 60 * 60 * 1000);
  return {
    summary: `[${assignment.courseName}] ${assignment.title}`,
    description: `PrairieLearn source: ${assignment.sourceUrl}`,
    start: { dateTime: startDate.toISOString(), timeZone: "UTC" },
    end: { dateTime: endDate.toISOString(), timeZone: "UTC" },
    reminders: { useDefault: false, overrides: assignment.completionStatus === "completed" ? [] : [{ method: "popup", minutes: reminderMinutes }] },
    ...(colorId ? { colorId } : {}),
    extendedProperties: { private: { prairieRun: "1", assignmentId: assignment.id, sourceUrl: assignment.sourceUrl, calendarId } },
  };
}

function colorDistanceToGrey(color) {
  const match = String(color || "").match(/^#([0-9a-f]{6})$/i);
  if (!match) return Number.POSITIVE_INFINITY;
  const values = [0, 2, 4].map((index) => parseInt(match[1].slice(index, index + 2), 16));
  return Math.max(...values) - Math.min(...values);
}

async function getColorPlan(token, courseKeys) {
  const stored = await PrairieRunExt.storageLocalGet(CALENDAR_COLOR_KEY);
  const saved = stored[CALENDAR_COLOR_KEY] || {};
  const colors = await calendarRequest("/colors", {}, token);
  const eventColors = colors.event || {};
  const colorIds = Object.keys(eventColors);
  const greyColorId = colorIds.sort((a, b) => colorDistanceToGrey(eventColors[a].background) - colorDistanceToGrey(eventColors[b].background))[0];
  const classColorIds = colorIds.filter((id) => id !== greyColorId);
  const classColors = { ...saved.classColors };
  courseKeys.forEach((key, index) => { if (!classColors[key] && classColorIds.length) classColors[key] = classColorIds[index % classColorIds.length]; });
  await PrairieRunExt.storageLocalSet({ [CALENDAR_COLOR_KEY]: { classColors, greyColorId } });
  return { classColors, greyColorId };
}

function sourceIdentity(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/pl\/course_instance\/(\d+)\/(assessment|assessment_instance)\/(\d+)\/?$/);
    return match && url.protocol === "https:" ? `${url.origin}/pl/course_instance/${match[1]}/${match[2]}/${match[3]}` : null;
  } catch { return null; }
}

async function listMarkedEvents(calendarId, token) {
  const matches = new Map();
    let pageToken;
    do {
      const params = new URLSearchParams({ maxResults: "250", showDeleted: "false", singleEvents: "true" });
      params.append("privateExtendedProperty", "prairieRun=1");
      if (pageToken) params.set("pageToken", pageToken);
      const result = await calendarRequest(`/calendars/${encodeURIComponent(calendarId)}/events?${params}`, {}, token);
      for (const event of result.items || []) {
        const marker = event.extendedProperties?.private;
        if (event.id && event.status !== "cancelled" && marker?.prairieRun === "1") matches.set(event.id, event);
      }
      pageToken = result.nextPageToken;
    } while (pageToken);
  return [...matches.values()];
}

async function findMarkedEvents(assignment, calendarId, token, cachedEvents) {
  const keys = new Set([assignment.id, ...(assignment.assignmentAliases || [])]);
  const sources = new Set([assignment.sourceUrl, ...(assignment.sourceUrls || [])].map(sourceIdentity).filter(Boolean));
  const events = cachedEvents || await listMarkedEvents(calendarId, token);
  return events.filter((event) => {
    const marker = event.extendedProperties?.private;
    if (marker?.prairieRun !== "1") return false;
    const descriptionUrl = event.description?.match(/PrairieLearn source:\s*(https:\/\/[^\s<>]+)/)?.[1];
    return keys.has(marker.assignmentId)
      || [marker.sourceUrl, descriptionUrl].some((value) => {
        const identity = sourceIdentity(value);
        return identity && sources.has(identity);
      });
  });
}

async function exportAssignments(assignments) {
  // Snapshot input so waiting in the queue cannot change what is exported.
  const snapshot = structuredClone(assignments);
  return queueWrite(() => exportAssignmentsNow(snapshot));
}

async function findParentCandidates(assignments) {
  const unresolved = assignments.filter((item) => item.instanceId && !item.assessmentId && item.dueAtLocal);
  if (!unresolved.length) return [];
  const token = await getCalendarToken();
  const calendars = await listWritableCalendars(token);
  const stored = await PrairieRunExt.storageLocalGet(CALENDAR_MAPPINGS_KEY);
  const mappings = stored[CALENDAR_MAPPINGS_KEY] || {};
  const eventCache = new Map();
  const candidates = new Map();
  for (const item of unresolved) {
    const course = String(item.courseInstanceId);
    const relatedCalendars = calendars.filter((calendar) => calendar.id === mappings[course]
      || calendar.summary === `PrairieLearn — ${item.courseName}`);
    for (const calendar of relatedCalendars) {
      if (!eventCache.has(calendar.id)) eventCache.set(calendar.id, await listMarkedEvents(calendar.id, token));
      for (const event of eventCache.get(calendar.id)) {
        // Title narrows candidates only. A server redirect must verify the
        // relationship before any alias is saved or event is removed.
        if (event.summary !== `[${item.courseName}] ${item.title}`) continue;
        const urls = [event.extendedProperties?.private?.sourceUrl,
          event.description?.match(/PrairieLearn source:\s*(https:\/\/[^\s<>]+)/)?.[1]];
        for (const url of urls) {
          const identity = sourceIdentity(url);
          if (!identity) continue;
          const parsed = new URL(identity);
          const match = parsed.pathname.match(/^\/pl\/course_instance\/(\d+)\/assessment\/(\d+)$/);
          if (!match || match[1] !== course || parsed.origin !== new URL(item.sourceUrl).origin) continue;
          const candidate = { courseInstanceId: course, assessmentId: match[2], instanceId: String(item.instanceId) };
          candidates.set(`${course}:${match[2]}:${item.instanceId}`, candidate);
        }
      }
    }
  }
  return [...candidates.values()];
}

async function insertOrRecoverEvent(assignment, calendarId, resource, token, generations) {
  const generationKey = `${calendarId}|${assignment.id}`;
  let generation = generations[generationKey] || 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const eventId = await stableEventId(assignment.id, generation);
    const path = `/calendars/${encodeURIComponent(calendarId)}/events`;
    try {
      const event = await calendarRequest(path, { method: "POST", body: JSON.stringify({ ...resource, id: eventId }) }, token);
      return { event, status: "added" };
    } catch (error) {
      if (error.status !== 409) throw error;
      let event;
      try { event = await calendarRequest(`${path}/${eventId}`, {}, token); }
      catch (lookupError) {
        if (lookupError.status !== 410) throw lookupError;
      }
      if (!event || event.status === "cancelled") {
        // A deleted ID may remain reserved by Google. Persist the next
        // generation before insertion so retries and reloads reuse that ID.
        generations[generationKey] = ++generation;
        await PrairieRunExt.storageLocalSet({ [CALENDAR_GENERATIONS_KEY]: generations });
        continue;
      }
      const keys = new Set([assignment.id, ...(assignment.assignmentAliases || [])]);
      if (event.extendedProperties?.private?.prairieRun !== "1" || !keys.has(event.extendedProperties?.private?.assignmentId)) throw new Error("Existing event ID does not belong to this PrairieRun assignment.");
      await calendarRequest(`${path}/${eventId}`, { method: "PATCH", body: JSON.stringify(resource) }, token);
      return { event, status: "updated" };
    }
  }
  throw new Error("Could not restore the Calendar event after multiple deleted IDs; refresh to retry.");
}

async function inspectAssignmentEvents(assignments) {
  const dated = assignments.filter((item) => item.dueAtLocal && item.syncState !== "stale");
  if (!dated.length) return { missingIds: [], duplicateIds: [] };
  const token = await getCalendarToken();
  const calendars = await listWritableCalendars(token);
  const stored = await PrairieRunExt.storageLocalGet(CALENDAR_MAPPINGS_KEY);
  const mappings = stored[CALENDAR_MAPPINGS_KEY] || {};
  const cache = new Map();
  const missingIds = [];
  const duplicateIds = [];
  for (const item of dated) {
    const courseKey = item.courseInstanceId || item.courseName;
    const calendar = calendars.find((entry) => entry.id === mappings[courseKey])
      || calendars.find((entry) => entry.summary === `PrairieLearn — ${item.courseName || "Class"}`);
    if (!calendar) { missingIds.push(item.id); continue; }
    if (!cache.has(calendar.id)) cache.set(calendar.id, await listMarkedEvents(calendar.id, token));
    const matches = await findMarkedEvents(item, calendar.id, token, cache.get(calendar.id));
    if (!matches.length) missingIds.push(item.id);
    if (matches.length > 1) duplicateIds.push(item.id);
  }
  return { missingIds, duplicateIds };
}

async function exportAssignmentsNow(assignments) {
  if (!assignments.length) throw new Error("No assignments with due dates are ready to sync.");
  const token = await getCalendarToken();
  const calendars = await listWritableCalendars(token);
  const stored = await PrairieRunExt.storageLocalGet([CALENDAR_MAPPINGS_KEY, CALENDAR_SYNC_KEY, CALENDAR_GENERATIONS_KEY, "prairierunSettings"]);
  const mappings = stored[CALENDAR_MAPPINGS_KEY] || {};
  const sync = stored[CALENDAR_SYNC_KEY] || {};
  const generations = stored[CALENDAR_GENERATIONS_KEY] || {};
  const reminderMinutes = Math.max(0, Math.min(10080, Number(stored.prairierunSettings?.notificationLeadMinutes) || 240));
  const results = [];
  const eventCache = new Map();
  const courseKeys = [...new Set(assignments.map((assignment) => assignment.courseInstanceId || assignment.courseName))];
  const colorPlan = await getColorPlan(token, courseKeys);
  for (const assignment of assignments) {
    if (!assignment.dueAtLocal) { results.push({ assignment, status: "skipped", reason: "Missing due date" }); continue; }
    try {
      const courseKey = assignment.courseInstanceId || assignment.courseName;
      const mappedCalendar = mappings[courseKey] ? calendars.find((item) => item.id === mappings[courseKey]) : null;
      const calendar = mappedCalendar || await getOrCreateClassCalendar(assignment.courseName, calendars, token);
      if (!calendar) throw new Error(`Could not find a calendar for ${assignment.courseName}.`);
      mappings[courseKey] = calendar.id;
      const classColorId = colorPlan.classColors[courseKey];
      // Always verify the marked event. A user may have deleted it directly in
      // Google Calendar while the local sync record still has its old event ID.
      if (!eventCache.has(calendar.id)) eventCache.set(calendar.id, await listMarkedEvents(calendar.id, token));
      const calendarEvents = eventCache.get(calendar.id);
      const matches = await findMarkedEvents(assignment, calendar.id, token, calendarEvents);
      const generatedId = await stableEventId(assignment.id, generations[`${calendar.id}|${assignment.id}`] || 0);
      const preferredId = sync[assignment.id]?.googleEventId;
      let event = matches.find((item) => item.id === preferredId)
        || matches.find((item) => item.id === generatedId)
        || matches.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
      const colorId = assignment.completionStatus === "completed"
        ? colorPlan.greyColorId
        : assignment.completionStatus === "unknown" && event?.id
          ? null
          : classColorId;
      const resource = eventResource(assignment, calendar.id, colorId, reminderMinutes);
      let status;
      if (event?.id) { await calendarRequest(`/calendars/${encodeURIComponent(calendar.id)}/events/${encodeURIComponent(event.id)}`, { method: "PATCH", body: JSON.stringify(resource) }, token); status = "updated"; }
      else {
        const recovered = await insertOrRecoverEvent(assignment, calendar.id, resource, token, generations);
        event = recovered.event;
        status = recovered.status;
      }
      let removedDuplicates = 0;
      for (const duplicate of matches.filter((item) => item.id !== event.id)) {
        await calendarRequest(`/calendars/${encodeURIComponent(calendar.id)}/events/${encodeURIComponent(duplicate.id)}`, { method: "DELETE" }, token);
        removedDuplicates++;
      }
      for (const alias of assignment.assignmentAliases || []) {
        if (alias !== assignment.id) delete sync[alias];
      }
      const removedIds = new Set(matches.map((item) => item.id));
      eventCache.set(calendar.id, [...calendarEvents.filter((item) => !removedIds.has(item.id)), { ...event, ...resource }]);
      sync[assignment.id] = { assignmentId: assignment.id, calendarId: calendar.id, googleEventId: event.id, lastSyncedAt: new Date().toISOString(), eventFingerprint: assignment.sourceFingerprint, completionStatus: assignment.completionStatus, syncStatus: "synced" };
      results.push({ assignment, calendar, status, eventId: event.id, removedDuplicates });
    } catch (error) {
      results.push({ assignment, status: "failed", reason: error?.message || "Unknown Calendar API error" });
    }
  }
  await PrairieRunExt.storageLocalSet({ [CALENDAR_MAPPINGS_KEY]: mappings, [CALENDAR_SYNC_KEY]: sync });
  return results;
}

async function removeAssignmentEvent(assignment) {
  const snapshot = structuredClone(assignment);
  return queueWrite(() => removeAssignmentEventNow(snapshot));
}

async function removeAssignmentEventNow(assignment) {
  const stored = await PrairieRunExt.storageLocalGet([CALENDAR_MAPPINGS_KEY, CALENDAR_SYNC_KEY]);
  const sync = stored[CALENDAR_SYNC_KEY] || {};
  const mapping = sync[assignment.id];
  if (!mapping?.calendarId) return { status: "skipped", assignment };
  const token = await getCalendarToken();
  const events = await findMarkedEvents(assignment, mapping.calendarId, token);
  for (const event of events) await calendarRequest(`/calendars/${encodeURIComponent(mapping.calendarId)}/events/${encodeURIComponent(event.id)}`, { method: "DELETE" }, token);
  delete sync[assignment.id];
  await PrairieRunExt.storageLocalSet({ [CALENDAR_SYNC_KEY]: sync });
  return { status: events.length ? "removed" : "skipped", assignment, eventId: events[0]?.id };
}

globalThis.PrairieRunCalendar = { exportAssignments, removeAssignmentEvent,
  findParentCandidates: (assignments) => queueWrite(() => findParentCandidates(structuredClone(assignments))),
  inspectAssignmentEvents: (assignments) => queueWrite(() => inspectAssignmentEvents(structuredClone(assignments))),
};
})();

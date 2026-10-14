const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const assignment = {
  id: 'pl:1:assessment:2', courseInstanceId: '1', courseName: 'CS', title: 'Homework',
  sourceUrl: 'https://us.prairielearn.com/pl/course_instance/1/assessment/2/',
  dueAtLocal: '2026-10-20 11:00:00', timezone: 'CDT', completionStatus: 'completed',
  assignmentAliases: ['pl:1:instance:3'],
};
function marked(id, key = assignment.id) {
  return { id, colorId: '1', extendedProperties: { private: { prairieRun: '1', assignmentId: key } } };
}
function harness({ initial = [], loseInsert = false, failPatch = false, failCreateCalendar = false, hidden = false } = {}) {
  const events = structuredClone(initial);
  const local = { prairierunCalendarMappings: { '1': 'class' } };
  const calls = [];
  let lost = false;
  const context = {
    URL, URLSearchParams, TextEncoder, structuredClone, crypto: webcrypto,
    setTimeout: (fn) => { fn(); },
    PrairieRunExt: {
      getSessionValue: async () => ({ accessToken: 'test', expiresAt: Date.now() + 3600000 }),
      storageLocalGet: async () => structuredClone(local),
      storageLocalSet: async (values) => Object.assign(local, structuredClone(values)),
    },
    fetch: async (url, options) => {
      const route = new URL(url);
      calls.push({ path: route.pathname, method: options.method || 'GET', query: route.search });
      const reply = (body, status = 200) => ({ ok: status < 400, status,
        json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
      if (route.pathname.endsWith('/calendarList')) {
        assert.equal(route.searchParams.get('showHidden'), 'true');
        return reply({ items: failCreateCalendar ? [] : [{ id: 'class', summary: 'PrairieLearn — CS', hidden }] });
      }
      if (route.pathname.endsWith('/colors')) return reply({ event: {
        '8': { background: '#888888' }, '1': { background: '#3366cc' },
      } });
      if (route.pathname === '/calendar/v3/calendars' && options.method === 'POST') {
        throw new Error('Calendar creation response lost');
      }
      if (route.pathname.endsWith('/events') && options.method === 'POST') {
        const resource = JSON.parse(options.body);
        if (events.some((event) => event.id === resource.id)) return reply({ error: 'duplicate' }, 409);
        events.push(resource);
        if (loseInsert && !lost) { lost = true; throw new Error('Response lost after event was stored'); }
        return reply(resource);
      }
      if (route.pathname.endsWith('/events')) {
        const key = route.searchParams.getAll('privateExtendedProperty').find((value) => value.startsWith('assignmentId=')).slice(13);
        const matching = events.filter((event) => event.extendedProperties?.private?.assignmentId === key);
        // Each page returns one result to exercise duplicate lookup pagination.
        const index = Number(route.searchParams.get('pageToken') || 0);
        return reply({ items: matching.slice(index, index + 1),
          ...(index + 1 < matching.length ? { nextPageToken: String(index + 1) } : {}) });
      }
      const id = route.pathname.split('/').pop();
      const index = events.findIndex((event) => event.id === id);
      if (index === -1) return reply({}, 404);
      if (options.method === 'PATCH') {
        if (failPatch) return reply({ error: 'forbidden' }, 403);
        Object.assign(events[index], JSON.parse(options.body));
      }
      if (options.method === 'DELETE') { events.splice(index, 1); return reply(null, 204); }
      return reply(events[index]);
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/calendar.js'), 'utf8'), context);
  return { api: context.PrairieRunCalendar, events, calls, local };
}

test('overlapping exports create one event and apply the last completion update', async () => {
  const h = harness();
  await Promise.all([
    h.api.exportAssignments([{ ...assignment, completionStatus: 'incomplete' }]),
    h.api.exportAssignments([assignment]),
  ]);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].colorId, '8');
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 1);
});
test('lost insert response retries the same ID and recovers the existing event', async () => {
  const h = harness({ loseInsert: true });
  const result = await h.api.exportAssignments([assignment]);
  assert.equal(result[0].status, 'updated');
  assert.equal(h.events.length, 1);
  assert.match(h.events[0].id, /^prr[0-9a-f]{64}$/);
});
test('reconciliation repairs all marked duplicates and verified instance aliases', async () => {
  const unrelated = marked('unrelated', 'pl:1:assessment:999');
  const unmarked = { id: 'unmarked', extendedProperties: { private: { assignmentId: assignment.id } } };
  const h = harness({ initial: [marked('a'), marked('b'), marked('c', 'pl:1:instance:3'), unrelated, unmarked] });
  const results = await h.api.exportAssignments([assignment]);
  assert.equal(results[0].removedDuplicates, 2);
  assert.equal(h.events.length, 3);
  assert.equal(h.events.find((event) => event.id === 'a').colorId, '8');
  assert.ok(h.events.some((event) => event.id === 'unrelated'));
  assert.ok(h.events.some((event) => event.id === 'unmarked'));
});
test('failed canonical update preserves duplicate events', async () => {
  const h = harness({ initial: [marked('a'), marked('b')], failPatch: true });
  const results = await h.api.exportAssignments([assignment]);
  assert.equal(results[0].status, 'failed');
  assert.equal(h.events.length, 2);
  assert.equal(h.calls.filter((call) => call.method === 'DELETE').length, 0);
});
test('clearing local mappings still finds and updates existing marked events', async () => {
  const h = harness({ initial: [marked('old')], hidden: true });
  delete h.local.prairierunCalendarMappings;
  await h.api.exportAssignments([assignment]);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].id, 'old');
  assert.equal(h.events[0].colorId, '8');
});
test('uncertain calendar creation is not blindly retried', async () => {
  const h = harness({ failCreateCalendar: true });
  const results = await h.api.exportAssignments([assignment]);
  assert.equal(results[0].status, 'failed');
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 1);
});

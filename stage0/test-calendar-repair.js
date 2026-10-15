const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('upgrade repairs unchanged past-due assignments, retries failures, then stops forcing exports', async () => {
  const oldTime = Date.now();
  const local = { prairierunLastDailyCalendarSync: oldTime };
  const calls = [];
  let fail = true;
  const input = [{ id: 'pl:1:assessment:2', dueAtLocal: '2020-01-01 11:00:00', syncState: 'synced' }];
  const context = {
    console: { log: () => {} }, input,
    PrairieRunCalendar: { exportAssignments: async (items) => {
      calls.push(items.map((item) => item.id));
      return items.map((assignment) => ({ assignment,
        status: fail ? 'failed' : 'updated', reason: fail ? 'Network failed' : undefined }));
    } },
    PrairieRunExt: {
      storageLocalGet: async () => structuredClone(local),
      storageLocalSet: async (items) => Object.assign(local, structuredClone(items)),
      tabsSendMessage: async () => undefined,
      addRuntimeMessageListener: () => {}, addStorageChangedListener: () => {},
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context);
  const run = () => vm.runInContext('notifyHomeTab(1, input, new Set())', context);
  await run();
  assert.equal(calls.length, 1);
  assert.equal(local.prairierunCalendarRepairVersion, undefined);
  assert.equal(local.prairierunLastDailyCalendarSync, oldTime);
  assert.equal(local.prairierunSyncStatus.state, 'error');
  fail = false;
  await run();
  assert.equal(calls.length, 2);
  assert.equal(local.prairierunCalendarRepairVersion, 2);
  await run();
  assert.equal(calls.length, 2);
  // Discovering a new attempt link schedules repair even after today's
  // reconciliation, and even when the original assignment is past due.
  input[0].sourceUrl = 'https://us.prairielearn.com/pl/course_instance/1/assessment/2/';
  input[0].title = 'Homework';
  local.prairierunAssignments = structuredClone(input);
  input[0].assignmentAliases = ['pl:1:instance:3'];
  input[0].sourceUrls = [input[0].sourceUrl,
    'https://us.prairielearn.com/pl/course_instance/1/assessment_instance/3/'];
  const scan = await vm.runInContext('saveScanResult(input)', context);
  assert.ok(scan.detectedIds.has(input[0].id));
  context.input = scan.merged;
  context.detected = scan.detectedIds;
  await vm.runInContext('notifyHomeTab(1, input, detected)', context);
  assert.equal(calls.length, 3);
  assert.equal(local.prairierunAssignments[0].identityRepairPending, false);
  // A subsequent page omitting the attempt must not forget its verified link.
  context.input = [{ ...input[0], sourceUrls: [], assignmentAliases: [] }];
  const next = await vm.runInContext('saveScanResult(input)', context);
  assert.ok(next.merged[0].sourceUrls.some((url) => url.includes('/assessment_instance/3/')));
  assert.equal(next.detectedIds.size, 0);
});

test('instance-only scans recover parent identity from history or a confirmed same-course link', async () => {
  const instance = { id: 'pl:229304:instance:15272849', courseInstanceId: '229304',
    assessmentId: null, instanceId: '15272849', label: 'GA:9',
    title: 'Group Activity 9: B+ Trees Automated', score: 100, completionStatus: 'completed',
    sourceUrl: 'https://us.prairielearn.com/pl/course_instance/229304/assessment_instance/15272849/',
    assignmentAliases: ['pl:229304:instance:15272849'],
  };
  const original = { ...instance, id: 'pl:229304:assessment:2724826',
    assessmentId: '2724826', instanceId: null, completionStatus: 'unknown', score: null,
  };
  const local = {};
  const context = { URL, console: { log: () => {} }, input: [instance], history: [original], links: {},
    PrairieRunCalendar: {}, PrairieRunExt: {
      storageLocalSet: async (value) => Object.assign(local, value),
      storageLocalGet: async () => structuredClone(local),
      addRuntimeMessageListener: () => {}, addStorageChangedListener: () => {},
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context);
  const run = () => vm.runInContext('resolveHistoricalIdentities(input, history, links)', context);
  let result = run()[0];
  assert.equal(result.id, original.id);
  assert.equal(result.completionStatus, 'completed');
  assert.equal(result.score, 100);
  assert.ok(result.assignmentAliases.includes(instance.id));
  assert.ok(result.sourceUrls.includes('https://us.prairielearn.com/pl/course_instance/229304/assessment/2724826/'));
  context.history = [];
  assert.equal(run()[0].id, instance.id); // No title-only guessing.
  context.links = { [instance.id]: original.id };
  assert.equal(run()[0].id, original.id);
  // A configured link must cause identity repair even when already synced.
  local.prairierunAssignments = [{ ...instance, syncState: 'synced' }];
  local.prairierunAssignmentLinks = context.links;
  const scan = await vm.runInContext('saveScanResult(input)', context);
  assert.equal(scan.merged[0].id, original.id);
  assert.equal(scan.merged[0].identityRepairPending, true);
  assert.ok(scan.detectedIds.has(original.id));
  context.links = { [instance.id]: 'pl:999999:assessment:2724826' };
  assert.equal(run()[0].id, instance.id); // Cross-course links rejected.
  context.links = {};
  context.history = [original, { ...original, assessmentId: '999999' }];
  assert.equal(run()[0].id, instance.id); // Ambiguous history rejected.
  context.history = [{ ...original, label: 'GA:10' }];
  assert.equal(run()[0].id, instance.id); // Same title alone isn't evidence.
});

test('a clean scan learns, saves and reuses server-verified parent links without manual settings', async () => {
  const item = { id: 'pl:229304:instance:15272849', courseInstanceId: '229304',
    instanceId: '15272849', assessmentId: null, label: 'GA:9', title: 'B+ Trees',
    dueAtLocal: '2026-10-16 23:59:00', completionStatus: 'completed', score: 100,
    sourceUrl: 'https://us.prairielearn.com/pl/course_instance/229304/assessment_instance/15272849/' };
  const local = { prairierunAssignments: [{ ...item, syncState: 'synced' }] };
  let lookups = 0;
  let verificationMessages = 0;
  const context = { URL, console: { log: () => {} }, input: [item],
    PrairieRunCalendar: {
      findParentCandidates: async () => { lookups++; return [{ courseInstanceId: '229304', assessmentId: '2724826', instanceId: '15272849' }]; },
      exportAssignments: async (items) => items.map((assignment) => ({ assignment, status: 'updated', removedDuplicates: 1 })),
    },
    PrairieRunExt: {
      storageLocalGet: async () => structuredClone(local),
      storageLocalSet: async (value) => Object.assign(local, structuredClone(value)),
      addRuntimeMessageListener: () => {}, addStorageChangedListener: () => {},
      tabsSendMessage: async (_tab, message) => {
        if (message.type !== 'PRAIRIERUN_RESOLVE_IDENTITIES') return;
        verificationMessages++;
        assert.equal(message.candidates[0].assessmentId, '2724826');
        return { ok: true, links: { 'pl:229304:instance:15272849': 'pl:229304:assessment:2724826' } };
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context);
  const scan = await vm.runInContext('saveScanResult(input, 1)', context);
  assert.equal(scan.merged[0].id, 'pl:229304:assessment:2724826');
  assert.equal(scan.merged[0].score, 100);
  assert.equal(local.prairierunAssignmentLinks[item.id], 'pl:229304:assessment:2724826');
  context.detected = scan.detectedIds;
  context.saved = scan.merged;
  await vm.runInContext('notifyHomeTab(1, saved, detected)', context);
  assert.equal(local.prairierunSyncStatus.state, 'complete');
  assert.equal(local.prairierunSyncStatus.removedDuplicates, 1);
  assert.match(local.prairierunSyncStatus.current, /Removed 1/);
  await vm.runInContext('saveScanResult(input, 1)', context);
  assert.equal(lookups, 1);
  assert.equal(verificationMessages, 1);
});

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

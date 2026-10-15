const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveParentCandidates } = require('../extension/identity-resolver.js');
const candidate = { courseInstanceId: '229304', assessmentId: '2724826', instanceId: '15272849' };
const origin = 'https://us.prairielearn.com';

test('server redirect verifies different assessment/instance IDs without requesting the start route', async () => {
  const calls = [];
  const links = await resolveParentCandidates([candidate, candidate], origin, async (url, options) => {
    calls.push(url);
    assert.equal(url, `${origin}/pl/course_instance/229304/assessment/2724826/__prairierun_identity__`);
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'same-origin');
    return { ok: true, url: `${origin}/pl/course_instance/229304/assessment_instance/15272849/` };
  });
  assert.deepEqual(links, { 'pl:229304:instance:15272849': 'pl:229304:assessment:2724826' });
  assert.equal(calls.length, 1);
});
test('errors, login pages, unrelated attempts, foreign origins and courses never authorize linking', async () => {
  for (const response of [
    { ok: false, url: `${origin}/pl/course_instance/229304/assessment/2724826/__prairierun_identity__` },
    { ok: true, url: `${origin}/login` },
    { ok: true, url: `${origin}/pl/course_instance/229304/assessment_instance/999/` },
    { ok: true, url: `${origin}/pl/course_instance/999/assessment_instance/15272849/` },
    { ok: true, url: 'https://example.com/pl/course_instance/229304/assessment_instance/15272849/' },
  ]) assert.deepEqual(await resolveParentCandidates([candidate], origin, async () => response), {});
  assert.deepEqual(await resolveParentCandidates([candidate], origin, async () => { throw new Error('offline'); }), {});
});
test('conflicting parent assessments are rejected', async () => {
  const links = await resolveParentCandidates([candidate, { ...candidate, assessmentId: '999' }], origin,
    async () => ({ ok: true, url: `${origin}/pl/course_instance/229304/assessment_instance/15272849` }));
  assert.deepEqual(links, {});
});

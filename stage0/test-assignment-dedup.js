const assert = require('node:assert/strict');
const test = require('node:test');

function row(kind, id, label, score, day) {
  const anchor = {
    textContent: kind === 'assessment' ? 'New instance' : `Homework instance #${id}`,
    getAttribute: () => `/pl/course_instance/1/${kind}/${id}/`,
  };
  return {
    textContent: 'Homework',
    querySelectorAll: (selector) => selector === 'a[href]' ? [anchor] : [
      { textContent: label }, { textContent: 'Homework' },
      { textContent: `100% until 11:00, Tue, Oct ${day}` },
    ],
    querySelector: (selector) => selector.includes('assessment-set-badge')
      ? { textContent: label } : selector.includes('scorebar')
        ? { textContent: `${score}%` } : null,
  };
}

for (const file of ['../extension/prairielearn-adapter.js', './prairielearn-adapter.js']) {
  const adapter = require(file);
  test(`${file}: multiple attempts produce one completed assignment and verified aliases`, () => {
    const rows = [row('assessment', 2, 'HW:1', 0, 20),
      row('assessment_instance', 3, 'HW:1#1', 100, 10),
      row('assessment_instance', 4, 'HW:1#2', 80, 20)];
    const document = { title: 'Assessments — CS | PrairieLearn',
      querySelector: () => null, querySelectorAll: () => rows };
    const location = { href: 'https://us.prairielearn.com/pl/course_instance/1/assessments' };
    for (const order of [rows, [...rows].reverse()]) {
      document.querySelectorAll = () => order;
      const assignments = adapter.extractAssignments(document, location);
      assert.equal(assignments.length, 1);
      assert.equal(assignments[0].id, 'pl:1:assessment:2');
      assert.equal(assignments[0].score, 100);
      assert.equal(assignments[0].completionStatus, 'completed');
      assert.deepEqual(new Set(assignments[0].sourceUrls), new Set([
        'https://us.prairielearn.com/pl/course_instance/1/assessment/2/',
        'https://us.prairielearn.com/pl/course_instance/1/assessment_instance/3/',
        'https://us.prairielearn.com/pl/course_instance/1/assessment_instance/4/',
      ]));
      assert.match(assignments[0].dueAtLocal, /-10 11:00:00$/);
      assert.deepEqual(new Set(assignments[0].assignmentAliases),
        new Set(['pl:1:assessment:2', 'pl:1:instance:3', 'pl:1:instance:4']));
    }
    assert.equal(adapter.completionFromScore(95), 'incomplete');
  });
}

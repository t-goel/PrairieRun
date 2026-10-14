const assert = require("node:assert/strict");
const test = require("node:test");
const adapter = require("./prairielearn-adapter.js");

test("class and assignment URLs are classified correctly", () => {
  assert.equal(adapter.pageType("https://us.prairielearn.com/", "Home | PrairieLearn"), "home");
  assert.equal(adapter.pageType("https://us.prairielearn.com/pl/course_instance/229304/assessments", "Assessments"), "course");
  assert.equal(adapter.pageType("https://us.prairielearn.com/pl/course_instance/229304/assessment_instance/14526257/", "Lec:01"), "assignment");
  assert.deepEqual(adapter.pathParts("https://us.prairielearn.com/pl/course_instance/229304/assessment/2724861/"), {
    courseInstanceId: "229304",
    kind: "assessment",
    id: "2724861",
  });
});

test("scores map to the configured completion threshold", () => {
  assert.equal(adapter.parsePercentage("97%"), 97);
  assert.equal(adapter.parsePercentage("Not started"), null);
  assert.equal(adapter.completionFromScore(94.99), "incomplete");
  assert.equal(adapter.completionFromScore(95), "incomplete");
  assert.equal(adapter.completionFromScore(95.01), "completed");
  assert.equal(adapter.completionFromScore(null), "unknown");
});

test("access details preserve the exact local timestamp and timezone", () => {
  const details = "&lt;table&gt;&lt;tr&gt;&lt;td&gt;100&lt;/td&gt;&lt;td&gt;2026-08-26 14:15:00 (CDT)&lt;/td&gt;&lt;td&gt;2026-09-11 23:59:59 (CDT)&lt;/td&gt;&lt;/tr&gt;";
  const result = adapter.parseDueInfo("100% until 23:59, Fri, Sep 11", details);
  assert.equal(result.dueAtLocal, "2026-09-11 23:59:00");
  assert.equal(result.timezone, "CDT");
  assert.equal(result.dueText, "23:59, Fri, Sep 11");
  const conflicting = adapter.parseDueInfo("100% until 23:59, Mon, Sep 14", details.replace("2026-09-11", "2026-09-23"));
  assert.equal(conflicting.dueAtLocal, "2026-09-14 23:59:00");
});

test("base labels and instance titles normalize to one assignment key", () => {
  assert.equal(adapter.baseLabel("Lec:01#1"), "Lec:01");
  assert.equal(adapter.normalizeInstanceTitle("The Relational Model instance #1"), "The Relational Model");
  assert.equal(adapter.stableAssignmentKey({ courseInstanceId: "229304", assessmentId: "2724861" }), "pl:229304:assessment:2724861");
});

test("completed originals keep their deadline instead of a later extension deadline", () => {
  const base = {
    sourceUrl: "https://us.prairielearn.com/pl/course_instance/229304/assessment/2724861/",
    score: 100,
    completionStatus: "completed",
    dueAtLocal: "2026-09-10 23:59:00",
    dueText: "23:59, Thu, Sep 10",
    timezone: "CDT",
    rawDueText: "until 23:59, Thu, Sep 10",
  };
  const extension = {
    sourceUrl: "https://us.prairielearn.com/pl/course_instance/229304/assessment_instance/14526257/",
    score: 80,
    completionStatus: "incomplete",
    dueAtLocal: "2026-09-20 23:59:00",
    dueText: "23:59, Sun, Sep 20",
    timezone: "CDT",
    rawDueText: "until 23:59, Sun, Sep 20",
  };
  assert.deepEqual(adapter.resolveAssessmentData(extension, base), base);
});

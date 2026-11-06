const assert = require("node:assert/strict");
const test = require("node:test");
const model = require("../extension/deadline-model.js");

test("localToUtc maps CDT abbreviation to UTC", () => {
  assert.equal(model.localToUtc("2026-10-20 11:00:00", "CDT"), "2026-10-20T16:00:00.000Z");
});

test("localToUtc maps America/Chicago across the 2026 DST switch", () => {
  // CDT (-05:00) before 2026-11-01 02:00, CST (-06:00) after.
  assert.equal(model.localToUtc("2026-10-15 23:59:00", "America/Chicago"), "2026-10-16T04:59:00.000Z");
  assert.equal(model.localToUtc("2026-11-02 23:59:00", "America/Chicago"), "2026-11-03T05:59:00.000Z");
});

test("fromLegacyPlAssignment maps due date, status, course code, and aliases", () => {
  const item = model.fromLegacyPlAssignment({
    id: "pl:1:assessment:2",
    courseInstanceId: "1",
    courseName: "CS 411",
    title: "Homework",
    sourceUrl: "https://us.prairielearn.com/pl/course_instance/1/assessment/2/",
    dueAtLocal: "2026-10-20 11:00:00",
    timezone: "CDT",
    completionStatus: "completed",
    assignmentAliases: ["pl:1:instance:3"],
  });
  assert.equal(item.dueAt, "2026-10-20T16:00:00.000Z");
  assert.equal(item.status, "completed");
  assert.equal(item.source, "prairielearn");
  assert.equal(item.courseKey, "prairielearn:1");
  assert.equal(item.courseCode, "CS 411");
  assert.ok(item.aliases.includes("pl:1:instance:3"));
  assert.equal(item.pl.assessmentId, "2");
});

test("status maps score to in_progress and missing score to unknown", () => {
  const withScore = model.fromLegacyPlAssignment({
    id: "pl:1:assessment:3",
    courseInstanceId: "1",
    courseName: "CS 411",
    title: "HW",
    sourceUrl: "https://us.prairielearn.com/pl/course_instance/1/assessment/3/",
    dueAtLocal: null,
    completionStatus: "incomplete",
    score: 40,
  });
  assert.equal(withScore.status, "in_progress");
  const withoutScore = model.fromLegacyPlAssignment({
    id: "pl:1:assessment:4",
    courseInstanceId: "1",
    courseName: "CS 411",
    title: "HW",
    sourceUrl: "https://us.prairielearn.com/pl/course_instance/1/assessment/4/",
    dueAtLocal: null,
    completionStatus: "incomplete",
  });
  assert.equal(withoutScore.status, "unknown");
});

test("toLegacy round-trips the deadline item", () => {
  const legacy = {
    id: "pl:1:assessment:2",
    courseInstanceId: "1",
    courseName: "CS 411",
    title: "Homework",
    sourceUrl: "https://us.prairielearn.com/pl/course_instance/1/assessment/2/",
    sourceUrls: ["https://us.prairielearn.com/pl/course_instance/1/assessment/2/"],
    assessmentId: "2",
    instanceId: null,
    assignmentAliases: ["pl:1:instance:3"],
    score: 100,
    completionStatus: "completed",
    dueAtLocal: "2026-10-20 11:00:00",
    timezone: "CDT",
    rawDueText: "until 11:00",
  };
  const item = model.fromLegacyPlAssignment(legacy);
  const back = model.toLegacyPlAssignment(item, {});
  assert.equal(back.id, legacy.id);
  assert.equal(back.courseInstanceId, "1");
  assert.equal(back.completionStatus, "completed");
  assert.deepEqual([...back.assignmentAliases].sort(), ["pl:1:instance:3"]);
  // UTC instant survives the Central wall-clock round-trip.
  const again = model.fromLegacyPlAssignment(back);
  assert.equal(again.dueAt, item.dueAt);
  assert.equal(again.title, item.title);
});

test("fingerprint does not depend on key order", () => {
  const base = {
    id: "x",
    source: "manual",
    title: "T",
    url: "https://example.com/",
    dueAt: "2026-10-20T16:00:00.000Z",
    status: "unknown",
  };
  const a = model.makeDeadlineItem({ ...base, location: "Room 1", startAt: null });
  const b = model.makeDeadlineItem({ url: base.url, status: base.status, dueAt: base.dueAt, title: base.title, source: base.source, id: base.id, location: "Room 1", startAt: null });
  assert.equal(model.fingerprint(a), model.fingerprint(b));
});

const assert = require("node:assert/strict");
const test = require("node:test");

require("../extension/deadline-model.js");
require("../extension/view-utils.js");
const digest = require("../extension/options-digest.js");

function item(partial) {
  return globalThis.PrairieRunModel.makeDeadlineItem({
    id: partial.id || `id-${Math.random().toString(16).slice(2)}`,
    source: partial.source || "prairielearn",
    kind: "assignment",
    courseKey: partial.courseKey || "course:1",
    courseName: partial.courseName || "CS 425",
    courseCode: partial.courseCode || "CS 425",
    title: partial.title || "Assignment",
    dueAt: partial.dueAt,
    status: partial.status || "not_started",
    score: partial.score ?? null,
    url: partial.url || "https://example.com/a",
    ...partial,
  });
}

test("selectDigestItems sorts by dueAt and caps the list", () => {
  const now = new Date("2026-11-10T18:00:00Z");
  const selected = digest.selectDigestItems([
    item({ id: "c", title: "C", dueAt: "2026-11-12T06:00:00Z", source: "canvas" }),
    item({ id: "a", title: "A", dueAt: "2026-11-11T06:00:00Z", source: "gradescope" }),
    item({ id: "b", title: "B", dueAt: "2026-11-11T12:00:00Z", source: "courseweb" }),
  ], { now, limit: 2, windowDays: 14 });
  assert.deepEqual(selected.map((row) => row.title), ["A", "B"]);
});

test("selectDigestItems drops completed, undated, and far-future items", () => {
  const now = new Date("2026-11-10T18:00:00Z");
  const selected = digest.selectDigestItems([
    item({ id: "done", title: "Done", dueAt: "2026-11-11T06:00:00Z", status: "completed", score: 100 }),
    item({ id: "nodue", title: "No due", dueAt: null }),
    item({ id: "far", title: "Far", dueAt: "2027-01-01T06:00:00Z" }),
    item({ id: "keep", title: "Keep", dueAt: "2026-11-12T06:00:00Z", source: "prairietest" }),
  ], { now, limit: 12, windowDays: 14 });
  assert.deepEqual(selected.map((row) => row.title), ["Keep"]);
});

test("selectDigestItems keeps direct assignment urls", () => {
  const now = new Date("2026-11-10T18:00:00Z");
  const [row] = digest.selectDigestItems([
    item({
      id: "gs",
      title: "HW4",
      dueAt: "2026-11-12T06:00:00Z",
      source: "gradescope",
      url: "https://www.gradescope.com/courses/9/assignments/44",
    }),
  ], { now });
  assert.equal(row.url, "https://www.gradescope.com/courses/9/assignments/44");
});

test("courseLabel formats raw course names like 'CS425 ECE428 Fall 2026' to clean code", () => {
  const gsItem = item({
    source: "gradescope",
    courseName: "CS425 ECE428 Fall 2026",
    courseCode: null,
  });
  assert.equal(digest.courseLabel(gsItem), "CS 425");
});

test("courseLabel formats course website titles like 'Distributed Systems :: Fall :: CS 425 / ECE 428 :: Assignments' to clean code", () => {
  const cwItem = item({
    source: "courseweb",
    courseName: "Distributed Systems :: Fall :: CS 425 / ECE 428 :: Assignments",
    courseCode: null,
  });
  assert.equal(digest.courseLabel(cwItem), "CS 425");
});

test("courseLabel resolves course code via prairierunCourseLinks", () => {
  const customItem = item({
    source: "gradescope",
    courseKey: "gradescope:999",
    courseName: "Distributed Systems",
    courseCode: null,
  });
  const links = {
    CS425: { gradescope: ["gradescope:999"], confirmed: true },
  };
  assert.equal(digest.courseLabel(customItem, links), "CS 425");
});

test("renderRow builds DOM with badge, clean course label, and no overlap", () => {
  const { document } = require("linkedom").parseHTML("<!doctype html><html><body></body></html>");
  globalThis.document = document;
  const rowItem = item({
    source: "gradescope",
    courseName: "CS425 ECE428 Fall 2026",
    title: "HW 4",
    dueAt: "2026-11-12T06:00:00Z",
    url: "https://www.gradescope.com/courses/9/assignments/44",
  });
  const row = digest.renderRow(rowItem);
  assert.equal(row.querySelector(".prr-digest-badge").textContent, "Gradescope");
  assert.equal(row.querySelector(".prr-digest-course").textContent, "CS 425");
  assert.equal(row.querySelector(".prr-digest-title").textContent, "HW 4");
  assert.ok(row.querySelector(".prr-digest-due"));
});

test("renderRow supports all sources with clean uppercase badge labels", () => {
  const { document } = require("linkedom").parseHTML("<!doctype html><html><body></body></html>");
  globalThis.document = document;
  const sources = ["canvas", "gradescope", "prairietest", "courseweb", "prairielearn"];
  for (const source of sources) {
    const r = digest.renderRow(item({ source, title: "Test", courseCode: "CS 101" }));
    assert.ok(r.querySelector(".prr-digest-badge").textContent.length > 0);
    assert.equal(r.querySelector(".prr-digest-course").textContent, "CS 101");
  }
});

test("selectDigestItems deduplicates cross-source duplicates for the same course", () => {
  const now = new Date("2026-11-10T18:00:00Z");
  const gsItem = item({
    id: "gs-hw4",
    source: "gradescope",
    courseCode: "CS 425",
    title: "HW4",
    dueAt: "2026-11-12T06:00:00Z",
    url: "https://gradescope.com/hw4",
  });
  const cwItem = item({
    id: "cw-hw4",
    source: "courseweb",
    courseCode: "CS 425",
    title: "HW4",
    dueAt: "2026-11-12T06:00:00Z",
    url: "https://courses.grainger.illinois.edu/cs425/hw4.html",
  });
  const selected = digest.selectDigestItems([gsItem, cwItem], { now });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, "gs-hw4");
  assert.equal(selected[0].source, "gradescope");
});

test("selectDigestItems deduplicates across title whitespace variations (HW4 vs HW 4)", () => {
  const now = new Date("2026-11-10T18:00:00Z");
  const gsItem = item({
    id: "gs-hw4",
    source: "gradescope",
    courseCode: "CS 425",
    title: "HW 4",
    dueAt: "2026-11-12T06:00:00Z",
  });
  const cwItem = item({
    id: "cw-hw4",
    source: "courseweb",
    courseCode: "CS 425",
    title: "HW4",
    dueAt: "2026-11-12T06:00:00Z",
  });
  const selected = digest.selectDigestItems([cwItem, gsItem], { now });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].source, "gradescope");
});

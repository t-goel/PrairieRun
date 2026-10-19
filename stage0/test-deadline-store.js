const assert = require("node:assert/strict");
const test = require("node:test");

const model = require("../extension/deadline-model.js");
const store = require("../extension/deadline-store.js");

const DUE = "2026-10-18T04:59:00.000Z";

function gradescopeItem(overrides = {}) {
  return model.makeDeadlineItem({
    id: "gs:9:555",
    source: "gradescope",
    kind: "assignment",
    courseKey: "gradescope:9",
    courseName: "CS 425",
    courseCode: "CS 425",
    title: "HW 3",
    dueAt: DUE,
    status: "submitted",
    url: "https://www.gradescope.com/courses/9/assignments/555",
    ...overrides,
  });
}

function canvasItem(overrides = {}) {
  return model.makeDeadlineItem({
    id: "canvas:55:assignment:123",
    source: "canvas",
    kind: "assignment",
    courseKey: "canvas:55",
    courseName: "CS 425",
    courseCode: "CS 425",
    title: "HW 3",
    dueAt: DUE,
    status: "unknown",
    url: "https://canvas.illinois.edu/courses/55/assignments/123",
    ...overrides,
  });
}

function confirmedLink() {
  return {
    "CS 425": {
      gradescope: ["gradescope:9"],
      canvas: ["canvas:55"],
      confirmed: true,
    },
  };
}

function okResult(items) {
  return { status: "ok", items, checkedAt: "2026-10-16T00:00:00.000Z" };
}

test("confirmed link merges the Canvas feed duplicate into the Gradescope item", () => {
  const { items, changes, nearMisses } = store.mergeSourceResults(
    [],
    { gradescope: okResult([gradescopeItem()]), canvas: okResult([canvasItem()]) },
    confirmedLink()
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "gs:9:555");
  assert.ok(items[0].aliases.includes("canvas:55:assignment:123"));
  assert.ok(items[0].sourceUrls.includes("https://canvas.illinois.edu/courses/55/assignments/123"));
  // Gradescope already carries a real status, so it is kept.
  assert.equal(items[0].status, "submitted");
  assert.deepEqual(changes.added, ["gs:9:555"]);
  assert.deepEqual(nearMisses, []);
});

test("unconfirmed link keeps both items", () => {
  const links = confirmedLink();
  links["CS 425"].confirmed = false;
  const { items, nearMisses } = store.mergeSourceResults(
    [],
    { gradescope: okResult([gradescopeItem()]), canvas: okResult([canvasItem()]) },
    links
  );
  assert.equal(items.length, 2);
  assert.deepEqual(nearMisses, []);
});

test("same title with a 2-hour delta is a near miss, not a merge", () => {
  const late = canvasItem({ dueAt: "2026-10-18T06:59:00.000Z" });
  const { items, nearMisses } = store.mergeSourceResults(
    [],
    { gradescope: okResult([gradescopeItem()]), canvas: okResult([late]) },
    confirmedLink()
  );
  assert.equal(items.length, 2);
  assert.equal(nearMisses.length, 1);
  assert.equal(nearMisses[0].deltaMinutes, 120);
  assert.deepEqual([nearMisses[0].a, nearMisses[0].b].sort(), ["canvas:55:assignment:123", "gs:9:555"]);
});

test("Canvas CRN section suffix does not block the title match", () => {
  const tagged = canvasItem({ title: "HW 3 (CS 425 AL1 Fall 2026 CRN12345)" });
  const { items } = store.mergeSourceResults(
    [],
    { gradescope: okResult([gradescopeItem()]), canvas: okResult([tagged]) },
    confirmedLink()
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "gs:9:555");
});

test("signed_out source keeps its previous items and reports no changes", () => {
  const prev = [gradescopeItem(), canvasItem()];
  const first = store.mergeSourceResults(
    prev,
    {
      gradescope: { status: "signed_out", items: [], checkedAt: "2026-10-16T00:00:00.000Z" },
      canvas: okResult([canvasItem()]),
    },
    {}
  );
  assert.equal(first.items.length, 2);
  assert.ok(first.items.some((item) => item.id === "gs:9:555"));
  assert.deepEqual(first.changes, { added: [], changed: [], removed: [] });

  // Same for an error result on a source missing fresh items.
  const second = store.mergeSourceResults(
    prev,
    { gradescope: { status: "error", items: [], error: "boom", checkedAt: "2026-10-16T00:00:00.000Z" } },
    {}
  );
  assert.equal(second.items.length, 2);
  assert.deepEqual(second.changes, { added: [], changed: [], removed: [] });
});

test("merging the same results twice is idempotent", () => {
  const results = {
    gradescope: okResult([gradescopeItem()]),
    canvas: okResult([canvasItem()]),
  };
  const links = confirmedLink();
  const first = store.mergeSourceResults([], results, links);
  assert.equal(first.items.length, 1);
  const second = store.mergeSourceResults(first.items, results, links);
  assert.deepEqual(second.items, first.items);
  assert.deepEqual(second.changes, { added: [], changed: [], removed: [] });
  assert.deepEqual(second.nearMisses, []);
});

test("ok status replaces that source's items and reports changed", () => {
  const results = { gradescope: okResult([gradescopeItem()]) };
  const first = store.mergeSourceResults([], results, {});
  const second = store.mergeSourceResults(
    first.items,
    { gradescope: okResult([gradescopeItem({ title: "HW 3 revised" })]) },
    {}
  );
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].title, "HW 3 revised");
  assert.deepEqual(second.changes.changed, ["gs:9:555"]);
});

test("settings opt-out drops that source's items", () => {
  const { items, changes } = store.mergeSourceResults(
    [gradescopeItem(), canvasItem()],
    {},
    {},
    { sources: { canvas: { enabled: false } } }
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "gradescope");
  assert.deepEqual(changes.removed, ["canvas:55:assignment:123"]);
});

test("suggestCourseLinks groups all three sources under CS 425", () => {
  const plItem = model.makeDeadlineItem({
    id: "pl:229304:assessment:2724826",
    source: "prairielearn",
    kind: "assignment",
    courseKey: "prairielearn:229304",
    courseName: "CS 425: Distributed Systems",
    courseCode: "CS 425",
    title: "HW 3",
    dueAt: DUE,
    url: "https://us.prairielearn.com/pl/course_instance/229304/assessment/2724826/",
  });
  const links = store.suggestCourseLinks([canvasItem(), gradescopeItem(), plItem]);
  assert.ok(links["CS 425"]);
  assert.deepEqual(links["CS 425"].canvas, ["canvas:55"]);
  assert.deepEqual(links["CS 425"].gradescope, ["gradescope:9"]);
  assert.deepEqual(links["CS 425"].prairielearn, ["prairielearn:229304"]);
  assert.equal(links["CS 425"].confirmed, false);
});

test("normTitle ignores case, punctuation, and the CRN suffix", () => {
  assert.equal(store.normTitle("HW 3 (CS 425 AL1 Fall 2026 CRN12345)"), "hw 3");
  assert.equal(store.normTitle("  HW-3! "), "hw3");
  assert.equal(store.normTitle("Group Activity 9: B+ Trees"), "group activity 9 b trees");
});

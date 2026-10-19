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
  assert.ok(links["CS425"]);
  assert.deepEqual(links["CS425"].canvas, ["canvas:55"]);
  assert.deepEqual(links["CS425"].gradescope, ["gradescope:9"]);
  assert.deepEqual(links["CS425"].prairielearn, ["prairielearn:229304"]);
  assert.equal(links["CS425"].confirmed, false);
});

test("normTitle ignores case, punctuation, and the CRN suffix", () => {
  assert.equal(store.normTitle("HW 3 (CS 425 AL1 Fall 2026 CRN12345)"), "hw 3");
  assert.equal(store.normTitle("  HW-3! "), "hw3");
  assert.equal(store.normTitle("Group Activity 9: B+ Trees"), "group activity 9 b trees");
});

function prairielearnItem(overrides = {}) {
  return model.makeDeadlineItem({
    id: "pl:101:assessment:1",
    source: "prairielearn",
    kind: "assignment",
    courseKey: "prairielearn:101",
    courseName: "CS 498",
    courseCode: "CS 498",
    title: "HW 1",
    dueAt: DUE,
    url: "https://us.prairielearn.com/pl/course_instance/101/assessment/1/",
    ...overrides,
  });
}

function prairietestItem(overrides = {}) {
  return model.makeDeadlineItem({
    id: "pt:4:5",
    source: "prairietest",
    kind: "assignment",
    courseKey: "prairietest:4",
    courseName: "CS 498",
    courseCode: "CS 498",
    title: "HW 1",
    dueAt: DUE,
    url: "https://prairietest.example.com/courses/4/assignments/5",
    ...overrides,
  });
}

test("normalizeCourseCode ignores case, whitespace, and punctuation", () => {
  assert.equal(store.normalizeCourseCode("CS 498"), "CS498");
  assert.equal(store.normalizeCourseCode("cs-498"), "CS498");
  assert.equal(store.normalizeCourseCode("CS498"), "CS498");
  assert.equal(store.normalizeCourseCode(" cs_498 "), "CS498");
  // Long display names keep at most the code core plus 3 trailing letters.
  assert.equal(store.normalizeCourseCode("CS 425 AL1 Fall 2026 CRN12345"), "CS425AL1");
});

test("CS498, CS498DK, and CS498DK2 land in one family bucket", () => {
  const links = store.suggestCourseLinks([
    prairietestItem({ courseCode: "CS 498" }),
    prairielearnItem({ courseCode: "CS 498DK", courseKey: "prairielearn:101" }),
    prairielearnItem({
      id: "pl:202:assessment:2",
      courseCode: "CS 498DK2",
      courseKey: "prairielearn:202",
      url: "https://us.prairielearn.com/pl/course_instance/202/assessment/2/",
    }),
  ]);
  const codes = Object.keys(links);
  assert.deepEqual(codes, ["CS498"]);
  assert.deepEqual(links["CS498"].prairietest, ["prairietest:4"]);
  assert.deepEqual(links["CS498"].prairielearn, ["prairielearn:101", "prairielearn:202"]);
  assert.equal(links["CS498"].confirmed, false);
});

test("codes differing only in case/whitespace/punctuation share one bucket", () => {
  const links = store.suggestCourseLinks([
    prairietestItem({ courseCode: "cs-498" }),
    prairielearnItem({ courseCode: "CS498", courseKey: "prairielearn:101" }),
  ]);
  assert.deepEqual(Object.keys(links), ["CS498"]);
});

test("near prefixes such as CS49 and CS4 are not a family (false positives)", () => {
  const cs49 = store.suggestCourseLinks([
    prairietestItem({ courseCode: "CS498" }),
    gradescopeItem({ courseCode: "CS49", courseKey: "gradescope:9", id: "gs:9:49" }),
  ]);
  assert.equal(Object.keys(cs49).length, 2);
  const cs4 = store.suggestCourseLinks([
    prairietestItem({ courseCode: "CS498" }),
    gradescopeItem({ courseCode: "CS4", courseKey: "gradescope:9", id: "gs:9:4" }),
  ]);
  assert.equal(Object.keys(cs4).length, 2);
});

test("linked family buckets merge across suffixed course codes", () => {
  const links = {
    CS498: { gradescope: ["gradescope:9"], confirmed: true },
    "CS498DK": { prairietest: ["prairietest:4"], canvas: ["canvas:55"], confirmed: true },
  };
  const { items, nearMisses } = store.mergeSourceResults(
    [],
    {
      gradescope: okResult([gradescopeItem({ courseCode: "CS498" })]),
      prairietest: okResult([prairietestItem({ courseCode: "CS 498DK2", title: "HW 3" })]),
      canvas: okResult([canvasItem({ courseCode: "CS 498DK2" })]),
    },
    links
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "gs:9:555");
  assert.ok(items[0].aliases.includes("canvas:55:assignment:123"));
  assert.ok(items[0].aliases.includes("pt:4:5"));
  assert.deepEqual(nearMisses, []);
});

test("near-miss detection covers title-prefix pairs across linked courses", () => {
  const gs = gradescopeItem({ title: "Quiz 1" });
  const cv = canvasItem({ title: "Quiz 1 (extension)", dueAt: "2026-10-18T06:59:00.000Z" });
  const { items, nearMisses } = store.mergeSourceResults(
    [],
    { gradescope: okResult([gs]), canvas: okResult([cv]) },
    confirmedLink()
  );
  assert.equal(items.length, 2);
  assert.equal(nearMisses.length, 1);
  assert.equal(nearMisses[0].deltaMinutes, 120);
});

test("linked title-prefix pairs merge within the dedupe window", () => {
  const cv = canvasItem({ title: "HW 3 (extension)", dueAt: "2026-10-18T05:02:00.000Z" });
  const { items, nearMisses } = store.mergeSourceResults(
    [],
    { gradescope: okResult([gradescopeItem()]), canvas: okResult([cv]) },
    confirmedLink()
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "gs:9:555");
  assert.ok(items[0].aliases.includes("canvas:55:assignment:123"));
  assert.deepEqual(nearMisses, []);
});

test("digit-suffix titles like Quiz 1 vs Quiz 10 are never duplicates", () => {
  const gs = gradescopeItem({ title: "Quiz 1" });
  const cv = canvasItem({ title: "Quiz 10", dueAt: "2026-10-18T06:59:00.000Z" });
  const { items, nearMisses } = store.mergeSourceResults(
    [],
    { gradescope: okResult([gs]), canvas: okResult([cv]) },
    confirmedLink()
  );
  assert.equal(items.length, 2);
  assert.deepEqual(nearMisses, []);
});

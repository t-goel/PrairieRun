// Options page Course links table unit tests (PR 7).
// Runs directly in Node (`node --test stage0/test-options-courses.js`).
const assert = require("node:assert/strict");
const test = require("node:test");

const store = require("../extension/deadline-store.js");
globalThis.PrairieRunDeadlineStore = store;
const courses = require("../extension/options-courses.js");

test("migrateStoredLinks re-keys legacy spaced codes to normalized form", () => {
  const legacy = {
    "CS 425": { canvas: ["canvas:55"], prairielearn: ["prairielearn:99"], confirmed: true },
  };
  const migrated = courses.migrateStoredLinks(legacy);
  assert.equal(migrated["CS 425"], undefined);
  assert.ok(migrated.CS425);
  assert.deepEqual(migrated.CS425.canvas, ["canvas:55"]);
  assert.deepEqual(migrated.CS425.prairielearn, ["prairielearn:99"]);
  assert.equal(migrated.CS425.confirmed, true);
});

test("migrateStoredLinks folds same-family legacy keys into one bucket", () => {
  const legacy = {
    CS498: { prairielearn: ["prairielearn:101"], confirmed: false },
    "CS 498 DK": { canvas: ["canvas:55"], confirmed: true },
  };
  const migrated = courses.migrateStoredLinks(legacy);
  assert.deepEqual(Object.keys(migrated), ["CS498"]);
  assert.deepEqual(migrated.CS498.prairielearn, ["prairielearn:101"]);
  assert.deepEqual(migrated.CS498.canvas, ["canvas:55"]);
  assert.equal(migrated.CS498.confirmed, true);
});

test("migrateStoredLinks keeps unrelated codes on separate rows", () => {
  const legacy = {
    "CS 225": { canvas: ["canvas:225"], confirmed: true },
    "CS 425": { canvas: ["canvas:425"], confirmed: true },
  };
  const migrated = courses.migrateStoredLinks(legacy);
  assert.deepEqual(Object.keys(migrated).sort(), ["CS225", "CS425"]);
});

test("migrateStoredLinks handles empty/colliding legacy entries", () => {
  assert.deepEqual(courses.migrateStoredLinks(null), {});
  assert.deepEqual(courses.migrateStoredLinks({}), {});
  const colliding = {
    "CS 425": { canvas: ["canvas:55"], confirmed: false },
    CS425: { canvas: ["canvas:55", "canvas:56"], confirmed: true },
  };
  const migrated = courses.migrateStoredLinks(colliding);
  assert.deepEqual(Object.keys(migrated), ["CS425"]);
  assert.deepEqual(migrated.CS425.canvas.sort(), ["canvas:55", "canvas:56"]);
  assert.equal(migrated.CS425.confirmed, true);
});

test("courseHomeUrl maps assignment URLs to course homes", () => {
  assert.equal(
    courses.courseHomeUrl("https://us.prairielearn.com/pl/course_instance/101/assessment/55/"),
    "https://us.prairielearn.com/pl/course_instance/101/assessments"
  );
  assert.equal(
    courses.courseHomeUrl("https://canvas.illinois.edu/courses/55/assignments/123"),
    "https://canvas.illinois.edu/courses/55"
  );
  assert.equal(
    courses.courseHomeUrl("https://www.gradescope.com/courses/9/assignments/555"),
    "https://www.gradescope.com/courses/9"
  );
  assert.equal(
    courses.courseHomeUrl("https://www.gradescope.com/courses/9"),
    "https://www.gradescope.com/courses/9"
  );
  assert.equal(
    courses.courseHomeUrl("https://prairietest.example.com/pt/reservations/1"),
    "https://prairietest.example.com/pt"
  );
  assert.equal(courses.courseHomeUrl("not a url"), null);
  assert.equal(courses.courseHomeUrl(""), null);
});

test("urlsByCourseKey keeps the first home URL per courseKey", () => {
  const map = courses.urlsByCourseKey([
    {
      courseKey: "prairielearn:101",
      url: "https://us.prairielearn.com/pl/course_instance/101/assessment/1/",
    },
    {
      courseKey: "prairielearn:101",
      url: "https://us.prairielearn.com/pl/course_instance/101/assessment/2/",
    },
    {
      courseKey: "gradescope:9",
      url: "https://www.gradescope.com/courses/9/assignments/555",
    },
  ]);
  assert.equal(map.get("prairielearn:101"), "https://us.prairielearn.com/pl/course_instance/101/assessments");
  assert.equal(map.get("gradescope:9"), "https://www.gradescope.com/courses/9");
});

test("resolveCourseHref matches courseKey, courseName, or legacy code", () => {
  const items = [
    {
      source: "canvas",
      courseKey: "canvas:55",
      courseName: "CS 425",
      courseCode: "CS 425",
      url: "https://canvas.illinois.edu/courses/55/assignments/123",
    },
    {
      source: "prairielearn",
      courseKey: "prairielearn:101",
      courseName: "CS 498DK2",
      courseCode: "CS 498DK2",
      url: "https://us.prairielearn.com/pl/course_instance/101/assessment/1/",
    },
  ];
  const urls = courses.urlsByCourseKey(items);
  assert.equal(
    courses.resolveCourseHref(items, "canvas", "canvas:55", urls),
    "https://canvas.illinois.edu/courses/55"
  );
  assert.equal(
    courses.resolveCourseHref(items, "canvas", "CS 425", urls),
    "https://canvas.illinois.edu/courses/55"
  );
  assert.equal(
    courses.resolveCourseHref(items, "prairielearn", "CS 498DK2", urls),
    "https://us.prairielearn.com/pl/course_instance/101/assessments"
  );
  assert.equal(courses.resolveCourseHref(items, "gradescope", "CS 425", urls), null);
});

test("appendPresenceLink renders a green check and Link anchor", () => {
  const { document } = require("linkedom").parseHTML("<!doctype html><html><body></body></html>");
  const cell = document.createElement("td");
  courses.appendPresenceLink(cell, document, "https://www.gradescope.com/courses/9", "Gradescope");
  const link = cell.querySelector("a.prr-course-link");
  assert.ok(link);
  assert.equal(link.getAttribute("href"), "https://www.gradescope.com/courses/9");
  assert.match(link.textContent, /✓\s*Link/);
  assert.equal(link.querySelector(".prr-course-link__check")?.textContent, "✓");
});

test("firstCourseHref picks the first resolvable course page", () => {
  const items = [
    {
      source: "canvas",
      courseKey: "canvas:55",
      url: "https://canvas.illinois.edu/courses/55/assignments/123",
    },
  ];
  const urls = courses.urlsByCourseKey(items);
  assert.equal(
    courses.firstCourseHref(items, "canvas", ["canvas:55"], urls),
    "https://canvas.illinois.edu/courses/55"
  );
  assert.equal(courses.firstCourseHref(items, "gradescope", ["gradescope:9"], urls), null);
});

test("foldLinkRows collapses CS498DK into CS498", () => {
  const folded = courses.foldLinkRows(
    { CS498DK: { prairielearn: ["prairielearn:101"], confirmed: false } },
    {
      CS498: {
        prairielearn: ["prairielearn:101"],
        canvas: ["canvas:55"],
        prairietest: ["prairietest:CS 498"],
        confirmed: false,
      },
    }
  );
  assert.deepEqual(folded.codes, ["CS498"]);
  assert.deepEqual(folded.suggested.CS498.canvas, ["canvas:55"]);
  assert.deepEqual(folded.links.CS498.prairielearn, ["prairielearn:101"]);
});

test("buildTable renders check Link for enrolled Gradescope course with zero assignments", () => {
  const { document } = require("linkedom").parseHTML("<!doctype html><html><body></body></html>");
  const items = [
    {
      source: "canvas",
      courseKey: "canvas:55",
      courseCode: "CS 425",
      courseName: "CS 425 AL1 Fall 2026",
      url: "https://canvas.illinois.edu/courses/55/assignments/123",
    },
  ];
  const enrolledCourses = [
    {
      source: "gradescope",
      courseKey: "gradescope:101",
      courseCode: "CS 425",
      courseName: "Fall 2026 CS 425",
      url: "https://www.gradescope.com/courses/101",
    },
  ];
  const allEntities = [...items, ...enrolledCourses];
  const suggested = store.suggestCourseLinks(allEntities);
  const links = {
    CS425: { canvas: ["canvas:55"], gradescope: ["gradescope:101"], confirmed: true },
  };

  const { table, codes } = courses.buildTable(document, allEntities, links, suggested);
  assert.deepEqual(codes, ["CS425"]);

  const row = table.querySelector("tr:nth-child(2)");
  assert.ok(row, "expected data row");
  const cells = [...row.querySelectorAll("td")];
  // Columns: Course, PrairieLearn, Gradescope, Canvas, PrairieTest, Website
  assert.equal(cells[0].textContent, "CS425");
  assert.equal(cells[1].textContent, "—"); // PrairieLearn
  assert.match(cells[2].textContent, /✓\s*Link/); // Gradescope
  const gsAnchor = cells[2].querySelector("a.prr-course-link");
  assert.ok(gsAnchor);
  assert.equal(gsAnchor.getAttribute("href"), "https://www.gradescope.com/courses/101");
  assert.match(cells[3].textContent, /✓\s*Link/); // Canvas
  assert.equal(cells[4].textContent, "—"); // PrairieTest
});

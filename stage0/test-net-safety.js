const assert = require("node:assert/strict");
const test = require("node:test");
const { assertSafeUrl, fetchPage } = require("../extension/net.js");

test("assertSafeUrl rejects PrairieLearn assessment start routes", () => {
  const blocked = [
    "https://us.prairielearn.com/pl/course_instance/229304/assessment/2724861/",
    "https://us.prairielearn.com/pl/course_instance/229304/assessment/2724861",
    "https://us.prairielearn.com/pl/course_instance/229304/assessment/2724861?x=1",
  ];
  for (const url of blocked) {
    assert.throws(() => assertSafeUrl(url), /Unsafe|SafetyError/);
  }
});

test("assertSafeUrl allows safe PrairieLearn paths", () => {
  const allowed = [
    "https://us.prairielearn.com/pl",
    "https://us.prairielearn.com/pl/",
    "https://us.prairielearn.com/pl/course_instance/229304/assessments",
    "https://us.prairielearn.com/pl/course_instance/229304/assessment_instance/14526257/",
    "https://us.prairielearn.com/pl/course_instance/229304/assessment/2724861/__prairierun_identity__",
  ];
  for (const url of allowed) {
    assert.ok(assertSafeUrl(url));
  }
});

test("fetchPage rejects non-GET methods without fetching", async () => {
  await assert.rejects(() => fetchPage("https://us.prairielearn.com/pl", { method: "POST" }), /GET/);
});

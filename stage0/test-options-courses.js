// Tests for the stored course-links migration in extension/options-courses.js.
// Legacy spaced keys ("CS 498", "CS 498DK") must collapse into the suggested
// family bucket ("CS498") so the Course links table shows one row per family.
const assert = require("node:assert/strict");
const test = require("node:test");

globalThis.PrairieRunDeadlineStore = require("../extension/deadline-store.js");
const courses = require("../extension/options-courses.js");

test("migrateStoredLinks re-keys legacy spaced codes to normalized form", () => {
  const migrated = courses.migrateStoredLinks({
    "CS 425": { prairielearn: ["CS 425"], confirmed: true },
  });
  assert.deepEqual(migrated, {
    CS425: { prairielearn: ["CS 425"], confirmed: true },
  });
});

test("migrateStoredLinks folds same-family legacy keys into one bucket", () => {
  const migrated = courses.migrateStoredLinks({
    "CS 498": { canvas: ["CS 498"], prairietest: ["CS 498"], confirmed: false },
    "CS 498DK": { prairielearn: ["CS 498DK"], confirmed: true },
    "cs-498dk2": { prairielearn: ["CS 498DK2"], confirmed: false },
  });
  const codes = Object.keys(migrated);
  assert.deepEqual(codes, ["CS498"]);
  const bucket = migrated.CS498;
  assert.equal(bucket.confirmed, true, "any confirmed member keeps the bucket confirmed");
  assert.deepEqual([...new Set(bucket.prairielearn)].sort(), ["CS 498DK", "CS 498DK2"]);
  assert.deepEqual(bucket.canvas, ["CS 498"]);
  assert.deepEqual(bucket.prairietest, ["CS 498"]);
});

test("migrateStoredLinks keeps unrelated codes on separate rows", () => {
  const migrated = courses.migrateStoredLinks({
    "CS 425": { prairielearn: ["CS 425"] },
    "CS 498": { canvas: ["CS 498"] },
  });
  assert.deepEqual(
    Object.keys(migrated).sort(),
    ["CS425", "CS498"],
    "CS4 is not a family of CS498 and must not fold"
  );
});

test("migrateStoredLinks handles empty/colliding legacy entries", () => {
  assert.deepEqual(courses.migrateStoredLinks(null), {});
  assert.deepEqual(courses.migrateStoredLinks({}), {});
  const migrated = courses.migrateStoredLinks({
    "CS 498": { prairielearn: ["CS 498"], confirmed: false },
    CS498: { canvas: ["CS 498"], confirmed: true },
  });
  assert.deepEqual(Object.keys(migrated), ["CS498"]);
  assert.equal(migrated.CS498.confirmed, true);
  assert.deepEqual([...new Set(migrated.CS498.prairielearn)], ["CS 498"]);
  assert.deepEqual(migrated.CS498.canvas, ["CS 498"]);
});

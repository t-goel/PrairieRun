// Tests for the new dashboard column layout and nested Canvas & CourseWeb sources options.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { parseHTML } = require("linkedom");

const optionsHtmlPath = path.join(__dirname, "../extension/options.html");
const optionsHtml = fs.readFileSync(optionsHtmlPath, "utf-8");

test("options.html has the expected left/right columns and nested sources controls", () => {
  const { document } = parseHTML(optionsHtml);

  const leftCol = document.querySelector(".page-col.page-col--left");
  const rightCol = document.querySelector(".page-col.page-col--right");
  assert.ok(leftCol, "left column exists");
  assert.ok(rightCol, "right column exists");

  // Left column sections: Reminders, Sources
  const leftSections = Array.from(leftCol.children).filter((el) => el.tagName === "SECTION");
  assert.equal(leftSections.length, 2, "left column has 2 cards");
  assert.equal(leftSections[0].id, "output-settings", "card 1 is reminders");
  assert.equal(leftSections[1].id, "sources", "card 2 is sources");

  // Right column sections: Calendar, Course links, Exclude Assignments
  const rightSections = Array.from(rightCol.children).filter((el) => el.tagName === "SECTION");
  assert.equal(rightSections.length, 3, "right column has 3 cards");
  assert.equal(rightSections[0].id, "calendar-card", "card 1 is calendar");
  assert.equal(rightSections[1].id, "course-links", "card 2 is course links");
  assert.equal(rightSections[2].id, "assignment-filters", "card 3 is exclude assignments");

  // Sources card contains nested Canvas subpanel and UIUC course websites subpanel
  const sourcesCard = document.querySelector("#sources");
  assert.ok(sourcesCard, "sources card exists");

  const canvasSetup = sourcesCard.querySelector("#canvas-setup");
  assert.ok(canvasSetup, "#canvas-setup is inside #sources");
  const canvasItem = canvasSetup.closest('li[data-source-id="canvas"]');
  assert.ok(canvasItem, "#canvas-setup is inside the Canvas source item");

  const courseWeb = sourcesCard.querySelector("#course-websites");
  assert.ok(courseWeb, "#course-websites is inside #sources");
  const courseWebItem = courseWeb.closest('li[data-source-id="courseweb"]');
  assert.ok(courseWebItem, "#course-websites is inside the courseweb source item");

  // Standalone cards are gone from the top level
  assert.equal(document.querySelectorAll("#course-websites").length, 1);
  assert.equal(document.querySelectorAll("#canvas-setup").length, 1);

  // Digest is at the bottom
  const digest = document.querySelector("#assignment-digest");
  assert.ok(digest, "#assignment-digest exists");
});

test("options-courseweb mounts and renders saved course pages with remove buttons", async () => {
  const { document } = parseHTML(optionsHtml);
  globalThis.document = document;

  let storedSettings = {
    courseWebsites: ["https://courses.grainger.illinois.edu/cs425/fa2026/assignments.html"],
  };

  globalThis.PrairieRunExt = {
    storageLocalGet: async (key) => ({ [key]: storedSettings }),
    storageLocalSet: async (obj) => {
      if (obj.prairierunSettings) storedSettings = obj.prairierunSettings;
    },
    addStorageChangedListener: () => {},
  };

  require("../extension/deadline-model.js");
  require("../extension/source-courseweb.js");
  delete require.cache[require.resolve("../extension/options-courseweb.js")];
  require("../extension/options-courseweb.js");

  const courseweb = globalThis.PrairieRunCourseWebOptions;
  assert.ok(courseweb, "PrairieRunCourseWebOptions is exported");
  await courseweb.init(document);

  const list = document.querySelector("#course-websites-list");
  assert.equal(list.children.length, 1, "renders 1 course page item");
  const link = list.querySelector("a");
  assert.equal(link.textContent, "https://courses.grainger.illinois.edu/cs425/fa2026/assignments.html");
  const removeBtn = list.querySelector("button");
  assert.ok(removeBtn, "remove button exists");

  // Click remove button
  removeBtn.click();
  // Wait microtask for async remove handler
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(storedSettings.courseWebsites, [], "course page was removed from settings");
  assert.equal(list.children.length, 0, "course page list is now empty in DOM");
});

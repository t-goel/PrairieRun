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

test("selectDigestItems filters out removedDeadlines", () => {
  const now = new Date("2026-11-10T18:00:00Z");
  const keep = item({ id: "keep-1", title: "Keep", dueAt: "2026-11-12T06:00:00Z" });
  const drop = item({ id: "office-hours", title: "Office Hours", dueAt: "2026-11-12T06:00:00Z" });
  const selected = digest.selectDigestItems([keep, drop], { now, removedDeadlines: ["office-hours"] });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, "keep-1");
});

test("renderRow reflects isExcluded with prr-digest-row--excluded and prr-digest-row--calendar-hidden", () => {
  const { document } = require("linkedom").parseHTML("<!doctype html><html><body></body></html>");
  globalThis.document = document;
  const rowItem = item({ id: "hw4", title: "HW 4", dueAt: "2026-11-12T06:00:00Z" });
  const row = digest.renderRow(rowItem, null, { isExcluded: true, isCalendarHidden: true });
  assert.ok(row.classList.contains("prr-digest-row--excluded"));
  assert.ok(row.classList.contains("prr-digest-row--calendar-hidden"));
});

test("renderRow builds action buttons with hide-from-calendar and remove controls", () => {
  const { document } = require("linkedom").parseHTML("<!doctype html><html><body></body></html>");
  globalThis.document = document;
  const rowItem = item({
    id: "item-1",
    source: "canvas",
    courseCode: "CS 425",
    title: "Office Hours",
    dueAt: "2026-11-12T06:00:00Z",
  });
  let toggled = false;
  let removed = false;
  const row = digest.renderRow(rowItem, null, {
    isCalendarHidden: false,
    onToggleHide: () => { toggled = true; },
    onRemove: () => { removed = true; },
  });
  const hideBtn = row.querySelector(".prr-digest-action-hide");
  const removeBtn = row.querySelector(".prr-digest-action-remove");
  assert.ok(hideBtn);
  assert.ok(removeBtn);
  assert.equal(hideBtn.getAttribute("aria-label"), "Hide from calendar");
  assert.equal(removeBtn.getAttribute("aria-label"), "Remove");
  hideBtn.click();
  removeBtn.click();
  assert.equal(toggled, true);
  assert.equal(removed, true);
});

test("renderRow reflects isCalendarHidden with active button and row class", () => {
  const { document } = require("linkedom").parseHTML("<!doctype html><html><body></body></html>");
  globalThis.document = document;
  const rowItem = item({
    id: "item-2",
    source: "canvas",
    title: "Discussion",
    dueAt: "2026-11-12T06:00:00Z",
  });
  const row = digest.renderRow(rowItem, null, { isCalendarHidden: true });
  assert.ok(row.classList.contains("prr-digest-row--calendar-hidden"));
  const hideBtn = row.querySelector(".prr-digest-action-hide");
  assert.ok(hideBtn.classList.contains("prr-digest-action-btn--active"));
  assert.equal(hideBtn.getAttribute("aria-label"), "Unhide from calendar");
});

test("render handles in-place toggle and filter updates without recreating DOM nodes", async () => {
  const { document, window } = require("linkedom").parseHTML("<!doctype html><html><body><div id='assignment-digest'></div></body></html>");
  globalThis.document = document;
  globalThis.window = window;

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const nextDay = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  const storage = {
    prairierunDeadlines: [
      item({ id: "hw4", title: "HW4", dueAt: tomorrow, source: "gradescope" }),
      item({ id: "mp4", title: "MP4", dueAt: nextDay, source: "gradescope" }),
    ],
    prairierunHiddenFromCalendar: [],
    prairierunRemovedDeadlines: [],
    prairierunKeywordFilters: [],
  };

  const listeners = [];
  globalThis.PrairieRunExt = {
    storageLocalGet: async (keys) => {
      if (typeof keys === "string") return { [keys]: storage[keys] };
      const out = {};
      for (const k of keys) out[k] = storage[k];
      return out;
    },
    storageLocalSet: async (obj) => {
      Object.assign(storage, obj);
    },
    addStorageChangedListener: (fn) => listeners.push(fn),
    storageOnChanged: (fn) => listeners.push(fn),
    runtimeSendMessage: async () => {},
  };

  const section = document.getElementById("assignment-digest");
  await digest.render(section);

  const root = section.querySelector("[data-prr-digest]");
  assert.ok(root);
  const rows = root.querySelectorAll(".prr-digest-row");
  assert.equal(rows.length, 2);

  const hw4Row = rows[0];
  const mp4Row = rows[1];

  // 1. In-place toggle hide
  const hw4HideBtn = hw4Row.querySelector(".prr-digest-action-hide");
  hw4HideBtn.click();

  // Button and row updated in place:
  assert.ok(hw4HideBtn.classList.contains("prr-digest-action-btn--active"));
  assert.ok(hw4Row.classList.contains("prr-digest-row--calendar-hidden"));
  // DOM element identity preserved:
  assert.equal(root.querySelectorAll(".prr-digest-row")[0], hw4Row);

  // 2. In-place filter change event:
  const filterEvt = new window.CustomEvent("prairierun-filters-changed", { detail: { keywords: ["mp4"] } });
  document.dispatchEvent(filterEvt);

  assert.ok(mp4Row.classList.contains("prr-digest-row--excluded"));
  assert.ok(mp4Row.classList.contains("prr-digest-row--calendar-hidden"));
  // Node identity is still preserved:
  assert.equal(root.querySelectorAll(".prr-digest-row")[1], mp4Row);

  // 3. In-place remove
  const mp4RemoveBtn = mp4Row.querySelector(".prr-digest-action-remove");
  mp4RemoveBtn.click();

  assert.equal(root.querySelectorAll(".prr-digest-row").length, 1);
  assert.equal(root.querySelectorAll(".prr-digest-row")[0], hw4Row);
});

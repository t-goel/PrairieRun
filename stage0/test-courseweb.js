// Courseweb UIUC page parser tests (CS425-style due lines).
const assert = require("node:assert/strict");
const test = require("node:test");
const { parseHTML } = require("linkedom");

require("../extension/deadline-model.js");
const courseweb = require("../extension/source-courseweb.js");

const CS425_URL = "https://courses.grainger.illinois.edu/cs425/fa2026/assignments.html";

const CS425_HTML = `<!doctype html><html><head><title>CS 425</title></head><body>
  <h1>Distributed Systems :: Fall :: CS 425 / ECE 428 :: Assignments</h1>
  <h2>Machine Problems (MPs)</h2>
  <p>MPs are ALWAYS due on a SUNDAY at 11.59 PM Central Time, and DEMOS are on the subsequent MONDAY.</p>
  <p>[MP1 Specification Document]: Released 8/25. Due @ 9/13 11.59 PM Central Time (Sun). Demos on 9/14 (Mon).</p>
  <p>[MP2 Specification Document]: Released 9/15. Due @ 9/27 11.59 PM Central Time (Sun).</p>
  <p><a href="mp3.pdf">[MP3 Specification Document]</a>: Released 10/13. Due @ 11/8 11.59 PM Central Time (Sun).</p>
  <p>[MP4 Specification Document]: To be Released 11/10. Due @ 12/6 11.59 PM Central Time (Sun). Demos on 12/7 (Mon).</p>
  <h2>Homework Assignments (HWs)</h2>
  <p>[HW1 Document]: Released 8/27. Due 9/20 at 11.59 PM Central Time. (HW1 is due on a SUNDAY!)</p>
  <p>[HW4 Document]: Released 11/3. Due @ 12/3 11.59 PM Central Time. (HW4 is due on a THURSDAY!)</p>
  <h2>Exams</h2>
  <p>Midterm Exam on 10/8. See Course schedule for the date.</p>
</body></html>`;

test("parseDate prefers Due @ over Released dates and accepts 11.59 dots", () => {
  const due = courseweb.parseDate(
    "Released 8/25. Due @ 9/13 11.59 PM Central Time (Sun).",
    CS425_URL
  );
  assert.ok(due);
  // 2026-09-13 23:59 America/Chicago
  assert.match(due, /^2026-09-1[3-4]T/);
  const hw = courseweb.parseDate("Due 9/20 at 11.59 PM Central Time", CS425_URL);
  assert.ok(hw);
  assert.match(hw, /^2026-09-2[0-1]T/);
});

test("parseDate handles midterm exam on M/D", () => {
  const mid = courseweb.parseDate("Midterm Exam on 10/8. See Course schedule.", CS425_URL);
  assert.ok(mid);
  assert.match(mid, /^2026-10-0[8-9]T/);
});

test("parseCoursePage extracts CS425 MP/HW/exam rows with titles", () => {
  const { document } = parseHTML(CS425_HTML);
  const parsed = courseweb.parseCoursePage(document, CS425_URL);
  assert.match(parsed.courseName, /CS 425/i);
  const titles = parsed.rows.map((row) => row.title);
  assert.ok(titles.some((t) => /MP1/i.test(t)), `missing MP1 in ${titles.join(", ")}`);
  assert.ok(titles.some((t) => /MP3/i.test(t)), `missing MP3 in ${titles.join(", ")}`);
  assert.ok(titles.some((t) => /MP4/i.test(t)), `missing MP4 in ${titles.join(", ")}`);
  assert.ok(titles.some((t) => /HW1/i.test(t)), `missing HW1 in ${titles.join(", ")}`);
  assert.ok(titles.some((t) => /HW4/i.test(t)), `missing HW4 in ${titles.join(", ")}`);
  assert.ok(titles.some((t) => /Midterm/i.test(t)), `missing Midterm in ${titles.join(", ")}`);
  const mp3 = parsed.rows.find((row) => /MP3/i.test(row.title));
  assert.ok(mp3?.url?.endsWith("mp3.pdf"));
});

test("parseCoursePage ignores section headings and Sunday-boilerplate due lines", () => {
  const { document } = parseHTML(CS425_HTML);
  const parsed = courseweb.parseCoursePage(document, CS425_URL);
  const titles = parsed.rows.map((row) => row.title);
  assert.equal(titles.some((t) => /^machine problems/i.test(t)), false);
  assert.equal(titles.some((t) => /^homework assignments/i.test(t)), false);
  assert.equal(
    courseweb.parseDate("MPs are ALWAYS due on a SUNDAY at 11.59 PM Central Time", CS425_URL),
    null
  );
  assert.equal(
    courseweb.parseDate("Released 8/25. Demos on 9/14 (Mon).", CS425_URL),
    null
  );
});

test("courseCodeFrom reads path-style codes", () => {
  assert.equal(courseweb.courseCodeFrom("cs425"), "CS 425");
  assert.equal(courseweb.courseCodeFrom("CS 425 / ECE 428"), "CS 425");
});

test("sync maps CS425 page into DeadlineItems with courseCode", async () => {
  const result = await courseweb.sync({
    settings: { courseWebsites: [CS425_URL] },
    now: new Date("2026-11-10T12:00:00Z"),
    fetchPage: async () => ({ ok: true, status: 200, url: CS425_URL, text: CS425_HTML }),
    parseHtml: (_name, html, url) => {
      const { document } = parseHTML(html);
      return courseweb.parseCoursePage(document, url);
    },
  });
  assert.equal(result.status, "ok");
  assert.ok(result.items.length >= 5);
  assert.equal(result.courses[0].courseCode, "CS 425");
  assert.ok(result.items.every((item) => item.source === "courseweb"));
  assert.ok(result.items.some((item) => /MP1/i.test(item.title) && item.dueAt));
});

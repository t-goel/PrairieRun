const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const bundle = JSON.parse(fs.readFileSync("prairierun-stage-0-captures-2026-09-11.json", "utf8"));

test("updated capture covers the captured course assessment page", () => {
  const urls = bundle.captures.map((capture) => capture.url);
  assert.ok(urls.some((url) => url.includes("course_instance/229304/assessments")));
});

test("updated capture includes a zero-score assignment without a due date", () => {
  const cs411 = bundle.captures.find((capture) => capture.url.endsWith("course_instance/229304/assessments"));
  assert.match(cs411.html, /Project Track 2/);
  assert.match(cs411.html, /data-testid="scorebar"[^>]*>[\s\S]*?0%/);
  assert.match(cs411.html, /Project Track 2[\s\S]*?<\/tr>/);
});

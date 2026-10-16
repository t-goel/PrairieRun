const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");

// Ensure PrairieRunModel is loaded
const PrairieRunModel = require("../extension/deadline-model.js");
globalThis.PrairieRunModel = PrairieRunModel;

const icsWriter = require("../extension/ics-writer.js");
const { buildCalendar, escapeText, foldLine, formatUtc, filterWindow } = icsWriter;

const optionsExport = require("../extension/options-export.js");

const FIXED_NOW = new Date("2026-09-01T12:00:00.000Z");

const FOUR_ITEMS = [
  {
    id: "pl:123:assessment:456",
    source: "prairielearn",
    kind: "assignment",
    courseKey: "prairielearn:123",
    courseCode: "CS 225",
    courseName: "CS 225: Data Structures",
    title: "Homework 1",
    dueAt: "2026-09-12T04:59:00.000Z",
    allDay: false,
    status: "in_progress",
    url: "https://us.prairielearn.com/pl/course_instance/123/assessment/456/",
    fetchedAt: "2026-09-01T12:00:00.000Z",
  },
  {
    id: "gs:100:200",
    source: "gradescope",
    kind: "assignment",
    courseKey: "gradescope:100",
    courseCode: "CS 374",
    courseName: "CS 374: Algorithms",
    title: "Problem Set 2",
    dueAt: "2026-09-20T04:59:00.000Z",
    lateDueAt: "2026-09-22T04:59:00.000Z",
    allDay: false,
    status: "not_started",
    url: "https://www.gradescope.com/courses/100/assignments/200",
    fetchedAt: "2026-09-01T12:00:00.000Z",
  },
  {
    id: "canvas:500:assignment:600",
    source: "canvas",
    kind: "assignment",
    courseKey: "canvas:500",
    courseCode: "CS 425",
    courseName: "CS 425: Distributed Systems",
    title: "Reading Quiz 3",
    dueAt: "2026-10-16T04:59:00.000Z",
    allDay: true,
    status: "not_started",
    url: "https://canvas.illinois.edu/courses/500/assignments/600",
    fetchedAt: "2026-09-01T12:00:00.000Z",
  },
  {
    id: "pt:reservation:789",
    source: "prairietest",
    kind: "exam",
    courseKey: "prairietest:225",
    courseCode: "CS 225",
    courseName: "CS 225: Data Structures",
    title: "Midterm 1",
    startAt: "2026-10-22T19:00:00.000Z",
    endAt: "2026-10-22T20:50:00.000Z",
    location: "DCL 440",
    status: "in_progress",
    url: "https://prairietest.com/pt/reservation/789",
    fetchedAt: "2026-09-01T12:00:00.000Z",
  },
];

test("Golden output for 4 items matches expected shapes, headers, and time formats", () => {
  const { text } = buildCalendar(FOUR_ITEMS, { now: FIXED_NOW });

  // Header checks
  assert.ok(text.includes("BEGIN:VCALENDAR\r\n"));
  assert.ok(text.includes("VERSION:2.0\r\n"));
  assert.ok(text.includes("PRODID:-//PrairieRun//Deadlines//EN\r\n"));
  assert.ok(text.includes("CALSCALE:GREGORIAN\r\n"));
  assert.ok(text.includes("METHOD:PUBLISH\r\n"));
  assert.ok(text.includes("X-WR-CALNAME:PrairieRun\r\n"));
  assert.ok(text.includes("X-WR-TIMEZONE:America/Chicago\r\n"));
  assert.ok(text.includes("REFRESH-INTERVAL;VALUE=DURATION:PT1H\r\n"));
  assert.ok(text.includes("X-PUBLISHED-TTL:PT1H\r\n"));
  assert.ok(text.endsWith("END:VCALENDAR\r\n"));

  // PL item check: block1h shape
  assert.ok(text.includes("UID:pl:123:assessment:456\r\n"));
  assert.ok(text.includes("DTSTART:20260912T035900Z\r\n"));
  assert.ok(text.includes("DTEND:20260912T045900Z\r\n"));
  assert.ok(text.includes("SUMMARY:[CS 225] Homework 1\r\n"));

  // Gradescope item check: lateDueAt in description (escaped per RFC 5545)
  assert.ok(text.includes("UID:gs:100:200\r\n"));
  assert.ok(text.includes("Late due: Mon Sep 21\\, 11:59 PM CDT"));

  // Canvas item check: all-day shape in Central time
  assert.ok(text.includes("UID:canvas:500:assignment:600\r\n"));
  assert.ok(text.includes("DTSTART;VALUE=DATE:20261015\r\n"));
  assert.ok(text.includes("DTEND;VALUE=DATE:20261016\r\n"));

  // PrairieTest item check: exam shape with LOCATION
  assert.ok(text.includes("UID:pt:reservation:789\r\n"));
  assert.ok(text.includes("DTSTART:20261022T190000Z\r\n"));
  assert.ok(text.includes("DTEND:20261022T205000Z\r\n"));
  assert.ok(text.includes("LOCATION:DCL 440\r\n"));
});

test("Every physical line <= 75 octets and only CRLF line separators", () => {
  const { text } = buildCalendar(FOUR_ITEMS, { now: FIXED_NOW });

  // No bare \n without preceding \r
  const bareNewlines = text.replace(/\r\n/g, "").includes("\n");
  assert.equal(bareNewlines, false, "Must not contain bare LF");

  // Only \r\n endings
  assert.ok(text.endsWith("\r\n"), "File must end with CRLF");

  // Every physical line <= 75 octets
  const lines = text.split("\r\n");
  // Last entry after trailing \r\n is empty string
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const octets = Buffer.byteLength(line, "utf8");
    assert.ok(
      octets <= 75,
      `Line ${i} has ${octets} octets (> 75): ${line.slice(0, 40)}...`
    );
  }
});

test("A title with special chars and emoji repeated to 200 chars folds without breaking emoji and unfolds back", () => {
  const baseTitle = "Lab 2: parse, escape; and \\ backslash 🎓";
  let longTitle = baseTitle;
  while (longTitle.length < 200) {
    longTitle += " " + baseTitle;
  }
  const escaped = escapeText(longTitle);
  const contentLine = `SUMMARY:${escaped}`;
  const folded = foldLine(contentLine);

  const physicalLines = folded.split("\r\n");
  assert.ok(physicalLines.length > 1, "Must fold into multiple lines");

  for (let i = 0; i < physicalLines.length; i++) {
    const line = physicalLines[i];
    const octets = Buffer.byteLength(line, "utf8");
    assert.ok(
      octets <= 75,
      `Physical line ${i} exceeds 75 octets (${octets}): ${line.slice(0, 30)}`
    );
    if (i > 0) {
      assert.ok(line.startsWith(" "), "Continuation line must start with a space");
    }
    // Verify no broken surrogate pairs in the line
    assert.doesNotMatch(line, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "Surrogate pair must not be split");
  }

  // Unfold per RFC 5545 (remove CRLF followed by a single space or tab)
  const unfolded = folded.replace(/\r\n[ \t]/g, "");
  assert.equal(unfolded, contentLine, "Unfolded line must match original escaped content");
});

test("UID is identical across two builds; SEQUENCE is unchanged when fingerprint is the same and +1 after dueAt changes", () => {
  const b1 = buildCalendar(FOUR_ITEMS, { now: FIXED_NOW });
  const b2 = buildCalendar(FOUR_ITEMS, { now: FIXED_NOW, sequences: b1.sequences });

  // UIDs match exactly
  for (const item of FOUR_ITEMS) {
    assert.ok(b1.text.includes(`UID:${item.id}\r\n`));
    assert.ok(b2.text.includes(`UID:${item.id}\r\n`));
    assert.equal(b1.sequences[item.id].n, 0);
    assert.equal(b2.sequences[item.id].n, 0);
  }

  // Verify SEQUENCE:0 in both
  assert.ok(!b1.text.includes("SEQUENCE:1"));
  assert.ok(!b2.text.includes("SEQUENCE:1"));

  // Change dueAt for the first item
  const modifiedItems = [
    { ...FOUR_ITEMS[0], dueAt: "2026-09-15T04:59:00.000Z" },
    ...FOUR_ITEMS.slice(1),
  ];

  const b3 = buildCalendar(modifiedItems, { now: FIXED_NOW, sequences: b2.sequences });

  assert.equal(b3.sequences[FOUR_ITEMS[0].id].n, 1, "Modified item sequence must increment by 1");
  assert.equal(b3.sequences[FOUR_ITEMS[1].id].n, 0, "Unchanged item sequence must remain 0");
  assert.ok(b3.text.includes("SEQUENCE:1\r\n"));
});

test("Completed item produces no VALARM; nightBefore produces 8 PM CDT trigger", () => {
  const completedItem = {
    ...FOUR_ITEMS[0],
    status: "completed",
  };
  const { text: completedText } = buildCalendar([completedItem], {
    now: FIXED_NOW,
    nightBefore: true,
  });
  assert.ok(!completedText.includes("BEGIN:VALARM"), "Completed item must have no VALARM");
  assert.ok(completedText.includes("✓ [CS 225] Homework 1"), "Completed item must have ✓ prefix in summary");

  // Test nightBefore with dueAt: 2026-10-18T04:59:00Z (8 PM CDT on Oct 17 = 01:00Z Oct 18)
  const dueItem = {
    ...FOUR_ITEMS[0],
    status: "in_progress",
    dueAt: "2026-10-18T04:59:00.000Z",
  };
  const { text: alarmText } = buildCalendar([dueItem], {
    now: FIXED_NOW,
    nightBefore: true,
    nightBeforeHour: 20,
    leadMinutes: 240,
  });

  assert.ok(alarmText.includes("BEGIN:VALARM\r\n"));
  assert.ok(alarmText.includes("TRIGGER:-PT240M\r\n"), "Must include leadMinutes alarm");
  assert.ok(
    alarmText.includes("TRIGGER;VALUE=DATE-TIME:20261018T010000Z\r\n"),
    "Must include nightBefore alarm at 20261018T010000Z"
  );
});

test("instant eventShape sets DTSTART = DTEND = dueAt", () => {
  const item = FOUR_ITEMS[0];
  const { text } = buildCalendar([item], {
    now: FIXED_NOW,
    eventShape: "instant",
  });
  assert.ok(text.includes("DTSTART:20260912T045900Z\r\n"));
  assert.ok(text.includes("DTEND:20260912T045900Z\r\n"));
});

test("filterWindow filters items outside next N days", () => {
  const items = [
    { id: "1", dueAt: "2026-09-02T12:00:00.000Z" }, // 1 day ahead
    { id: "2", dueAt: "2026-09-10T12:00:00.000Z" }, // 9 days ahead
    { id: "3", dueAt: "2026-09-20T12:00:00.000Z" }, // 19 days ahead
    { id: "4", dueAt: "2026-08-30T12:00:00.000Z" }, // past
  ];
  const filtered7 = filterWindow(items, FIXED_NOW, 7);
  assert.equal(filtered7.length, 1);
  assert.equal(filtered7[0].id, "1");

  const filtered14 = filterWindow(items, FIXED_NOW, 14);
  assert.equal(filtered14.length, 2);
  assert.equal(filtered14[0].id, "1");
  assert.equal(filtered14[1].id, "2");
});

test("options-export downloadIcs persists sequences and builds calendar", async () => {
  let savedStorage = {};
  globalThis.PrairieRunExt = {
    storageLocalGet: async (keys) => {
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        out[k] = savedStorage[k];
      }
      return out;
    },
    storageLocalSet: async (items) => {
      Object.assign(savedStorage, items);
    },
  };

  savedStorage = {
    prairierunSettings: {
      output: {
        eventShape: "block1h",
        leadMinutes: 120,
      },
    },
    prairierunIcsSequences: {},
  };

  const result = await optionsExport.downloadIcs(FOUR_ITEMS, "prairierun-test.ics");
  assert.ok(result.text.includes("BEGIN:VCALENDAR"));
  assert.ok(result.text.includes("TRIGGER:-PT120M"));
  assert.ok(savedStorage.prairierunIcsSequences[FOUR_ITEMS[0].id]);
  assert.equal(savedStorage.prairierunIcsSequences[FOUR_ITEMS[0].id].n, 0);
});

test("options-export render creates export buttons and removes coming soon note", async () => {
  function makeElement(tagName) {
    const children = [];
    const listeners = {};
    const elem = {
      tagName: tagName.toUpperCase(),
      dataset: {},
      style: {},
      children,
      textContent: "",
      className: "",
      id: "",
      type: "",
      disabled: false,
      appendChild(child) {
        children.push(child);
        return child;
      },
      addEventListener(event, fn) {
        listeners[event] = fn;
      },
      querySelector(sel) {
        if (sel.startsWith("#")) {
          const id = sel.slice(1);
          if (this.id === id) return this;
          for (const c of children) {
            const res = c.querySelector?.(sel);
            if (res) return res;
          }
        }
        if (sel.startsWith(".")) {
          const cls = sel.slice(1);
          if (this.className?.includes(cls)) return this;
          for (const c of children) {
            const res = c.querySelector?.(sel);
            if (res) return res;
          }
        }
        if (sel.startsWith("[data-")) {
          const key = sel.slice(6, -1);
          if (this.dataset && this.dataset[key] !== undefined) return this;
          for (const c of children) {
            const res = c.querySelector?.(sel);
            if (res) return res;
          }
        }
        return null;
      },
      querySelectorAll(sel) {
        const out = [];
        if (sel === "p.muted" && this.tagName === "P" && this.className === "muted") {
          out.push(this);
        }
        for (const c of children) {
          if (c.querySelectorAll) out.push(...c.querySelectorAll(sel));
        }
        return out;
      },
      remove() {
        if (elem.parent) {
          const idx = elem.parent.children.indexOf(elem);
          if (idx >= 0) elem.parent.children.splice(idx, 1);
        }
      },
    };
    return elem;
  }

  const section = makeElement("section");
  section.id = "export";
  const comingSoon = makeElement("p");
  comingSoon.className = "muted";
  comingSoon.textContent = "Coming soon";
  comingSoon.parent = section;
  section.appendChild(comingSoon);

  const mockDoc = {
    createElement: makeElement,
  };
  globalThis.document = mockDoc;
  globalThis.PrairieRunIcsWriter = icsWriter;

  let savedStorage = {
    prairierunDeadlines: FOUR_ITEMS,
    prairierunSettings: {
      sources: {
        prairielearn: { enabled: true },
        canvas: { enabled: true },
        gradescope: { enabled: false },
      },
    },
    prairierunIcsSequences: {},
  };

  globalThis.PrairieRunExt = {
    storageLocalGet: async (keys) => {
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        out[k] = savedStorage[k];
      }
      return out;
    },
    storageLocalSet: async (items) => {
      Object.assign(savedStorage, items);
    },
  };

  await optionsExport.render(section);

  // Coming soon note removed
  const notes = section.querySelectorAll("p.muted").filter((p) =>
    /coming soon/i.test(p.textContent || "")
  );
  assert.equal(notes.length, 0, "Coming soon note must be removed");

  // Export buttons container exists
  const allBtn = section.querySelector("#export-all-ics");
  assert.ok(allBtn, "Download all (.ics) button must exist");

  const plBtn = section.querySelector("#export-prairielearn-ics");
  assert.ok(plBtn, "Download PrairieLearn (.ics) button must exist");

  const canvasBtn = section.querySelector("#export-canvas-ics");
  assert.ok(canvasBtn, "Download Canvas (.ics) button must exist");

  const gsBtn = section.querySelector("#export-gradescope-ics");
  assert.equal(gsBtn, null, "Disabled source button must not exist");
});

test("Round-trip: if ics-parse.js from PR 4 is present, parsing the output returns the same UIDs and instants", (t) => {
  let icsParse = null;
  try {
    icsParse = require("../extension/ics-parse.js");
    // Verify parseIcs is actually implemented and does not throw the PR 1 stub error
    icsParse.parseIcs("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
  } catch {
    t.skip("ics-parse.js from PR 4 is not available or is a stub");
    return;
  }

  const { text } = buildCalendar(FOUR_ITEMS, { now: FIXED_NOW });
  const parsedEvents = icsParse.parseIcs(text);
  assert.equal(parsedEvents.length, FOUR_ITEMS.length);

  for (let i = 0; i < FOUR_ITEMS.length; i++) {
    const original = FOUR_ITEMS[i];
    const parsed = parsedEvents.find((e) => e.uid === original.id);
    assert.ok(parsed, `Parsed events must contain UID ${original.id}`);

    const instant = icsParse.toInstant(parsed.dtstart);
    if (original.allDay) {
      assert.equal(instant.allDay, true);
    } else if (original.kind === "exam") {
      assert.equal(instant.iso, original.startAt);
    } else {
      // block1h dtstart is dueAt - 1h
      const expectedStart = new Date(new Date(original.dueAt).getTime() - 60 * 60 * 1000).toISOString();
      assert.equal(instant.iso, expectedStart);
    }
  }
});

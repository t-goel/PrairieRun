// Options page Filters card unit tests.
// Runs directly in Node (`node --test stage0/test-options-filters.js`).
const assert = require("node:assert/strict");
const test = require("node:test");
const { parseHTML } = require("linkedom");

const filters = require("../extension/options-filters.js");

function setupDOM() {
  const html = `<!doctype html>
  <html>
    <body>
      <section class="card" id="assignment-filters">
        <h2>Filters</h2>
        <div class="prr-chip-box" id="filter-chips-box">
          <div class="prr-chip-list" id="filter-chips-list"></div>
          <input type="text" id="filter-keyword-input" class="prr-chip-input" placeholder="Type keyword and press Enter…" />
        </div>
        <p id="filter-status" class="muted filter-status" hidden></p>
      </section>
    </body>
  </html>`;
  const dom = parseHTML(html);
  globalThis.document = dom.document;
  function triggerKey(element, key) {
    const ev = new dom.Event("keydown", { bubbles: true, cancelable: true });
    ev.key = key;
    element.dispatchEvent(ev);
  }
  return { document: dom.document, triggerKey };
}

test("matchesKeywords performs case-insensitive substring matching", () => {
  assert.equal(filters.matchesKeywords("CS 425 Office Hours with TA", ["office hours"]), true);
  assert.equal(filters.matchesKeywords("CS 425 OFFICE HOURS", ["office hours"]), true);
  assert.equal(filters.matchesKeywords("Discussion Section 01", ["discussion", "quiz"]), true);
  assert.equal(filters.matchesKeywords("Homework 1", ["office hours"]), false);
  assert.equal(filters.matchesKeywords("", ["office hours"]), false);
  assert.equal(filters.matchesKeywords(null, ["office hours"]), false);
  assert.equal(filters.matchesKeywords("Homework 1", []), false);
  assert.equal(filters.matchesKeywords("Homework 1", null), false);
  assert.equal(filters.matchesKeywords("Weekly Quiz #2", ["  quiz  "]), true);
});

test("createChip builds chip element with text and remove button", () => {
  const { document } = setupDOM();
  let removed = null;
  const chip = filters.createChip("office hours", (kw) => {
    removed = kw;
  });

  assert.ok(chip.classList.contains("prr-chip"));
  assert.equal(chip.dataset.keyword, "office hours");
  const text = chip.querySelector(".prr-chip-text");
  assert.ok(text);
  assert.equal(text.textContent, "office hours");

  const btn = chip.querySelector(".prr-chip-remove");
  assert.ok(btn);
  assert.equal(btn.textContent, "×");
  assert.equal(btn.getAttribute("aria-label"), 'Remove filter "office hours"');

  btn.click();
  assert.equal(removed, "office hours");
});

test("initFiltersCard handles Enter to add chip, Backspace to remove chip, and X click", async () => {
  const { document, triggerKey } = setupDOM();

  let storage = {
    prairierunSettings: { keywordFilters: ["lecture"] },
    prairierunKeywordFilters: ["lecture"],
  };
  let sentMessages = [];

  globalThis.PrairieRunExt = {
    storageLocalGet: async (keys) => {
      const result = {};
      const keyArr = Array.isArray(keys) ? keys : [keys];
      for (const k of keyArr) {
        if (k in storage) result[k] = storage[k];
      }
      return result;
    },
    storageLocalSet: async (obj) => {
      Object.assign(storage, obj);
    },
    runtimeSendMessage: async (msg) => {
      sentMessages.push(msg);
      return { ok: true };
    },
    addStorageChangedListener: () => {},
  };

  const instance = filters.initFiltersCard(document);
  assert.ok(instance);

  // Wait for initial read
  await new Promise((resolve) => setTimeout(resolve, 10));

  const list = document.querySelector("#filter-chips-list");
  const input = document.querySelector("#filter-keyword-input");

  // Initial chip from storage ("lecture")
  let chips = list.querySelectorAll(".prr-chip");
  assert.equal(chips.length, 1);
  assert.equal(chips[0].querySelector(".prr-chip-text").textContent, "lecture");

  // 1. Type "office hours" and hit Enter
  input.value = "office hours";
  triggerKey(input, "Enter");
  await new Promise((resolve) => setTimeout(resolve, 10));

  chips = list.querySelectorAll(".prr-chip");
  assert.equal(chips.length, 2);
  assert.equal(chips[1].querySelector(".prr-chip-text").textContent, "office hours");
  assert.equal(input.value, "");
  assert.deepEqual(storage.prairierunKeywordFilters, ["lecture", "office hours"]);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].type, "PRAIRIERUN_KEYWORD_FILTERS_CHANGED");
  assert.deepEqual(sentMessages[0].keywords, ["lecture", "office hours"]);

  // 2. Typing duplicate (case-insensitive) does not add
  input.value = "Office Hours";
  triggerKey(input, "Enter");
  await new Promise((resolve) => setTimeout(resolve, 10));
  chips = list.querySelectorAll(".prr-chip");
  assert.equal(chips.length, 2);

  // 3. Backspace with text in input does NOT delete chip
  input.value = "abc";
  input.selectionStart = 3;
  input.selectionEnd = 3;
  triggerKey(input, "Backspace");
  await new Promise((resolve) => setTimeout(resolve, 10));
  chips = list.querySelectorAll(".prr-chip");
  assert.equal(chips.length, 2);

  // 4. Backspace with NO text in input deletes the last chip ("office hours")
  input.value = "";
  input.selectionStart = 0;
  input.selectionEnd = 0;
  triggerKey(input, "Backspace");
  await new Promise((resolve) => setTimeout(resolve, 10));

  chips = list.querySelectorAll(".prr-chip");
  assert.equal(chips.length, 1);
  assert.equal(chips[0].querySelector(".prr-chip-text").textContent, "lecture");
  assert.deepEqual(storage.prairierunKeywordFilters, ["lecture"]);

  // 5. Clicking the X on the remaining chip deletes it
  const removeBtn = chips[0].querySelector(".prr-chip-remove");
  removeBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  chips = list.querySelectorAll(".prr-chip");
  assert.equal(chips.length, 0);
  assert.deepEqual(storage.prairierunKeywordFilters, []);
});

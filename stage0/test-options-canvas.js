// Tests for extension/options-canvas.js (PR 4) with a minimal fake DOM.
// Covers render structure, masked display, URL validation, the enable toggle
// permission flow, the planner checkbox, and setup vs connected views.
const assert = require("node:assert/strict");
const test = require("node:test");

// ---- Minimal fake DOM: only what options-canvas.js uses. ----
function matches(node, selector) {
  const match = selector.match(/^([a-zA-Z][\w-]*)?(?:\.([\w-]+))?((?:\[[^\]]+\])*)$/);
  if (!match) return false;
  const [, tag, cls, attrs] = match;
  if (tag && node.tag !== tag) return false;
  if (cls && !(node.attributes.class || "").split(" ").includes(cls)) return false;
  for (const attrMatch of attrs.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    const [, name, want] = attrMatch;
    const got = node.attributes[name];
    if (got === undefined) return false;
    if (want !== undefined && got !== want) return false;
  }
  return true;
}

function makeNode(tag) {
  const node = {
    tag,
    children: [],
    attributes: {},
    style: {},
    checked: false,
    value: "",
    parent: null,
    listeners: {},
    _text: "",
    set className(v) {
      this.attributes.class = String(v);
    },
    get className() {
      return this.attributes.class || "";
    },
    set textContent(v) {
      this._text = String(v ?? "");
      this.children = [];
    },
    get textContent() {
      if (this.children.length === 0) return this._text;
      return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
    },
    setAttribute(key, value) {
      this.attributes[key] = String(value);
    },
    getAttribute(key) {
      return this.attributes[key];
    },
    removeAttribute(key) {
      delete this.attributes[key];
    },
    append(...nodes) {
      for (const n of nodes) {
        if (n && typeof n === "object") {
          n.parent = this;
          this.children.push(n);
        }
      }
    },
    appendChild(n) {
      this.append(n);
      return n;
    },
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    focus() {},
    querySelectorAll(selector) {
      const out = [];
      const walk = (n) => {
        for (const child of n.children) {
          if (typeof child === "string") continue;
          if (matches(child, selector)) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    },
  };
  return node;
}

function makeTextNode(text) {
  return {
    tag: "#text",
    children: [],
    attributes: {},
    listeners: {},
    parent: null,
    _text: String(text ?? ""),
    get textContent() {
      return this._text;
    },
    set textContent(v) {
      this._text = String(v ?? "");
    },
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    },
  };
}

async function fire(node, type) {
  for (const fn of node.listeners[type] || []) await fn();
}

function find(section, selector) {
  const found = section.querySelectorAll(selector);
  assert.ok(found.length > 0, `expected ${selector}`);
  return found[0];
}

function isHidden(node) {
  return node.attributes.hidden !== undefined;
}

function makeHarness({ grantPermission = true, seedSecrets = {}, seedSettings = {} } = {}) {
  const store = {
    prairierunSecrets: { ...seedSecrets },
    prairierunSettings: { ...seedSettings },
  };
  const permissionCalls = [];
  const messengerCalls = [];
  global.document = {
    createElement: (tag) => makeNode(tag),
    createTextNode: (text) => makeTextNode(text),
  };
  globalThis.PrairieRunExt = {
    storageLocalGet: async (key) => ({ [key]: store[key] }),
    storageLocalSet: async (items) => Object.assign(store, items),
    permissionsRequest: async (origins) => {
      permissionCalls.push(origins);
      return grantPermission;
    },
    runtimeSendMessage: async (message) => {
      messengerCalls.push(message);
      return { ok: true };
    },
  };
  return { store, permissionCalls, messengerCalls };
}

const TOKEN = "secretTOKEN99";
const GOOD_URL = `https://canvas.illinois.edu/feeds/calendars/user_${TOKEN}.ics`;

async function renderFresh(section, harnessOpts) {
  delete require.cache[require.resolve("../extension/options-canvas.js")];
  delete global.document;
  const harness = makeHarness(harnessOpts);
  const mod = require("../extension/options-canvas.js");
  await mod.render(section);
  return { ...harness, mod };
}

function newSection() {
  const section = makeNode("section");
  const h2 = makeNode("h2");
  h2.textContent = "Canvas";
  const soon = makeNode("p");
  soon.className = "muted";
  soon.textContent = "Coming soon";
  section.append(h2, soon);
  return section;
}

test("render builds controls and drops the coming-soon note", async () => {
  const section = newSection();
  await renderFresh(section);
  assert.equal(section.querySelectorAll("p").filter((p) => p.textContent === "Coming soon").length, 0);
  find(section, '[data-pr-canvas-feed]');
  find(section, '[data-pr-canvas-planner]');
  assert.equal(find(section, '[data-pr-canvas-feed]').tag, "input");
  assert.equal(find(section, '[data-pr-canvas-feed]').attributes.type, "password");
});

test("without a saved feed, shows the setup form and hides the connected row", async () => {
  const section = newSection();
  await renderFresh(section);
  assert.equal(isHidden(find(section, '[data-pr-canvas-setup]')), false);
  assert.equal(isHidden(find(section, '[data-pr-canvas-connected]')), true);
  find(section, '[data-pr-canvas-save]');
  assert.equal(isHidden(find(section, '[data-pr-canvas-cancel]')), true);
  assert.equal(find(section, '[data-pr-canvas-saved]').textContent, "");
});

test("with a saved feed, shows the connected row and hides the setup form", async () => {
  const section = newSection();
  await renderFresh(section, { seedSecrets: { canvasFeedUrl: GOOD_URL } });
  assert.equal(isHidden(find(section, '[data-pr-canvas-connected]')), false);
  assert.equal(isHidden(find(section, '[data-pr-canvas-setup]')), true);
  const saved = find(section, '[data-pr-canvas-saved]').textContent;
  assert.match(saved, /^Feed connected · /);
  assert.ok(saved.includes("…/user_***.ics"), saved);
  assert.ok(!saved.includes(TOKEN), "token must not appear masked or otherwise");
});

test("Change reveals the setup form; Cancel returns to connected", async () => {
  const section = newSection();
  await renderFresh(section, { seedSecrets: { canvasFeedUrl: GOOD_URL } });
  await fire(find(section, '[data-pr-canvas-change]'), "click");
  assert.equal(isHidden(find(section, '[data-pr-canvas-setup]')), false);
  assert.equal(isHidden(find(section, '[data-pr-canvas-connected]')), true);
  assert.equal(isHidden(find(section, '[data-pr-canvas-cancel]')), false);

  await fire(find(section, '[data-pr-canvas-cancel]'), "click");
  assert.equal(isHidden(find(section, '[data-pr-canvas-setup]')), true);
  assert.equal(isHidden(find(section, '[data-pr-canvas-connected]')), false);
  assert.match(find(section, '[data-pr-canvas-saved]').textContent, /^Feed connected · /);
});

test("saved feed URL is shown masked, never raw", async () => {
  const section = newSection();
  await renderFresh(section, { seedSecrets: { canvasFeedUrl: GOOD_URL } });
  const saved = find(section, '[data-pr-canvas-saved]').textContent;
  assert.ok(saved.includes("…/user_***.ics"), saved);
  assert.ok(!saved.includes(TOKEN), "token must not appear masked or otherwise");
  assert.ok(!find(section, '[data-pr-canvas-feed]').value.includes(TOKEN));
});

test("invalid feed URLs are rejected and not saved", async () => {
  const section = newSection();
  const { store } = await renderFresh(section);
  const input = find(section, '[data-pr-canvas-feed]');
  input.value = "https://canvas.illinois.edu/calendar?x=1";
  await fire(find(section, '[data-pr-canvas-save]'), "click");
  assert.equal(store.prairierunSecrets.canvasFeedUrl, undefined);
  assert.ok(find(section, '[data-pr-canvas-message]').textContent.length > 0);
});

test("illinois feed URL saves cleanly; other hosts save with a warning", async () => {
  const section = newSection();
  const { store } = await renderFresh(section);
  const input = find(section, '[data-pr-canvas-feed]');
  input.value = GOOD_URL;
  await fire(find(section, '[data-pr-canvas-save]'), "click");
  assert.equal(store.prairierunSecrets.canvasFeedUrl, GOOD_URL);
  assert.equal(input.value, "");
  assert.match(find(section, '[data-pr-canvas-message]').textContent, /saved/i);
  assert.equal(isHidden(find(section, '[data-pr-canvas-connected]')), false);
  assert.equal(isHidden(find(section, '[data-pr-canvas-setup]')), true);

  await fire(find(section, '[data-pr-canvas-change]'), "click");
  input.value = "https://canvas.example.edu/feeds/calendars/user_abc123.ics";
  await fire(find(section, '[data-pr-canvas-save]'), "click");
  assert.equal(store.prairierunSecrets.canvasFeedUrl, "https://canvas.example.edu/feeds/calendars/user_abc123.ics");
  assert.match(find(section, '[data-pr-canvas-message]').textContent, /not a canvas\.illinois\.edu feed/);
  assert.equal(isHidden(find(section, '[data-pr-canvas-connected]')), false);
});

test("feed URL with query parameters is accepted", async () => {
  const section = newSection();
  const { store } = await renderFresh(section);
  const input = find(section, '[data-pr-canvas-feed]');
  input.value = `https://canvas.illinois.edu/feeds/calendars/user_${TOKEN}.ics?ex=abc123&xs=4ed5f6a7b8`;
  await fire(find(section, '[data-pr-canvas-save]'), "click");
  assert.equal(
    store.prairierunSecrets.canvasFeedUrl,
    `https://canvas.illinois.edu/feeds/calendars/user_${TOKEN}.ics?ex=abc123&xs=4ed5f6a7b8`,
  );
  assert.match(find(section, '[data-pr-canvas-message]').textContent, /saved/i);
});

test("saving the feed URL triggers a background resync when Canvas is enabled", async () => {
  const section = newSection();
  const { store, messengerCalls } = await renderFresh(section, {
    seedSettings: { sources: { canvas: { enabled: true } } },
  });
  const input = find(section, '[data-pr-canvas-feed]');
  input.value = GOOD_URL;
  await fire(find(section, '[data-pr-canvas-save]'), "click");
  assert.equal(store.prairierunSecrets.canvasFeedUrl, GOOD_URL);
  assert.deepEqual(messengerCalls, [{ type: "PRAIRIERUN_SYNC_NOW" }]);
});

test("saving the feed URL does not resync while Canvas is disabled", async () => {
  const section = newSection();
  const { store, messengerCalls } = await renderFresh(section);
  const input = find(section, '[data-pr-canvas-feed]');
  input.value = GOOD_URL;
  await fire(find(section, '[data-pr-canvas-save]'), "click");
  assert.equal(store.prairierunSecrets.canvasFeedUrl, GOOD_URL);
  assert.deepEqual(messengerCalls, []);
});

test("clearing the feed URL triggers a resync only while Canvas is enabled", async () => {
  const section = newSection();
  const { store, messengerCalls } = await renderFresh(section, {
    seedSecrets: { canvasFeedUrl: GOOD_URL },
    seedSettings: { sources: { canvas: { enabled: true } } },
  });
  await fire(find(section, '[data-pr-canvas-clear]'), "click");
  assert.equal(store.prairierunSecrets.canvasFeedUrl, undefined);
  assert.deepEqual(messengerCalls, [{ type: "PRAIRIERUN_SYNC_NOW" }]);
  assert.equal(isHidden(find(section, '[data-pr-canvas-setup]')), false);
  assert.equal(isHidden(find(section, '[data-pr-canvas-connected]')), true);

  const disabledSection = newSection();
  const disabled = await renderFresh(disabledSection, {
    seedSecrets: { canvasFeedUrl: GOOD_URL },
  });
  await fire(find(disabledSection, '[data-pr-canvas-clear]'), "click");
  assert.equal(disabled.store.prairierunSecrets.canvasFeedUrl, undefined);
  assert.deepEqual(disabled.messengerCalls, []);
});

test("planner checkbox persists plannerApi", async () => {
  const section = newSection();
  const { store } = await renderFresh(section);
  const box = find(section, '[data-pr-canvas-planner]');
  box.checked = true;
  await fire(box, "change");
  assert.equal(store.prairierunSettings.sources.canvas.plannerApi, true);
});

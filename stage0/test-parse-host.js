// PR 2 parse-host tests: with a DOMParser available (Firefox event page,
// Node tests via linkedom) parseHtml calls the registered parser in place
// with a real Document.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { DOMParser } = require("linkedom");

const EXT = path.join(__dirname, "..", "extension");

function loadParseHost() {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  sandbox.DOMParser = DOMParser;
  vm.createContext(sandbox);
  const run = (file) => vm.runInContext(fs.readFileSync(path.join(EXT, file), "utf8"), sandbox, { filename: file });
  run("source-registry.js");
  const seen = [];
  sandbox.PrairieRunSources.register({
    id: "canvas",
    label: "Canvas",
    origins: ["https://canvas.illinois.edu"],
    signInUrl: "https://canvas.illinois.edu/",
    parsers: {
      x: (doc, url) => {
        seen.push({ nodeType: doc.nodeType, hasQuery: typeof doc.querySelector === "function", url });
        return { title: doc.querySelector("p").textContent, url };
      },
    },
    isSignedOut: () => false,
    sync: async () => ({ status: "ok", items: [], checkedAt: new Date().toISOString() }),
  });
  run("parse-host.js");
  return { api: sandbox.PrairieRunParseHost, seen };
}

test("parseHtml calls the registered parser with a Document", async () => {
  const { api, seen } = loadParseHost();
  const result = await api.parseHtml("canvas.x", "<p>hi</p>", "https://canvas.illinois.edu/");
  assert.deepEqual(result, { title: "hi", url: "https://canvas.illinois.edu/" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].nodeType, 9);
  assert.equal(seen[0].hasQuery, true);
});

test("parseHtml rejects unknown sources and parsers", async () => {
  const { api } = loadParseHost();
  await assert.rejects(() => api.parseHtml("nope.x", "<p>hi</p>", "https://example.com/"), /Unknown source/);
  await assert.rejects(() => api.parseHtml("canvas.missing", "<p>hi</p>", "https://example.com/"), /Unknown parser/);
  await assert.rejects(() => api.parseHtml("nokey", "<p>hi</p>", "https://example.com/"), /Invalid parser key/);
});

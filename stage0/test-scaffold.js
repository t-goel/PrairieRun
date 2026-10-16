const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");

function loadInSandbox(file, sandbox) {
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, file), "utf8"), sandbox, { filename: file });
  return sandbox;
}

function extractImportScripts() {
  const text = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const match = text.match(/importScripts\(([^)]+)\)/);
  assert.ok(match, "background.js must contain an importScripts(...) list");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function firefoxScripts() {
  const text = fs.readFileSync(path.join(ROOT, "build-manifest.js"), "utf8");
  const match = text.match(/FIREFOX_BACKGROUND_SCRIPTS\s*=\s*\[([^\]]+)\]/);
  assert.ok(match, "build-manifest.js must define FIREFOX_BACKGROUND_SCRIPTS");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test("background importScripts matches the Firefox scripts array minus background.js", () => {
  const imported = extractImportScripts();
  const firefox = firefoxScripts();
  assert.deepEqual(imported, firefox.filter((file) => file !== "background.js"));
  for (const file of firefox) {
    assert.ok(fs.existsSync(path.join(EXT, file)), `background dependency exists: ${file}`);
  }
});

test("Chrome manifest keeps offscreen; Firefox manifest drops it", () => {
  execFileSync(process.execPath, [path.join(ROOT, "build-manifest.js"), "--target=chrome", "--check"], { stdio: "pipe" });
  const base = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.base.json"), "utf8"));
  const chrome = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  assert.ok((chrome.permissions || []).includes("offscreen"), "Chrome keeps offscreen permission");
  assert.ok(chrome.optional_host_permissions?.length >= 3, "Chrome keeps optional hosts");
  assert.ok(chrome.options_ui?.page === "options.html", "Chrome has options_ui");

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "prairierun-scaffold-"));
  try {
    execFileSync(process.execPath, [path.join(ROOT, "build-manifest.js"), "--target=firefox", `--out=${outDir}`], { stdio: "pipe" });
    const firefox = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
    assert.ok(!(firefox.permissions || []).includes("offscreen"), "Firefox drops offscreen");
    assert.ok(!firefox.optional_host_permissions, "Firefox moves optional hosts");
    assert.ok((firefox.host_permissions || []).some((h) => h.includes("canvas.illinois.edu")), "Firefox keeps Canvas host");
    assert.deepEqual(firefox.background.scripts, firefoxScripts());
    void base;
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("all four sources register with unique ids", () => {
  const sandbox = { console };
  loadInSandbox("source-registry.js", sandbox);
  // PrairieLearn wrapper needs the model + a storage stub.
  sandbox.PrairieRunModel = require("./../extension/deadline-model.js");
  sandbox.PrairieRunExt = {
    storageLocalGet: async () => ({ prairierunAssignments: [] }),
    storageLocalSet: async () => undefined,
  };
  for (const file of ["source-prairielearn.js", "source-canvas.js", "source-gradescope.js", "source-prairietest.js"]) {
    vm.runInContext(fs.readFileSync(path.join(EXT, file), "utf8"), sandbox, { filename: file });
  }
  const ids = JSON.parse(JSON.stringify(sandbox.PrairieRunSources.list().map((a) => a.id).sort()));
  assert.deepEqual(ids, ["canvas", "gradescope", "prairielearn", "prairietest"]);
  assert.equal(new Set(ids).size, 4);
});

test("runSync fans out to adapters, merges once, outputs once, and saves both keys", async () => {
  const sandbox = { console };
  loadInSandbox("source-registry.js", sandbox);
  loadInSandbox("deadline-model.js", sandbox);
  loadInSandbox("deadline-store.js", sandbox);
  loadInSandbox("outputs.js", sandbox);
  sandbox.PrairieRunNet = { fetchPage: async () => ({ ok: true }) };
  sandbox.PrairieRunParseHost = { parseHtml: async () => ({}) };

  const saved = {};
  sandbox.PrairieRunExt = {
    storageLocalGet: async (key) => {
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) out[k] = saved[k];
      return out;
    },
    storageLocalSet: async (items) => Object.assign(saved, items),
  };

  // Wrap the real merge/outputs with call counters.
  const realMerge = sandbox.PrairieRunDeadlineStore.mergeSourceResults;
  let mergeCalls = 0;
  sandbox.PrairieRunDeadlineStore.mergeSourceResults = (...args) => {
    mergeCalls += 1;
    return realMerge(...args);
  };
  let outputCalls = 0;
  sandbox.PrairieRunOutputs.run = async () => {
    outputCalls += 1;
    return {};
  };

  sandbox.PrairieRunSources.register({
    id: "a",
    label: "A",
    origins: ["https://example.com"],
    signInUrl: "https://example.com/",
    parsers: {},
    isSignedOut: () => false,
    sync: async () => ({ status: "ok", items: [], checkedAt: new Date().toISOString() }),
  });
  sandbox.PrairieRunSources.register({
    id: "b",
    label: "B",
    origins: ["https://example.org"],
    signInUrl: "https://example.org/",
    parsers: {},
    isSignedOut: () => false,
    sync: async () => ({ status: "error", items: [], checkedAt: new Date().toISOString() }),
  });

  loadInSandbox("sync-orchestrator.js", sandbox);
  const result = await sandbox.PrairieRunOrchestrator.runSync({ sources: ["a", "b"] });
  assert.equal(mergeCalls, 1);
  assert.equal(outputCalls, 1);
  assert.ok("prairierunDeadlines" in saved, "saves deadlines");
  assert.ok("prairierunSourceStatus" in saved, "saves source status");
  assert.ok(result.results.a && result.results.b, "returns both adapter results");
});

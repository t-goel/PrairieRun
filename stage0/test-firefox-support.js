// Firefox-support regression tests: the compat shim behaves identically
// under the Firefox `browser.*` promise namespace and the Chrome/Brave
// `chrome.*` MV3 promise namespace, session tokens never touch local
// storage, and the generated manifests stay in sync with the base manifest.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const COMPAT_PATH = path.join(ROOT, "extension", "compat.js");
const BASE_MANIFEST_PATH = path.join(ROOT, "extension", "manifest.base.json");
const CHROME_MANIFEST_PATH = path.join(ROOT, "extension", "manifest.json");

function makeLocalStore() {
  const data = {};
  return {
    data,
    get: (keys) => Promise.resolve(
      Array.isArray(keys)
        ? Object.fromEntries(keys.map((key) => [key, data[key]]))
        : { [keys]: data[keys] },
    ),
    set: (items) => { Object.assign(data, items); return Promise.resolve(); },
    clear: () => { for (const key of Object.keys(data)) delete data[key]; return Promise.resolve(); },
  };
}

function runCompatWith(extObject, { exposeAs = "browser", userAgent = "" } = {}) {
  const sandbox = { console };
  sandbox[exposeAs] = extObject;
  sandbox.navigator = { userAgent };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(COMPAT_PATH, "utf8"), sandbox, { filename: "compat.js" });
  return sandbox.PrairieRunExt;
}

function firefoxNamespace({ session = true } = {}) {
  const local = makeLocalStore();
  const sessionStore = makeLocalStore();
  return {
    local,
    sessionStore,
    storage: { local, ...(session ? { session: sessionStore } : {}), onChanged: { addListener: () => undefined } },
    tabs: {
      create: (options) => Promise.resolve({ id: 7, ...options }),
      remove: () => Promise.resolve(),
      query: () => Promise.resolve([{ id: 1, url: "https://us.prairielearn.com/" }]),
      get: (tabId) => Promise.resolve({ id: tabId, status: "complete" }),
      sendMessage: (tabId, message) => Promise.resolve({ ok: true, tabId, message }),
      onUpdated: { addListener: () => undefined, removeListener: () => undefined },
    },
    runtime: { sendMessage: (message) => Promise.resolve({ ok: true, message }), onMessage: { addListener: () => undefined } },
    identity: {
      getRedirectURL: (sub) => `https://mock-id.extensions.allizom.org/${sub || ""}`,
      launchWebAuthFlow: () => Promise.resolve("https://mock-id.extensions.allizom.org/oauth2#access_token=tok&expires_in=3600"),
    },
  };
}

test("compat shim works under the Firefox browser.* namespace", async () => {
  const ns = firefoxNamespace();
  const ext = runCompatWith(ns, { exposeAs: "browser", userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0" });
  assert.equal(ext.isFirefox, true);
  await ext.storageLocalSet({ a: 1 });
  assert.deepEqual(await ext.storageLocalGet("a"), { a: 1 });
  assert.deepEqual(await ext.tabsQuery({}), [{ id: 1, url: "https://us.prairielearn.com/" }]);
  assert.deepEqual((await ext.tabsSendMessage(1, { type: "PING" })).ok, true);
  assert.deepEqual((await ext.runtimeSendMessage({ type: "PING" })).ok, true);
  // `.catch` chaining (the call sites this shim protects) must not throw.
  await ext.tabsRemove(9).catch(() => undefined);
  await ext.storageLocalClear();
  assert.deepEqual(await ext.storageLocalGet("a"), { a: undefined });
  assert.match(ext.identityGetRedirectURL("oauth2"), /allizom\.org/);
});

test("compat shim works under the Chrome chrome.* namespace", async () => {
  const ns = firefoxNamespace();
  const ext = runCompatWith(ns, { exposeAs: "chrome", userAgent: "Mozilla/5.0 Chrome/120.0" });
  assert.equal(ext.isFirefox, false);
  await ext.storageLocalSet({ b: 2 });
  assert.deepEqual(await ext.storageLocalGet(["b"]), { b: 2 });
  assert.deepEqual((await ext.tabsCreate({ url: "https://example.com", active: false })).id, 7);
  assert.deepEqual((await ext.tabsGet(3)).status, "complete");
});

test("Brave-like user agents do not select Firefox OAuth behavior", () => {
  const ns = firefoxNamespace();
  const ext = runCompatWith(ns, { exposeAs: "browser", userAgent: "Mozilla/5.0 Chrome/120.0 Safari/537.36" });
  assert.equal(ext.isFirefox, false);
});

test("session tokens fall back to memory and never touch local storage", async () => {
  const ns = firefoxNamespace({ session: false });
  const ext = runCompatWith(ns, { exposeAs: "browser", userAgent: "Firefox/121.0" });
  const expiresAt = Date.now() + 3600_000;
  await ext.setSessionValue("tok", { accessToken: "secret", expiresAt });
  assert.deepEqual(await ext.getSessionValue("tok"), { accessToken: "secret", expiresAt });
  assert.deepEqual(ns.local.data, {});
  await ext.clearSessionValues();
  assert.equal(await ext.getSessionValue("tok"), undefined);
});

test("session tokens prefer storage.session when available", async () => {
  const ns = firefoxNamespace({ session: true });
  const ext = runCompatWith(ns, { exposeAs: "browser", userAgent: "Firefox/121.0" });
  await ext.setSessionValue("tok", { accessToken: "abc", expiresAt: 123 });
  assert.deepEqual(ns.sessionStore.data, { tok: { accessToken: "abc", expiresAt: 123 } });
  assert.deepEqual(ns.local.data, {});
  await ext.clearSessionValues();
  assert.deepEqual(ns.sessionStore.data, {});
});

test("background loads without importScripts when modules are preloaded (Firefox scripts array)", () => {
  const sandbox = { console, PrairieRunCalendar: { exportAssignments: async () => [] } };
  const calls = [];
  const local = makeLocalStore();
  sandbox.PrairieRunExt = {
    isFirefox: true,
    storageLocalGet: () => Promise.resolve({}),
    storageLocalSet: () => Promise.resolve(),
    addRuntimeMessageListener: () => calls.push("runtime-listener"),
    addStorageChangedListener: () => calls.push("storage-listener"),
  };
  void local;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "extension", "background.js"), "utf8"), sandbox, { filename: "background.js" });
  assert.deepEqual(calls, ["runtime-listener", "storage-listener"]);
});

test("chrome manifest matches the base manifest", () => {
  execFileSync(process.execPath, [path.join(ROOT, "build-manifest.js"), "--target=chrome", "--check"], { stdio: "pipe" });
  const base = JSON.parse(fs.readFileSync(BASE_MANIFEST_PATH, "utf8"));
  const chrome = JSON.parse(fs.readFileSync(CHROME_MANIFEST_PATH, "utf8"));
  assert.deepEqual(chrome, base);
});

test("firefox manifest swaps in a scripts-array background and the gecko identity block", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "prairierun-firefox-"));
  try {
    execFileSync(process.execPath, [path.join(ROOT, "build-manifest.js"), "--target=firefox", `--out=${outDir}`], { stdio: "pipe" });
    const base = JSON.parse(fs.readFileSync(BASE_MANIFEST_PATH, "utf8"));
    const firefox = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
    const { browser_specific_settings, background, ...rest } = firefox;
    const { background: _baseBackground, ...baseRest } = base;
    void _baseBackground;
    assert.deepEqual(rest, baseRest);
    // scripts array (not service_worker: Firefox only enables that on 121+)
    // with the shim and calendar module ahead of the scanner.
    assert.deepEqual(background, { scripts: ["compat.js", "calendar.js", "background.js"] });
    assert.equal(browser_specific_settings.gecko.strict_min_version, "115.0");
    assert.match(browser_specific_settings.gecko.id, /@/);
    for (const file of ["compat.js", "calendar.js", "background.js", "content.js", "home-panel.js", "popup.js"]) {
      assert.ok(fs.existsSync(path.join(outDir, file)), `dist ships ${file}`);
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

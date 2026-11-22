const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createZipArchive,
  calculateCrc32,
  getChromeFiles,
  getFirefoxFiles,
} = require("../scripts/package-extensions.js");

test("calculateCrc32 computes standard IEEE 802.3 CRC-32", () => {
  const buf = Buffer.from("123456789", "utf8");
  // Standard check value for ASCII "123456789" is 0xcbf43926 (3421780262)
  assert.equal(calculateCrc32(buf), 0xcbf43926 >>> 0);
});

test("createZipArchive generates valid ZIP buffer with local and central headers", () => {
  const files = [
    { relativePath: "hello.txt", buffer: Buffer.from("Hello, World!", "utf8") },
    { relativePath: "manifest.json", buffer: Buffer.from('{"manifest_version": 3}', "utf8") },
  ];

  const zipBuffer = createZipArchive(files);
  assert.ok(Buffer.isBuffer(zipBuffer));
  assert.ok(zipBuffer.length > 0);

  // Local file header magic PK\x03\x04
  assert.equal(zipBuffer.readUInt32LE(0), 0x04034b50);

  // End of central directory record magic PK\x05\x06 at trailing 22 bytes
  const eocdOffset = zipBuffer.length - 22;
  assert.equal(zipBuffer.readUInt32LE(eocdOffset), 0x06054b50);
  assert.equal(zipBuffer.readUInt16LE(eocdOffset + 8), 2); // 2 records
  assert.equal(zipBuffer.readUInt16LE(eocdOffset + 10), 2); // 2 total records
});

test("getChromeFiles excludes .pem, .md, and manifest.base.json", () => {
  const chromeFiles = getChromeFiles();
  assert.ok(chromeFiles.length > 10, "Found chrome files");

  for (const file of chromeFiles) {
    assert.notEqual(file.relativePath, "manifest.base.json", "manifest.base.json must not be in bundle");
    assert.ok(!file.relativePath.endsWith(".pem"), "Private keys must never be packaged");
    assert.ok(!file.relativePath.endsWith(".md"), "Markdown files should not be packaged");
  }

  const manifest = chromeFiles.find((f) => f.relativePath === "manifest.json");
  assert.ok(manifest, "manifest.json is present in chrome package");
});

test("getFirefoxFiles includes manifest.json and background modules", () => {
  const firefoxFiles = getFirefoxFiles();
  assert.ok(firefoxFiles.length > 10, "Found firefox files");

  const manifest = firefoxFiles.find((f) => f.relativePath === "manifest.json");
  assert.ok(manifest, "manifest.json is present in firefox package");
});

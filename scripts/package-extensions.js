#!/usr/bin/env node
// Zero-dependency packager that generates ready-to-upload .zip distributions
// for both the Chrome Web Store and Firefox Add-ons (AMO).
//
// Usage:
//   node scripts/package-extensions.js [--out-dir=dist]
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_BASE = path.join(ROOT, "extension", "manifest.base.json");
const CHROME_DIR = path.join(ROOT, "extension");
const FIREFOX_DIR = path.join(ROOT, "dist-firefox");

// Build CRC-32 lookup table for pre-Node 22 environments
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function calculateCrc32(buffer) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buffer);
  let c = -1;
  for (let i = 0; i < buffer.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buffer[i]) & 0xff];
  }
  return (c ^ (-1)) >>> 0;
}

function createZipArchive(files) {
  // files: Array of { relativePath: string, buffer: Buffer }
  const localChunks = [];
  const centralChunks = [];
  let byteOffset = 0;

  for (const file of files) {
    const normalizedName = file.relativePath.replace(/\\/g, "/");
    const nameBuffer = Buffer.from(normalizedName, "utf8");
    const rawData = file.buffer;
    const crc = calculateCrc32(rawData);

    // Deflate compression
    const deflated = zlib.deflateRawSync(rawData);
    const useDeflate = deflated.length < rawData.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : rawData;

    // Fixed DOS datetime: 2026-01-01 00:00:00
    const dosTime = 0;
    const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

    // 1. Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4);         // version needed to extract (2.0)
    localHeader.writeUInt16LE(0, 6);          // general purpose bit flag
    localHeader.writeUInt16LE(method, 8);     // compression method
    localHeader.writeUInt16LE(dosTime, 10);   // last mod time
    localHeader.writeUInt16LE(dosDate, 12);   // last mod date
    localHeader.writeUInt32LE(crc, 14);       // CRC-32
    localHeader.writeUInt32LE(payload.length, 18); // compressed size
    localHeader.writeUInt32LE(rawData.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuffer.length, 26); // file name length
    localHeader.writeUInt16LE(0, 28);                 // extra field length

    localChunks.push(localHeader, nameBuffer, payload);

    // 2. Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4);         // version made by
    centralHeader.writeUInt16LE(20, 6);         // version needed to extract
    centralHeader.writeUInt16LE(0, 8);          // flags
    centralHeader.writeUInt16LE(method, 10);    // method
    centralHeader.writeUInt16LE(dosTime, 12);   // time
    centralHeader.writeUInt16LE(dosDate, 14);   // date
    centralHeader.writeUInt32LE(crc, 16);       // CRC-32
    centralHeader.writeUInt32LE(payload.length, 20); // compressed size
    centralHeader.writeUInt32LE(rawData.length, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBuffer.length, 28); // name length
    centralHeader.writeUInt16LE(0, 30);              // extra length
    centralHeader.writeUInt16LE(0, 32);              // comment length
    centralHeader.writeUInt16LE(0, 34);              // disk number start
    centralHeader.writeUInt16LE(0, 36);              // internal file attributes
    centralHeader.writeUInt32LE(0, 38);              // external file attributes
    centralHeader.writeUInt32LE(byteOffset, 42);     // relative offset of local header

    centralChunks.push(centralHeader, nameBuffer);

    byteOffset += localHeader.length + nameBuffer.length + payload.length;
  }

  const centralDirOffset = byteOffset;
  let centralDirSize = 0;
  for (const chunk of centralChunks) centralDirSize += chunk.length;

  // 3. End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);             // signature
  eocd.writeUInt16LE(0, 4);                      // number of this disk
  eocd.writeUInt16LE(0, 6);                      // disk where central dir starts
  eocd.writeUInt16LE(files.length, 8);           // number of central dir records on this disk
  eocd.writeUInt16LE(files.length, 10);          // total number of central dir records
  eocd.writeUInt32LE(centralDirSize, 12);        // size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16);      // offset of start of central directory
  eocd.writeUInt16LE(0, 20);                     // comment length

  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

function parseCliArgs() {
  const args = { outDir: "dist" };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--out-dir=")) args.outDir = arg.slice("--out-dir=".length);
  }
  return args;
}

function getChromeFiles() {
  const allowedExts = new Set([".js", ".css", ".html", ".json", ".png", ".svg"]);
  const entries = fs.readdirSync(CHROME_DIR);
  const files = [];

  for (const entry of entries) {
    // Explicitly exclude internal and forbidden files
    if (entry === "manifest.base.json") continue;
    if (entry.endsWith(".pem")) continue; // NEVER package private keys
    if (entry.endsWith(".md")) continue;  // Documentation is not needed in extension bundle
    if (entry.startsWith(".")) continue;

    const ext = path.extname(entry).toLowerCase();
    if (!allowedExts.has(ext)) continue;

    const fullPath = path.join(CHROME_DIR, entry);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;

    files.push({
      relativePath: entry,
      buffer: fs.readFileSync(fullPath),
    });
  }
  return files;
}

function getFirefoxFiles() {
  const entries = fs.readdirSync(FIREFOX_DIR);
  const files = [];

  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const fullPath = path.join(FIREFOX_DIR, entry);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;

    files.push({
      relativePath: entry,
      buffer: fs.readFileSync(fullPath),
    });
  }
  return files;
}

function main() {
  const { outDir } = parseCliArgs();
  const absoluteOutDir = path.isAbsolute(outDir) ? outDir : path.join(ROOT, outDir);

  console.log("=== PrairieRun Extension Release Packager ===");

  // 1. Read base manifest version
  const baseJson = JSON.parse(fs.readFileSync(MANIFEST_BASE, "utf8"));
  const version = baseJson.version || "0.1.0";
  console.log(`Target version: v${version}`);

  // 2. Ensure manifests and distributions are freshly built
  console.log("\nBuilding Chrome and Firefox manifests...");
  execFileSync(process.execPath, [path.join(ROOT, "build-manifest.js"), "--target=chrome"], { stdio: "inherit" });
  execFileSync(process.execPath, [path.join(ROOT, "build-manifest.js"), "--target=firefox", `--out=${FIREFOX_DIR}`], { stdio: "inherit" });

  fs.mkdirSync(absoluteOutDir, { recursive: true });

  // 3. Package Chrome extension
  console.log("\nPackaging Chrome Web Store bundle...");
  const chromeFiles = getChromeFiles();
  const chromeZipBuffer = createZipArchive(chromeFiles);
  const chromeZipPath = path.join(absoluteOutDir, `prairierun-chrome-v${version}.zip`);
  const chromeLatestZipPath = path.join(absoluteOutDir, "prairierun-chrome.zip");

  fs.writeFileSync(chromeZipPath, chromeZipBuffer);
  fs.writeFileSync(chromeLatestZipPath, chromeZipBuffer);
  console.log(`  -> ${path.relative(ROOT, chromeZipPath)} (${(chromeZipBuffer.length / 1024).toFixed(1)} KB, ${chromeFiles.length} files)`);
  console.log(`  -> ${path.relative(ROOT, chromeLatestZipPath)} (latest alias)`);

  // Verify Chrome manifest inside package
  const hasChromeManifest = chromeFiles.some((f) => f.relativePath === "manifest.json");
  if (!hasChromeManifest) throw new Error("Chrome bundle is missing manifest.json!");
  const hasPem = chromeFiles.some((f) => f.relativePath.endsWith(".pem"));
  if (hasPem) throw new Error("CRITICAL: .pem private key was found in package! Halting.");

  // 4. Package Firefox Add-on
  console.log("\nPackaging Firefox AMO bundle...");
  const firefoxFiles = getFirefoxFiles();
  const firefoxZipBuffer = createZipArchive(firefoxFiles);
  const firefoxZipPath = path.join(absoluteOutDir, `prairierun-firefox-v${version}.zip`);
  const firefoxLatestZipPath = path.join(absoluteOutDir, "prairierun-firefox.zip");

  fs.writeFileSync(firefoxZipPath, firefoxZipBuffer);
  fs.writeFileSync(firefoxLatestZipPath, firefoxZipBuffer);
  console.log(`  -> ${path.relative(ROOT, firefoxZipPath)} (${(firefoxZipBuffer.length / 1024).toFixed(1)} KB, ${firefoxFiles.length} files)`);
  console.log(`  -> ${path.relative(ROOT, firefoxLatestZipPath)} (latest alias)`);

  // Verify Firefox manifest inside package
  const hasFirefoxManifest = firefoxFiles.some((f) => f.relativePath === "manifest.json");
  if (!hasFirefoxManifest) throw new Error("Firefox bundle is missing manifest.json!");

  console.log("\nAll packages built successfully!");
  console.log(`Outputs directory: ${path.relative(ROOT, absoluteOutDir)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("Packaging failed:", error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  createZipArchive,
  calculateCrc32,
  getChromeFiles,
  getFirefoxFiles,
};

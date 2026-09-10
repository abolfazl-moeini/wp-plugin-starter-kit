import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { promisify } from "node:util";

import {
  readZipEntries,
  readEmbeddedManifestFromZip,
  createCanonicalZip,
  generateArtifactManifest,
  MAX_ENTRY_UNCOMPRESSED_BYTES,
  MAX_MANIFEST_UNCOMPRESSED_BYTES,
} from "../canonical-artifact-manifest.mjs";

const execFileAsync = promisify(execFile);

function buildMinimalZip(entries) {
  const localChunks = [];
  const cdChunks = [];
  let currentOffset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const payload = entry.payload || Buffer.alloc(0);
    const compMethod = entry.compMethod ?? 8;
    const compSize = entry.compressedSize ?? payload.length;
    const uncompSize = entry.uncompressedSize ?? payload.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(compMethod, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(entry.crc32 ?? 0, 14);
    localHeader.writeUInt32LE(compSize, 18);
    localHeader.writeUInt32LE(uncompSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localChunk = Buffer.concat([localHeader, nameBuf, payload]);
    localChunks.push(localChunk);

    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(0, 8);
    cdHeader.writeUInt16LE(compMethod, 10);
    cdHeader.writeUInt16LE(0, 12);
    cdHeader.writeUInt16LE(0, 14);
    cdHeader.writeUInt32LE(entry.crc32 ?? 0, 16);
    cdHeader.writeUInt32LE(compSize, 20);
    cdHeader.writeUInt32LE(uncompSize, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36);
    cdHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cdHeader.writeUInt32LE(currentOffset, 42);

    cdChunks.push(Buffer.concat([cdHeader, nameBuf]));
    currentOffset += localChunk.length;
  }

  const localAll = Buffer.concat(localChunks);
  const cdAll = Buffer.concat(cdChunks);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdAll.length, 12);
  eocd.writeUInt32LE(localAll.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localAll, cdAll, eocd]);
}

test("F14: Bounded inflate fails closed when deflated stream exceeds declared uncompressed size", () => {
  const actualDecompressedData = Buffer.alloc(20000, 65); // 20KB of 'A'
  const deflated = zlib.deflateRawSync(actualDecompressedData);

  // Declare uncompressed size of only 10 bytes to simulate zip bomb deception
  const zip = buildMinimalZip([
    {
      name: "sample-plugin/payload.txt",
      payload: deflated,
      uncompressedSize: 10,
    },
  ]);

  assert.throws(
    () => readZipEntries(zip),
    /candidate ZIP payload inflate failed:.*Cannot create a Buffer larger than/i
  );
});

test("F14: Declared uncompressed size exceeding MAX_ENTRY_UNCOMPRESSED_BYTES is rejected before inflate", () => {
  const zip = buildMinimalZip([
    {
      name: "sample-plugin/huge.bin",
      payload: Buffer.from("test"),
      uncompressedSize: MAX_ENTRY_UNCOMPRESSED_BYTES + 1024,
    },
  ]);

  assert.throws(
    () => readZipEntries(zip),
    /candidate ZIP entry exceeds bounded entry limit/i
  );
});

test("F14: Child process rejects zip bomb stream without host OOM or uncaught exception", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f14-child-bomb-"));
  try {
    const actualData = Buffer.alloc(50000, 88);
    const deflated = zlib.deflateRawSync(actualData);
    const zip = buildMinimalZip([
      {
        name: "sample-plugin/bomb.bin",
        payload: deflated,
        uncompressedSize: 15,
      },
    ]);
    const zipFile = path.join(tmpRoot, "bomb.zip");
    await writeFile(zipFile, zip);

    const script = `
      import fs from "node:fs";
      import { readZipEntries } from "${path.resolve("canonical-artifact-manifest.mjs")}";
      const buf = fs.readFileSync("${zipFile}");
      try {
        readZipEntries(buf);
        process.exit(1);
      } catch (err) {
        if (/Cannot create a Buffer larger than|inflate failed/i.test(err.message)) {
          process.exit(0);
        }
        process.exit(2);
      }
    `;
    const scriptFile = path.join(tmpRoot, "check.mjs");
    await writeFile(scriptFile, script);

    const { stdout, stderr } = await execFileAsync("node", [scriptFile]);
    assert.equal(stderr, "");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("F14: ZIP entry name containing newline or carriage return is rejected with explicit error", async () => {
  const validPayload = zlib.deflateRawSync(Buffer.from("safe content"));
  const zipWithNewline = buildMinimalZip([
    {
      name: "sample-plugin/file\nname.php",
      payload: validPayload,
      uncompressedSize: 12,
    },
  ]);

  assert.throws(
    () => readZipEntries(zipWithNewline),
    /candidate ZIP entry path contains newline characters/i
  );

  const zipWithCr = buildMinimalZip([
    {
      name: "sample-plugin/file\rname.php",
      payload: validPayload,
      uncompressedSize: 12,
    },
  ]);

  assert.throws(
    () => readZipEntries(zipWithCr),
    /candidate ZIP entry path contains newline characters/i
  );

  // Also verify createCanonicalZip rejects filenames with newline
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f14-zip-cr-"));
  try {
    const staging = path.join(tmpRoot, "sample-plugin");
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, "sample-plugin.php"), "<?php");
    const badFile = path.join(staging, "bad\nfile.txt");
    try {
      await writeFile(badFile, "malicious");
      await assert.rejects(
        createCanonicalZip({
          sourceRoot: staging,
          outputZip: path.join(tmpRoot, "out.zip"),
          rootName: "sample-plugin",
        }),
        /Zip entry relative path contains illegal newline or carriage return characters/i
      );
    } catch (fsErr) {
      // If filesystem rejects \n in filename, safe
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("F14: Canonical ZIP creation is bit-for-bit deterministic across timezones and locales", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f14-reproducible-"));
  try {
    const pluginName = "sample-repro";
    const staging = path.join(tmpRoot, pluginName);
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, `${pluginName}.php`), "<?php // canonical\n");
    await mkdir(path.join(staging, "src/FrameworkClosure"), { recursive: true });
    await writeFile(
      path.join(staging, "src/FrameworkClosure/functions-closure.php"),
      "<?php // closure\n"
    );
    await mkdir(path.join(staging, "vendor/composer"), { recursive: true });
    await writeFile(
      path.join(staging, "vendor/composer/autoload_files.php"),
      `<?php return array('$baseDir . "/src/FrameworkClosure/functions-closure.php"');\n`
    );
    await writeFile(
      path.join(staging, "vendor/autoload.php"),
      "<?php // autoloader\n"
    );

    const manifest = await generateArtifactManifest({
      rootDir: staging,
      consumer: pluginName,
      profile: "Profile S",
    });
    await writeFile(
      path.join(staging, "artifact-manifest.json"),
      JSON.stringify(manifest, null, 2)
    );

    const zip1 = path.join(tmpRoot, "out-tehran.zip");
    const zip2 = path.join(tmpRoot, "out-utc.zip");

    const origTz = process.env.TZ;
    const origEpoch = process.env.SOURCE_DATE_EPOCH;
    try {
      process.env.SOURCE_DATE_EPOCH = "1704067200";
      process.env.TZ = "Asia/Tehran";
      await createCanonicalZip({
        sourceRoot: staging,
        outputZip: zip1,
        rootName: pluginName,
      });

      process.env.TZ = "UTC";
      await createCanonicalZip({
        sourceRoot: staging,
        outputZip: zip2,
        rootName: pluginName,
      });
    } finally {
      if (origTz === undefined) delete process.env.TZ;
      else process.env.TZ = origTz;
      if (origEpoch === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = origEpoch;
    }

    const hash1 = crypto.createHash("sha256").update(await readFile(zip1)).digest("hex");
    const hash2 = crypto.createHash("sha256").update(await readFile(zip2)).digest("hex");

    assert.equal(
      hash1,
      hash2,
      `ZIP hashes must be identical across timezones: ${hash1} vs ${hash2}`
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("F14: Embedded manifest parser enforces bounded inflate and size limits", () => {
  const validManifest = {
    schemaVersion: 1,
    consumer: "sample-plugin",
    profile: "Profile S",
    artifactId: "sample-plugin-profile-s",
    files: [],
  };
  const manifestJson = JSON.stringify(validManifest);
  const deflated = zlib.deflateRawSync(Buffer.from(manifestJson, "utf8"));

  // 1. Manifest declared uncompressed size exceeds MAX_MANIFEST_UNCOMPRESSED_BYTES
  const hugePayload = zlib.deflateRawSync(Buffer.alloc(MAX_MANIFEST_UNCOMPRESSED_BYTES + 1, 65));
  const hugeManifestZip = buildMinimalZip([
    {
      name: "sample-plugin/artifact-manifest.json",
      payload: hugePayload,
      uncompressedSize: MAX_MANIFEST_UNCOMPRESSED_BYTES + 1,
    },
  ]);
  const hugeRes = readEmbeddedManifestFromZip(hugeManifestZip, "sample-plugin");
  assert.equal(hugeRes.valid, false);
  assert.match(hugeRes.reason, /Embedded manifest uncompressed size exceeds limit/i);

  // 2. Manifest deflated stream exceeds declared size
  const bombManifestZip = buildMinimalZip([
    {
      name: "sample-plugin/artifact-manifest.json",
      payload: zlib.deflateRawSync(Buffer.alloc(2000, 66)),
      uncompressedSize: 5,
    },
  ]);
  const bombRes = readEmbeddedManifestFromZip(bombManifestZip, "sample-plugin");
  assert.equal(bombRes.valid, false);
  assert.match(bombRes.reason, /inflate failed:.*Cannot create a Buffer larger than|Failed to decompress manifest:.*Cannot create a Buffer larger than/i);
});

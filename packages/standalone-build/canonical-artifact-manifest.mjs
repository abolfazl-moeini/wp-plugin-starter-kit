#!/usr/bin/env node

/**
 * Plan 3: Canonical Artifact Manifest & Verification Engine (Tamper Resistance Phase 1)
 * 
 * Functions:
 * 1. Collects all production files in deterministic lexicographic order.
 * 2. Strict rejection of symlinks, path traversals, and root development directories.
 * 3. Preserves nested production namespaces (e.g. src/Modules/OnlineTest/Tests/TestRegistry.php).
 * 4. Generates canonical SHA-256 digest of artifact manifest avoiding self-recursion.
 * 5. Structured, fail-closed verifier with zero fatal errors or white-screens.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { chmod, cp, lstat, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

const execFileAsync = promisify(execFile);

export function canonicalSourceDate(epoch = process.env.SOURCE_DATE_EPOCH) {
  const parsed = epoch === undefined || epoch === null || epoch === "" ? NaN : Number(epoch);
  const seconds = Number.isFinite(parsed) ? parsed : Date.parse("2026-01-01T00:00:00Z") / 1000;
  return new Date(seconds * 1000);
}

export async function normalizeStagingTree(dir, { epoch = process.env.SOURCE_DATE_EPOCH } = {}) {
  const canonicalTime = canonicalSourceDate(epoch);
  const st = await lstat(dir);
  if (st.isSymbolicLink()) {
    throw new Error(`Refusing to normalize symlink: ${dir}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`Staging path is not a directory: ${dir}`);
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const childStat = await lstat(fullPath);
    if (childStat.isSymbolicLink()) {
      throw new Error(`Refusing to chmod/utimes symlink: ${fullPath}`);
    }
    if (childStat.isDirectory()) {
      await normalizeStagingTree(fullPath, { epoch });
      await chmod(fullPath, 0o755);
      await utimes(fullPath, canonicalTime, canonicalTime);
    } else if (childStat.isFile()) {
      await chmod(fullPath, 0o644);
      await utimes(fullPath, canonicalTime, canonicalTime);
    } else {
      throw new Error(`Unsupported staging entry type: ${fullPath}`);
    }
  }

  await chmod(dir, 0o755);
  await utimes(dir, canonicalTime, canonicalTime);
}

export function isSafeRelative(value) {
  return (
    typeof value === "string" &&
    value !== "" &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value !== ".." &&
    !value.startsWith("../")
  );
}

function uint32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function uint16(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

export const MAX_ENTRY_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MB max for a single file entry
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 500 * 1024 * 1024; // 500 MB max total uncompressed
export const MAX_MANIFEST_UNCOMPRESSED_BYTES = 10 * 1024 * 1024; // 10 MB max for artifact manifest
export const MAX_COMPRESSED_INPUT_BYTES = 500 * 1024 * 1024; // 500 MB max compressed archive

const SKIP_ZIP_RELATIVE_NAMES = new Set([
  "artifact-manifest.json",
  "release-manifest.json",
  "release-manifest.sig",
]);

function hashZipPayload(bytes, {
  name,
  compressionMethod,
  compressedSize,
  uncompressedSize,
  localHeaderOffset,
  localNameLength,
  localExtraLength,
  isDirectory,
}) {
  if (isDirectory) {
    return null;
  }
  if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
    throw new Error(
      `candidate ZIP payload exceeds bounded entry limit (${uncompressedSize} > ${MAX_ENTRY_UNCOMPRESSED_BYTES}): ${name}`
    );
  }
  const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
  if (dataOffset + compressedSize > bytes.length) {
    throw new Error(`candidate ZIP payload is truncated: ${name}`);
  }
  const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
  let payload;
  if (compressionMethod === 0) {
    payload = compressed;
  } else if (compressionMethod === 8) {
    try {
      payload = zlib.inflateRawSync(compressed, {
        maxOutputLength: Math.min(uncompressedSize + 1, MAX_ENTRY_UNCOMPRESSED_BYTES),
      });
    } catch (err) {
      throw new Error(`candidate ZIP payload inflate failed: ${name}: ${err.message}`);
    }
  } else {
    throw new Error(`unsupported ZIP compression method ${compressionMethod}: ${name}`);
  }
  if (payload.length !== uncompressedSize) {
    throw new Error(
      `candidate ZIP payload size mismatch: ${name} (expected ${uncompressedSize}, got ${payload.length})`,
    );
  }
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function zipEntryRelativePath(entryName, consumer) {
  const prefix = consumer ? `${consumer}/` : "";
  if (prefix && (entryName === consumer || entryName === prefix)) {
    return "";
  }
  if (prefix && entryName.startsWith(prefix)) {
    return entryName.slice(prefix.length);
  }
  return entryName;
}

export function readZipEntries(bytes) {
  if (bytes.length > MAX_COMPRESSED_INPUT_BYTES) {
    throw new Error(`candidate ZIP compressed size exceeds limit (${bytes.length} > ${MAX_COMPRESSED_INPUT_BYTES})`);
  }
  const earliest = Math.max(0, bytes.length - 0x10016);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (uint32(bytes, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("candidate ZIP has no end-of-central-directory record");
  if (uint16(bytes, eocd + 4) !== 0 || uint16(bytes, eocd + 6) !== 0) {
    throw new Error("multi-disk candidate ZIPs are not allowed");
  }
  const entriesCount = uint16(bytes, eocd + 10);
  const centralSize = uint32(bytes, eocd + 12);
  const centralOffset = uint32(bytes, eocd + 16);
  if (entriesCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("Zip64 candidate ZIPs are not allowed");
  }
  if (centralOffset + centralSize > bytes.length) throw new Error("candidate ZIP central directory is truncated");

  const entries = [];
  const seenNames = new Set();
  const caseFolded = new Set();
  let offset = centralOffset;
  let totalUncompressedSize = 0;

  for (let index = 0; index < entriesCount; index += 1) {
    if (offset + 46 > bytes.length || uint32(bytes, offset) !== 0x02014b50) {
      throw new Error("candidate ZIP has an invalid central-directory entry");
    }
    const flags = uint16(bytes, offset + 8);
    const compressionMethod = uint16(bytes, offset + 10);
    const compressedSize = uint32(bytes, offset + 20);
    const uncompressedSize = uint32(bytes, offset + 24);
    const nameLength = uint16(bytes, offset + 28);
    const extraLength = uint16(bytes, offset + 30);
    const commentLength = uint16(bytes, offset + 32);
    const externalAttributes = uint32(bytes, offset + 38);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) throw new Error("candidate ZIP central-directory entry is truncated");
    if ((flags & 0x0001) !== 0) throw new Error("encrypted candidate ZIP entries are not allowed");
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = rawName.toString("utf8");
    if (!Buffer.from(name, "utf8").equals(rawName) || !isSafeRelative(name.replace(/\/$/, ""))) {
      throw new Error(`candidate ZIP has an unsafe entry path: ${name}`);
    }
    if (name.includes("\n") || name.includes("\r")) {
      throw new Error(`candidate ZIP entry path contains newline characters: ${JSON.stringify(name)}`);
    }

    if (seenNames.has(name) || caseFolded.has(name.toLowerCase())) {
      throw new Error(`candidate ZIP contains duplicate or case-colliding entry: ${name}`);
    }
    seenNames.add(name);
    caseFolded.add(name.toLowerCase());

    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new Error(`candidate ZIP entry exceeds bounded entry limit (${uncompressedSize} > ${MAX_ENTRY_UNCOMPRESSED_BYTES}): ${name}`);
    }

    totalUncompressedSize += uncompressedSize;
    if (totalUncompressedSize > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error(`candidate ZIP exceeds maximum uncompressed size limit (${totalUncompressedSize} > ${MAX_TOTAL_UNCOMPRESSED_BYTES})`);
    }

    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new Error(`candidate ZIP entry is a symlink: ${name}`);
    }

    const localHeaderOffset = uint32(bytes, offset + 42);
    if (localHeaderOffset === 0xffffffff) {
      throw new Error("Zip64 candidate ZIPs are not allowed");
    }
    if (localHeaderOffset + 30 > bytes.length || uint32(bytes, localHeaderOffset) !== 0x04034b50) {
      throw new Error(`candidate ZIP local header is invalid: ${name}`);
    }
    const localNameLength = uint16(bytes, localHeaderOffset + 26);
    const localExtraLength = uint16(bytes, localHeaderOffset + 28);
    if (localHeaderOffset + 30 + localNameLength + localExtraLength > bytes.length) {
      throw new Error(`candidate ZIP local header is truncated: ${name}`);
    }
    const localName = bytes.subarray(
      localHeaderOffset + 30,
      localHeaderOffset + 30 + localNameLength
    ).toString("utf8");
    if (localName !== name) {
      throw new Error(`candidate ZIP local name does not match central directory name: ${name}`);
    }

    const isDirectory = name.endsWith("/");
    const sha256 = hashZipPayload(bytes, {
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      localNameLength,
      localExtraLength,
      isDirectory,
    });

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      isDirectory,
      externalAttributes,
      sha256,
    });

    offset = end;
  }
  return entries;
}

export function canonicalizeJson(obj) {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    // If array contains objects with 'path', sort canonically by path
    const isPathArray = obj.length > 0 && obj.every((item) => item && typeof item === "object" && typeof item.path === "string");
    const arr = isPathArray ? [...obj].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) : obj;
    return "[" + arr.map(canonicalizeJson).join(",") + "]";
  }
  const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalizeJson(obj[k])).join(",") + "}";
}

export function computeManifestDigest(manifestPayload) {
  // Strip non-deterministic or self-referential fields for canonical digest calculation
  const { manifestDigest, signature, kid, buildId, generatedAt, ...canonicalPayload } = manifestPayload;
  const canonicalStr = canonicalizeJson(canonicalPayload);
  return crypto.createHash("sha256").update(canonicalStr, "utf8").digest("hex");
}

export function validateArtifactManifestObject(manifest, { consumer = null } = {}) {
  const blockers = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["Artifact manifest must be an object"];
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    return ["artifact-manifest.json has unsupported schema or invalid files array"];
  }
  if (typeof manifest.consumer !== "string" || manifest.consumer.length === 0) {
    blockers.push("Manifest consumer must be a non-empty string");
  } else if (consumer && manifest.consumer !== consumer) {
    blockers.push(`Manifest consumer mismatch (expected '${consumer}', got '${manifest.consumer}')`);
  }
  if (typeof manifest.profile !== "string" || manifest.profile.length === 0) {
    blockers.push("Manifest profile must be a non-empty string");
  }
  const expectedArtifactId = typeof manifest.consumer === "string" && typeof manifest.profile === "string"
    ? `${manifest.consumer}-${manifest.profile.toLowerCase().replace(/\s+/g, "-")}`
    : null;
  if (typeof manifest.artifactId !== "string" || manifest.artifactId.length === 0) {
    blockers.push("Manifest artifactId must be a non-empty string");
  } else if (expectedArtifactId && manifest.artifactId !== expectedArtifactId) {
    blockers.push(`Manifest artifactId mismatch (expected '${expectedArtifactId}', got '${manifest.artifactId}')`);
  }
  if (typeof manifest.manifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(manifest.manifestDigest)) {
    blockers.push("Manifest manifestDigest must be a lowercase SHA-256 digest");
  }
  if (manifest.resolvedProfile !== undefined && manifest.resolvedProfile !== "s" && manifest.resolvedProfile !== "clean") {
    blockers.push("Manifest resolvedProfile must be 's' or 'clean' when present");
  }
  if (manifest.obfuscate !== undefined && typeof manifest.obfuscate !== "boolean") {
    blockers.push("Manifest obfuscate must be a boolean when present");
  }
  if (manifest.dynamicEdges !== undefined && !Array.isArray(manifest.dynamicEdges)) {
    blockers.push("Manifest dynamicEdges must be an array when present");
  }
  if (manifest.obfuscate !== undefined && manifest.resolvedProfile !== undefined) {
    if ((manifest.obfuscate && manifest.resolvedProfile !== "s") || (!manifest.obfuscate && manifest.resolvedProfile !== "clean")) {
      blockers.push("Manifest obfuscate flag is inconsistent with resolvedProfile");
    }
  }
  if (manifest.toolchain !== undefined) {
    if (typeof manifest.toolchain !== "object" || Array.isArray(manifest.toolchain) || manifest.toolchain === null) {
      blockers.push("Manifest toolchain must be an object when present");
    } else {
      const requiredTools = ["node", "php", "zip", "unzip", "rsync", "composer"];
      for (const tool of requiredTools) {
        if (typeof manifest.toolchain[tool] !== "string" || manifest.toolchain[tool].trim().length === 0) {
          blockers.push(`Manifest toolchain must contain a non-empty string for '${tool}'`);
        }
      }
    }
  }
  for (const [index, file] of manifest.files.entries()) {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      blockers.push(`Manifest file entry ${index} must be an object`);
      continue;
    }
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      blockers.push(`Manifest file entry has invalid SHA-256: ${file.path || index}`);
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      blockers.push(`Manifest file entry has invalid size: ${file.path || index}`);
    }
    if (file.isFile !== true || file.isSymlink !== false) {
      blockers.push(`Manifest file entry has invalid type flags: ${file.path || index}`);
    }
  }
  return blockers;
}

export async function hashFile(filePath) {
  const content = await readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

export async function collectCanonicalFiles(dir, baseDir = dir, isRoot = true) {
  const entries = await readdir(dir, { withFileTypes: true });
  let files = [];
  const seenPaths = new Set();
  const caseFolded = new Set();

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).split(path.sep).join("/");

    // Skip manifest files to avoid recursion
    if (
      relPath === "artifact-manifest.json" ||
      relPath === "release-manifest.json" ||
      relPath === "release-manifest.sig" ||
      entry.name === ".DS_Store"
    ) {
      continue;
    }

    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are forbidden in production artifact: ${relPath}`);
    }

    if (entry.name.startsWith(".") && entry.name !== ".htaccess") {
      throw new Error(`Hidden dotfiles are forbidden in production artifact: ${relPath}`);
    }

    if (entry.isDirectory()) {
      const lowerName = entry.name.toLowerCase();
      // Root development dirs forbidden in production tree
      if (isRoot) {
        const ROOT_DEV_DIRS = new Set([
          "tests",
          "unit-tests",
          "dev",
          "docs",
          "coverage",
          "artifacts",
          "bin",
          "docker-phpunit",
          "node_modules",
          ".git",
        ]);
        if (ROOT_DEV_DIRS.has(lowerName)) {
          throw new Error(`Root development directory is forbidden in production artifact: ${relPath}`);
        }
      }
      files = files.concat(await collectCanonicalFiles(fullPath, baseDir, false));
    } else if (entry.isFile()) {
      // Validate path hygiene
      if (
        relPath.includes("\\") ||
        path.posix.normalize(relPath) !== relPath ||
        relPath.startsWith("../") ||
        path.isAbsolute(relPath) ||
        relPath.includes("\0")
      ) {
        throw new Error(`Unsafe file path detected in production tree: ${relPath}`);
      }

      if (seenPaths.has(relPath) || caseFolded.has(relPath.toLowerCase())) {
        throw new Error(`Duplicate or case-colliding path: ${relPath}`);
      }
      seenPaths.add(relPath);
      caseFolded.add(relPath.toLowerCase());

      const sha256 = await hashFile(fullPath);
      const stat = await lstat(fullPath);

      files.push({
        path: relPath,
        size: stat.size,
        sha256,
        isFile: true,
        isSymlink: false,
      });
    }
  }

  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function generateArtifactManifest({
  rootDir,
  consumer,
  version = "1.0.0",
  profile = "Profile S",
  transformerVersion = "1.0.0",
  phpTarget = "7.4+",
  composerLockSha256 = null,
  buildId = null,
  toolchain = null,
  resolvedProfile = null,
  obfuscate = null,
  dynamicEdges = null,
}) {
  const files = await collectCanonicalFiles(rootDir);
  const normalizedConsumer = consumer || path.basename(rootDir);
  const normalizedProfile = profile || "Profile S";
  const slugProfile = normalizedProfile.toLowerCase().replace(/\s+/g, "-");

  const filesDigest = crypto.createHash("sha256").update(
    files.map((f) => `${f.path}:${f.sha256}:${f.size}`).join("\n")
  ).digest("hex");

  const payload = {
    schemaVersion: 1,
    purpose: "artifact-integrity-manifest",
    consumer: normalizedConsumer,
    artifactId: `${normalizedConsumer}-${slugProfile}`,
    version,
    buildId: buildId || `build-${normalizedConsumer}-${filesDigest.slice(0, 16)}`,
    profile: normalizedProfile,
    transformerVersion,
    phpTarget,
    composerLockSha256,
    signingStatus: "not-configured",
    files,
  };
  if (toolchain && typeof toolchain === "object" && !Array.isArray(toolchain)) {
    payload.toolchain = toolchain;
  }
  if (typeof resolvedProfile === "string" && resolvedProfile.length > 0) {
    payload.resolvedProfile = resolvedProfile;
  }
  if (typeof obfuscate === "boolean") {
    payload.obfuscate = obfuscate;
  }
  if (Array.isArray(dynamicEdges)) {
    payload.dynamicEdges = dynamicEdges;
  }

  const manifestDigest = computeManifestDigest(payload);
  const finalManifest = {
    ...payload,
    manifestDigest,
  };

  const manifestPath = path.join(rootDir, "artifact-manifest.json");
  await writeFile(manifestPath, JSON.stringify(finalManifest, null, 2) + "\n", "utf8");

  return finalManifest;
}

export async function verifyArtifactManifest({
  rootDir,
  manifestObject = null,
  expectedZipPath = null,
  consumer = null,
}) {
  const missingFiles = [];
  const unexpectedFiles = [];
  const modifiedFiles = [];
  const blockers = [];
  let manifest = manifestObject;

  const manifestPath = path.join(rootDir, "artifact-manifest.json");

  if (!manifest) {
    try {
      const stat = await lstat(manifestPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return {
          schemaVersion: 1,
          status: "invalid_manifest",
          severity: "high",
          fatal: false,
          blockers: ["artifact-manifest.json must be a regular non-symlink file"],
          missingFiles,
          unexpectedFiles,
          modifiedFiles,
        };
      }
      const raw = await readFile(manifestPath, "utf8");
      manifest = JSON.parse(raw);
    } catch (err) {
      return {
        schemaVersion: 1,
        status: "invalid_manifest",
        severity: "high",
        fatal: false,
        blockers: [`Cannot read or parse artifact-manifest.json: ${err.message}`],
        missingFiles,
        unexpectedFiles,
        modifiedFiles,
      };
    }
  }

  // Validate manifest structure and identity before trusting any path or digest.
  const structureBlockers = validateArtifactManifestObject(manifest, { consumer });
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    return {
      schemaVersion: 1,
      status: "invalid_manifest",
      severity: "high",
      fatal: false,
      blockers: ["artifact-manifest.json has unsupported schema or invalid files array"],
      missingFiles,
      unexpectedFiles,
      modifiedFiles,
    };
  }
  blockers.push(...structureBlockers);

  // Verify manifest digest
  if (typeof manifest.manifestDigest === "string" && /^[a-f0-9]{64}$/.test(manifest.manifestDigest)) {
    const computedDigest = computeManifestDigest(manifest);
    if (computedDigest !== manifest.manifestDigest) {
      blockers.push(`Manifest digest mismatch: expected ${manifest.manifestDigest}, computed ${computedDigest}`);
    }
  }

  const manifestFileMap = new Map();
  const seenPaths = new Set();
  const caseFolded = new Set();

  for (const f of manifest.files) {
    if (!f.path || typeof f.path !== "string") {
      blockers.push("Manifest file entry is missing path string");
      continue;
    }
    if (
      f.path.includes("\\") ||
      path.posix.normalize(f.path) !== f.path ||
      f.path.startsWith("../") ||
      path.isAbsolute(f.path) ||
      f.path.includes("\0")
    ) {
      blockers.push(`Unsafe path in manifest: ${f.path}`);
      continue;
    }
    if (seenPaths.has(f.path) || caseFolded.has(f.path.toLowerCase())) {
      blockers.push(`Duplicate path in manifest: ${f.path}`);
      continue;
    }
    seenPaths.add(f.path);
    caseFolded.add(f.path.toLowerCase());
    manifestFileMap.set(f.path, f);

    const physical = path.join(rootDir, f.path);
    try {
      const st = await lstat(physical);
      if (st.isSymbolicLink()) {
        blockers.push(`Symlink forbidden on disk: ${f.path}`);
      } else if (!st.isFile()) {
        blockers.push(`Non-regular file on disk: ${f.path}`);
      } else {
        if (st.size !== f.size) {
          modifiedFiles.push({
            path: f.path,
            expectedSize: f.size,
            actualSize: st.size,
          });
          continue;
        }
        const actualSha = await hashFile(physical);
        if (actualSha !== f.sha256) {
          modifiedFiles.push({
            path: f.path,
            expectedSha: f.sha256,
            actualSha,
          });
        }
      }
    } catch {
      missingFiles.push(f.path);
    }
  }

  // Scan disk for unexpected files
  async function scanDisk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full).split(path.sep).join("/");
      if (
        rel === "artifact-manifest.json" ||
        rel === "release-manifest.json" ||
        rel === "release-manifest.sig" ||
        entry.name === ".DS_Store"
      ) {
        continue;
      }
      const diskStat = await lstat(full);
      if (diskStat.isSymbolicLink()) {
        blockers.push(`Symlink forbidden on disk: ${rel}`);
        unexpectedFiles.push(rel);
        continue;
      }
      if (diskStat.isDirectory()) {
        await scanDisk(full);
      } else if (diskStat.isFile()) {
        if (!manifestFileMap.has(rel)) {
          unexpectedFiles.push(rel);
        }
      } else {
        blockers.push(`Non-regular file on disk: ${rel}`);
        unexpectedFiles.push(rel);
      }
    }
  }

  try {
    await scanDisk(rootDir);
  } catch (err) {
    blockers.push(`Disk scanning error: ${err.message}`);
  }

  // If ZIP validation requested, hash inflated payloads (never name-only).
  if (expectedZipPath && fs.existsSync(expectedZipPath)) {
    try {
      const zipStat = await lstat(expectedZipPath);
      if (zipStat.isSymbolicLink() || !zipStat.isFile()) {
        blockers.push("expected ZIP must be a regular non-symlink file");
      } else {
        const zipBytes = await readFile(expectedZipPath);
        const zipEntries = readZipEntries(zipBytes);
        const zipFileMap = new Map();
        for (const entry of zipEntries) {
          if (entry.isDirectory) continue;
          const rel = zipEntryRelativePath(entry.name, consumer);
          if (!rel || SKIP_ZIP_RELATIVE_NAMES.has(rel)) continue;
          zipFileMap.set(rel, entry);
          if (!manifestFileMap.has(rel)) {
            unexpectedFiles.push(rel);
          }
        }
        for (const [rel, file] of manifestFileMap) {
          const zipEntry = zipFileMap.get(rel);
          if (!zipEntry) {
            missingFiles.push(rel);
            continue;
          }
          if (zipEntry.uncompressedSize !== file.size || zipEntry.sha256 !== file.sha256) {
            modifiedFiles.push({
              path: rel,
              expectedSha: file.sha256,
              actualSha: zipEntry.sha256,
              expectedSize: file.size,
              actualSize: zipEntry.uncompressedSize,
            });
          }
        }
      }
    } catch (err) {
      blockers.push(`ZIP inspection error: ${err.message}`);
    }
  }

  let status = "valid";
  if (blockers.length > 0) {
    status = "invalid_manifest";
  } else if (modifiedFiles.length > 0) {
    status = "modified";
  } else if (missingFiles.length > 0) {
    status = "missing";
  } else if (unexpectedFiles.length > 0) {
    status = "unexpected";
  }

  return {
    schemaVersion: 1,
    status,
    severity: status === "valid" ? "none" : "high",
    fatal: false,
    consumer: manifest.consumer,
    artifactId: manifest.artifactId,
    manifestDigest: manifest.manifestDigest,
    signingStatus: manifest.signingStatus || "not-configured",
    blockers,
    missingFiles,
    unexpectedFiles,
    modifiedFiles,
  };
}

export async function verifyZipAgainstManifest({
  zipPath,
  consumer,
  manifest = null,
}) {
  let zipBytes;
  try {
    const st = await lstat(zipPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      return {
        schemaVersion: 1,
        status: "invalid_manifest",
        severity: "high",
        fatal: false,
        blockers: ["ZIP archive must be a regular non-symlink file"],
        missingFiles: [],
        unexpectedFiles: [],
        modifiedFiles: [],
      };
    }
    zipBytes = await readFile(zipPath);
  } catch (err) {
    return {
      schemaVersion: 1,
      status: "invalid_manifest",
      severity: "high",
      fatal: false,
      blockers: [`Cannot read ZIP file: ${err.message}`],
      missingFiles: [],
      unexpectedFiles: [],
      modifiedFiles: [],
    };
  }

  // 1. Preflight binary check (names, traversal, symlink, payload hashes)
  let entries;
  try {
    entries = readZipEntries(zipBytes);
  } catch (err) {
    return {
      schemaVersion: 1,
      status: "invalid_manifest",
      severity: "high",
      fatal: false,
      blockers: [`ZIP binary preflight check failed: ${err.message}`],
      missingFiles: [],
      unexpectedFiles: [],
      modifiedFiles: [],
    };
  }

  // 2. Strict single root requirement
  const expectedPrefix = `${consumer}/`;
  for (const entry of entries) {
    if (entry.name !== consumer && entry.name !== expectedPrefix && !entry.name.startsWith(expectedPrefix)) {
      return {
        schemaVersion: 1,
        status: "invalid_manifest",
        severity: "high",
        fatal: false,
        blockers: [`ZIP entry does not reside within single root '${consumer}/': ${entry.name}`],
        missingFiles: [],
        unexpectedFiles: [],
        modifiedFiles: [],
      };
    }
    if (/(^|\/)(?:symbol[-_]map|symbols)[^/]*\.json$/i.test(entry.name)) {
      return {
        schemaVersion: 1,
        status: "invalid_manifest",
        severity: "high",
        fatal: false,
        blockers: [`secret build intermediate packaged in ZIP: ${entry.name}`],
        missingFiles: [],
        unexpectedFiles: [],
        modifiedFiles: [],
      };
    }
  }

  // 3. Resolve manifest from the caller or the embedded ZIP payload (no unzip).
  let resolvedManifest = manifest;
  if (!resolvedManifest) {
    const embedded = readEmbeddedManifestFromZip(zipBytes, consumer);
    if (!embedded.valid) {
      return {
        schemaVersion: 1,
        status: "invalid_manifest",
        severity: "high",
        fatal: false,
        blockers: [embedded.reason || "embedded artifact-manifest.json is invalid"],
        missingFiles: [],
        unexpectedFiles: [],
        modifiedFiles: [],
      };
    }
    resolvedManifest = embedded.manifest;
  }

  const structureBlockers = validateArtifactManifestObject(resolvedManifest, { consumer });
  if (structureBlockers.length > 0 || !resolvedManifest || !Array.isArray(resolvedManifest.files)) {
    return {
      schemaVersion: 1,
      status: "invalid_manifest",
      severity: "high",
      fatal: false,
      blockers: structureBlockers.length > 0
        ? structureBlockers
        : ["artifact-manifest.json has unsupported schema or invalid files array"],
      missingFiles: [],
      unexpectedFiles: [],
      modifiedFiles: [],
    };
  }

  if (typeof resolvedManifest.manifestDigest === "string" && /^[a-f0-9]{64}$/.test(resolvedManifest.manifestDigest)) {
    const computedDigest = computeManifestDigest(resolvedManifest);
    if (computedDigest !== resolvedManifest.manifestDigest) {
      structureBlockers.push(
        `Manifest digest mismatch: expected ${resolvedManifest.manifestDigest}, computed ${computedDigest}`,
      );
    }
  }
  if (structureBlockers.length > 0) {
    return {
      schemaVersion: 1,
      status: "invalid_manifest",
      severity: "high",
      fatal: false,
      blockers: structureBlockers,
      missingFiles: [],
      unexpectedFiles: [],
      modifiedFiles: [],
    };
  }

  const missingFiles = [];
  const unexpectedFiles = [];
  const modifiedFiles = [];
  const manifestFileMap = new Map();
  for (const file of resolvedManifest.files) {
    if (!file || typeof file.path !== "string") continue;
    manifestFileMap.set(file.path, file);
  }

  const zipFileMap = new Map();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const rel = zipEntryRelativePath(entry.name, consumer);
    if (!rel || SKIP_ZIP_RELATIVE_NAMES.has(rel)) continue;
    zipFileMap.set(rel, entry);
  }

  for (const [rel, file] of manifestFileMap) {
    const zipEntry = zipFileMap.get(rel);
    if (!zipEntry) {
      missingFiles.push(rel);
      continue;
    }
    if (zipEntry.uncompressedSize !== file.size || zipEntry.sha256 !== file.sha256) {
      modifiedFiles.push({
        path: rel,
        expectedSha: file.sha256,
        actualSha: zipEntry.sha256,
        expectedSize: file.size,
        actualSize: zipEntry.uncompressedSize,
      });
    }
  }
  for (const rel of zipFileMap.keys()) {
    if (!manifestFileMap.has(rel)) {
      unexpectedFiles.push(rel);
    }
  }

  let status = "valid";
  if (modifiedFiles.length > 0) {
    status = "modified";
  } else if (missingFiles.length > 0) {
    status = "missing";
  } else if (unexpectedFiles.length > 0) {
    status = "unexpected";
  }

  return {
    schemaVersion: 1,
    status,
    severity: status === "valid" ? "none" : "high",
    fatal: false,
    consumer: resolvedManifest.consumer,
    artifactId: resolvedManifest.artifactId,
    manifestDigest: resolvedManifest.manifestDigest,
    signingStatus: resolvedManifest.signingStatus || "not-configured",
    blockers: [],
    missingFiles,
    unexpectedFiles,
    modifiedFiles,
  };
}

export function readEmbeddedManifestFromZip(zipBytes, consumer) {
  if (!Buffer.isBuffer(zipBytes)) {
    throw new Error("zipBytes must be a Buffer");
  }
  if (zipBytes.length > MAX_COMPRESSED_INPUT_BYTES) {
    return { valid: false, reason: `Candidate ZIP compressed size exceeds limit (${zipBytes.length} > ${MAX_COMPRESSED_INPUT_BYTES})` };
  }
  try {
    readZipEntries(zipBytes);
  } catch (err) {
    return { valid: false, reason: `Invalid ZIP: ${err.message}` };
  }
  const eocd = zipBytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) {
    return { valid: false, reason: "Invalid ZIP: End of Central Directory record not found" };
  }
  const cdOffset = zipBytes.readUInt32LE(eocd + 16);
  const cdSize = zipBytes.readUInt32LE(eocd + 12);
  if (cdOffset + cdSize > zipBytes.length) {
    return { valid: false, reason: "Invalid ZIP: Central directory extends beyond file bounds" };
  }

  let offset = cdOffset;
  let manifestEntry = null;
  const targetNameA = `${consumer}/artifact-manifest.json`;
  const targetNameB = "artifact-manifest.json";

  while (offset < eocd) {
    if (zipBytes.readUInt32LE(offset) !== 0x02014b50) {
      return { valid: false, reason: "Invalid ZIP: Corrupted central directory header" };
    }
    const nameLen = zipBytes.readUInt16LE(offset + 28);
    const extraLen = zipBytes.readUInt16LE(offset + 30);
    const commentLen = zipBytes.readUInt16LE(offset + 32);
    const name = zipBytes.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");

    if (name === targetNameA || name === targetNameB) {
      if (manifestEntry) {
        return { valid: false, reason: "Duplicate manifest entries detected in ZIP" };
      }
      manifestEntry = {
        name,
        compMethod: zipBytes.readUInt16LE(offset + 10),
        compSize: zipBytes.readUInt32LE(offset + 20),
        uncompSize: zipBytes.readUInt32LE(offset + 24),
        localOffset: zipBytes.readUInt32LE(offset + 42),
      };
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }

  if (!manifestEntry) {
    return { valid: false, reason: `Embedded artifact-manifest.json missing in ZIP for consumer '${consumer}'` };
  }

  const { compMethod, compSize, uncompSize, localOffset } = manifestEntry;
  if (uncompSize > MAX_MANIFEST_UNCOMPRESSED_BYTES) {
    return { valid: false, reason: `Embedded manifest uncompressed size exceeds limit (${uncompSize} > ${MAX_MANIFEST_UNCOMPRESSED_BYTES})` };
  }
  if (compMethod !== 0 && compMethod !== 8) {
    return { valid: false, reason: `Unsupported ZIP compression method for embedded manifest: ${compMethod}` };
  }
  if (localOffset + 30 > zipBytes.length || zipBytes.readUInt32LE(localOffset) !== 0x04034b50) {
    return { valid: false, reason: "Invalid local file header for embedded manifest" };
  }
  const localNameLen = zipBytes.readUInt16LE(localOffset + 26);
  const localExtraLen = zipBytes.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
  if (dataOffset + compSize > zipBytes.length) {
    return { valid: false, reason: "Truncated manifest data in ZIP" };
  }

  const compData = zipBytes.subarray(dataOffset, dataOffset + compSize);
  let uncompData;
  try {
    uncompData = compMethod === 0 ? compData : zlib.inflateRawSync(compData, {
      maxOutputLength: Math.min(uncompSize + 1, MAX_MANIFEST_UNCOMPRESSED_BYTES),
    });
  } catch (err) {
    return { valid: false, reason: `Failed to decompress manifest: ${err.message}` };
  }

  if (uncompData.length !== uncompSize) {
    return { valid: false, reason: `Decompressed manifest size mismatch (expected ${uncompSize}, got ${uncompData.length})` };
  }

  let manifestObj;
  try {
    manifestObj = JSON.parse(uncompData.toString("utf8"));
  } catch (err) {
    return { valid: false, reason: `Embedded artifact-manifest.json is malformed JSON: ${err.message}` };
  }

  const structureBlockers = validateArtifactManifestObject(manifestObj, { consumer });
  if (structureBlockers.length > 0) {
    return { valid: false, reason: structureBlockers.join("; ") };
  }

  const computedDigest = computeManifestDigest(manifestObj);
  if (manifestObj.manifestDigest !== computedDigest) {
    return { valid: false, reason: `Embedded manifestDigest is forged or corrupted (${manifestObj.manifestDigest} vs ${computedDigest})` };
  }

  return {
    valid: true,
    manifest: manifestObj,
    manifestDigest: manifestObj.manifestDigest,
    artifactId: manifestObj.artifactId,
  };
}

/**
 * Collect plugin-relative paths Composer will `require` from autoload.files.
 * Used both to order ZIP entries (complementary in-place-unzip defense) and
 * to fail closed in atomic deploy preflight when a listed target is missing.
 */
export async function collectComposerAutoloadFileTargets(rootDir) {
  const targets = new Set();
  const root = path.resolve(rootDir);

  const autoloadFilesPhp = path.join(root, "vendor/composer/autoload_files.php");
  if (fs.existsSync(autoloadFilesPhp)) {
    const content = await readFile(autoloadFilesPhp, "utf8");
    let matchCount = 0;
    for (const m of content.matchAll(/\$baseDir\s*\.\s*['"]\/([^'"]+)['"]/g)) {
      targets.add(m[1].replace(/\\/g, "/"));
      matchCount++;
    }
    for (const m of content.matchAll(/\$vendorDir\s*\.\s*['"]\/([^'"]+)['"]/g)) {
      targets.add(`vendor/${m[1].replace(/\\/g, "/")}`);
      matchCount++;
    }
    if (matchCount === 0 && (content.includes("=>") || content.includes("$baseDir") || content.includes("$vendorDir"))) {
      throw new Error(`Unsupported Composer autoload_files.php format in ${autoloadFilesPhp}`);
    }
  }

  const autoloadStaticPhp = path.join(root, "vendor/composer/autoload_static.php");
  if (fs.existsSync(autoloadStaticPhp)) {
    const content = await readFile(autoloadStaticPhp, "utf8");
    // Support both long `array(...)` and short `[...]` static $files forms.
    // Without the short-form branch a `[...]` block silently yields zero targets.
    const filesBlockMatch = content.match(/public\s+static\s+\$files\s*=\s*array\s*\(([\s\S]*?)\);/) || content.match(/public\s+static\s+\$files\s*=\s*\[([\s\S]*?)\];/);
    if (filesBlockMatch) {
      const filesBlock = filesBlockMatch[1];
      let matchCount = 0;
      for (const m of filesBlock.matchAll(/__DIR__\s*\.\s*['"]\/\.\.\/\.\.['"]\s*\.\s*['"]\/([^'"]+)['"]/g)) {
        targets.add(m[1].replace(/\\/g, "/"));
        matchCount++;
      }
      for (const m of filesBlock.matchAll(/__DIR__\s*\.\s*['"]\/\.\.['"]\s*\.\s*['"]\/([^'"]+)['"]/g)) {
        targets.add(`vendor/${m[1].replace(/\\/g, "/")}`);
        matchCount++;
      }
      if (matchCount === 0 && filesBlock.trim().length > 0 && filesBlock.includes("=>")) {
        throw new Error(`Unsupported Composer autoload_static.php files block format in ${autoloadStaticPhp}`);
      }
    }
  }

  const composerJsonPath = path.join(root, "composer.json");
  if (fs.existsSync(composerJsonPath)) {
    const cData = JSON.parse(await readFile(composerJsonPath, "utf8"));
    if (Array.isArray(cData?.autoload?.files)) {
      for (const f of cData.autoload.files) {
        if (typeof f === "string" && f.trim()) {
          targets.add(f.replace(/\\/g, "/").replace(/^\.\//, ""));
        }
      }
    }
  }

  // Validate containment, traversal, and symlinks for all resolved targets
  const validatedTargets = new Set();
  const realRoot = (() => {
    try {
      return fs.realpathSync(root);
    } catch {
      return root;
    }
  })();
  for (const t of targets) {
    if (!t || typeof t !== "string") continue;
    const normalized = path.posix.normalize(t);
    if (normalized.startsWith("../") || normalized === ".." || path.isAbsolute(normalized)) {
      throw new Error(`Composer autoload target '${t}' attempts parent directory traversal`);
    }
    const resolvedPath = path.resolve(root, normalized);
    if (!resolvedPath.startsWith(root + path.sep)) {
      throw new Error(`Composer autoload target '${t}' escapes root boundary: ${resolvedPath}`);
    }
    // Reject symlink escapes anywhere in the parent chain, not just the leaf.
    // A lexical inside-check alone accepts `linkdir/evil.php` where `linkdir`
    // points outside the root.
    let cursor = resolvedPath;
    while (cursor.startsWith(root + path.sep) && cursor !== root) {
      let st = null;
      try {
        st = await fs.promises.lstat(cursor);
      } catch {
        cursor = path.dirname(cursor);
        continue;
      }
      if (st.isSymbolicLink()) {
        let linkTarget;
        try {
          linkTarget = await fs.promises.realpath(cursor);
        } catch {
          throw new Error(`Composer autoload target '${t}' traverses an unreadable symlink: ${cursor}`);
        }
        if (linkTarget !== realRoot && !linkTarget.startsWith(realRoot + path.sep)) {
          throw new Error(`Composer autoload target '${t}' escapes root via symlink: ${cursor} -> ${linkTarget}`);
        }
        break;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (fs.existsSync(resolvedPath)) {
      const st = await fs.promises.lstat(resolvedPath);
      if (st.isSymbolicLink()) {
        throw new Error(`Composer autoload target '${t}' must not be a symbolic link: ${resolvedPath}`);
      }
    }
    validatedTargets.add(normalized);
  }

  return validatedTargets;
}

/**
 * Computes canonical entry priority for deterministic, race-free ZIP archive creation.
 * Crucial constraint: Bootstrap, framework closures, and autoload target files MUST strictly
 * precede Composer autoloader files (vendor/autoload.php & autoload_real.php) to prevent
 * transient Fatal errors during in-place extractions.
 */
function getCanonicalEntryPriority(rel, rootName, autoloadTargets = new Set()) {
  if (!rel) return 0; // Root directory
  // Priority 10: Critical root descriptors & bootstrap
  if (
    rel === `${rootName}.php` ||
    rel === "artifact-manifest.json" ||
    rel === "LICENSE" ||
    rel === "readme.txt" ||
    rel === "project.config.json" ||
    (!rel.includes("/") && rel.endsWith(".php"))
  ) {
    return 10;
  }
  // Priority 20: Framework Closures & Composer autoload.files targets
  if (
    rel === "src" ||
    rel === "src/FrameworkClosure" ||
    rel === "src/FrameworkClosure/functions-closure.php" ||
    rel.startsWith("src/FrameworkClosure/") ||
    autoloadTargets.has(rel) ||
    (rel.startsWith("src/") && rel.endsWith("-register.php"))
  ) {
    return 20;
  }
  // Priority 30: Other plugin PHP files (classes, modules)
  if (!rel.startsWith("vendor/") && !rel.startsWith("vendor-prefixed/") && rel.endsWith(".php")) {
    return 30;
  }
  // Priority 40: Other plugin static assets, styles, languages, templates
  if (!rel.startsWith("vendor/") && !rel.startsWith("vendor-prefixed/")) {
    return 40;
  }
  // Priority 50: Vendor-prefixed and third-party vendor code
  if (
    rel.startsWith("vendor-prefixed/") ||
    (rel.startsWith("vendor/") && !rel.startsWith("vendor/composer/") && rel !== "vendor/autoload.php")
  ) {
    return 50;
  }
  // Priority 60+: Composer autoloader files (MUST BE EXTRACTED LAST)
  if (rel === "vendor/composer/ClassLoader.php") return 60;
  if (rel.startsWith("vendor/composer/") && !rel.endsWith("autoload_real.php")) return 61;
  if (rel === "vendor/composer/autoload_real.php") return 62;
  if (rel === "vendor/autoload.php") return 70;
  return 55;
}

const EXCLUDED_ZIP_DIR_NAMES = new Set([".git", "node_modules"]);
const EXCLUDED_ZIP_FILE_NAMES = new Set([".DS_Store"]);

async function collectCanonicalZipEntries(dir, relPrefix = "") {
  const items = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_ZIP_DIR_NAMES.has(entry.name)) continue;
      const childRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      items.push({ rel: childRel, isDirectory: true });
      const subItems = await collectCanonicalZipEntries(path.join(dir, entry.name), childRel);
      items.push(...subItems);
    } else if (entry.isFile()) {
      if (EXCLUDED_ZIP_FILE_NAMES.has(entry.name) || entry.name.endsWith(".bak") || entry.name.endsWith(".swp")) continue;
      const childRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      items.push({ rel: childRel, isDirectory: false });
    }
  }
  return items;
}

export async function createCanonicalZip({ sourceRoot, outputZip, rootName }) {
  const root = path.resolve(sourceRoot);
  const archive = path.resolve(outputZip);
  await mkdir(path.dirname(archive), { recursive: true });
  await rm(archive, { force: true });

  const parentDir = path.dirname(root);
  const baseName = path.basename(root);

  let targetDir = root;
  let zipCwd = parentDir;
  let tmpStage = null;

  if (baseName === rootName) {
    await normalizeStagingTree(root);
  } else {
    tmpStage = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), `zip-${rootName}-`));
    targetDir = path.join(tmpStage, rootName);
    await cp(root, targetDir, { recursive: true });
    await normalizeStagingTree(targetDir);
    zipCwd = tmpStage;
  }

  try {
    const autoloadTargets = await collectComposerAutoloadFileTargets(targetDir);

    const items = await collectCanonicalZipEntries(targetDir);
    for (const item of items) {
      if (item.rel.includes("\n") || item.rel.includes("\r")) {
        throw new Error(`Zip entry relative path contains illegal newline or carriage return characters: ${JSON.stringify(item.rel)}`);
      }
    }
    items.sort((a, b) => {
      const pa = getCanonicalEntryPriority(a.rel, rootName, autoloadTargets);
      const pb = getCanonicalEntryPriority(b.rel, rootName, autoloadTargets);
      if (pa !== pb) return pa - pb;
      return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
    });

    const finalZipLines = [];
    const emittedDirs = new Set();

    function emitDir(dirRel) {
      if (!dirRel) {
        if (!emittedDirs.has(rootName)) {
          finalZipLines.push(`${rootName}/`);
          emittedDirs.add(rootName);
        }
        return;
      }
      const parts = dirRel.split("/").filter(Boolean);
      let cur = rootName;
      emitDir("");
      for (const p of parts) {
        cur += `/${p}`;
        if (!emittedDirs.has(cur)) {
          finalZipLines.push(`${cur}/`);
          emittedDirs.add(cur);
        }
      }
    }

    emitDir("");

    for (const item of items) {
      if (item.isDirectory) {
        emitDir(item.rel);
      } else {
        const parentRel = path.dirname(item.rel);
        if (parentRel && parentRel !== ".") {
          emitDir(parentRel);
        }
        finalZipLines.push(`${rootName}/${item.rel}`);
      }
    }

    await new Promise((resolve, reject) => {
      const zipProc = execFile(
        "zip",
        ["-q", "-X", archive, "-@"],
        {
          cwd: zipCwd,
          env: {
            ...process.env,
            TZ: "UTC",
            LC_ALL: "C",
            LANG: "C",
            SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH || "1704067200",
          },
        },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`Failed to create canonical ZIP '${archive}': ${stderr || err.message}`));
          } else {
            resolve();
          }
        }
      );
      zipProc.stdin.on("error", () => {
        // Prevent unhandled EPIPE if zip exits prematurely
      });
      zipProc.stdin.write(finalZipLines.join("\n") + "\n");
      zipProc.stdin.end();
    });
  } finally {
    if (tmpStage) {
      await rm(tmpStage, { recursive: true, force: true });
    }
  }

  return archive;
}

if (process.argv[1] && process.argv[1].endsWith("canonical-artifact-manifest.mjs")) {
  const [,, cmd, targetDir] = process.argv;
  if (cmd === "generate" && targetDir) {
    generateArtifactManifest({ rootDir: path.resolve(targetDir) }).then((m) => {
      console.log(JSON.stringify(m, null, 2));
    });
  } else if (cmd === "verify" && targetDir) {
    verifyArtifactManifest({ rootDir: path.resolve(targetDir) }).then((r) => {
      console.log(JSON.stringify(r, null, 2));
      if (r.status !== "valid") process.exit(1);
    });
  } else {
    console.log("Usage: node canonical-artifact-manifest.mjs <generate|verify> <targetDir>");
  }
}

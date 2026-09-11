#!/usr/bin/env node

/**
 * Shared Artifact Test Fixture Helper
 *
 * Enforces strict binary preflight on ZIP archives before extraction:
 * 1. Verifies regular file / non-symlink status and minimal size.
 * 2. Computes pre-extraction SHA-256 hash.
 * 3. Preflights ZIP central directory entries: enforces single-root `${consumer}/`,
 *    rejects path traversal, absolute paths, and duplicate/case-colliding entries.
 * 4. Extracts safely once into an isolated temporary directory.
 * 5. Verifies extracted root is a regular directory without symlinks.
 * 6. Guarantees safe cleanup in after hooks.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readZipEntries } from "./canonical-artifact-manifest.mjs";
import { resolveContentRoot } from "./resolve-content-root.mjs";

const execFileAsync = promisify(execFile);

export function getDefaultZipPath(consumer) {
  let root;
  try {
    root = resolveContentRoot({
      scriptDir: path.dirname(fileURLToPath(import.meta.url)),
      cwd: process.cwd(),
      env: process.env,
    });
  } catch {
    const localDist = path.resolve(process.cwd(), `dist/${consumer}-profile-s.zip`);
    const fallback = "/Users/moeini/Dev/tavangary.new/wordpress/wp-content";
    if (!fs.existsSync(localDist) && fs.existsSync(fallback)) {
      root = fallback;
    } else {
      root = process.cwd();
    }
  }
  return path.resolve(root, `dist/${consumer}-profile-s.zip`);
}

export async function prepareArtifactFixture({
  consumer,
  zipPath = getDefaultZipPath(consumer),
  customStagingRoot = null,
  signal = null,
}) {
  if (!consumer || typeof consumer !== "string") {
    throw new Error("prepareArtifactFixture: consumer is required");
  }
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Artifact ZIP does not exist at ${zipPath}`);
  }

  const st = await lstat(zipPath);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Artifact ZIP must be a regular file, not a symlink: ${zipPath}`);
  }
  if (st.size < 1000) {
    throw new Error(`Artifact ZIP is too small to be valid (${st.size} bytes): ${zipPath}`);
  }

  const zipBytes = await readFile(zipPath);
  const zipSha256 = crypto.createHash("sha256").update(zipBytes).digest("hex");

  // Enforce central directory safety and single-root topology
  const entries = readZipEntries(zipBytes);
  const expectedPrefix = `${consumer}/`;
  const seenEntries = new Set();

  for (const entry of entries) {
    if (entry.name.includes("..") || entry.name.startsWith("/") || entry.name.startsWith("\\")) {
      throw new Error(`Unsafe traversal entry in ZIP: ${entry.name}`);
    }
    if (entry.name !== consumer && entry.name !== expectedPrefix && !entry.name.startsWith(expectedPrefix)) {
      throw new Error(`ZIP entry '${entry.name}' does not reside in single root '${consumer}/'`);
    }
    const lower = entry.name.toLowerCase();
    if (seenEntries.has(lower)) {
      throw new Error(`Duplicate or case-colliding entry in ZIP: ${entry.name}`);
    }
    seenEntries.add(lower);
  }

  // Create isolated owned directory
  let ownedDir;
  if (customStagingRoot) {
    await fs.promises.mkdir(customStagingRoot, { recursive: true });
    ownedDir = path.join(customStagingRoot, `staging-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await fs.promises.mkdir(ownedDir, { recursive: true });
  } else {
    ownedDir = await mkdtemp(path.join(os.tmpdir(), `fixture-${consumer}-`));
  }

  try {
    if (signal?.aborted) {
      throw new Error("Fixture extraction aborted before execution");
    }

    const snapshotPath = path.join(ownedDir, `.snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.zip`);
    await fs.promises.writeFile(snapshotPath, zipBytes, { flag: "wx", mode: 0o400 });
    try {
      await execFileAsync("unzip", ["-q", snapshotPath, "-d", ownedDir], signal ? { signal } : {});
    } finally {
      await rm(snapshotPath, { force: true }).catch(() => {});
    }

    const pluginDir = path.join(ownedDir, consumer);
    if (!fs.existsSync(pluginDir)) {
      throw new Error(`Extracted plugin root '${consumer}' does not exist in staging: ${pluginDir}`);
    }

    const pluginSt = await lstat(pluginDir);
    if (pluginSt.isSymbolicLink() || !pluginSt.isDirectory()) {
      throw new Error(`Extracted plugin root must be a regular directory, not a symlink: ${pluginDir}`);
    }

    return {
      stagingRoot: ownedDir,
      pluginDir,
      zipPath,
      zipSha256,
      entries: entries.map((e) => e.name),
      cleanup: async () => {
        if (ownedDir && fs.existsSync(ownedDir)) {
          await rm(ownedDir, { recursive: true, force: true });
        }
      },
    };
  } catch (err) {
    if (ownedDir && fs.existsSync(ownedDir)) {
      try {
        await rm(ownedDir, { recursive: true, force: true });
      } catch {}
    }
    throw err;
  }
}

export async function createHermeticZipFixture({ tmpDir, consumer }) {
  const { generateArtifactManifest, createCanonicalZip } = await import("./canonical-artifact-manifest.mjs");
  const pluginSrc = path.join(tmpDir, consumer);
  await fs.promises.mkdir(pluginSrc, { recursive: true });
  await fs.promises.writeFile(path.join(pluginSrc, `${consumer}.php`), `<?php echo 'OK ${consumer}';\n`, "utf8");
  
  const manifest = await generateArtifactManifest({
    rootDir: pluginSrc,
    consumer,
    profile: "Profile S",
  });
  await fs.promises.writeFile(path.join(pluginSrc, "artifact-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const zipPath = path.join(tmpDir, `${consumer}-profile-s.zip`);
  await createCanonicalZip({
    sourceRoot: pluginSrc,
    outputZip: zipPath,
    rootName: consumer,
  });

  const zipBytes = await fs.promises.readFile(zipPath);
  const zipSha256 = crypto.createHash("sha256").update(zipBytes).digest("hex");
  return { zipPath, zipSha256, manifestDigest: manifest.manifestDigest };
}

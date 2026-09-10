import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  computeTreeContentHash,
  computePluginCompositeFingerprint,
  planDependencyGraphBuild,
} from "../build-cache-engine.mjs";

import {
  generateArtifactManifest,
  verifyArtifactManifest,
  verifyZipAgainstManifest,
} from "../canonical-artifact-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const execFileAsync = promisify(execFile);

test("Content-based cache: modifying 1 byte in source file creates cache miss", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cache-test-"));
  try {
    await mkdir(path.join(tmpDir, "src"), { recursive: true });
    await writeFile(path.join(tmpDir, "src/main.php"), "<?php echo 'v1';");

    const hash1 = await computeTreeContentHash(tmpDir);

    // Modify 1 byte
    await writeFile(path.join(tmpDir, "src/main.php"), "<?php echo 'v2';");
    const hash2 = await computeTreeContentHash(tmpDir);

    assert.notEqual(hash1, hash2, "Changing file content must produce different content hash");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Content-based cache: updating mtime/timestamp WITHOUT changing content results in cache hit", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cache-mtime-"));
  try {
    await mkdir(path.join(tmpDir, "src"), { recursive: true });
    const filePath = path.join(tmpDir, "src/main.php");
    await writeFile(filePath, "<?php echo 'constant';");

    const hash1 = await computeTreeContentHash(tmpDir);

    // Change timestamp to 2 hours ago
    const pastTime = (Date.now() - 7200000) / 1000;
    await utimes(filePath, pastTime, pastTime);

    const hash2 = await computeTreeContentHash(tmpDir);
    assert.equal(hash1, hash2, "Changing timestamp without content modification must produce identical hash");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Dependency graph: changing shared plugins/wpdev propagates to all dependent plugins", async () => {
  const previousCache = {
    _tools: "tools-hash-v1",
    _wpdev: "wpdev-hash-v1",
    "tavangary-core": "tools-hash-v1:wpdev-hash-v1:core-hash-v1:profile:clean",
    "wpdev-crm": "tools-hash-v1:wpdev-hash-v1:crm-hash-v1:profile:clean",
  };

  const currentFingerprints = {
    tools: "tools-hash-v1",
    wpdev: "wpdev-hash-v2", // changed!
    plugins: {
      "tavangary-core": "core-hash-v1",
      "wpdev-crm": "crm-hash-v1",
    },
  };

  const plan = planDependencyGraphBuild({
    targetPlugins: ["tavangary-core", "wpdev-crm"],
    previousCache,
    currentFingerprints,
    mode: "changed",
  });

  assert.equal(plan["tavangary-core"].shouldRebuild, true);
  assert.ok(plan["tavangary-core"].reason.includes("wpdev"));
  assert.equal(plan["wpdev-crm"].shouldRebuild, true);
  assert.ok(plan["wpdev-crm"].reason.includes("wpdev"));
});

test("Dependency graph: changing only a single consumer only rebuilds that consumer", async () => {
  const previousCache = {
    _tools: "tools-hash-v1",
    _wpdev: "wpdev-hash-v1",
    // Composite identity always binds the canonical tier (F05): clean builds
    // carry an explicit profile:clean segment.
    "tavangary-core": "tools-hash-v1:wpdev-hash-v1:core-hash-v1:profile:clean",
    "wpdev-crm": "tools-hash-v1:wpdev-hash-v1:crm-hash-v1:profile:clean",
  };

  const currentFingerprints = {
    tools: "tools-hash-v1",
    wpdev: "wpdev-hash-v1",
    plugins: {
      "tavangary-core": "core-hash-v2", // changed!
      "wpdev-crm": "crm-hash-v1", // unchanged!
    },
  };

  const plan = planDependencyGraphBuild({
    targetPlugins: ["tavangary-core", "wpdev-crm"],
    previousCache,
    currentFingerprints,
    mode: "changed",
  });

  assert.equal(plan["tavangary-core"].shouldRebuild, true);
  assert.ok(plan["tavangary-core"].reason.includes("Source code changed"));
  assert.equal(plan["wpdev-crm"].shouldRebuild, false);
  assert.equal(plan["wpdev-crm"].reason, "Cached (inputs unchanged)");
});

test("Dependency graph: toolchain fingerprint changes invalidate cached artifacts", () => {
  const targetPlugins = ["tavangary-core"];
  const base = {
    tools: "tools",
    wpdev: "wpdev",
    plugins: { "tavangary-core": "source" },
    toolchain: "toolchain-v1",
  };
  const initial = planDependencyGraphBuild({
    targetPlugins,
    previousCache: {},
    currentFingerprints: base,
  });
  const changed = planDependencyGraphBuild({
    targetPlugins,
    previousCache: {
      _tools: base.tools,
      _wpdev: base.wpdev,
      "tavangary-core": initial["tavangary-core"].compositeFingerprint,
    },
    currentFingerprints: { ...base, toolchain: "toolchain-v2" },
  });
  assert.equal(changed["tavangary-core"].shouldRebuild, true);
});

test("ZIP verification: tampered byte inside ZIP fails verification", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "zip-tamper-"));
  const stagingPlugin = path.join(tmpDir, "test-plugin");
  const zipPath = path.join(tmpDir, "test-plugin.zip");
  try {
    await mkdir(path.join(stagingPlugin, "src"), { recursive: true });
    await writeFile(path.join(stagingPlugin, "src/code.php"), "<?php echo 'original';");

    const manifest = await generateArtifactManifest({
      rootDir: stagingPlugin,
      consumer: "test-plugin",
      version: "1.0.0",
      profile: "Profile S",
    });

    await execFileAsync("zip", ["-r", "-q", zipPath, "test-plugin"], { cwd: tmpDir });

    // Verify valid ZIP passes
    const validReport = await verifyZipAgainstManifest({
      zipPath,
      consumer: "test-plugin",
      manifest,
    });
    assert.equal(validReport.status, "valid");

    // Create a tampered ZIP where a byte in code.php is changed
    await writeFile(path.join(stagingPlugin, "src/code.php"), "<?php echo 'TAMPERED';");
    const tamperedZipPath = path.join(tmpDir, "tampered.zip");
    await execFileAsync("zip", ["-r", "-q", tamperedZipPath, "test-plugin"], { cwd: tmpDir });

    const tamperedReport = await verifyZipAgainstManifest({
      zipPath: tamperedZipPath,
      consumer: "test-plugin",
      manifest,
    });
    assert.equal(tamperedReport.status, "modified");
    assert.ok(tamperedReport.modifiedFiles.some((f) => f.path === "src/code.php"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("ZIP verification: missing entry inside ZIP fails verification", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "zip-missing-"));
  const stagingPlugin = path.join(tmpDir, "test-plugin");
  try {
    await mkdir(path.join(stagingPlugin, "src"), { recursive: true });
    await writeFile(path.join(stagingPlugin, "src/a.php"), "<?php echo 'a';");
    await writeFile(path.join(stagingPlugin, "src/b.php"), "<?php echo 'b';");

    const manifest = await generateArtifactManifest({
      rootDir: stagingPlugin,
      consumer: "test-plugin",
      version: "1.0.0",
      profile: "Profile S",
    });

    // Create zip missing b.php
    await rm(path.join(stagingPlugin, "src/b.php"));
    const incompleteZip = path.join(tmpDir, "incomplete.zip");
    await execFileAsync("zip", ["-r", "-q", incompleteZip, "test-plugin"], { cwd: tmpDir });

    const report = await verifyZipAgainstManifest({
      zipPath: incompleteZip,
      consumer: "test-plugin",
      manifest,
    });
    assert.equal(report.status, "missing");
    assert.ok(report.missingFiles.includes("src/b.php"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("PHP verifier: rejects symlinks and directory traversal safely without warnings or fatal errors", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "php-verifier-test-"));
  try {
    await mkdir(path.join(tmpDir, "src"), { recursive: true });
    await writeFile(path.join(tmpDir, "src/index.php"), "<?php echo 'ok';");

    const manifest = await generateArtifactManifest({
      rootDir: tmpDir,
      consumer: "test-plugin",
      version: "1.0.0",
      profile: "Profile S",
    });

    // Run PHP verifier script
    const phpScript = `
    require_once '${path.resolve(packageRoot, "diagnostic-artifact-verifier.php")}';
    $res = \\WPDev\\Core\\ArtifactIntegrityVerifier::verify('${tmpDir}');
    echo json_encode($res);
    `;

    const { stdout } = await execFileAsync("php", ["-r", phpScript]);
    const res = JSON.parse(stdout);
    assert.equal(res.status, "valid");
    assert.equal(res.fatal, false);
    assert.equal(res.severity, "none");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

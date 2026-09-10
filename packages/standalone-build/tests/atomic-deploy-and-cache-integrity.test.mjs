import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  computeTreeContentHash,
  writeAtomicCacheFile,
  planDependencyGraphBuild,
  canReuseCachedZip,
  CACHE_SCHEMA_VERSION,
} from "../build-cache-engine.mjs";

import {
  parsePipelineArgs,
} from "../build-all-standalone-plugins.mjs";

import {
  generateArtifactManifest,
  verifyArtifactManifest,
} from "../canonical-artifact-manifest.mjs";

import { atomicDeployPlugin } from "../build-all-standalone-plugins.mjs";

const execFileAsync = promisify(execFile);

test("Atomic deploy: preserves original plugin directory if ZIP verification or extraction fails", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "atomic-deploy-"));
  const pluginsDir = path.join(tmpRoot, "plugins");
  const targetPluginDir = path.join(pluginsDir, "sample-plugin");
  const corruptedZip = path.join(tmpRoot, "corrupted.zip");

  try {
    await mkdir(targetPluginDir, { recursive: true });
    await writeFile(path.join(targetPluginDir, "original.php"), "<?php echo 'v1-safe';");

    // Create a corrupted zip with invalid manifest
    const stagingDir = path.join(tmpRoot, "staging/sample-plugin");
    await mkdir(stagingDir, { recursive: true });
    await writeFile(path.join(stagingDir, "broken.php"), "<?php echo 'broken';");
    await writeFile(path.join(stagingDir, "artifact-manifest.json"), "{ invalid JSON ");
    await execFileAsync("zip", ["-r", "-q", corruptedZip, "sample-plugin"], { cwd: path.join(tmpRoot, "staging") });

    // Call real atomicDeployPlugin implementation
    let deployFailed = false;
    try {
      await atomicDeployPlugin(corruptedZip, "sample-plugin", { pluginsDir, contentRoot: tmpRoot });
    } catch (err) {
      deployFailed = true;
    }

    assert.equal(deployFailed, true, "Deploy must fail for corrupted zip");
    // Verify original plugin is 100% intact
    assert.ok(fs.existsSync(path.join(targetPluginDir, "original.php")), "Original plugin must remain untouched");
    const content = await readFile(path.join(targetPluginDir, "original.php"), "utf8");
    assert.equal(content, "<?php echo 'v1-safe';", "Original file content must be preserved");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("Cache engine: writeAtomicCacheFile writes atomically and prevents corruption on read", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cache-atomic-"));
  const cacheFilePath = path.join(tmpDir, ".build-cache.json");
  try {
    const data = { _tools: "tool-hash", "tavangary-core": "core-hash" };
    await writeAtomicCacheFile(cacheFilePath, data);

    assert.ok(fs.existsSync(cacheFilePath));
    const readData = JSON.parse(await readFile(cacheFilePath, "utf8"));
    assert.deepEqual(readData, data);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Cache engine: nested production namespaces named Tests or Dev are NOT ignored in fingerprint", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cache-nested-"));
  try {
    await mkdir(path.join(tmpDir, "src/Modules/OnlineTest/Tests"), { recursive: true });
    await writeFile(path.join(tmpDir, "src/Modules/OnlineTest/Tests/TestRegistry.php"), "<?php return 1;");

    const hash1 = await computeTreeContentHash(tmpDir);

    // Modify nested TestRegistry
    await writeFile(path.join(tmpDir, "src/Modules/OnlineTest/Tests/TestRegistry.php"), "<?php return 2;");
    const hash2 = await computeTreeContentHash(tmpDir);

    assert.notEqual(hash1, hash2, "Nested production Tests directory must be part of content fingerprint");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Cache engine: production dotfiles like .htaccess are included in fingerprint", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cache-htaccess-"));
  try {
    await mkdir(path.join(tmpDir, "src"), { recursive: true });
    await writeFile(path.join(tmpDir, "src/index.php"), "<?php echo 1;");
    await writeFile(path.join(tmpDir, ".htaccess"), "Deny from all");

    const hash1 = await computeTreeContentHash(tmpDir);

    await writeFile(path.join(tmpDir, ".htaccess"), "Allow from all");
    const hash2 = await computeTreeContentHash(tmpDir);

    assert.notEqual(hash1, hash2, ".htaccess modification must change fingerprint");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Atomic deploy: rollback restores previous version on bootstrap or verification failure", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "deploy-rollback-"));
  const pluginsDir = path.join(tmpRoot, "plugins");
  const targetPluginDir = path.join(pluginsDir, "my-plugin");

  try {
    await mkdir(targetPluginDir, { recursive: true });
    await writeFile(path.join(targetPluginDir, "plugin.php"), "<?php echo 'v1-active';");

    // Simulate deploy with invalid zip content
    const badZip = path.join(tmpRoot, "bad.zip");
    await writeFile(badZip, "not a real zip file");

    let failed = false;
    try {
      await atomicDeployPlugin(badZip, "my-plugin", { pluginsDir, contentRoot: tmpRoot });
    } catch {
      failed = true;
    }

    assert.equal(failed, true, "Unzip/preflight failure must be caught");
    assert.ok(fs.existsSync(path.join(targetPluginDir, "plugin.php")), "Original plugin must survive failure");
    const content = await readFile(path.join(targetPluginDir, "plugin.php"), "utf8");
    assert.equal(content, "<?php echo 'v1-active';", "Original file content unchanged");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("Atomic deploy: successful deployment swaps candidate in and removes backup cleanly", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "deploy-success-"));
  const pluginsDir = path.join(tmpRoot, "plugins");
  const targetPluginDir = path.join(pluginsDir, "my-plugin");
  const validZip = path.join(tmpRoot, "valid.zip");

  try {
    await mkdir(targetPluginDir, { recursive: true });
    await writeFile(path.join(targetPluginDir, "my-plugin.php"), "<?php echo 'v1-old';");

    // Build valid candidate
    const stagingDir = path.join(tmpRoot, "staging/my-plugin");
    await mkdir(stagingDir, { recursive: true });
    await writeFile(path.join(stagingDir, "my-plugin.php"), "<?php echo 'v2-new';");
    await generateArtifactManifest({ rootDir: stagingDir, consumer: "my-plugin" });
    await execFileAsync("zip", ["-r", "-q", "-X", validZip, "my-plugin"], { cwd: path.join(tmpRoot, "staging") });

    await atomicDeployPlugin(validZip, "my-plugin", { pluginsDir, contentRoot: tmpRoot });

    assert.ok(fs.existsSync(path.join(targetPluginDir, "my-plugin.php")), "Deployed plugin must exist");
    const content = await readFile(path.join(targetPluginDir, "my-plugin.php"), "utf8");
    assert.equal(content, "<?php echo 'v2-new';", "Deployed content must match v2-new");

    // Verify no leftover backups or staging dirs
    const allEntries = await fs.promises.readdir(pluginsDir);
    const backups = allEntries.filter((e) => e.includes(".backup") || e.includes(".staging"));
    assert.equal(backups.length, 0, "No staging or backup directories should remain after successful deploy");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("Cache engine: ZIP reuse requires matching SHA-256; missing or same-size tamper is a miss", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cache-zip-reuse-"));
  const zipPath = path.join(tmpDir, "plugin-profile-s.zip");
  try {
    const original = Buffer.alloc(64, 0x41);
    original.write("PK\x03\x04", 0);
    await writeFile(zipPath, original);
    const sha = crypto.createHash("sha256").update(original).digest("hex");

    assert.equal(CACHE_SCHEMA_VERSION, 3, "cache schema must be version 3 with canonical nested option hashing");
    assert.equal(await canReuseCachedZip({ zipPath, expectedSha256: sha }), true);

    const tampered = Buffer.from(original);
    tampered[20] = 0x42;
    await writeFile(zipPath, tampered);
    assert.equal(
      await canReuseCachedZip({ zipPath, expectedSha256: sha }),
      false,
      "same-size one-byte ZIP change must be a cache miss"
    );

    await rm(zipPath, { force: true });
    assert.equal(await canReuseCachedZip({ zipPath, expectedSha256: sha }), false, "missing ZIP is a cache miss");
    assert.equal(await canReuseCachedZip({ zipPath, expectedSha256: null }), false);
    assert.equal(await canReuseCachedZip({ zipPath: zipPath, expectedSha256: "deadbeef" }), false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Atomic deploy: manifest-only trees without the plugin bootstrap are not a successful smoke", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "deploy-manifest-only-"));
  const pluginsDir = path.join(tmpRoot, "plugins");
  const targetPluginDir = path.join(pluginsDir, "my-plugin");
  const validZip = path.join(tmpRoot, "manifest-only.zip");

  try {
    await mkdir(targetPluginDir, { recursive: true });
    await writeFile(path.join(targetPluginDir, "my-plugin.php"), "<?php echo 'v1-safe';");

    const stagingDir = path.join(tmpRoot, "staging/my-plugin");
    await mkdir(stagingDir, { recursive: true });
    await writeFile(path.join(stagingDir, "readme.txt"), "no bootstrap here");
    await generateArtifactManifest({ rootDir: stagingDir, consumer: "my-plugin" });
    await execFileAsync("zip", ["-r", "-q", "-X", validZip, "my-plugin"], { cwd: path.join(tmpRoot, "staging") });

    await assert.rejects(
      () => atomicDeployPlugin(validZip, "my-plugin", { pluginsDir, contentRoot: tmpRoot }),
      /bootstrap|main plugin entry/i
    );

    const content = await readFile(path.join(targetPluginDir, "my-plugin.php"), "utf8");
    assert.equal(content, "<?php echo 'v1-safe';", "Original plugin must be restored or left untouched");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("Atomic deploy: refuses to overwrite a dirty git working tree at the target", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "deploy-git-protect-"));
  const pluginsDir = path.join(tmpRoot, "plugins");
  const targetPluginDir = path.join(pluginsDir, "my-plugin");
  const validZip = path.join(tmpRoot, "valid.zip");

  try {
    await mkdir(targetPluginDir, { recursive: true });
    await writeFile(path.join(targetPluginDir, "my-plugin.php"), "<?php echo 'local-wip';");
    await execFileAsync("git", ["init"], { cwd: targetPluginDir });
    await execFileAsync("git", ["add", "my-plugin.php"], { cwd: targetPluginDir });

    const stagingDir = path.join(tmpRoot, "staging/my-plugin");
    await mkdir(stagingDir, { recursive: true });
    await writeFile(path.join(stagingDir, "my-plugin.php"), "<?php echo 'from-zip';");
    await generateArtifactManifest({ rootDir: stagingDir, consumer: "my-plugin" });
    await execFileAsync("zip", ["-r", "-q", "-X", validZip, "my-plugin"], { cwd: path.join(tmpRoot, "staging") });

    await assert.rejects(
      () => atomicDeployPlugin(validZip, "my-plugin", { pluginsDir, contentRoot: tmpRoot }),
      /dirty git|working tree/i
    );

    const content = await readFile(path.join(targetPluginDir, "my-plugin.php"), "utf8");
    assert.equal(content, "<?php echo 'local-wip';");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("Atomic deploy: never reclaims a live or malformed lock based only on age", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "deploy-lock-"));
  const pluginsDir = path.join(tmpRoot, "plugins");
  const lockFile = path.join(pluginsDir, ".sample-plugin.deploy.lock");
  try {
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(lockFile, JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      time: 0,
    }));
    await assert.rejects(
      atomicDeployPlugin(path.join(tmpRoot, "missing.zip"), "sample-plugin", { pluginsDir, contentRoot: tmpRoot }),
      /Deployment lock active/
    );
    assert.equal(fs.existsSync(lockFile), true);

    await writeFile(lockFile, "not-json");
    await assert.rejects(
      atomicDeployPlugin(path.join(tmpRoot, "missing.zip"), "sample-plugin", { pluginsDir, contentRoot: tmpRoot }),
      /cannot be safely validated/
    );
    assert.equal(await readFile(lockFile, "utf8"), "not-json");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("Pipeline CLI: unknown modes fail closed and suite/test-mode conflicts are explicit", () => {
  assert.throws(() => parsePipelineArgs(["--test", "--test-mode=not-a-mode"]), /Invalid --test-mode/);
  assert.throws(() => parsePipelineArgs(["--test", "--suite=nope"]), /Invalid --suite/);
  assert.throws(
    () => parsePipelineArgs(["--test", "--suite=fast", "--test-mode=full"]),
    /Conflicting --suite/
  );

  const affected = parsePipelineArgs(["--test"]);
  assert.equal(affected.testMode, "affected");

  const full = parsePipelineArgs(["--test", "--suite=full"]);
  assert.equal(full.testMode, "full");

  const docker = parsePipelineArgs(["--test-mode=docker-smoke"]);
  assert.equal(docker.testMode, "docker-smoke");

  const deployOnly = parsePipelineArgs(["--deploy"]);
  assert.equal(deployOnly.testMode, "affected", "--deploy without tests must still run affected tests");
  assert.throws(
    () => parsePipelineArgs(["--build-only", "--deploy"]),
    /cannot be combined with --deploy/
  );

  assert.equal(parsePipelineArgs(["--obfuscate"]).profile, "s");
  assert.equal(parsePipelineArgs(["--profile=s"]).isObfuscate, true);
  assert.throws(() => parsePipelineArgs(["--profile=a"]), /Invalid --profile 'a'/);
  assert.throws(
    () => parsePipelineArgs(["--obfuscate", "--profile=clean"]),
    /Conflicting profile flags/,
  );
});

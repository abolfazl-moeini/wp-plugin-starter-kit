import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { generateArtifactManifest, createCanonicalZip } from "../canonical-artifact-manifest.mjs";
import { atomicDeployPlugin } from "../build-all-standalone-plugins.mjs";

const execFileAsync = promisify(execFile);

async function createValidCandidateZip({ tmpRoot, pluginName }) {
  const staging = path.join(tmpRoot, `stage-${pluginName}`, pluginName);
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, `${pluginName}.php`), "<?php // valid candidate\necho 'v2-new';");
  await mkdir(path.join(staging, "src/FrameworkClosure"), { recursive: true });
  await writeFile(
    path.join(staging, "src/FrameworkClosure/functions-closure.php"),
    "<?php // framework closure\n"
  );
  const manifest = await generateArtifactManifest({
    rootDir: staging,
    consumer: pluginName,
    profile: "Profile S",
  });
  await writeFile(path.join(staging, "artifact-manifest.json"), JSON.stringify(manifest, null, 2));

  const zipPath = path.join(tmpRoot, `${pluginName}-profile-s.zip`);
  await createCanonicalZip({
    sourceRoot: staging,
    outputZip: zipPath,
    rootName: pluginName,
  });
  return zipPath;
}

test("F01: Failure after target backup rename restores previous version without deleting backup in finally", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f01-test-fsync-backup-"));
  try {
    const pluginsDir = path.join(tmpRoot, "plugins");
    const pluginName = "sample-plugin";
    const targetDir = path.join(pluginsDir, pluginName);
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, `${pluginName}.php`), "<?php // original v1\necho 'v1-healthy';");
    await writeFile(path.join(targetDir, "data.txt"), "original-state");

    const validZip = await createValidCandidateZip({ tmpRoot, pluginName });

    let caughtErr = null;
    try {
      await atomicDeployPlugin(validZip, pluginName, {
        pluginsDir,
        contentRoot: tmpRoot,
        injectFault: "after_backup_rename_fsync",
      });
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, "Deploy must fail when fault is injected during backup fsync");
    // CRITICAL: The previous healthy version must NOT be deleted or lost!
    assert.ok(fs.existsSync(targetDir), "Target plugin directory must still exist");
    assert.ok(fs.existsSync(path.join(targetDir, "data.txt")), "Target must contain original data.txt");
    const content = await readFile(path.join(targetDir, `${pluginName}.php`), "utf8");
    assert.ok(content.includes("v1-healthy"), "Target must contain original v1 content");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("F01: Failure after candidate swap rolls back candidate and restores previous version", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f01-test-fsync-swap-"));
  try {
    const pluginsDir = path.join(tmpRoot, "plugins");
    const pluginName = "sample-plugin";
    const targetDir = path.join(pluginsDir, pluginName);
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, `${pluginName}.php`), "<?php // original v1\necho 'v1-healthy';");
    await writeFile(path.join(targetDir, "data.txt"), "original-state");

    const validZip = await createValidCandidateZip({ tmpRoot, pluginName });

    let caughtErr = null;
    try {
      await atomicDeployPlugin(validZip, pluginName, {
        pluginsDir,
        contentRoot: tmpRoot,
        injectFault: "after_candidate_swap_fsync",
      });
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, "Deploy must fail when fault is injected during swap fsync");
    assert.ok(fs.existsSync(targetDir), "Target plugin directory must be restored");
    assert.ok(fs.existsSync(path.join(targetDir, "data.txt")), "Target must contain original data.txt");
    const content = await readFile(path.join(targetDir, `${pluginName}.php`), "utf8");
    assert.ok(content.includes("v1-healthy"), "Target must contain original v1 content after rollback");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("F01: Failure during post-commit backup purge does NOT replace healthy target with backup", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f01-test-purge-backup-"));
  try {
    const pluginsDir = path.join(tmpRoot, "plugins");
    const pluginName = "sample-plugin";
    const targetDir = path.join(pluginsDir, pluginName);
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, `${pluginName}.php`), "<?php // original v1\necho 'v1-healthy';");

    const validZip = await createValidCandidateZip({ tmpRoot, pluginName });

    let caughtErr = null;
    try {
      await atomicDeployPlugin(validZip, pluginName, {
        pluginsDir,
        contentRoot: tmpRoot,
        injectFault: "during_backup_purge",
      });
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, "Deploy should raise error when backup purge fails");
    // Target was already verified and committed: it MUST have the new v2 version, NOT be destroyed or reverted to partial backup!
    assert.ok(fs.existsSync(targetDir), "Target plugin directory must remain present");
    const content = await readFile(path.join(targetDir, `${pluginName}.php`), "utf8");
    assert.ok(content.includes("v2-new"), "Committed target must preserve the new verified version");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("F01: Failed rollback raises composite error with original and rollback errors", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f01-test-composite-err-"));
  try {
    const pluginsDir = path.join(tmpRoot, "plugins");
    const pluginName = "sample-plugin";
    const targetDir = path.join(pluginsDir, pluginName);
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, `${pluginName}.php`), "<?php // original v1\necho 'v1-healthy';");

    const validZip = await createValidCandidateZip({ tmpRoot, pluginName });

    let caughtErr = null;
    try {
      await atomicDeployPlugin(validZip, pluginName, {
        pluginsDir,
        contentRoot: tmpRoot,
        injectFault: "after_candidate_swap_fsync",
        healthCheck: async () => {
          throw new Error("Verification failed intentionally");
        },
      });
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, "Deploy must fail");
    // Normal rollback should succeed:
    const content = await readFile(path.join(targetDir, `${pluginName}.php`), "utf8");
    assert.ok(content.includes("v1-healthy"), "Target must contain original v1 content");

    // Now test with failure during rollback:
    let rollbackFailErr = null;
    try {
      await atomicDeployPlugin(validZip, pluginName, {
        pluginsDir,
        contentRoot: tmpRoot,
        injectFault: "during_rollback_rename",
        healthCheck: async () => {
          throw new Error("Verification failed intentionally");
        },
      });
    } catch (err) {
      rollbackFailErr = err;
    }

    assert.ok(rollbackFailErr, "Must throw composite error");
    assert.ok(rollbackFailErr.rollbackError, "Must contain rollbackError");
    assert.ok(rollbackFailErr.originalError, "Must contain originalError");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

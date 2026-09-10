import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireInterProcessLock,
  canonicalizePath,
  runPipelineOrchestration,
} from "../build-all-standalone-plugins.mjs";

test("F02: Lock acquisition rejects reclaim when process.kill returns EPERM", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f02-lock-eperm-"));
  const lockFile = path.join(tmpRoot, ".deploy.lock");

  try {
    // Write a lock file with PID 1 (which exists and typically throws EPERM for non-root users on POSIX)
    // or simulate with mock process.kill if running as root
    const lockPayload = {
      pid: 1, // PID 1 always exists
      host: os.hostname(),
      token: "test-token-1",
      time: Date.now(),
    };
    await writeFile(lockFile, JSON.stringify(lockPayload), "utf8");

    // Attempt to acquire the lock: it must NOT reclaim PID 1!
    let acquired = false;
    let caughtErr = null;
    try {
      const lock = await acquireInterProcessLock({ lockFile });
      if (lock) {
        acquired = true;
        await lock.release();
      }
    } catch (err) {
      caughtErr = err;
    }

    assert.equal(acquired, false, "Must not acquire or reclaim lock for living process PID 1");
    assert.ok(caughtErr, "Must throw lock error");
    assert.ok(
      caughtErr.message.includes("concurrent deploy detected") ||
      caughtErr.message.includes("lock active") ||
      caughtErr.message.includes("Lock active") ||
      caughtErr.message.includes("Deployment lock active"),
      `Expected concurrent error but got: ${caughtErr.message}`
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("F02: Lock acquisition reclaims dead lock only on ESRCH with atomic rename serialization", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f02-lock-esrch-"));
  const lockFile = path.join(tmpRoot, ".deploy.lock");

  try {
    // Choose a very high PID that does not exist
    const deadPid = 99999999;
    const lockPayload = {
      pid: deadPid,
      host: os.hostname(),
      token: "dead-process-token",
      time: Date.now() - 60000,
    };
    await writeFile(lockFile, JSON.stringify(lockPayload), "utf8");

    // Now attempt to acquire: should successfully reclaim dead lock
    const lock = await acquireInterProcessLock({ lockFile });
    assert.ok(lock, "Lock should be acquired after reclaiming dead PID");
    assert.ok(lock.token, "Lock must have a valid token");

    // Second acquisition attempt must fail while lock is held
    let secondAcquired = false;
    try {
      await acquireInterProcessLock({ lockFile });
      secondAcquired = true;
    } catch (err) {
      assert.ok(err.message.includes("active") || err.message.includes("concurrent"));
    }
    assert.equal(secondAcquired, false, "Second process must not acquire held lock");

    // Release lock
    await lock.release();
    assert.equal(fs.existsSync(lockFile), false, "Lock file should be removed upon release");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("F02: canonicalizePath resolves symlinks to identical canonical targets", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f02-canonical-"));
  try {
    const realDir = path.join(tmpRoot, "real-plugins");
    const symlinkDir = path.join(tmpRoot, "symlink-plugins");
    await mkdir(realDir, { recursive: true });
    await symlink(realDir, symlinkDir);

    const c1 = canonicalizePath(realDir);
    const c2 = canonicalizePath(symlinkDir);
    assert.equal(c1, c2, "canonicalizePath must resolve real and symlinked dirs to identical path");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("F02: runPipelineOrchestration holds workspace lock and blocks concurrent run from recovering active journal", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f02-orchestration-lock-"));
  try {
    const distDir = path.join(tmpRoot, "dist");
    const pluginsDir = path.join(tmpRoot, "plugins");
    await mkdir(distDir, { recursive: true });
    await mkdir(pluginsDir, { recursive: true });

    // Hold the lock manually to simulate active run in progress
    const lock = await acquireInterProcessLock({
      lockFile: path.join(distDir, ".transaction.deploy.lock"),
    });
    assert.ok(lock, "Should acquire test lock");

    // Now try running runPipelineOrchestration on the same root
    let concurrentErr = null;
    try {
      await runPipelineOrchestration({
        contentRoot: tmpRoot,
        distDir,
        pluginsDir,
        overrideDeploy: false,
        overrideForce: true,
      });
    } catch (err) {
      concurrentErr = err;
    }

    assert.ok(concurrentErr, "Concurrent pipeline orchestration must fail when lock is held");
    assert.ok(
      concurrentErr.message.includes("active") ||
      concurrentErr.message.includes("concurrent") ||
      concurrentErr.message.includes("lock"),
      `Expected concurrency error message, got: ${concurrentErr.message}`
    );

    await lock.release();
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

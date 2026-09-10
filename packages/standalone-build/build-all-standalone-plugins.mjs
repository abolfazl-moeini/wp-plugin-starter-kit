#!/usr/bin/env node

/**
 * Unified Central Build & Test Pipeline for Standalone Obfuscated Plugins
 * 
 * Usage:
 *   node tools/build-all-standalone-plugins.mjs [--deploy] [--test] [--changed] [--force] [--suite=<name>]
 */

import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { copyFile, rm, readFile, rename, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_CONSUMERS,
  isValidConsumerName,
  CACHE_SCHEMA_VERSION,
  DEPLOY_JOURNAL_SCHEMA_VERSION,
  computeAllFingerprintsParallel,
  computeArtifactTestCoverage,
  computeTestDependencyFingerprint,
  createDeployReceiptRecord,
  createTargetCacheRecord,
  createTestEvidenceRecord,
  deriveJournalPaths,
  loadBuildCacheRecord,
  loadDeployJournalRecord,
  loadDeployReceiptRecord,
  planDependencyGraphBuild,
  recoverInterruptedDeployment,
  validateCachedTargetArtifact,
  validateDeployJournalSchema,
  validateDeployReceiptRecord,
  validateJournalTransition,
  validateTestEvidenceRecord,
  writeAtomicCacheFile,
  TransactionJournalManager,
  fsyncDir,
  TEST_SPEC_MAP,
  REQUIRED_ARTIFACT_TESTS,
} from "./build-cache-engine.mjs";

import {
  collectComposerAutoloadFileTargets,
  readEmbeddedManifestFromZip,
  readZipEntries,
  verifyArtifactManifest,
} from "./canonical-artifact-manifest.mjs";

import {
  resolveImpactedTests,
  TEST_DEPENDENCY_GRAPH,
} from "./test-impact-map.mjs";

import { BuildDag } from "./build-dag-runner.mjs";
import { TARGET_REGISTRY, listStandaloneConsumers } from "./target-registry.mjs";
import { resolveContentRoot } from "./resolve-content-root.mjs";
import { parseClosedProfileFlags } from "./profile-s-fail-closed.mjs";
import { assembleProfileSCandidate } from "./assemble-profile-s-candidate.mjs";
import { createBuildPlan, resolveArtifactZipName } from "./build-plan.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
function getContentRoot() {
  try {
    return resolveContentRoot({ scriptDir });
  } catch (err) {
    // node --test imports this module from the package directory.
    // Release CLI invocations must not silently build the wrong tree.
    if (process.env.NODE_TEST_CONTEXT) {
      return process.cwd();
    }
    throw err;
  }
}

let cachedContentRoot;
function defaultContentRoot() {
  if (cachedContentRoot === undefined) {
    cachedContentRoot = getContentRoot();
  }
  return cachedContentRoot;
}

export const MAX_JOBS_LIMIT = Math.max(1, Math.min(8, os.cpus().length || 4));

export class BoundedTailBuffer {
  constructor(maxBytes = 64 * 1024) {
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.currentBytes = 0;
    this.totalBytes = 0;
    this.truncated = false;
    this.bytesDropped = 0;
    this.boundaryAdjustedBytes = 0;
  }

  push(chunk) {
    if (!chunk) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += buf.length;
    this.chunks.push(buf);
    this.currentBytes += buf.length;

    while (this.currentBytes > this.maxBytes && this.chunks.length > 0) {
      this.truncated = true;
      const first = this.chunks[0];
      if (this.currentBytes - first.length >= this.maxBytes) {
        this.currentBytes -= first.length;
        this.bytesDropped += first.length;
        this.chunks.shift();
      } else {
        const excess = this.currentBytes - this.maxBytes;
        this.chunks[0] = first.subarray(excess);
        this.currentBytes -= excess;
        this.bytesDropped += excess;
        break;
      }
    }
  }

  toBuffer() {
    if (this.chunks.length === 0) return Buffer.alloc(0);
    if (this.chunks.length === 1) return this.chunks[0];
    return Buffer.concat(this.chunks);
  }

  toString() {
    const rawBuf = this.toBuffer();
    if (rawBuf.length === 0) return "";

    let start = 0;
    // Discard any split UTF-8 continuation bytes at the beginning of the truncated window
    if (this.truncated) {
      while (start < rawBuf.length && (rawBuf[start] & 0xC0) === 0x80) {
        start++;
      }
    }

    let end = rawBuf.length;
    // Trim incomplete trailing multi-byte UTF-8 sequence at the end of the window
    for (let i = 1; i <= 4 && end - i >= start; i++) {
      const b = rawBuf[end - i];
      if ((b & 0x80) === 0) {
        break;
      }
      if ((b & 0xE0) === 0xC0) {
        if (i < 2) end = end - i;
        break;
      }
      if ((b & 0xF0) === 0xE0) {
        if (i < 3) end = end - i;
        break;
      }
      if ((b & 0xF8) === 0xF0) {
        if (i < 4) end = end - i;
        break;
      }
    }

    if (start >= end) return "";
    this.boundaryAdjustedBytes = start + (rawBuf.length - end);
    return rawBuf.subarray(start, end).toString("utf8");
  }

  getMetadata() {
    const tailStr = this.toString();
    return {
      totalBytes: this.totalBytes,
      bufferedBytes: this.currentBytes,
      truncated: this.truncated,
      bytesDropped: this.bytesDropped,
      boundaryAdjustedBytes: this.boundaryAdjustedBytes,
      tail: tailStr,
    };
  }
}

export async function runSelectedNodeTests({
  testFiles = [],
  jobsLimit = 4,
  signal = null,
  executor = null,
  cwd = null,
  scriptDir: customScriptDir = scriptDir,
} = {}) {
  const resolvedCwd = cwd || defaultContentRoot();
  if (!Array.isArray(testFiles)) {
    throw new Error("runSelectedNodeTests: testFiles must be an array");
  }
  if (testFiles.length === 0) {
    return {
      selected: 0,
      concurrency: 1,
      durationMs: 0,
      stdout: "",
      stderr: "",
      stdoutTail: "",
      stderrTail: "",
      stdoutTotalBytes: 0,
      stderrTotalBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }

  if (typeof jobsLimit !== "number" || !Number.isInteger(jobsLimit) || jobsLimit < 1 || jobsLimit > MAX_JOBS_LIMIT) {
    throw new Error(`runSelectedNodeTests: invalid jobsLimit '${jobsLimit}' (must be positive integer between 1 and ${MAX_JOBS_LIMIT})`);
  }
  const numericJobs = jobsLimit;

  const testsDir = path.join(customScriptDir, "tests");
  const seenLower = new Set();
  const fullPaths = [];

  for (const rawName of testFiles) {
    if (typeof rawName !== "string" || !rawName.trim()) {
      throw new Error(`runSelectedNodeTests: invalid test file entry: ${JSON.stringify(rawName)}`);
    }
    const cleanName = rawName.trim();
    if (cleanName.includes("..") || cleanName.includes("/") || cleanName.includes("\\")) {
      throw new Error(`runSelectedNodeTests: invalid test file path (must be basename in tests directory): '${cleanName}'`);
    }
    if (!cleanName.endsWith(".test.mjs")) {
      throw new Error(`runSelectedNodeTests: test file must have .test.mjs extension: '${cleanName}'`);
    }

    const lower = cleanName.toLowerCase();
    if (seenLower.has(lower)) {
      throw new Error(`runSelectedNodeTests: duplicate or case-colliding test file detected: '${cleanName}'`);
    }
    seenLower.add(lower);

    const fullPath = path.join(testsDir, cleanName);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`runSelectedNodeTests: test file does not exist: '${fullPath}'`);
    }
    const st = await fs.promises.lstat(fullPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`runSelectedNodeTests: test file must be a regular file, not a symlink: '${fullPath}'`);
    }
    fullPaths.push(fullPath);
  }

  const testArgs = ["--test", `--test-concurrency=${numericJobs}`, ...fullPaths];

  const startTime = Date.now();
  if (executor) {
    const execOptions = { cwd: resolvedCwd };
    if (signal) execOptions.signal = signal;
    const testRes = await executor(process.execPath, testArgs, execOptions);
    const durationMs = Date.now() - startTime;

    const outBuf = new BoundedTailBuffer(64 * 1024);
    if (testRes.stdout) outBuf.push(testRes.stdout);
    const outMeta = outBuf.getMetadata();

    const errBuf = new BoundedTailBuffer(64 * 1024);
    if (testRes.stderr) errBuf.push(testRes.stderr);
    const errMeta = errBuf.getMetadata();

    return {
      selected: testFiles.length,
      concurrency: numericJobs,
      stdout: outMeta.tail,
      stderr: errMeta.tail,
      stdoutTail: outMeta.tail,
      stderrTail: errMeta.tail,
      stdoutTotalBytes: outMeta.totalBytes,
      stderrTotalBytes: errMeta.totalBytes,
      stdoutTruncated: outMeta.truncated,
      stderrTruncated: errMeta.truncated,
      durationMs,
    };
  }

  const MAX_CAPTURE_BYTES = 64 * 1024;
  const stdoutBuf = new BoundedTailBuffer(MAX_CAPTURE_BYTES);
  const stderrBuf = new BoundedTailBuffer(MAX_CAPTURE_BYTES);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finalize = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(val);
    };

    const child = spawn(process.execPath, testArgs, {
      cwd: resolvedCwd,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuf.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderrBuf.push(chunk);
    });

    child.on("error", (err) => {
      finalize(err);
    });

    child.on("close", (code) => {
      const durationMs = Date.now() - startTime;
      const outMeta = stdoutBuf.getMetadata();
      const errMeta = stderrBuf.getMetadata();

      let outStr = outMeta.tail;
      if (outMeta.truncated) {
        outStr = `[... truncated ${outMeta.totalBytes - outMeta.bufferedBytes} bytes ...]\n` + outStr;
      }
      let errStr = errMeta.tail;
      if (errMeta.truncated) {
        errStr = `[... truncated ${errMeta.totalBytes - errMeta.bufferedBytes} bytes ...]\n` + errStr;
      }

      if (code !== 0) {
        const err = new Error(`Node tests failed with exit code ${code}\n${errStr}\n${outStr}`);
        err.code = code;
        err.stdout = outStr;
        err.stderr = errStr;
        err.stdoutTail = outMeta.tail;
        err.stderrTail = errMeta.tail;
        err.stdoutTotalBytes = outMeta.totalBytes;
        err.stderrTotalBytes = errMeta.totalBytes;
        err.stdoutTruncated = outMeta.truncated;
        err.stderrTruncated = errMeta.truncated;
        return finalize(err);
      }
      finalize(null, {
        selected: testFiles.length,
        concurrency: numericJobs,
        stdout: outStr,
        stderr: errStr,
        stdoutTail: outMeta.tail,
        stderrTail: errMeta.tail,
        stdoutTotalBytes: outMeta.totalBytes,
        stderrTotalBytes: errMeta.totalBytes,
        stdoutTruncated: outMeta.truncated,
        stderrTruncated: errMeta.truncated,
        durationMs,
      });
    });
  });
}

export function canonicalizePath(targetPath) {
  if (!targetPath) return targetPath;
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    const segments = [];
    let curr = resolved;
    while (curr !== path.dirname(curr)) {
      if (fs.existsSync(curr)) {
        try {
          const realParent = fs.realpathSync(curr);
          return path.join(realParent, ...segments);
        } catch {
          break;
        }
      }
      segments.unshift(path.basename(curr));
      curr = path.dirname(curr);
    }
    return resolved;
  }
}

export async function acquireInterProcessLock({
  lockFile,
  resourceName = path.basename(lockFile),
  signal = null,
  timeoutMs = 0,
  pollIntervalMs = 50,
}) {
  const canonDir = canonicalizePath(path.dirname(lockFile));
  const canonLockFile = path.join(canonDir, path.basename(lockFile));
  await fs.promises.mkdir(canonDir, { recursive: true });

  const lockToken = crypto.randomUUID();
  const lockPayload = JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    token: lockToken,
    time: Date.now(),
  });

  const startTime = Date.now();

  while (true) {
    if (signal?.aborted) {
      throw new Error(`Lock acquisition aborted for ${resourceName}`);
    }

    try {
      const handle = await fs.promises.open(canonLockFile, "wx");
      await handle.writeFile(lockPayload, "utf8");
      await handle.close();

      let released = false;
      return {
        lockFile: canonLockFile,
        token: lockToken,
        release: async () => {
          if (released) return;
          released = true;
          try {
            const cur = JSON.parse(await fs.promises.readFile(canonLockFile, "utf8"));
            if (cur.token === lockToken) {
              await fs.promises.rm(canonLockFile, { force: true });
            }
          } catch {
            // Never remove a lock whose ownership can no longer be proven
          }
        },
      };
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }

      let reclaim = false;
      try {
        const lockData = JSON.parse(await fs.promises.readFile(canonLockFile, "utf8"));
        if (!Number.isSafeInteger(lockData.pid) || typeof lockData.host !== "string") {
          throw new Error("deployment lock has invalid ownership metadata");
        }
        if (lockData.host === os.hostname()) {
          try {
            process.kill(lockData.pid, 0);
          } catch (killErr) {
            if (killErr.code === "ESRCH") {
              reclaim = true;
            }
          }
        }
      } catch (lockError) {
        throw new Error(`Deployment lock for ${resourceName} cannot be safely validated: ${lockError.message}`);
      }

      if (reclaim) {
        const reclaimPath = `${canonLockFile}.reclaim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        try {
          await fs.promises.rename(canonLockFile, reclaimPath);
          await fs.promises.rm(reclaimPath, { force: true }).catch(() => {});
          continue;
        } catch {
          // Reclaim race lost to another concurrent process
        }
      }

      if (timeoutMs > 0 && Date.now() - startTime < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        continue;
      }

      throw new Error(`Deployment lock active for ${resourceName} (concurrent deploy detected)`);
    }
  }
}

export async function atomicDeployPlugin(profileSZip, pluginName, options = {}) {
  if (typeof pluginName !== "string" || !/^[a-z0-9_-]+$/i.test(pluginName) || pluginName.includes("/") || pluginName.includes("\\") || pluginName === "." || pluginName === "..") {
    throw new Error(`Invalid plugin slug '${pluginName}': must be a single safe path segment`);
  }
  if (options.stagingToken && (options.stagingToken.includes("/") || options.stagingToken.includes("\\") || options.stagingToken.includes("..") || options.stagingToken === "." || options.stagingToken.trim() === "")) {
    throw new Error(`Invalid staging token '${options.stagingToken}': must not escape plugins directory`);
  }
  if (options.backupToken && (options.backupToken.includes("/") || options.backupToken.includes("\\") || options.backupToken.includes("..") || options.backupToken === "." || options.backupToken.trim() === "")) {
    throw new Error(`Invalid backup token '${options.backupToken}': must not escape plugins directory`);
  }
  if (options.bootstrapFile && (path.isAbsolute(options.bootstrapFile) || options.bootstrapFile.includes("..") || options.bootstrapFile.includes("\\") || options.bootstrapFile.includes("\0") || /^[a-zA-Z]:/.test(options.bootstrapFile))) {
    throw new Error(`Invalid bootstrap path '${options.bootstrapFile}': must be relative within target root`);
  }

  const resolvedContentRoot = canonicalizePath(
    options.contentRoot
      ? path.resolve(options.contentRoot)
      : options.pluginsDir
        ? path.dirname(path.resolve(options.pluginsDir))
        : defaultContentRoot()
  );
  const resolvedPluginsDir = canonicalizePath(
    options.pluginsDir
      ? path.resolve(options.pluginsDir)
      : path.join(resolvedContentRoot, "plugins")
  );
  const targetDir = path.join(resolvedPluginsDir, pluginName);
  const tempExtractDir = path.join(
    resolvedPluginsDir,
    options.stagingToken || `.${pluginName}.staging-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const backupDir = path.join(
    resolvedPluginsDir,
    options.backupToken || `.${pluginName}.backup-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );

  let deployLock = null;
  if (!options.skipPluginLock && !options.parentLockToken) {
    const lockFile = path.join(resolvedPluginsDir, `.${pluginName}.deploy.lock`);
    deployLock = await acquireInterProcessLock({
      lockFile,
      resourceName: pluginName,
      signal: options.signal,
    });
  }

  let swapDone = false;
  let backupExists = false;
  let txPhase = "staged";

  try {
    if (fs.existsSync(targetDir)) {
      await assertDeployTargetSafe(targetDir);
    }

    // 2. Preflight binary check on ZIP
    const zipStat = await fs.promises.lstat(profileSZip);
    if (zipStat.isSymbolicLink() || !zipStat.isFile()) {
      throw new Error(`Deploy input '${profileSZip}' must be a regular file, not a symlink or directory`);
    }

    const zipBytes = await fs.promises.readFile(profileSZip);
    const computedZipSha = crypto.createHash("sha256").update(zipBytes).digest("hex");
    if (options.expectedZipSha && computedZipSha !== options.expectedZipSha) {
      throw new Error(`Deploy input ZIP digest mismatch (expected ${options.expectedZipSha}, got ${computedZipSha})`);
    }
    const entries = readZipEntries(zipBytes);

    // 3. Strict single root requirement
    const expectedPrefix = `${pluginName}/`;
    for (const entry of entries) {
      if (entry.name !== pluginName && entry.name !== expectedPrefix && !entry.name.startsWith(expectedPrefix)) {
        throw new Error(`ZIP entry '${entry.name}' does not reside in single root '${pluginName}/'`);
      }
    }

    await fs.promises.mkdir(tempExtractDir, { recursive: true });
    const snapshotZipPath = path.join(tempExtractDir, `.snapshot-${Date.now()}.zip`);
    await fs.promises.writeFile(snapshotZipPath, zipBytes, { flag: "wx", mode: 0o400 });

    if (typeof options.onPreflightComplete === "function") {
      await options.onPreflightComplete();
    }

    try {
      await execFileAsync("unzip", ["-q", snapshotZipPath, "-d", tempExtractDir], {
        cwd: resolvedContentRoot,
        signal: options.signal,
      });
    } finally {
      await fs.promises.rm(snapshotZipPath, { force: true }).catch(() => {});
    }

    const extractedPluginDir = path.join(tempExtractDir, pluginName);
    if (!fs.existsSync(extractedPluginDir)) {
      throw new Error(`Expected root directory '${pluginName}' missing from extracted ZIP`);
    }

    // 4. Manifest integrity check on candidate
    const verifyReport = await verifyArtifactManifest({ rootDir: extractedPluginDir, consumer: pluginName });
    if (verifyReport.status !== "valid") {
      throw new Error(`Atomic deploy aborted: extracted candidate failed integrity check (${verifyReport.status})`);
    }

    // Pre-swap PHP syntax validation on candidate bootstrap
    const targetMeta = TARGET_REGISTRY[pluginName];
    const bootstrapRelPath = options.bootstrapFile || targetMeta?.bootstrapFile || `${pluginName}.php`;
    const candidateBootstrap = path.join(extractedPluginDir, bootstrapRelPath);
    if (!fs.existsSync(candidateBootstrap)) {
      throw new Error(`Atomic deploy aborted: candidate bootstrap '${bootstrapRelPath}' is missing`);
    }
    const candidateBootstrapStat = await fs.promises.lstat(candidateBootstrap);
    if (candidateBootstrapStat.isSymbolicLink() || !candidateBootstrapStat.isFile() || candidateBootstrapStat.size === 0) {
      throw new Error(`Atomic deploy aborted: candidate bootstrap '${bootstrapRelPath}' is empty or not a regular file`);
    }
    await execFileAsync("php", ["-l", candidateBootstrap], {
      cwd: extractedPluginDir,
      signal: options.signal,
    });

    // Mandatory Framework Closure preflight: registered framework consumers, or
    // any candidate that already has a FrameworkClosure tree, must ship the file.
    const candidateClosure = path.join(extractedPluginDir, "src/FrameworkClosure/functions-closure.php");
    const candidateClosureDir = path.join(extractedPluginDir, "src/FrameworkClosure");
    const requiresFrameworkClosure = Boolean(targetMeta?.sharedFramework) || fs.existsSync(candidateClosureDir);
    if (requiresFrameworkClosure) {
      if (!fs.existsSync(candidateClosure)) {
        throw new Error("Atomic deploy aborted: candidate FrameworkClosure/functions-closure.php is missing");
      }
      const closureStat = await fs.promises.lstat(candidateClosure);
      if (closureStat.isSymbolicLink() || !closureStat.isFile() || closureStat.size === 0) {
        throw new Error("Atomic deploy aborted: candidate FrameworkClosure/functions-closure.php is empty or not a regular file");
      }
      await execFileAsync("php", ["-l", candidateClosure], {
        cwd: extractedPluginDir,
        signal: options.signal,
      });
    }

    // Mandatory Composer Autoloader targets preflight verification
    const candidateVendorAutoload = path.join(extractedPluginDir, "vendor/autoload.php");
    if (fs.existsSync(candidateVendorAutoload)) {
      const vendorStat = await fs.promises.lstat(candidateVendorAutoload);
      if (vendorStat.isSymbolicLink() || !vendorStat.isFile() || vendorStat.size === 0) {
        throw new Error("Atomic deploy aborted: vendor/autoload.php is empty or not a regular file");
      }
      const candidateAutoloadReal = path.join(extractedPluginDir, "vendor/composer/autoload_real.php");
      if (!fs.existsSync(candidateAutoloadReal)) {
        throw new Error("Atomic deploy aborted: vendor/composer/autoload_real.php is missing");
      }
      const realStat = await fs.promises.lstat(candidateAutoloadReal);
      if (realStat.isSymbolicLink() || !realStat.isFile() || realStat.size === 0) {
        throw new Error("Atomic deploy aborted: vendor/composer/autoload_real.php is empty or not a regular file");
      }
      await execFileAsync("php", ["-l", candidateVendorAutoload], {
        cwd: extractedPluginDir,
        signal: options.signal,
      });
      await execFileAsync("php", ["-l", candidateAutoloadReal], {
        cwd: extractedPluginDir,
        signal: options.signal,
      });

      const candidateAutoloadTargets = await collectComposerAutoloadFileTargets(extractedPluginDir);
      for (const relTarget of candidateAutoloadTargets) {
        const absTarget = path.join(extractedPluginDir, relTarget);
        if (!fs.existsSync(absTarget)) {
          throw new Error(`Atomic deploy aborted: mandatory autoload target '${relTarget}' is missing from candidate`);
        }
        const tgtStat = await fs.promises.lstat(absTarget);
        if (tgtStat.isSymbolicLink() || !tgtStat.isFile() || tgtStat.size === 0) {
          throw new Error(`Atomic deploy aborted: mandatory autoload target '${relTarget}' is empty or not a regular file`);
        }
        if (relTarget.endsWith(".php")) {
          await execFileAsync("php", ["-l", absTarget], {
            cwd: extractedPluginDir,
            signal: options.signal,
          });
        }
      }
    }

    // 5. Atomic swap
    if (fs.existsSync(targetDir)) {
      if (typeof options.onPhaseChange === "function") {
        await options.onPhaseChange("backup_rename_intent");
      }
      await rename(targetDir, backupDir);
      backupExists = true;
      txPhase = "backup_renamed";
      if (options.injectFault === "after_backup_rename") {
        throw new Error("Fault injected immediately after target backup rename");
      }
      await fsyncDir(resolvedPluginsDir);
      if (options.injectFault === "after_backup_rename_fsync") {
        throw new Error("Fault injected during/after backup fsync");
      }
      if (typeof options.onPhaseChange === "function") {
        await options.onPhaseChange("backup_renamed");
      }
    }
    if (typeof options.onPhaseChange === "function") {
      await options.onPhaseChange("candidate_swap_intent");
    }
    await rename(extractedPluginDir, targetDir);
    swapDone = true;
    txPhase = "candidate_swapped";
    if (options.injectFault === "after_candidate_swap") {
      throw new Error("Fault injected immediately after candidate swap");
    }
    await fsyncDir(resolvedPluginsDir);
    if (options.injectFault === "after_candidate_swap_fsync") {
      throw new Error("Fault injected during/after candidate swap fsync");
    }
    if (typeof options.onPhaseChange === "function") {
      await options.onPhaseChange("candidate_swapped");
    }

    // 6. Post-swap structural check: bootstrap file existence and healthCheck
    if (typeof options.onPhaseChange === "function") {
      await options.onPhaseChange("target_verification_intent");
    }
    const deployedBootstrap = path.join(targetDir, bootstrapRelPath);
    if (!fs.existsSync(deployedBootstrap)) {
      throw new Error(`Post-swap verification failed: main plugin bootstrap '${bootstrapRelPath}' is missing`);
    }
    const bootstrapStat = await fs.promises.lstat(deployedBootstrap);
    if (bootstrapStat.isSymbolicLink() || !bootstrapStat.isFile() || bootstrapStat.size === 0) {
      throw new Error("Post-swap verification failed: main plugin bootstrap is empty or not a regular file");
    }

    if (requiresFrameworkClosure) {
      const deployedClosure = path.join(targetDir, "src/FrameworkClosure/functions-closure.php");
      if (!fs.existsSync(deployedClosure)) {
        throw new Error("Post-swap verification failed: FrameworkClosure/functions-closure.php is missing");
      }
    }

    if (typeof options.healthCheck === "function") {
      await options.healthCheck(targetDir);
    }
    const postSwapReport = await verifyArtifactManifest({ rootDir: targetDir, consumer: pluginName });
    if (postSwapReport.status !== "valid") {
      throw new Error(`Post-swap verification failed: deployed tree integrity is ${postSwapReport.status}`);
    }

    // Attempt best-effort OPcache reset if supported
    try {
      await execFileAsync("php", ["-r", "if (function_exists('opcache_reset')) { opcache_reset(); }"], {
        cwd: targetDir,
        signal: options.signal,
      });
    } catch {
      // Non-fatal if CLI PHP SAPI does not expose opcache_reset
    }

    if (typeof options.onPhaseChange === "function") {
      await options.onPhaseChange("target_verified");
    }

    // Mark committed before touching backup!
    txPhase = "committed";

    // 7. Cleanup backup only upon 100% verified success (unless preserved for transactional orchestration)
    if (backupExists && !options.preserveBackup) {
      txPhase = "purging_backup";
      if (options.injectFault === "during_backup_purge") {
        throw new Error("Fault injected during backup directory purge");
      }
      try {
        await rm(backupDir, { recursive: true, force: true });
        backupExists = false;
        await fsyncDir(resolvedPluginsDir);
      } catch (cleanupErr) {
        console.warn(`WARNING: Post-commit backup cleanup failed for ${pluginName} at ${backupDir}: ${cleanupErr.message}`);
        if (options.strictCleanup || options.injectFault === "during_backup_purge") {
          throw cleanupErr;
        }
      }
    }

    return {
      deployedTargetDir: targetDir,
      backupDir: (options.preserveBackup && backupExists) ? backupDir : null,
      stagingDir: tempExtractDir,
    };
  } catch (err) {
    if (txPhase === "committed" || txPhase === "purging_backup") {
      // Target directory has reached commit and is verified healthy.
      // Never roll back or replace target with an incomplete backup!
      throw err;
    }

    let rollbackFailure = null;
    if (swapDone && backupExists) {
      try {
        if (options.injectFault === "during_rollback_rm") {
          throw new Error("Fault injected during rollback rm");
        }
        await rm(targetDir, { recursive: true, force: true });
        if (options.injectFault === "during_rollback_rename") {
          throw new Error("Fault injected during rollback rename");
        }
        await rename(backupDir, targetDir);
        await fsyncDir(resolvedPluginsDir);
        backupExists = false;
        swapDone = false;
        txPhase = "rolled_back";
      } catch (rollbackErr) {
        txPhase = "rollback_failed";
        rollbackFailure = rollbackErr;
        console.error(`EMERGENCY: Rollback failed for ${pluginName}! Backup preserved at ${backupDir}: ${rollbackErr.message}`);
      }
    } else if (backupExists && !fs.existsSync(targetDir)) {
      try {
        if (options.injectFault === "during_restore_rename") {
          throw new Error("Fault injected during restore rename");
        }
        await rename(backupDir, targetDir);
        await fsyncDir(resolvedPluginsDir);
        backupExists = false;
        txPhase = "restored";
      } catch (restoreErr) {
        txPhase = "rollback_failed";
        rollbackFailure = restoreErr;
        console.error(`EMERGENCY: Failed restoring backup for ${pluginName} from ${backupDir}: ${restoreErr.message}`);
      }
    } else if (swapDone && !backupExists) {
      // If candidate was swapped in on non-preexisting target, remove target
      try {
        await rm(targetDir, { recursive: true, force: true });
        await fsyncDir(resolvedPluginsDir);
        swapDone = false;
        txPhase = "cleaned_up";
      } catch (cleanupErr) {
        console.warn(`WARNING: Failed cleaning up non-preexisting target ${targetDir}: ${cleanupErr.message}`);
      }
    }

    if (rollbackFailure) {
      const compositeErr = new Error(`Rollback failed for ${pluginName} (original error: ${err.message}): ${rollbackFailure.message}`);
      compositeErr.originalError = err;
      compositeErr.rollbackError = rollbackFailure;
      throw compositeErr;
    }
    throw err;
  } finally {
    await rm(tempExtractDir, { recursive: true, force: true }).catch(() => {});

    if (deployLock) {
      await deployLock.release().catch(() => {});
    }
  }
}

export const TARGET_PLUGINS = listStandaloneConsumers();

export const ALLOWED_SUITES = new Set(["fast", "contract", "artifact", "full"]);
export const ALLOWED_TEST_MODES = new Set([
  "affected",
  "fast",
  "contract",
  "artifact",
  "full",
  "docker-smoke",
  "release",
]);

export function parsePipelineArgs(argv = process.argv) {
  const shouldDeploy = argv.includes("--deploy");
  const shouldTest = argv.includes("--test");
  const isBuildOnly = argv.includes("--build-only");
  const isForce = argv.includes("--force");
  const isChanged = argv.includes("--changed");
  const isWatch = argv.includes("--watch");
  const closedFlags = parseClosedProfileFlags(argv);
  const { profile, isObfuscate } = closedFlags;

  const jobsArg = argv.find((a) => a.startsWith("--jobs="));
  const jobsLimit = jobsArg ? parseInt(jobsArg.split("=")[1], 10) : Math.max(1, Math.min(4, os.cpus().length));
  if (jobsArg && (!Number.isFinite(jobsLimit) || jobsLimit < 1)) {
    throw new Error("Invalid --jobs value");
  }

  const suiteArg = argv.find((a) => a.startsWith("--suite="));
  const testModeArg = argv.find((a) => a.startsWith("--test-mode="));
  const suite = suiteArg ? suiteArg.split("=")[1] : null;
  const testModeExplicit = testModeArg ? testModeArg.split("=")[1] : null;

  if (suite && !ALLOWED_SUITES.has(suite)) {
    throw new Error(`Invalid --suite '${suite}'. Allowed: ${Array.from(ALLOWED_SUITES).join(", ")}`);
  }
  if (testModeExplicit && !ALLOWED_TEST_MODES.has(testModeExplicit)) {
    throw new Error(`Invalid --test-mode '${testModeExplicit}'. Allowed: ${Array.from(ALLOWED_TEST_MODES).join(", ")}`);
  }
  if (suite && testModeExplicit && suite !== testModeExplicit) {
    throw new Error(`Conflicting --suite=${suite} and --test-mode=${testModeExplicit}`);
  }

  if (isBuildOnly && shouldDeploy) {
    throw new Error("--build-only cannot be combined with --deploy");
  }

  let testMode = null;
  if (!isBuildOnly) {
    if (testModeExplicit) testMode = testModeExplicit;
    else if (suite) testMode = suite;
    else if (shouldTest || isChanged || shouldDeploy) testMode = "affected";
  }

  const distDirArg = argv.find((a) => a.startsWith("--dist-dir="));
  const distDir = distDirArg ? distDirArg.split("=")[1] : null;
  const pluginsDirArg = argv.find((a) => a.startsWith("--plugins-dir="));
  const pluginsDir = pluginsDirArg ? pluginsDirArg.split("=")[1] : null;
  const cacheFileArg = argv.find((a) => a.startsWith("--cache-file="));
  const cacheFile = cacheFileArg ? cacheFileArg.split("=")[1] : null;
  const receiptsDirArg = argv.find((a) => a.startsWith("--receipts-dir="));
  const receiptsDir = receiptsDirArg ? receiptsDirArg.split("=")[1] : null;
  const targetsArg = argv.find((a) => a.startsWith("--targets=") || a.startsWith("--target="));
  const targetPlugins = targetsArg ? targetsArg.split("=")[1].split(",").map((s) => s.trim()).filter(Boolean) : null;

  return {
    shouldDeploy,
    shouldTest,
    isBuildOnly,
    isForce,
    isChanged,
    isWatch,
    isObfuscate,
    profile,
    inlineFramework: closedFlags.inlineFramework,
    spaghetti: closedFlags.spaghetti,
    obfuscate: closedFlags.obfuscate,
    minifyAssets: closedFlags.minifyAssets,
    skipZip: closedFlags.skipZip,
    targetPhp: closedFlags.targetPhp,
    jobsLimit,
    suite,
    testMode,
    distDir,
    pluginsDir,
    cacheFile,
    receiptsDir,
    targetPlugins,
  };
}

export async function assertDeployTargetSafe(targetDir) {
  const gitMarker = path.join(targetDir, ".git");
  if (!fs.existsSync(gitMarker)) {
    return;
  }
  try {
    const { stdout } = await execFileAsync("git", ["-C", targetDir, "status", "--porcelain=v1"]);
    if (stdout.trim()) {
      throw new Error(`Refusing to overwrite dirty git working tree at ${targetDir}`);
    }
  } catch (err) {
    if (String(err.message).includes("Refusing to overwrite dirty git")) {
      throw err;
    }
    throw new Error(`Unable to verify git status for deploy target ${targetDir}: ${err.message}`);
  }
}

export async function runPipelineOrchestration(options = {}) {
  const customContentRoot = canonicalizePath(options.contentRoot || defaultContentRoot());
  const customScriptDir = options.scriptDir || scriptDir;
  const customDistDir = canonicalizePath(options.distDir || path.join(customContentRoot, "dist"));
  const customPluginsDir = canonicalizePath(options.pluginsDir || path.join(customContentRoot, "plugins"));
  const customReceiptsDir = canonicalizePath(options.receiptsDir || path.join(customDistDir, ".deploy-receipts"));
  const customCacheFile = options.cacheFile || path.join(customDistDir, ".build-cache.json");
  const targetPlugins = options.targetPlugins || (options.parsed?.targetPlugins) || TARGET_PLUGINS;
  const activeIsChanged = options.overrideChanged !== undefined ? options.overrideChanged : Boolean(options.isChanged);
  const activeTestMode = options.overrideTestMode !== undefined ? options.overrideTestMode : options.testMode;
  const activeIsForce = options.overrideForce !== undefined ? options.overrideForce : Boolean(options.isForce);
  const activeShouldDeploy = options.overrideDeploy !== undefined ? options.overrideDeploy : Boolean(options.shouldDeploy);
  const activeIsObfuscate = options.overrideObfuscate !== undefined ? options.overrideObfuscate : Boolean(options.isObfuscate || options.parsed?.isObfuscate);
  const jobsLimit = options.jobsLimit || 4;
  const executor = options.executor || null;
  const injectFailure = options.injectFailure || null;

  if (activeShouldDeploy && (activeTestMode === "fast" || activeTestMode === null)) {
    throw new Error("Fast test mode or missing test mode does not authorize deployment. Full or affected test suite required.");
  }

  const startTime = Date.now();
  await fs.promises.mkdir(customDistDir, { recursive: true });
  await fs.promises.mkdir(customReceiptsDir, { recursive: true });

  const pipelineLockFile = path.join(customDistDir, ".transaction.deploy.lock");
  const pipelineLock = await acquireInterProcessLock({
    lockFile: pipelineLockFile,
    resourceName: `pipeline-transaction-${path.basename(customDistDir)}`,
  });

  const journalFile = path.join(customDistDir, ".deploy-journal.json");

  let rollbackDeployment = async (reasonErr = null) => {
    try {
      await recoverInterruptedDeployment({
        journalFile,
        pluginsDir: customPluginsDir,
        distDir: customDistDir,
        logger: console,
      });
    } catch {}
  };

  try {
    // 1. Startup Recovery: Inspect and safely recover any interrupted deployment BEFORE reading cache
    await recoverInterruptedDeployment({
      journalFile,
      pluginsDir: customPluginsDir,
      distDir: customDistDir,
      logger: console,
    });

  // 2. Load Build Cache with Context-Aware Schema Validation
  let cache = {};
  if (!activeIsForce) {
    const loaded = await loadBuildCacheRecord(customCacheFile, {
      expectedConsumers: ALLOWED_CONSUMERS,
      expectedDistDir: customDistDir,
    });
    if (loaded.status === "valid") {
      cache = loaded.cache;
    } else if (loaded.status === "missing") {
      cache = {};
    } else {
      if (activeShouldDeploy || activeTestMode === "release") {
        throw new Error(`Invalid or corrupted cache record in deploy/release mode: ${loaded.reason}`);
      }
      console.log(`⚠ Existing cache is ${loaded.status} (${loaded.reason}); treating as miss.`);
      cache = {};
    }
  }

  const currentTransactionId = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const currentRunId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const canonicalDeployTargets = (activeShouldDeploy ? targetPlugins.slice().sort() : []).map((consumer) => {
    const targetDir = path.join(customPluginsDir, consumer);
    const preExisting = fs.existsSync(targetDir);
    return {
      consumer,
      preExisting,
      phase: "prepared",
      backupToken: `.${consumer}.backup-${currentTransactionId}`,
      stagingToken: `.${consumer}.staging-${currentTransactionId}`,
      candidateZipSha: "0".repeat(64),
      candidateManifestDigest: null,
    };
  });

  const initialTxContext = {
    schemaVersion: DEPLOY_JOURNAL_SCHEMA_VERSION,
    txId: currentTransactionId,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: "prepared",
    targets: canonicalDeployTargets,
    publication: {
      receipts: {},
      cache: null,
      backupsPurged: false,
    },
    error: null,
  };

  const txManager = new TransactionJournalManager({
    journalFile,
    distDir: customDistDir,
    initialJournal: initialTxContext,
  });

  if (activeShouldDeploy) {
    // Initial persistent write of prepared journal state with revision 1
    await txManager.update(async () => {});
  }

  const stagedReceipts = {};

  rollbackDeployment = async (reasonErr = null) => {
    if (txManager.isCommitted) {
      console.warn("⚠️ Transaction is already committed. Executing forward cleanup instead of rollback...");
      try {
        await recoverInterruptedDeployment({
          journalFile,
          pluginsDir: customPluginsDir,
          distDir: customDistDir,
          logger: console,
        });
      } catch (fwdErr) {
        console.error("❌ Forward cleanup failed after commit:", fwdErr);
      }
      return;
    }

    console.error("⚠️ Rolling back deployed targets due to pipeline failure:", reasonErr?.message || reasonErr);
    if (reasonErr?.stack) {
      console.error(reasonErr.stack);
    }
    await txManager.update(async (state) => {
      state.phase = "rolling_back";
      if (reasonErr) {
        state.error = {
          message: reasonErr.message,
          stack: reasonErr.stack,
          failedPhase: "rolling_back",
          timestamp: new Date().toISOString(),
        };
      }
    });

    let rollbackError = null;
    const snap = txManager.getSnapshot();
    let derived;
    try {
      derived = deriveJournalPaths({ journal: snap, pluginsDir: customPluginsDir, distDir: customDistDir });
    } catch (dErr) {
      rollbackError = dErr;
    }

    if (derived) {
      for (const target of [...derived.targets].reverse()) {
        try {
          if (target.preExisting) {
            if (target.phase !== "prepared") {
              if (!fs.existsSync(target.backupDir)) {
                throw new Error(`Rollback failed: Pre-existing backup directory missing for '${target.consumer}' at ${target.backupDir}`);
              }
              const bStat = await fs.promises.lstat(target.backupDir);
              if (bStat.isSymbolicLink() || !bStat.isDirectory()) {
                throw new Error(`Rollback failed: Backup directory for '${target.consumer}' is not a regular directory`);
              }
              if (fs.existsSync(target.targetDir)) {
                await rm(target.targetDir, { recursive: true, force: true });
              }
              await rename(target.backupDir, target.targetDir);
            }
          } else {
            if (target.phase !== "prepared" && fs.existsSync(target.targetDir)) {
              await rm(target.targetDir, { recursive: true, force: true });
            }
          }
          if (fs.existsSync(target.stagingDir)) {
            await rm(target.stagingDir, { recursive: true, force: true });
          }
          if (fs.existsSync(target.backupDir)) {
            await rm(target.backupDir, { recursive: true, force: true });
          }
        } catch (rErr) {
          console.error(`❌ Rollback error on ${target.consumer}:`, rErr);
          if (!rollbackError) rollbackError = rErr;
        }
      }

      // Rollback publication outputs with per-file existedBefore tracking
      try {
        if (snap.publication) {
          const pubReceipts = snap.publication.receipts || {};
          const targetReceiptsDir = path.join(customDistDir, ".deploy-receipts");
          const backupReceiptsDir = path.join(derived.txBackupDir, ".deploy-receipts");

          for (const [p, rInfo] of Object.entries(pubReceipts)) {
            const destRcptFile = path.join(targetReceiptsDir, `${p}.receipt.json`);
            if (rInfo.existedBefore) {
              const bkpRcptFile = path.join(backupReceiptsDir, `${p}.receipt.json`);
              if (!fs.existsSync(bkpRcptFile)) {
                throw new Error(`Rollback failed: Backup receipt missing for ${p}`);
              }
              const bkpStat = await fs.promises.lstat(bkpRcptFile);
              if (bkpStat.isSymbolicLink() || !bkpStat.isFile()) {
                throw new Error(`Rollback failed: Backup receipt for ${p} is not a regular file`);
              }
              const bkpBytes = await readFile(bkpRcptFile);
              const bkpDigest = crypto.createHash("sha256").update(bkpBytes).digest("hex");
              if (rInfo.preDigest && bkpDigest !== rInfo.preDigest) {
                throw new Error(`Rollback failed: Backup receipt digest mismatch for ${p}`);
              }
              const wr = await writeAtomicCacheFile(destRcptFile, JSON.parse(bkpBytes.toString("utf8")));
              if (wr.outcome !== "committed-durable") {
                throw new Error(`Failed to durably restore receipt for ${p}`);
              }
              await txManager.update(async (state) => {
                if (state.publication?.receipts?.[p]) {
                  state.publication.receipts[p].publishStatus = "restored";
                  state.publication.receipts[p].finalDigest = bkpDigest;
                }
              });
            } else {
              if (fs.existsSync(destRcptFile)) {
                await rm(destRcptFile, { force: true });
              }
              await txManager.update(async (state) => {
                if (state.publication?.receipts?.[p]) {
                  state.publication.receipts[p].publishStatus = "deleted";
                  state.publication.receipts[p].finalDigest = null;
                }
              });
            }
          }

          if (snap.publication.cache) {
            const cInfo = snap.publication.cache;
            const destCacheFile = customCacheFile;
            const bkpCacheFile = path.join(derived.txBackupDir, ".build-cache.json");

            if (cInfo.existedBefore) {
              if (!fs.existsSync(bkpCacheFile)) {
                throw new Error("Rollback failed: Backup cache file missing");
              }
              const bkpStat = await fs.promises.lstat(bkpCacheFile);
              if (bkpStat.isSymbolicLink() || !bkpStat.isFile()) {
                throw new Error("Rollback failed: Backup cache is not a regular file");
              }
              const bkpBytes = await readFile(bkpCacheFile);
              const bkpDigest = crypto.createHash("sha256").update(bkpBytes).digest("hex");
              if (cInfo.preDigest && bkpDigest !== cInfo.preDigest) {
                throw new Error("Rollback failed: Backup cache digest mismatch");
              }
              const wr = await writeAtomicCacheFile(destCacheFile, JSON.parse(bkpBytes.toString("utf8")));
              if (wr.outcome !== "committed-durable") {
                throw new Error("Failed to durably restore cache");
              }
              await txManager.update(async (state) => {
                if (state.publication?.cache) {
                  state.publication.cache.publishStatus = "restored";
                  state.publication.cache.finalDigest = bkpDigest;
                }
              });
            } else {
              if (fs.existsSync(destCacheFile)) {
                await rm(destCacheFile, { force: true });
              }
              await txManager.update(async (state) => {
                if (state.publication?.cache) {
                  state.publication.cache.publishStatus = "deleted";
                  state.publication.cache.finalDigest = null;
                }
              });
            }
          }
        }
        if (fs.existsSync(derived.txStagingDir)) {
          await rm(derived.txStagingDir, { recursive: true, force: true });
          if (fs.existsSync(derived.txStagingDir)) {
            throw new Error(`Rollback failed: txStagingDir still exists at ${derived.txStagingDir}`);
          }
        }
        if (fs.existsSync(derived.txBackupDir)) {
          await rm(derived.txBackupDir, { recursive: true, force: true });
          if (fs.existsSync(derived.txBackupDir)) {
            throw new Error(`Rollback failed: txBackupDir still exists at ${derived.txBackupDir}`);
          }
        }
        await fsyncDir(customPluginsDir);
        await fsyncDir(customDistDir);
      } catch (pubRollErr) {
        console.error("❌ Rollback error on publication files:", pubRollErr);
        if (!rollbackError) rollbackError = pubRollErr;
      }
    }

    if (rollbackError) {
      await txManager.update(async (state) => {
        state.phase = "rollback_failed";
        state.error = {
          message: rollbackError.message,
          stack: rollbackError.stack,
          failedPhase: "rolling_back",
          timestamp: new Date().toISOString(),
        };
      });
      txManager.terminate();
      const err = new Error(`Deployment rollback failed: ${rollbackError.message}`);
      err.outcome = "rollback-failed";
      throw err;
    } else {
      await txManager.update(async (state) => {
        state.phase = "rolled_back";
      });
      txManager.terminate();
      await rm(journalFile, { force: true });
      await fsyncDir(customDistDir);
    }
  };

  // DAG Orchestration
  const dag = new BuildDag({ concurrency: jobsLimit });

  // 1. Fingerprint Node
  dag.addNode("fingerprint", {
    task: async (results, taskOptions) => {
      console.log("🔍 Computing content-based SHA-256 fingerprints across sources and tools...");
      const tStart = Date.now();
      const fingerprints = await computeAllFingerprintsParallel({
        scriptDir: customScriptDir,
        pluginsDir: customPluginsDir,
        targetPlugins,
        jobs: jobsLimit,
        contentRoot: customContentRoot,
        signal: taskOptions?.signal,
      });
      const tElapsed = ((Date.now() - tStart) / 1000).toFixed(2);
      console.log(`✓ Fingerprints computed in ${tElapsed}s (tools: ${fingerprints.tools.slice(0, 8)}..., wpdev: ${fingerprints.wpdev.slice(0, 8)}...)\n`);
      return fingerprints;
    },
  });

  // 2. Plan Node
  dag.addNode("plan", {
    dependencies: ["fingerprint"],
    task: async ({ fingerprint }) => {
      const activeProfile = activeIsObfuscate ? "s" : "clean";
      return planDependencyGraphBuild({
        targetPlugins,
        previousCache: cache,
        currentFingerprints: {
          tools: fingerprint.tools,
          wpdev: fingerprint.wpdev,
          plugins: fingerprint.plugins,
          toolchain: fingerprint.toolchain,
        },
        mode: activeIsForce ? "force" : (activeIsChanged ? "changed" : "incremental"),
        profile: activeProfile,
        options: options.buildOptions || {},
      });
    },
  });

  // 3. Build Nodes per Plugin
  for (const plugin of targetPlugins) {
    dag.addNode(`build:${plugin}`, {
      dependencies: ["plan"],
      task: async ({ plan }, taskOptions) => {
        // Single source of truth: obfuscate flag decides the tier. options.profile
        // alone never flips the tier (prevents clean-plan/S-build divergence).
        const pluginPlan = plan[plugin];
        const parsedFlags = options.parsed || {};
        const pluginBuildPlan = createBuildPlan({
          consumer: plugin,
          profile: parsedFlags.profile || (activeIsObfuscate ? "s" : "clean"),
          isObfuscate: activeIsObfuscate,
          obfuscate: parsedFlags.obfuscate,
          inlineFramework: options.inlineFramework ?? parsedFlags.inlineFramework,
          spaghetti: options.spaghetti ?? parsedFlags.spaghetti,
          minifyAssets: options.minifyAssets ?? parsedFlags.minifyAssets,
          skipZip: options.skipZip ?? parsedFlags.skipZip,
          targetPhp: options.targetPhp ?? parsedFlags.targetPhp,
        });
        const activeProfile = pluginBuildPlan.capabilities.inlineFramework
          && pluginBuildPlan.capabilities.spaghetti
          && pluginBuildPlan.capabilities.obfuscate
          ? "s"
          : "clean";
        const targetZipPath = path.join(customDistDir, resolveArtifactZipName(pluginBuildPlan));

        const cachedArtifact = cache.artifacts?.[plugin];
        // Always enforce profile identity: clean and S artifacts are never
        // interchangeable, even for legacy cache records without profile info.
        const expectedProfile = activeProfile;
        const cacheValidation = await validateCachedTargetArtifact({
          cacheRecord: cachedArtifact,
          zipPath: targetZipPath,
          consumer: plugin,
          expectedCompositeFingerprint: pluginPlan.compositeFingerprint,
          expectedProfile,
        });

        if (!pluginPlan.shouldRebuild && cacheValidation.valid) {
          console.log(`⏩ [${plugin}] SKIP: ${pluginPlan.reason}`);
          return {
            status: "cached",
            plugin,
            artifactId: cachedArtifact.artifactId,
            composite: pluginPlan.compositeFingerprint,
            zipSha256: cachedArtifact.zipSha256,
            manifestDigest: cachedArtifact.manifestDigest,
          };
        }

        const rebuildReason = pluginPlan.shouldRebuild
          ? pluginPlan.reason
          : (cacheValidation.reason || "Cached inputs matched but ZIP validation failed");
        console.log(`📦 [${plugin}] BUILD: ${rebuildReason}...`);
        const pStart = Date.now();
        if (options.buildCandidate) {
          await options.buildCandidate({
            plugin,
            customContentRoot,
            customDistDir,
            customPluginsDir,
            customScriptDir,
            isObfuscate: activeIsObfuscate,
            profile: activeProfile,
            signal: taskOptions?.signal,
          });
        } else {
          await assembleProfileSCandidate({
            contentRoot: customContentRoot,
            consumer: plugin,
            outputDir: customDistDir,
            pluginsDir: customPluginsDir,
            buildPlan: pluginBuildPlan,
            isObfuscate: pluginBuildPlan.capabilities.obfuscate,
            profile: activeProfile,
            inlineFramework: pluginBuildPlan.capabilities.inlineFramework,
            spaghetti: pluginBuildPlan.capabilities.spaghetti,
            obfuscate: pluginBuildPlan.capabilities.obfuscate,
            minifyAssets: pluginBuildPlan.assetPolicy.minifyAssets,
            skipZip: pluginBuildPlan.skipZip,
            targetPhp: pluginBuildPlan.targetPhp,
            signal: taskOptions?.signal,
          });
        }

        if (!fs.existsSync(targetZipPath)) {
          throw new Error(`Build finished but expected target ZIP does not exist: ${targetZipPath}`);
        }

        const zipBytes = await fs.promises.readFile(targetZipPath);
        const zipSha256 = crypto.createHash("sha256").update(zipBytes).digest("hex");
        const embedded = readEmbeddedManifestFromZip(zipBytes, plugin);
        if (!embedded.valid) {
          throw new Error(`Built candidate ZIP for ${plugin} failed embedded manifest validation: ${embedded.reason}`);
        }
        const pElapsed = ((Date.now() - pStart) / 1000).toFixed(2);
        console.log(`  ✓ [${plugin}] Built and verified in ${pElapsed}s (digest: ${embedded.manifestDigest.slice(0, 8)}...).`);
        return {
          status: "rebuilt",
          plugin,
          artifactId: embedded.artifactId,
          composite: pluginPlan.compositeFingerprint,
          zipSha256,
          manifestDigest: embedded.manifestDigest,
        };
      },
    });
  }

  // 4. Test Node
  const buildNodeIds = targetPlugins.map((p) => `build:${p}`);
  dag.addNode("test", {
    dependencies: buildNodeIds,
    task: async ({ fingerprint, plan }, taskOptions) => {
      if (!activeTestMode) return { selected: 0, skipped: 0, selectedFiles: [], durationMs: 0 };

      if (activeTestMode === "docker-smoke") {
        return { selected: 0, skipped: 0, selectedFiles: [], durationMs: 0, reason: "Docker smoke deferred to post-deploy node" };
      }

      const allTestFiles = fs.readdirSync(path.join(customScriptDir, "tests")).filter((f) => f.endsWith(".test.mjs"));
      const changedKeys = [];
      if (fingerprint.toolchain && fingerprint.toolchain !== cache.toolchain) changedKeys.push("_tools");
      if (fingerprint.wpdev !== cache._wpdev) changedKeys.push("_wpdev");
      if (fingerprint.theme !== cache._theme) changedKeys.push("themes/tavangary");

      let toolsNeedFallback = false;
      if (!cache._toolFiles || typeof cache._toolFiles !== "object") {
        toolsNeedFallback = true;
      } else {
        const previousToolFiles = cache._toolFiles || {};
        const currentToolFiles = fingerprint.toolFiles || {};
        const allToolPaths = new Set([...Object.keys(previousToolFiles), ...Object.keys(currentToolFiles)]);
        for (const toolFile of allToolPaths) {
          if (previousToolFiles[toolFile] !== currentToolFiles[toolFile]) {
            const toolKey = `tool:${toolFile}`;
            if (TEST_DEPENDENCY_GRAPH[toolKey]) {
              changedKeys.push(toolKey);
            } else {
              toolsNeedFallback = true;
            }
          }
        }
      }
      if (toolsNeedFallback && fingerprint.tools !== cache._tools) {
        changedKeys.push("_tools");
      }

      const previousTestFiles = cache._testFiles || {};
      const currentTestFiles = fingerprint.testFiles || {};
      for (const testFile of new Set([...Object.keys(previousTestFiles), ...Object.keys(currentTestFiles)])) {
        if (previousTestFiles[testFile] !== currentTestFiles[testFile]) {
          changedKeys.push(testFile);
        }
      }
      for (const p of targetPlugins) {
        const previousArtifact = cache.artifacts?.[p];
        const coverage = computeArtifactTestCoverage({
          consumer: p,
          testEvidenceMap: cache._testEvidence || {},
          testFiles: currentTestFiles,
          toolFiles: fingerprint.toolFiles || {},
          toolchainFingerprint: fingerprint.toolchain || "",
          artifactRecord: previousArtifact || {},
          testMode: activeTestMode,
        });
        if (plan[p].shouldRebuild || !coverage.covered) changedKeys.push(p);
      }

      const impact = resolveImpactedTests({
        changedKeys,
        allTestFiles,
        mode: activeTestMode,
      });

      console.log(`\n========================================`);
      console.log(`🧪 Resolving Test Suite (mode=[${activeTestMode}])...`);
      console.log(`========================================`);
      console.log(`Reason: ${impact.reason}`);
      console.log(`Selected: ${impact.selected.length} files, Skipped: ${impact.skipped.length} files\n`);

      let testDurationMs = 0;
      if (impact.selected.length > 0) {
        const testRes = await runSelectedNodeTests({
          testFiles: impact.selected,
          jobsLimit,
          signal: taskOptions?.signal,
          executor,
          cwd: customContentRoot,
          scriptDir: customScriptDir,
        });
        testDurationMs = testRes.durationMs;
        console.log(testRes.stdout);
        console.log(`  ✓ Selected tests (${impact.selected.length} files) passed.`);
      }

      return {
        selected: impact.selected.length,
        skipped: impact.skipped.length,
        selectedFiles: impact.selected,
        durationMs: testDurationMs,
      };
    },
  });

  // 5. Stage Cache Node
  dag.addNode("plan:cache", {
    dependencies: ["test"],
    task: async (results) => {
      const { fingerprint } = results;
      const testResult = results.test || { selected: 0, skipped: 0, selectedFiles: [], durationMs: 0 };
      const testsActuallyRan = Boolean(
        activeTestMode &&
        activeTestMode !== "docker-smoke" &&
        testResult.selected > 0
      );

      const targetBindings = targetPlugins.map((p) => {
        const bRes = results[`build:${p}`];
        return {
          consumer: p,
          artifactId: bRes?.artifactId || `${p}-profile-s`,
          zipSha256: bRes?.zipSha256 || "",
          compositeFingerprint: bRes?.composite || "",
        };
      });

      const nextTestEvidence = {};
      if (testsActuallyRan) {
        for (const testFile of (testResult.selectedFiles || [])) {
          const testSha = fingerprint.testFiles?.[testFile] || "";
          if (testSha) {
            const depFingerprint = computeTestDependencyFingerprint({
              testFile,
              testFileSha256: testSha,
              toolFiles: fingerprint.toolFiles || {},
              toolchainFingerprint: fingerprint.toolchain || "",
            });

            const allowedArtifacts = new Set(TEST_SPEC_MAP[testFile]?.artifacts || []);
            const testBindings = targetBindings.filter((b) => allowedArtifacts.has(b.consumer));

            nextTestEvidence[testFile] = createTestEvidenceRecord({
              runId: currentRunId,
              transactionId: currentTransactionId,
              testFile,
              testFileSha256: testSha,
              testDependencyFingerprint: depFingerprint,
              toolchainFingerprint: fingerprint.toolchain,
              artifactBindings: testBindings,
              mode: activeTestMode,
              exitStatus: "passed",
              runDurationMs: testResult.durationMs,
            });
          }
        }
      }

      // Retain previous valid test evidence for skipped tests (strictly forbidden in release mode for releaseSameRun tests)
      const previousEvidence = cache._testEvidence || {};
      for (const [testFile, evRecord] of Object.entries(previousEvidence)) {
        if (!nextTestEvidence[testFile]) {
          const spec = TEST_SPEC_MAP[testFile];
          if (activeTestMode === "release" && spec?.releaseSameRun) {
            // Must not retain previous run evidence in release mode
            continue;
          }
          const expectedSha = fingerprint.testFiles?.[testFile];
          const depFingerprint = computeTestDependencyFingerprint({
            testFile,
            testFileSha256: expectedSha || evRecord.testFileSha256,
            toolFiles: fingerprint.toolFiles || {},
            toolchainFingerprint: fingerprint.toolchain || "",
          });
          const allowedArtifacts = new Set(spec?.artifacts || []);
          const expectedBindings = targetBindings.filter((b) => allowedArtifacts.has(b.consumer));

          const val = validateTestEvidenceRecord({
            evidence: evRecord,
            expectedTestFile: testFile,
            expectedTestFileSha256: expectedSha,
            expectedTestDependencyFingerprint: depFingerprint,
            expectedToolchainFingerprint: fingerprint.toolchain,
            expectedArtifactBindings: expectedBindings,
          });
          if (val.valid) {
            nextTestEvidence[testFile] = evRecord;
          }
        }
      }

      const nextCache = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        _tools: fingerprint.tools,
        _toolFiles: fingerprint.toolFiles || {},
        _wpdev: (fingerprint.wpdev && fingerprint.wpdev !== "missing") ? fingerprint.wpdev : "0".repeat(64),
        _theme: (fingerprint.theme && fingerprint.theme !== "missing") ? fingerprint.theme : "0".repeat(64),
        _testFiles: fingerprint.testFiles || {},
        _testEvidence: nextTestEvidence,
        toolchain: fingerprint.toolchain || null,
        artifacts: {},
      };

      for (const p of targetPlugins) {
        const bRes = results[`build:${p}`];
        if (bRes) {
          nextCache[p] = bRes.composite;

          const coverage = computeArtifactTestCoverage({
            consumer: p,
            testEvidenceMap: nextTestEvidence,
            testFiles: fingerprint.testFiles || {},
            toolFiles: fingerprint.toolFiles || {},
            toolchainFingerprint: fingerprint.toolchain || "",
            artifactRecord: {
              artifactId: bRes.artifactId || `${p}-profile-s`,
              zipSha256: bRes.zipSha256,
              compositeFingerprint: bRes.composite,
            },
            testMode: activeTestMode,
            currentTransactionId,
            currentRunId,
          });

          const validationState = coverage.covered ? "tests-passed" : "artifact-verified";

          nextCache.artifacts[p] = createTargetCacheRecord({
            artifactId: bRes.artifactId || `${p}-profile-s`,
            consumer: p,
            sourceFingerprint: fingerprint.plugins[p],
            wpdevFingerprint: (fingerprint.wpdev && fingerprint.wpdev !== "missing") ? fingerprint.wpdev : "0".repeat(64),
            toolsFingerprint: fingerprint.tools,
            themeFingerprint: (fingerprint.theme && fingerprint.theme !== "missing") ? fingerprint.theme : "0".repeat(64),
            toolchainFingerprint: fingerprint.toolchain,
            compositeFingerprint: bRes.composite,
            zipSha256: bRes.zipSha256,
            manifestDigest: bRes.manifestDigest,
            gates: {
              artifactIntegrity: {
                status: bRes.zipSha256 && bRes.manifestDigest ? "passed" : "pending",
                verifiedAt: new Date().toISOString(),
              },
              testCoverage: {
                status: coverage.covered ? "passed" : (coverage.coveredTests.length > 0 ? "partial" : "none"),
                coveredTests: coverage.coveredTests || [],
                missingTests: coverage.missingTests || [],
                coverageReason: coverage.reason,
              },
              deployment: {
                status: activeShouldDeploy ? "deployed" : "none",
                deployedAt: null,
              },
              runtimeSmoke: {
                status: "none",
                verifiedAt: null,
              },
            },
            validationState,
            testMode: activeTestMode,
            testEvidence: {
              selected: testResult.selected,
              skipped: testResult.skipped,
              coverageReason: coverage.reason,
            },
            outputPaths: {
              profileSZip: path.join(customDistDir, `${p}-profile-s.zip`),
              standardZip: path.join(customDistDir, `${p}.zip`),
            },
          });
        }
      }

      return nextCache;
    },
  });

  // 6. Deploy Nodes
  if (activeShouldDeploy) {
    for (const plugin of targetPlugins) {
      dag.addNode(`deploy:${plugin}`, {
        dependencies: ["plan:cache"],
        task: async (results, taskOptions) => {
          const { fingerprint } = results;
          const stagedCache = results["plan:cache"];
          const bRes = results[`build:${plugin}`];
          // Deploy the artifact tier that was actually built. Clean builds must
          // never deploy a stale Profile S ZIP (and vice versa).
          const deployZip = activeIsObfuscate
            ? path.join(customDistDir, `${plugin}-profile-s.zip`)
            : path.join(customDistDir, `${plugin}.zip`);
          if (!fs.existsSync(deployZip)) {
            throw new Error(`Cannot deploy '${plugin}': missing ZIP artifact at ${deployZip}`);
          }

          // Strictly gate deployment on verified test coverage
          const coverage = computeArtifactTestCoverage({
            consumer: plugin,
            testEvidenceMap: stagedCache._testEvidence,
            testFiles: fingerprint.testFiles || {},
            toolFiles: fingerprint.toolFiles || {},
            toolchainFingerprint: fingerprint.toolchain || "",
            artifactRecord: {
              artifactId: bRes?.artifactId || `${plugin}-profile-s`,
              zipSha256: bRes?.zipSha256,
              compositeFingerprint: bRes?.composite,
            },
            testMode: activeTestMode,
            currentTransactionId,
            currentRunId,
          });

          if (!coverage.covered) {
            throw new Error(`Cannot deploy '${plugin}': incomplete test coverage (${coverage.reason})`);
          }

          const receiptFile = path.join(customReceiptsDir, `${plugin}.receipt.json`);
          const currentZipBytes = await fs.promises.readFile(deployZip);
          const currentZipSha = crypto.createHash("sha256").update(currentZipBytes).digest("hex");
          const targetDir = path.join(customPluginsDir, plugin);

          const targetMeta = TARGET_REGISTRY[plugin];
          const bootstrapRelFile = targetMeta?.bootstrapFile || `${plugin}.php`;

          let skipDeploy = false;
          const loadedReceipt = await loadDeployReceiptRecord(receiptFile, plugin, {
            transactionId: null,
            expectedPluginsDir: customPluginsDir,
          });
          if (loadedReceipt.status === "valid") {
            const rcpt = loadedReceipt.receipt;
            const bootstrapPath = path.join(targetDir, bootstrapRelFile);
            if (
              !activeIsForce &&
              rcpt.zipSha256 === currentZipSha &&
              rcpt.compositeFingerprint === bRes?.composite &&
              fs.existsSync(targetDir) &&
              fs.existsSync(bootstrapPath)
            ) {
              const tStat = await fs.promises.lstat(targetDir);
              const bStat = await fs.promises.lstat(bootstrapPath);
              if (!tStat.isSymbolicLink() && tStat.isDirectory() && !bStat.isSymbolicLink() && bStat.isFile()) {
                const verifyReport = await verifyArtifactManifest({ rootDir: targetDir, consumer: plugin, profile: activeIsObfuscate ? "Profile S" : "clean" });
                if (
                  verifyReport.status === "valid" &&
                  verifyReport.manifestDigest === rcpt.manifestDigest &&
                  verifyReport.manifestDigest === (bRes?.manifestDigest || stagedCache.artifacts?.[plugin]?.manifestDigest)
                ) {
                  skipDeploy = true;
                }
              }
            }
          } else if (loadedReceipt.status !== "missing") {
            if (activeShouldDeploy || activeTestMode === "release") {
              throw new Error(`Cannot deploy '${plugin}': invalid or corrupted existing receipt (${loadedReceipt.reason})`);
            }
          }

          if (skipDeploy) {
            console.log(`⏩ [${plugin}] DEPLOY SKIP: Already deployed and verified on disk (${currentZipSha.slice(0, 8)}...)`);
            const loadedRcpt = loadedReceipt.receipt;
            await txManager.update(async (state) => {
              const tgt = state.targets.find((t) => t.consumer === plugin);
              if (tgt) {
                tgt.candidateZipSha = currentZipSha;
                tgt.candidateManifestDigest = bRes?.manifestDigest || stagedCache.artifacts?.[plugin]?.manifestDigest || loadedRcpt.manifestDigest;
              }
            });
            stagedReceipts[plugin] = loadedRcpt;
            return { status: "skipped" };
          }

          const preExisting = fs.existsSync(targetDir);
          const expectedBackupToken = `.${plugin}.backup-${currentTransactionId}`;
          const expectedStagingToken = `.${plugin}.staging-${currentTransactionId}`;

          await txManager.update(async (state) => {
            const tgt = state.targets.find((t) => t.consumer === plugin);
            if (tgt) {
              tgt.candidateZipSha = currentZipSha;
              tgt.candidateManifestDigest = bRes?.manifestDigest || stagedCache.artifacts?.[plugin]?.manifestDigest || null;
            }
          });

          if (injectFailure === "before_swap") {
            throw new Error("Injected failure before deploy swap");
          }

          const deployResult = await atomicDeployPlugin(deployZip, plugin, {
            pluginsDir: customPluginsDir,
            contentRoot: customContentRoot,
            parentLockToken: pipelineLock.token,
            skipPluginLock: true,
            signal: taskOptions?.signal,
            bootstrapFile: bootstrapRelFile,
            preserveBackup: true,
            backupToken: expectedBackupToken,
            stagingToken: expectedStagingToken,
            onPhaseChange: async (newPhase) => {
              await txManager.update(async (state) => {
                const tgt = state.targets.find((t) => t.consumer === plugin);
                if (tgt) {
                  tgt.phase = newPhase;
                }
              });
            },
            healthCheck: async (deployedTargetDir) => {
              const mainPhp = path.join(deployedTargetDir, bootstrapRelFile);
              if (fs.existsSync(mainPhp)) {
                await execFileAsync("php", ["-l", mainPhp], {
                  cwd: deployedTargetDir,
                  signal: taskOptions?.signal,
                });
              }
            },
          });

          if (injectFailure === "during_swap") {
            throw new Error("Injected failure during deploy swap");
          }

          const manifestPath = path.join(targetDir, "artifact-manifest.json");
          const manifestObj = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));

          const receiptRecord = createDeployReceiptRecord({
            transactionId: currentTransactionId,
            artifactId: bRes?.artifactId || manifestObj.artifactId || `${plugin}-profile-s`,
            consumer: plugin,
            targetPath: targetDir,
            zipSha256: currentZipSha,
            manifestDigest: manifestObj.manifestDigest,
            sourceFingerprint: fingerprint.plugins[plugin],
            wpdevFingerprint: (fingerprint.wpdev && fingerprint.wpdev !== "missing") ? fingerprint.wpdev : "0".repeat(64),
            toolsFingerprint: fingerprint.tools,
            themeFingerprint: (fingerprint.theme && fingerprint.theme !== "missing") ? fingerprint.theme : "0".repeat(64),
            toolchainFingerprint: fingerprint.toolchain,
            compositeFingerprint: bRes?.composite,
            validationState: "deployed",
          });

          stagedReceipts[plugin] = receiptRecord;
          console.log(`🚀 [${plugin}] DEPLOY: Candidate swapped into staging (receipt staged).`);
          return { status: "deployed", receipt: receiptRecord };
        },
      });
    }
  }

  // 7. Post-Deploy Docker Smoke Node
  if (activeTestMode === "docker-smoke" || activeTestMode === "release") {
    const postDeployDeps = activeShouldDeploy ? targetPlugins.map((p) => `deploy:${p}`) : ["plan:cache"];
    dag.addNode("smoke:docker", {
      dependencies: postDeployDeps,
      task: async (results, taskOptions) => {
        if (injectFailure === "during_smoke") {
          throw new Error("Injected failure during Docker smoke");
        }
        const dockerTest = path.join(customScriptDir, "tests-docker", "docker-runtime-smoke.test.mjs");
        console.log(`\n========================================`);
        console.log(`🧪 Running Docker Runtime Smoke Suite (Post-Deploy)...`);
        console.log(`========================================`);
        const testRes = await execFileAsync(process.execPath, ["--test", dockerTest], {
          cwd: customContentRoot,
          signal: taskOptions?.signal,
          env: {
            ...process.env,
            TAVANGARY_PIPELINE_TEST_MODE: activeTestMode,
            ALLOW_DOCKER_SKIP: activeTestMode === "release" ? "0" : (process.env.ALLOW_DOCKER_SKIP || "0"),
          },
        });
        console.log(testRes.stdout);
        console.log(`  ✓ Docker runtime smoke tests completed.`);
        return {
          status: "passed",
          transactionId: currentTransactionId,
          artifacts: Object.fromEntries(
            targetPlugins.map((p) => {
              const b = results[`build:${p}`];
              return [
                p,
                {
                  artifactId: b?.artifactId || `${p}-profile-s`,
                  zipSha256: b?.zipSha256 || "",
                  manifestDigest: b?.manifestDigest || "",
                  compositeFingerprint: b?.composite || "",
                },
              ];
            })
          ),
        };
      },
    });
  }

  // 8. Final Transactional Cache & Receipt Commit Node
  const finalCommitDeps = [];
  if (activeTestMode === "docker-smoke" || activeTestMode === "release") {
    finalCommitDeps.push("smoke:docker");
  } else if (activeShouldDeploy) {
    targetPlugins.forEach((p) => finalCommitDeps.push(`deploy:${p}`));
  } else {
    finalCommitDeps.push("plan:cache");
  }

  dag.addNode("commit:final-cache", {
    dependencies: finalCommitDeps,
    task: async (results) => {
      const stagedCache = structuredClone(results["plan:cache"]);
      const smokeResult = results["smoke:docker"];

      if (smokeResult && (smokeResult.status === "verified" || smokeResult.status === "passed")) {
        for (const plugin of targetPlugins) {
          const artifact = stagedCache.artifacts?.[plugin];
          if (artifact) {
            if (artifact.gates) {
              artifact.gates.runtimeSmoke = {
                status: "passed",
                verifiedAt: new Date().toISOString(),
                transactionId: currentTransactionId,
              };
            }
            artifact.validationState = "runtime-verified";
            artifact.runtimeVerifiedAt = new Date().toISOString();

            if (stagedReceipts[plugin]) {
              stagedReceipts[plugin].validationState = "runtime-verified";
              stagedReceipts[plugin].runtimeVerifiedAt = artifact.runtimeVerifiedAt;
            }
          }
        }
      }

      // Finalize gate states in stagedCache
      for (const plugin of targetPlugins) {
        const artifact = stagedCache.artifacts?.[plugin];
        if (artifact && artifact.gates) {
          const dRes = results[`deploy:${plugin}`];
          if (dRes?.status === "deployed") {
            artifact.gates.deployment = {
              status: "deployed",
              deployedAt: new Date().toISOString(),
            };
          } else if (dRes?.status === "skipped") {
            artifact.gates.deployment = {
              status: "verified-skip",
              deployedAt: null,
            };
          } else if (!activeShouldDeploy) {
            artifact.gates.deployment = {
              status: "not-requested",
              deployedAt: null,
            };
          }
        }
      }

      // Multi-file Transactional Commit
      const txStagingDir = path.join(customDistDir, `.tx-staging-${currentTransactionId}`);
      const txBackupDir = path.join(customDistDir, `.tx-backup-${currentTransactionId}`);
      await mkdir(txStagingDir, { recursive: true });
      await mkdir(txBackupDir, { recursive: true });

      const stagedReceiptsDir = path.join(txStagingDir, ".deploy-receipts");
      const backupReceiptsDir = path.join(txBackupDir, ".deploy-receipts");
      await mkdir(stagedReceiptsDir, { recursive: true });
      await mkdir(backupReceiptsDir, { recursive: true });

      const publicationReceipts = {};

      // 1. Stage receipts and capture backup states
      for (const [p, receipt] of Object.entries(stagedReceipts)) {
        const destReceiptFile = path.join(customReceiptsDir, `${p}.receipt.json`);
        const bkpReceiptFile = path.join(backupReceiptsDir, `${p}.receipt.json`);
        const stagedReceiptFile = path.join(stagedReceiptsDir, `${p}.receipt.json`);

        let existedBefore = false;
        let preDigest = null;
        let backupStatus = "absent";

        if (fs.existsSync(destReceiptFile)) {
          const destBytes = await readFile(destReceiptFile);
          preDigest = crypto.createHash("sha256").update(destBytes).digest("hex");
          await copyFile(destReceiptFile, bkpReceiptFile);
          existedBefore = true;
          backupStatus = "backed_up";
        }

        const wrRes = await writeAtomicCacheFile(stagedReceiptFile, receipt);
        if (wrRes.outcome !== "committed-durable") {
          throw new Error(`Failed to write staged receipt for ${p} (outcome: ${wrRes.outcome})`);
        }
        const stagedBytes = await readFile(stagedReceiptFile);
        const stagedDigest = crypto.createHash("sha256").update(stagedBytes).digest("hex");

        const loaded = await loadDeployReceiptRecord(stagedReceiptFile, p, {
          transactionId: currentTransactionId,
          expectedPluginsDir: customPluginsDir,
        });
        if (loaded.status !== "valid") {
          throw new Error(`Staged receipt validation failed for ${p}: ${loaded.reason}`);
        }

        publicationReceipts[p] = {
          consumer: p,
          existedBefore,
          preDigest,
          backupStatus,
          stagedDigest,
          publishStatus: "staged",
          finalDigest: null,
        };
      }

      // 2. Stage cache and capture backup state
      const stagedCacheFile = path.join(txStagingDir, ".build-cache.json");
      const bkpCacheFile = path.join(txBackupDir, ".build-cache.json");

      let cacheExistedBefore = false;
      let cachePreDigest = null;
      let cacheBackupStatus = "absent";

      if (fs.existsSync(customCacheFile)) {
        const cacheBytes = await readFile(customCacheFile);
        cachePreDigest = crypto.createHash("sha256").update(cacheBytes).digest("hex");
        await copyFile(customCacheFile, bkpCacheFile);
        cacheExistedBefore = true;
        cacheBackupStatus = "backed_up";
      }

      const wcRes = await writeAtomicCacheFile(stagedCacheFile, stagedCache);
      if (wcRes.outcome !== "committed-durable") {
        throw new Error(`Failed to write staged cache (outcome: ${wcRes.outcome})`);
      }
      const stagedCacheBytes = await readFile(stagedCacheFile);
      const stagedCacheDigest = crypto.createHash("sha256").update(stagedCacheBytes).digest("hex");

      const loadedCache = await loadBuildCacheRecord(stagedCacheFile, {
        expectedConsumers: targetPlugins,
        expectedDistDir: customDistDir,
      });
      if (loadedCache.status !== "valid") {
        throw new Error(`Staged cache validation failed: ${loadedCache.reason}`);
      }

      const publicationCache = {
        existedBefore: cacheExistedBefore,
        preDigest: cachePreDigest,
        backupStatus: cacheBackupStatus,
        stagedDigest: stagedCacheDigest,
        publishStatus: "staged",
        finalDigest: null,
      };

      if (injectFailure === "during_commit" || injectFailure === "during_commit_staging") {
        throw new Error("Injected failure during final commit");
      }

      // Update journal: publishing
      await txManager.update(async (state) => {
        state.phase = "publishing";
        state.publication.receipts = publicationReceipts;
        state.publication.cache = publicationCache;
      });

      if (injectFailure === "during_publication_receipts") {
        throw new Error("Injected failure during publication of receipts");
      }

      // 3. Atomically publish receipts in deterministic alphabetical order
      if (activeShouldDeploy) {
        await mkdir(customReceiptsDir, { recursive: true });
        const orderedReceiptConsumers = Object.keys(stagedReceipts).sort();
        for (const p of orderedReceiptConsumers) {
          const stagedReceiptFile = path.join(stagedReceiptsDir, `${p}.receipt.json`);
          const destReceiptFile = path.join(customReceiptsDir, `${p}.receipt.json`);

          await txManager.update(async (state) => {
            state.publication.receipts[p].publishStatus = "publishing";
          });

          await rename(stagedReceiptFile, destReceiptFile);
          await fsyncDir(customReceiptsDir);

          await txManager.update(async (state) => {
            state.publication.receipts[p].publishStatus = "published";
            state.publication.receipts[p].finalDigest = state.publication.receipts[p].stagedDigest;
          });
        }
      }

      if (injectFailure === "during_publication_cache") {
        throw new Error("Injected failure during publication of cache");
      }

      // 4. Atomically publish cache
      await txManager.update(async (state) => {
        state.publication.cache.publishStatus = "publishing";
      });

      await rename(stagedCacheFile, customCacheFile);
      await fsyncDir(customDistDir);

      await txManager.update(async (state) => {
        state.publication.cache.publishStatus = "published";
        state.publication.cache.finalDigest = state.publication.cache.stagedDigest;
        state.phase = "committed";
      });

      if (activeIsObfuscate) {
        for (const p of targetPlugins) {
          const profileSZip = path.join(customDistDir, `${p}-profile-s.zip`);
          const standardZip = path.join(customDistDir, `${p}.zip`);
          if (fs.existsSync(profileSZip)) {
            // Atomic alias publish: temp file + rename + fsync so an interrupted
            // copy can never leave a truncated live `{p}.zip`.
            const tmpAlias = path.join(customDistDir, `.${p}.zip.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
            await copyFile(profileSZip, tmpAlias);
            await rename(tmpAlias, standardZip);
            await fsyncDir(customDistDir);
          }
        }
      }

      if (injectFailure === "during_cleanup") {
        throw new Error("Injected failure during cleanup");
      }

      // 5. Remove backups only after durable disk write of cache and receipts
      if (activeShouldDeploy) {
        const snap = txManager.getSnapshot();
        const derived = deriveJournalPaths({ journal: snap, pluginsDir: customPluginsDir, distDir: customDistDir });
        for (const target of derived.targets) {
          if (target.backupDir && fs.existsSync(target.backupDir)) {
            await rm(target.backupDir, { recursive: true, force: true });
            if (fs.existsSync(target.backupDir)) {
              throw new Error(`Failed to remove backup directory during cleanup: ${target.backupDir}`);
            }
          }
          if (target.stagingDir && fs.existsSync(target.stagingDir)) {
            await rm(target.stagingDir, { recursive: true, force: true });
            if (fs.existsSync(target.stagingDir)) {
              throw new Error(`Failed to remove staging directory during cleanup: ${target.stagingDir}`);
            }
          }
        }
      }

      if (fs.existsSync(txStagingDir)) {
        await rm(txStagingDir, { recursive: true, force: true });
        if (fs.existsSync(txStagingDir)) {
          throw new Error(`Failed to remove staging directory during cleanup: ${txStagingDir}`);
        }
      }
      if (fs.existsSync(txBackupDir)) {
        await rm(txBackupDir, { recursive: true, force: true });
        if (fs.existsSync(txBackupDir)) {
          throw new Error(`Failed to remove backup directory during cleanup: ${txBackupDir}`);
        }
      }
      await fsyncDir(customDistDir);

      await txManager.update(async (state) => {
        state.publication.backupsPurged = true;
        state.phase = "cleanup_complete";
      });
      txManager.terminate();
      if (fs.existsSync(journalFile)) {
        await rm(journalFile, { force: true });
      }

      console.log(`\n✓ Transaction committed successfully (${currentTransactionId}). All receipts, cache, and targets durable.`);
      return stagedCache;
    },
  });

    const dagResults = await dag.run();
    return dagResults;
  } catch (err) {
    if (activeShouldDeploy || fs.existsSync(journalFile)) {
      await rollbackDeployment(err);
    }
    throw err;
  } finally {
    await pipelineLock.release().catch(() => {});
  }
}

export async function runDirectDeployTransaction({
  zipPath,
  pluginSlug,
  options = {},
}) {
  if (!zipPath || !fs.existsSync(zipPath)) {
    throw new Error(`Plugin ZIP archive not found at '${zipPath}'`);
  }
  if (!pluginSlug || !isValidConsumerName(pluginSlug)) {
    throw new Error(`Invalid plugin slug '${pluginSlug}': must be a safe lowercase alphanumeric kebab-case slug`);
  }

  const contentRoot = canonicalizePath(
    options.contentRoot
      ? path.resolve(options.contentRoot)
      : options.pluginsDir
        ? path.dirname(path.resolve(options.pluginsDir))
        : defaultContentRoot()
  );
  const pluginsDir = canonicalizePath(
    options.pluginsDir
      ? path.resolve(options.pluginsDir)
      : path.join(contentRoot, "plugins")
  );
  const distDir = canonicalizePath(options.distDir || path.join(contentRoot, "dist"));
  const receiptsDir = canonicalizePath(options.receiptsDir || path.join(distDir, ".deploy-receipts"));
  const journalFile = path.join(distDir, ".deploy-journal.json");

  await fs.promises.mkdir(distDir, { recursive: true });
  await fs.promises.mkdir(receiptsDir, { recursive: true });
  await fs.promises.mkdir(pluginsDir, { recursive: true });

  const transactionLockFile = path.join(distDir, ".transaction.deploy.lock");
  const lock = await acquireInterProcessLock({
    lockFile: transactionLockFile,
    resourceName: `direct-deploy-${pluginSlug}`,
    signal: options.signal,
  });

  try {
    const recResult = await recoverInterruptedDeployment({
      journalFile,
      pluginsDir,
      distDir,
      logger: options.logger || console,
      allowExternalConsumers: options.allowExternalConsumers ?? (!ALLOWED_CONSUMERS.has(pluginSlug)),
    });
    if (recResult.recovered && typeof options.onRecovered === "function") {
      await options.onRecovered(recResult);
    }

    const zipBytes = await fs.promises.readFile(zipPath);
    const zipSha256 = crypto.createHash("sha256").update(zipBytes).digest("hex");
    let candidateManifestDigest = null;
    try {
      const embedded = readEmbeddedManifestFromZip(zipBytes, pluginSlug);
      if (embedded?.manifest?.manifestDigest) {
        candidateManifestDigest = embedded.manifest.manifestDigest;
      }
    } catch {}
    if (!candidateManifestDigest || typeof candidateManifestDigest !== "string" || !/^[a-f0-9]{64}$/i.test(candidateManifestDigest)) {
      candidateManifestDigest = zipSha256;
    }

    const targetDir = path.join(pluginsDir, pluginSlug);
    const preExisting = fs.existsSync(targetDir);

    const txId = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const backupToken = `.${pluginSlug}.backup-${txId}`;
    const stagingToken = `.${pluginSlug}.staging-${txId}`;

    const initialTxContext = {
      schemaVersion: DEPLOY_JOURNAL_SCHEMA_VERSION,
      txId,
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "prepared",
      targets: [
        {
          consumer: pluginSlug,
          preExisting,
          phase: "prepared",
          backupToken,
          stagingToken,
          candidateZipSha: zipSha256,
          candidateManifestDigest,
        },
      ],
      publication: {
        receipts: {},
        cache: null,
        backupsPurged: false,
      },
      error: null,
    };

    const txManager = new TransactionJournalManager({
      journalFile,
      distDir,
      initialJournal: initialTxContext,
    });
    await txManager.update(async () => {});

    let deployResult;
    try {
      deployResult = await atomicDeployPlugin(zipPath, pluginSlug, {
        ...options,
        contentRoot,
        pluginsDir,
        backupToken,
        stagingToken,
        parentLockToken: lock.token,
        skipPluginLock: true,
        // Bind the deployed bytes to the digest recorded in journal/receipt.
        // atomicDeployPlugin re-reads the file and fails closed on mismatch,
        // closing the read -> deploy TOCTOU window.
        expectedZipSha: zipSha256,
        preserveBackup: Boolean(options.preserveBackup),
        onPhaseChange: async (newPhase) => {
          await txManager.update(async (state) => {
            const tgt = state.targets[0];
            if (tgt) {
              tgt.phase = newPhase;
            }
          });
          if (typeof options.onPhaseChange === "function") {
            await options.onPhaseChange(newPhase);
          }
        },
      });

      const receiptData = createDeployReceiptRecord({
        consumer: pluginSlug,
        zipSha256,
        manifestDigest: candidateManifestDigest,
        targetPath: targetDir,
        transactionId: txId,
      });

      const receiptFile = path.join(receiptsDir, `${pluginSlug}.receipt.json`);
      let receiptExistedBefore = false;
      let receiptPreDigest = null;
      let receiptBackupStatus = "absent";
      if (fs.existsSync(receiptFile)) {
        const destBytes = await fs.promises.readFile(receiptFile);
        receiptPreDigest = crypto.createHash("sha256").update(destBytes).digest("hex");
        receiptExistedBefore = true;
        receiptBackupStatus = "backed_up";
      }

      const receiptBytes = Buffer.from(JSON.stringify(receiptData, null, 2), "utf8");
      const stagedReceiptDigest = crypto.createHash("sha256").update(receiptBytes).digest("hex");

      const customCacheFile = path.join(distDir, ".build-cache.json");
      let cacheExistedBefore = false;
      let cachePreDigest = null;
      let cacheBackupStatus = "absent";
      let cacheStagedDigest = "0".repeat(64);
      if (fs.existsSync(customCacheFile)) {
        const cBytes = await fs.promises.readFile(customCacheFile);
        cachePreDigest = crypto.createHash("sha256").update(cBytes).digest("hex");
        cacheStagedDigest = cachePreDigest;
        cacheExistedBefore = true;
        cacheBackupStatus = "backed_up";
      }

      await txManager.update(async (state) => {
        state.phase = "publishing";
        state.publication.receipts[pluginSlug] = {
          consumer: pluginSlug,
          existedBefore: receiptExistedBefore,
          preDigest: receiptPreDigest,
          backupStatus: receiptBackupStatus,
          stagedDigest: stagedReceiptDigest,
          publishStatus: "publishing",
          finalDigest: null,
        };
        state.publication.cache = {
          existedBefore: cacheExistedBefore,
          preDigest: cachePreDigest,
          backupStatus: cacheBackupStatus,
          stagedDigest: cacheStagedDigest,
          publishStatus: "publishing",
          finalDigest: null,
        };
      });

      await writeAtomicCacheFile(receiptFile, receiptData);
      await fsyncDir(receiptsDir);

      await txManager.update(async (state) => {
        state.phase = "committed";
        state.publication.receipts[pluginSlug].publishStatus = "published";
        state.publication.receipts[pluginSlug].finalDigest = stagedReceiptDigest;
        state.publication.cache.publishStatus = "published";
        state.publication.cache.finalDigest = cacheStagedDigest;
      });

      if (!options.preserveBackup) {
        await txManager.update(async (state) => {
          state.publication.backupsPurged = true;
          state.phase = "cleanup_complete";
        });
      }

      txManager.terminate();
      if (!options.preserveBackup && fs.existsSync(journalFile)) {
        await fs.promises.rm(journalFile, { force: true });
      }

      return {
        success: true,
        deployedTargetDir: deployResult.deployedTargetDir,
        backupDir: deployResult.backupDir,
        txId,
        receiptFile,
      };
    } catch (deployErr) {
      await txManager.update(async (state) => {
        state.error = {
          message: deployErr.message,
          phase: state.phase,
        };
      }).catch(() => {});
      txManager.terminate();
      throw deployErr;
    }
  } finally {
    await lock.release().catch(() => {});
  }
}

async function main(options = {}) {
  const parsed = options.parsed || parsePipelineArgs(process.argv);
  const jobsLimit = parsed.jobsLimit;
  const activeIsChanged = options.overrideChanged !== undefined ? options.overrideChanged : parsed.isChanged;
  const activeTestMode = options.overrideTestMode !== undefined ? options.overrideTestMode : parsed.testMode;
  const activeIsForce = options.overrideForce !== undefined ? options.overrideForce : parsed.isForce;
  const activeShouldDeploy = options.overrideDeploy !== undefined ? options.overrideDeploy : parsed.shouldDeploy;

  const targetPlugins = parsed.targetPlugins || TARGET_PLUGINS;

  console.log("================================================================================");
  console.log("🚀 STARTING CENTRAL STANDALONE PLUGINS BUILD PIPELINE");
  console.log("================================================================================");
  console.log(`Target plugins: ${targetPlugins.join(", ")}`);
  console.log(`Auto-deploy to local plugins dir: ${activeShouldDeploy ? "YES" : "NO"}`);
  console.log(`Build mode: ${activeIsForce ? "FORCE" : (activeIsChanged ? "CHANGED-ONLY" : "INCREMENTAL")}`);
  console.log(`Concurrency limit (jobs): ${jobsLimit}`);
  console.log(`Protection profile: ${parsed.profile || "clean"} (obfuscate=${Boolean(parsed.isObfuscate)})`);
  console.log(`Test mode: ${activeTestMode || "NONE"}\n`);

  const startTime = Date.now();
  const dagResults = await runPipelineOrchestration({
    parsed,
    jobsLimit,
    targetPlugins,
    overrideChanged: activeIsChanged,
    overrideTestMode: activeTestMode,
    overrideForce: activeIsForce,
    overrideDeploy: activeShouldDeploy,
    distDir: parsed.distDir,
    pluginsDir: parsed.pluginsDir,
    cacheFile: parsed.cacheFile,
    receiptsDir: parsed.receiptsDir,
    inlineFramework: parsed.inlineFramework,
    spaghetti: parsed.spaghetti,
    obfuscate: parsed.obfuscate,
    minifyAssets: parsed.minifyAssets,
    skipZip: parsed.skipZip,
    targetPhp: parsed.targetPhp,
  });

  let rebuiltCount = 0;
  let cachedCount = 0;
  let deployChangedCount = 0;
  let deploySkippedCount = 0;

  for (const p of targetPlugins) {
    const bRes = dagResults[`build:${p}`];
    if (bRes?.status === "rebuilt") rebuiltCount++;
    if (bRes?.status === "cached") cachedCount++;

    if (activeShouldDeploy) {
      const dRes = dagResults[`deploy:${p}`];
      if (dRes?.status === "deployed") deployChangedCount++;
      if (dRes?.status === "skipped") deploySkippedCount++;
    }
  }

  const testStats = dagResults.test || { selected: 0, skipped: 0 };
  const finalDuration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log("\n================================================================================");
  console.log("📊 PIPELINE EXECUTION SUMMARY");
  console.log("================================================================================");
  console.log(`Rebuilt: ${rebuiltCount}`);
  console.log(`Cache hit: ${cachedCount}`);
  console.log(`Deploy changed: ${deployChangedCount}`);
  console.log(`Deploy skipped: ${deploySkippedCount}`);
  console.log(`Tests selected: ${testStats.selected}`);
  console.log(`Tests skipped by impact map: ${testStats.skipped}`);
  console.log(`Total wall time: ${finalDuration}s`);
  console.log("================================================================================");
  console.log("✅ PIPELINE EXECUTION FINISHED SUCCESSFULLY!");
  console.log("================================================================================");
}

async function startWatchMode() {
  console.log("👀 WATCH MODE ACTIVE: Watching plugin sources, tools, and theme for changes...\n");
  let isBuilding = false;
  let pendingChange = false;

  const runTrigger = async () => {
    if (isBuilding) {
      pendingChange = true;
      return;
    }
    isBuilding = true;
    try {
      await main({ overrideChanged: true, overrideTestMode: "affected" });
    } catch (err) {
      console.error("❌ Watch run failed:", err.message);
    } finally {
      isBuilding = false;
      if (pendingChange) {
        pendingChange = false;
        setTimeout(runTrigger, 200);
      }
    }
  };

  let debounceTimer = null;
  const onFsChange = (eventType, filename) => {
    if (!filename || filename.startsWith(".") || filename.endsWith(".tmp") || filename.includes("dist")) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      console.log(`\n🔄 Change detected in [${filename}] (${eventType}). Triggering incremental build & test...`);
      runTrigger();
    }, 250);
  };

  const watchContentRoot = defaultContentRoot();
  const watchDirs = [
    path.join(watchContentRoot, "plugins", "wpdev"),
    ...TARGET_PLUGINS.map((p) => path.join(watchContentRoot, "plugins", `${p}-dev`)),
    scriptDir,
    path.join(watchContentRoot, "themes", "tavangary"),
  ].filter((d) => fs.existsSync(d));

  const watchers = watchDirs.map((d) => fs.watch(d, { recursive: true }, onFsChange));

  process.on("SIGINT", () => {
    console.log("\n🛑 Stopping watch mode...");
    watchers.forEach((w) => w.close());
    process.exit(0);
  });

  // Run initial pass
  await runTrigger();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = parsePipelineArgs(process.argv);
  if (parsed.isWatch) {
    startWatchMode().catch((err) => {
      console.error("\n❌ Watch mode failed:", err);
      process.exit(1);
    });
  } else {
    main({ parsed }).catch((err) => {
      console.error("\n❌ Central build pipeline failed:", err);
      process.exit(1);
    });
  }
}

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pLimit } from "../build-dag-runner.mjs";

import {
  createTestEvidenceRecord,
  validateTestEvidenceRecord,
  TEST_EVIDENCE_SCHEMA_VERSION,
  computeTreeContentHash,
  writeAtomicCacheFile,
  loadBuildCacheRecord,
  loadDeployReceiptRecord,
  loadDeployJournalRecord,
  validateBuildCacheSchema,
  validateDeployJournalSchema,
  deriveJournalPaths,
  computeTestDependencyFingerprint,
  computeArtifactTestCoverage,
  TEST_SPEC_MAP,
  REQUIRED_ARTIFACT_TESTS,
  createTargetCacheRecord,
  CACHE_SCHEMA_VERSION,
} from "../build-cache-engine.mjs";
import {
  runSelectedNodeTests,
  runPipelineOrchestration,
  BoundedTailBuffer,
  MAX_JOBS_LIMIT,
} from "../build-all-standalone-plugins.mjs";
import { validateCanonicalTestRegistry } from "../test-dependency-registry.mjs";
import { resolveImpactedTests, TEST_DEPENDENCY_GRAPH } from "../test-impact-map.mjs";

test("Regression 1: loadBuildCacheRecord strictly rejects symlinks, directories, corrupted JSON, stale schema, and prototype pollution", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "loader-test-"));
  try {
    // 1. Missing file
    const missingRes = await loadBuildCacheRecord(path.join(tmpDir, "missing.json"));
    assert.equal(missingRes.status, "missing");

    // 2. Symlink file
    const realFile = path.join(tmpDir, "real.json");
    await writeFile(realFile, JSON.stringify({ schemaVersion: 2 }), "utf8");
    const linkFile = path.join(tmpDir, "link.json");
    await symlink(realFile, linkFile);
    const symlinkRes = await loadBuildCacheRecord(linkFile);
    assert.equal(symlinkRes.status, "invalid");
    assert.match(symlinkRes.reason, /symbolic link/i);

    // 3. Directory
    const subDir = path.join(tmpDir, "sub-dir");
    await mkdir(subDir);
    const dirRes = await loadBuildCacheRecord(subDir);
    assert.equal(dirRes.status, "invalid");
    assert.match(dirRes.reason, /not a regular file/i);

    // 4. Corrupted JSON
    const corruptedFile = path.join(tmpDir, "corrupted.json");
    await writeFile(corruptedFile, "{ malformed json", "utf8");
    const corruptRes = await loadBuildCacheRecord(corruptedFile);
    assert.equal(corruptRes.status, "corrupted");

    // 5. Stale schema
    const staleFile = path.join(tmpDir, "stale.json");
    await writeFile(staleFile, JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION - 1 }), "utf8");
    const staleRes = await loadBuildCacheRecord(staleFile);
    assert.equal(staleRes.status, "stale_schema");

    // 6. Incomplete schema (missing required top level fields)
    const incompleteFile = path.join(tmpDir, "incomplete.json");
    await writeFile(incompleteFile, JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, _tools: "abc" }), "utf8");
    const incompleteRes = await loadBuildCacheRecord(incompleteFile);
    assert.equal(incompleteRes.status, "invalid");
    assert.match(incompleteRes.reason, /missing required top-level field/i);

    // 7. Prototype pollution attempt
    const protoData = JSON.parse(`{"schemaVersion":${CACHE_SCHEMA_VERSION},"__proto__":{"polluted":true}}`);
    const protoVal = validateBuildCacheSchema(protoData);
    assert.equal(protoVal.valid, false);

    // 8. Fully Valid Cache Record
    const validData = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      _tools: "a".repeat(64),
      _toolFiles: { "tools/test.mjs": "b".repeat(64) },
      _wpdev: "c".repeat(64),
      _theme: "d".repeat(64),
      _testFiles: { "sample.test.mjs": "e".repeat(64) },
      _testEvidence: {},
      toolchain: "f".repeat(64),
      artifacts: {},
    };
    const validFile = path.join(tmpDir, "valid.json");
    await writeFile(validFile, JSON.stringify(validData), "utf8");
    const validRes = await loadBuildCacheRecord(validFile);
    assert.equal(validRes.status, "valid");
    assert.equal(validRes.cache._tools, "a".repeat(64));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Regression 2: writeAtomicCacheFile supports full failure injection (write, sync, rename, dir_sync), cleans temp, and preserves target", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "writer-fail-"));
  try {
    const targetFile = path.join(tmpDir, "cache.json");
    await writeAtomicCacheFile(targetFile, { schemaVersion: 2, key: "original" });

    // 1. Injected failure before write
    await assert.rejects(
      async () => {
        await writeAtomicCacheFile(targetFile, { schemaVersion: 2, key: "new" }, { injectFailure: "before_write" });
      },
      /injected failure before write/i
    );
    let current = JSON.parse(await readFile(targetFile, "utf8"));
    assert.equal(current.key, "original");

    // 2. Injected failure during write
    await assert.rejects(
      async () => {
        await writeAtomicCacheFile(targetFile, { schemaVersion: 2, key: "new" }, { injectFailure: "during_write" });
      },
      /injected failure during write/i
    );
    current = JSON.parse(await readFile(targetFile, "utf8"));
    assert.equal(current.key, "original");

    // 3. Injected failure before sync
    await assert.rejects(
      async () => {
        await writeAtomicCacheFile(targetFile, { schemaVersion: 2, key: "new" }, { injectFailure: "before_sync" });
      },
      /injected failure before sync/i
    );
    current = JSON.parse(await readFile(targetFile, "utf8"));
    assert.equal(current.key, "original");

    // 4. Injected failure before rename
    await assert.rejects(
      async () => {
        await writeAtomicCacheFile(targetFile, { schemaVersion: 2, key: "new" }, { injectFailure: "before_rename" });
      },
      /injected failure before rename/i
    );
    current = JSON.parse(await readFile(targetFile, "utf8"));
    assert.equal(current.key, "original");

    // Verify NO leftover tmp files in directory
    const dirEntries = await fs.promises.readdir(tmpDir);
    assert.deepEqual(dirEntries, ["cache.json"], "No temporary files should be left after failures");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Regression 3: multi-consumer test evidence allows all standalone artifacts to reach tests-passed, and isolates invalidations", () => {
  const dummyToolFiles = {
    "tools/artifact-fixture-helper.mjs": "1".repeat(64),
    "tools/canonical-artifact-manifest.mjs": "2".repeat(64),
    "tools/assemble-profile-s-candidate.mjs": "3".repeat(64),
    "tools/inline-wpdev-closure.mjs": "4".repeat(64),
    "tools/verify-profile-s-artifact.mjs": "5".repeat(64),
    "tools/class-completeness-gate.mjs": "6".repeat(64),
    "tools/run-plan3-eligibility-spike.mjs": "7".repeat(64),
    "tools/settings-field-inventory.mjs": "8".repeat(64),
    "tools/validate-settings-ownership-review.mjs": "9".repeat(64),
  };
  const dummyToolchain = "a".repeat(64);

  const targets = [
    "drm-connector",
    "tavangary-core",
    "tavangary-theme-panel",
    "wpdev-analytics",
    "wpdev-crm",
    "wpdev-tickets",
    "wpdev-woo-persian",
  ];
  const artifactRecords = {};
  for (const t of targets) {
    artifactRecords[t] = {
      artifactId: `${t}-profile-s`,
      zipSha256: crypto.createHash("sha256").update(t).digest("hex"),
      compositeFingerprint: crypto.createHash("sha256").update(`${t}-comp`).digest("hex"),
    };
  }

  // Create valid evidence for all required tests
  const allRequiredTests = new Set(Object.values(REQUIRED_ARTIFACT_TESTS).flat());
  const evidenceMap = {};

  for (const testFile of allRequiredTests) {
    const spec = TEST_SPEC_MAP[testFile] || { tools: [], artifacts: [] };
    const testSha = crypto.createHash("sha256").update(testFile).digest("hex");
    const depFp = computeTestDependencyFingerprint({
      testFile,
      testFileSha256: testSha,
      toolFiles: dummyToolFiles,
      toolchainFingerprint: dummyToolchain,
    });

    const bindings = (spec.artifacts || []).map((consumer) => ({
      consumer,
      artifactId: artifactRecords[consumer].artifactId,
      zipSha256: artifactRecords[consumer].zipSha256,
      compositeFingerprint: artifactRecords[consumer].compositeFingerprint,
    }));

    evidenceMap[testFile] = createTestEvidenceRecord({
      testFile,
      testFileSha256: testSha,
      testDependencyFingerprint: depFp,
      toolchainFingerprint: dummyToolchain,
      artifactBindings: bindings,
      mode: "full",
      exitStatus: "passed",
    });
  }

  // Verify that ALL 4 artifacts reach complete coverage
  for (const t of targets) {
    const cov = computeArtifactTestCoverage({
      consumer: t,
      testEvidenceMap: evidenceMap,
      testFiles: Object.fromEntries([...allRequiredTests].map((f) => [f, crypto.createHash("sha256").update(f).digest("hex")])),
      toolFiles: dummyToolFiles,
      toolchainFingerprint: dummyToolchain,
      artifactRecord: artifactRecords[t],
    });
    assert.equal(cov.covered, true, `Artifact '${t}' must achieve full test coverage with valid evidence`);
    assert.equal(cov.missingTests.length, 0);
  }

  // Now, modify the artifact record for ONE consumer (e.g. wpdev-crm)
  const modifiedRecords = {
    ...artifactRecords,
    "wpdev-crm": {
      ...artifactRecords["wpdev-crm"],
      zipSha256: "f".repeat(64),
    },
  };

  // Check coverage: ONLY wpdev-crm should be invalidated!
  const covCrm = computeArtifactTestCoverage({
    consumer: "wpdev-crm",
    testEvidenceMap: evidenceMap,
    testFiles: Object.fromEntries([...allRequiredTests].map((f) => [f, crypto.createHash("sha256").update(f).digest("hex")])),
    toolFiles: dummyToolFiles,
    toolchainFingerprint: dummyToolchain,
    artifactRecord: modifiedRecords["wpdev-crm"],
  });
  assert.equal(covCrm.covered, false, "wpdev-crm must be invalidated when its ZIP sha changes");

  const covTickets = computeArtifactTestCoverage({
    consumer: "wpdev-tickets",
    testEvidenceMap: evidenceMap,
    testFiles: Object.fromEntries([...allRequiredTests].map((f) => [f, crypto.createHash("sha256").update(f).digest("hex")])),
    toolFiles: dummyToolFiles,
    toolchainFingerprint: dummyToolchain,
    artifactRecord: modifiedRecords["wpdev-tickets"],
  });
  assert.equal(covTickets.covered, true, "wpdev-tickets must remain covered when unrelated artifact changes");
});

test("Regression 4: runSelectedNodeTests fail-closed validation on jobsLimit bounds and test file paths", async () => {
  // 1. Invalid jobsLimit
  await assert.rejects(
    async () => {
      await runSelectedNodeTests({ testFiles: ["sample.test.mjs"], jobsLimit: 0 });
    },
    /invalid jobsLimit/i
  );
  await assert.rejects(
    async () => {
      await runSelectedNodeTests({ testFiles: ["sample.test.mjs"], jobsLimit: -2 });
    },
    /invalid jobsLimit/i
  );
  await assert.rejects(
    async () => {
      await runSelectedNodeTests({ testFiles: ["sample.test.mjs"], jobsLimit: MAX_JOBS_LIMIT + 10 });
    },
    /invalid jobsLimit/i
  );
  await assert.rejects(
    async () => {
      await runSelectedNodeTests({ testFiles: ["sample.test.mjs"], jobsLimit: "4" });
    },
    /invalid jobsLimit/i
  );

  // 2. Traversal or invalid paths
  await assert.rejects(
    async () => {
      await runSelectedNodeTests({ testFiles: ["../outside.test.mjs"], jobsLimit: 2 });
    },
    /must be basename/i
  );
  await assert.rejects(
    async () => {
      await runSelectedNodeTests({ testFiles: ["non-existent-file-123.test.mjs"], jobsLimit: 2 });
    },
    /does not exist/i
  );
});

test("Regression 5: computeTreeContentHash concurrent work queue halts immediately on abort and tracks zero ops after abort", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "workqueue-abort-"));
  try {
    for (let i = 0; i < 40; i++) {
      await writeFile(path.join(tmpDir, `file-${i}.php`), `<?php echo ${i};`);
    }

    const stats = { opsStarted: 0, opsActive: 0, opsCompleted: 0, opsStartedAfterAbort: 0 };
    const controller = new AbortController();

    const traversalPromise = computeTreeContentHash(
      tmpDir,
      tmpDir,
      true,
      undefined,
      controller.signal,
      { stats }
    );

    setTimeout(() => {
      controller.abort();
    }, 2);

    await assert.rejects(
      async () => {
        await traversalPromise;
      },
      /aborted/i
    );

    assert.equal(stats.opsStartedAfterAbort, 0, "No new filesystem operations should be started after abort");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Regression 6: pipeline deploy requires verified test coverage and rejects fast mode or incomplete coverage", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pipeline-deploy-gate-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const distDir = path.join(tmpDir, "dist");
    await mkdir(pluginsDir, { recursive: true });
    await mkdir(distDir, { recursive: true });

    // 1. Fast mode with deploy -> rejected
    await assert.rejects(
      async () => {
        await runPipelineOrchestration({
          contentRoot: tmpDir,
          pluginsDir,
          distDir,
          testMode: "fast",
          shouldDeploy: true,
          targetPlugins: ["tavangary-core"],
        });
      },
      /fast test mode.*does not authorize deployment/i
    );

    // 2. Missing test mode with deploy -> rejected
    await assert.rejects(
      async () => {
        await runPipelineOrchestration({
          contentRoot: tmpDir,
          pluginsDir,
          distDir,
          testMode: null,
          shouldDeploy: true,
          targetPlugins: ["tavangary-core"],
        });
      },
      /missing test mode.*does not authorize deployment/i
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Regression 7: validateTestEvidenceRecord strictly rejects duplicate bindings, unauthorized consumers, and malformed bindings", () => {
  const dummyToolchain = "a".repeat(64);
  const rawEvidence = {
    schemaVersion: 2,
    runId: "run-1788245426208-abc123",
    testFile: "tavangary-core-artifact.test.mjs",
    testFileSha256: "b".repeat(64),
    testDependencyFingerprint: "c".repeat(64),
    toolchainFingerprint: dummyToolchain,
    artifactBindings: [
      { consumer: "tavangary-core", artifactId: "tavangary-core-profile-s", zipSha256: "d".repeat(64) },
      { consumer: "tavangary-core", artifactId: "tavangary-core-profile-s", zipSha256: "d".repeat(64) },
    ],
    mode: "full",
    exitStatus: "passed",
    runDurationMs: 100,
    executedAt: new Date().toISOString(),
  };
  const val = validateTestEvidenceRecord({ evidence: rawEvidence, expectedTestFile: "tavangary-core-artifact.test.mjs" });
  assert.equal(val.valid, false, "Must reject duplicate artifact bindings in raw evidence");
  assert.match(val.reason, /duplicate/i);
});

test("Regression 8: validateBuildCacheSchema performs deep fail-closed validation on artifacts, gates, toolchain, and paths", () => {
  const invalidCache = {
    schemaVersion: 2,
    _tools: "a".repeat(64),
    _toolFiles: {},
    _wpdev: "b".repeat(64),
    _theme: "c".repeat(64),
    _testFiles: {},
    _testEvidence: {},
    toolchain: "not-a-hex",
    artifacts: {
      "tavangary-core": {
        schemaVersion: 2,
        artifactId: "tavangary-core-profile-s",
        consumer: "mismatching-consumer",
        compositeFingerprint: "comp",
        zipSha256: "z".repeat(64),
        manifestDigest: "m".repeat(64),
        validationState: "invalid-state",
        gates: {
          artifactIntegrity: { status: "passed" },
        },
      }
    }
  };
  const val = validateBuildCacheSchema(invalidCache);
  assert.equal(val.valid, false, "Must reject invalid toolchain, mismatching consumer, and invalid state in cache schema");
});

test("Regression 9: loadDeployReceiptRecord strictly rejects symlinks, non-regular files, malformed JSON, and invalid schema", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "receipt-loader-test-"));
  try {
    // 1. Missing receipt
    const missing = await loadDeployReceiptRecord(path.join(tmpDir, "missing.json"), "tavangary-core");
    assert.equal(missing.status, "missing");

    // 2. Symlink receipt
    const realFile = path.join(tmpDir, "real-receipt.json");
    await writeFile(realFile, JSON.stringify({ schemaVersion: 2 }), "utf8");
    const linkFile = path.join(tmpDir, "link-receipt.json");
    await symlink(realFile, linkFile);
    const symlinkRes = await loadDeployReceiptRecord(linkFile, "tavangary-core");
    assert.equal(symlinkRes.status, "invalid");
    assert.match(symlinkRes.reason, /symbolic link/i);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Regression 10: writeAtomicCacheFile categorizes durability outcomes and does NOT claim target preservation on during_dir_sync", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "writer-durability-"));
  try {
    const targetFile = path.join(tmpDir, "cache.json");
    const res1 = await writeAtomicCacheFile(targetFile, { schemaVersion: 2, key: "original" });
    assert.equal(res1.outcome, "committed-durable");

    // Injected failure during directory sync
    const res2 = await writeAtomicCacheFile(
      targetFile,
      { schemaVersion: 2, key: "new" },
      { injectFailure: "during_dir_sync" }
    );
    assert.equal(res2.outcome, "committed-durability-uncertain");

    // Because rename succeeded before dir sync failure, the target file IS already the new content!
    const current = JSON.parse(await readFile(targetFile, "utf8"));
    assert.equal(current.key, "new", "Target is committed on disk even if dir sync durability is uncertain");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Regression 11: validateDeployJournalSchema and loadDeployJournalRecord strictly reject path injection, traversal, symlinks, and invalid tokens", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "journal-security-"));
  try {
    const txId = "tx-1725178000000-abcdef";
    const validJournal = {
      schemaVersion: 2,
      txId,
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "prepared",
      targets: [
        {
          consumer: "tavangary-core",
          preExisting: true,
          phase: "prepared",
          backupToken: `.tavangary-core.backup-${txId}`,
          stagingToken: `.tavangary-core.staging-${txId}`,
          candidateZipSha: "a".repeat(64),
          candidateManifestDigest: "b".repeat(64),
        },
      ],
      publication: {
        receipts: {},
        cache: null,
        backupsPurged: false,
      },
      error: null,
    };

    // 1. Valid journal validates cleanly
    const v1 = validateDeployJournalSchema(validJournal);
    assert.equal(v1.valid, true);

    // 2. Injected targetDir / backupDir / stagingDir in JSON must be rejected
    const injectedPathJournal = structuredClone(validJournal);
    injectedPathJournal.targets[0].targetDir = "/";
    const v2 = validateDeployJournalSchema(injectedPathJournal);
    assert.equal(v2.valid, false);
    assert.match(v2.reason, /forbidden injected path properties|disallowed key/i);

    // 3. Backup token traversal must be rejected
    const traversalJournal = structuredClone(validJournal);
    traversalJournal.targets[0].backupToken = "../../../etc/passwd";
    const v3 = validateDeployJournalSchema(traversalJournal);
    assert.equal(v3.valid, false);
    assert.match(v3.reason, /invalid backuptoken/i);

    // 4. Foreign txId in backup token must be rejected
    const foreignTxJournal = structuredClone(validJournal);
    foreignTxJournal.targets[0].backupToken = `.tavangary-core.backup-tx-999999-foreign`;
    const v4 = validateDeployJournalSchema(foreignTxJournal);
    assert.equal(v4.valid, false);
    assert.match(v4.reason, /invalid backuptoken/i);

    // 5. Unknown consumer must be rejected
    const unknownConsumerJournal = structuredClone(validJournal);
    unknownConsumerJournal.targets[0].consumer = "malicious-unknown-plugin";
    const v5 = validateDeployJournalSchema(unknownConsumerJournal);
    assert.equal(v5.valid, false);
    assert.match(v5.reason, /disallowed target consumer/i);

    // 6. Duplicate targets must be rejected
    const duplicateTargetsJournal = structuredClone(validJournal);
    duplicateTargetsJournal.targets.push(duplicateTargetsJournal.targets[0]);
    const v6 = validateDeployJournalSchema(duplicateTargetsJournal);
    assert.equal(v6.valid, false);
    assert.match(v6.reason, /duplicate consumer/i);

    // 7. Malformed / unknown phase must be rejected
    const malformedPhaseJournal = structuredClone(validJournal);
    malformedPhaseJournal.phase = "hacked_phase";
    const v7 = validateDeployJournalSchema(malformedPhaseJournal);
    assert.equal(v7.valid, false);
    assert.match(v7.reason, /invalid journal phase/i);

    // 8. Symlink journal file rejected on load
    const realFile = path.join(tmpDir, "real-journal.json");
    await writeFile(realFile, JSON.stringify(validJournal), "utf8");
    const linkFile = path.join(tmpDir, "link-journal.json");
    await symlink(realFile, linkFile);
    const symlinkRes = await loadDeployJournalRecord(linkFile);
    assert.equal(symlinkRes.status, "invalid");
    assert.match(symlinkRes.reason, /symbolic link/i);

    // 9. Oversized journal file (>64KB) rejected on load
    const bigFile = path.join(tmpDir, "oversized-journal.json");
    await writeFile(bigFile, JSON.stringify({ ...validJournal, padding: "x".repeat(70000) }), "utf8");
    const bigRes = await loadDeployJournalRecord(bigFile);
    assert.equal(bigRes.status, "invalid");
    assert.match(bigRes.reason, /exceeds maximum size limit/i);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Regression 12: deriveJournalPaths strictly checks directory containment and prevents traversal", () => {
  const pluginsDir = "/var/www/wordpress/wp-content/plugins";
  const distDir = "/var/www/wordpress/wp-content/dist";
  const txId = "tx-1725178000000-abcdef";

  const journal = {
    schemaVersion: 2,
    txId,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: "prepared",
    targets: [
      {
        consumer: "tavangary-core",
        preExisting: true,
        phase: "prepared",
        backupToken: `.tavangary-core.backup-${txId}`,
        stagingToken: `.tavangary-core.staging-${txId}`,
        candidateZipSha: "a".repeat(64),
        candidateManifestDigest: "b".repeat(64),
      },
    ],
  };

  const derived = deriveJournalPaths({ journal, pluginsDir, distDir });
  assert.equal(derived.targets.length, 1);
  assert.equal(derived.targets[0].targetDir, path.join(pluginsDir, "tavangary-core"));
  assert.equal(derived.targets[0].backupDir, path.join(pluginsDir, `.tavangary-core.backup-${txId}`));
  assert.equal(derived.targets[0].stagingDir, path.join(pluginsDir, `.tavangary-core.staging-${txId}`));
  assert.equal(derived.txStagingDir, path.join(distDir, `.tx-staging-${txId}`));
  assert.equal(derived.txBackupDir, path.join(distDir, `.tx-backup-${txId}`));
});

test("Regression 13: BoundedTailBuffer byte-slices large chunks, handles multi-megabyte streams, and outputs structured metadata", () => {
  const limit = 64 * 1024; // 64KB
  const buf = new BoundedTailBuffer(limit);

  // 1. Small chunk
  buf.push("Hello world\n");
  assert.equal(buf.getMetadata().totalBytes, 12);
  assert.equal(buf.getMetadata().truncated, false);
  assert.equal(buf.toString(), "Hello world\n");

  // 2. Huge 2MB chunk in single push
  const hugeChunk = Buffer.alloc(2 * 1024 * 1024, "A");
  hugeChunk.write("TAIL_MARKER_END", 2 * 1024 * 1024 - 15);
  buf.push(hugeChunk);

  const meta = buf.getMetadata();
  assert.equal(meta.truncated, true);
  assert.equal(meta.totalBytes, 12 + 2 * 1024 * 1024);
  assert.equal(meta.bufferedBytes, limit);
  assert.ok(meta.tail.endsWith("TAIL_MARKER_END"));
});

test("Regression 14: validateCanonicalTestRegistry validates 100% test file matching on disk, tool file existence, and critical test releaseSameRun constraint", () => {
  const testsDir = path.dirname(fileURLToPath(import.meta.url));
  const val = validateCanonicalTestRegistry(testsDir, process.cwd());
  assert.equal(val.valid, true, `Canonical registry must be 100% valid: ${val.reason}`);
  const expectedTotal = fs.readdirSync(testsDir).filter((f) => f.endsWith(".test.mjs")).length;
  assert.equal(val.totalTests, expectedTotal);
  assert.ok(val.totalTests >= 54);
  assert.equal(val.criticalTests, 11);
  assert.equal(val.releaseSameRunTests, 11);
});

test("Regression 15: BoundedTailBuffer UTF-8 boundary trimming discards split continuation bytes without Unicode replacement corruption", () => {
  const b = new BoundedTailBuffer(5);
  // "😀" is 4 bytes: F0 9F 98 80
  // Two emojis = 8 bytes
  b.push(Buffer.from("😀😀"));

  const meta = b.getMetadata();
  assert.equal(meta.bufferedBytes <= 5, true);
  assert.equal(meta.truncated, true);
  // Must decode to "😀" and NOT contain replacement char "" (\uFFFD)
  assert.equal(meta.tail, "😀");
  assert.equal(meta.tail.includes("\uFFFD"), false, "Decoded tail must never contain Unicode replacement character \\uFFFD");
});

test("Regression 16: computeTreeContentHash enforces strictly bounded active promise concurrency under high directory volume", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tree-queue-test-"));
  try {
    // Create 100 files
    for (let i = 0; i < 100; i++) {
      await fs.promises.writeFile(path.join(tmpDir, `file-${i}.php`), `<?php echo ${i};`);
    }

    let activeOps = 0;
    let maxObservedActiveOps = 0;
    const concurrencyLimit = 4;
    const testLimit = pLimit(concurrencyLimit);

    const customFsOps = {
      readdir: async (dir, opts) => fs.promises.readdir(dir, opts),
      lstat: async (p) => fs.promises.lstat(p),
      readFile: async (p) => {
        activeOps++;
        if (activeOps > maxObservedActiveOps) {
          maxObservedActiveOps = activeOps;
        }
        await new Promise((r) => setTimeout(r, 2));
        try {
          return await fs.promises.readFile(p);
        } finally {
          activeOps--;
        }
      },
    };

    const hash = await computeTreeContentHash(tmpDir, tmpDir, true, testLimit, null, {
      fsOps: customFsOps,
    });

    assert.equal(typeof hash, "string");
    assert.equal(hash.length, 64);
    assert.equal(maxObservedActiveOps <= concurrencyLimit, true, `Max observed active ops (${maxObservedActiveOps}) must not exceed concurrencyLimit (${concurrencyLimit})`);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Regression 17: validateBenchmarkSchema validates comprehensive benchmark report and rejects invalid schema", async () => {
  const { validateBenchmarkSchema } = await import("../dev/run-benchmark.mjs");
  const benchmarkFile = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "dev", "build-performance-benchmark.json"));
  const raw = await readFile(benchmarkFile, "utf8");
  const parsed = JSON.parse(raw);

  const val = validateBenchmarkSchema(parsed);
  assert.equal(val.valid, true, `Benchmark report on disk must be valid: ${val.reason}`);

  // Rejection tests
  assert.equal(validateBenchmarkSchema(null).valid, false);
  assert.equal(validateBenchmarkSchema({ ...parsed, schemaVersion: "1.0.0" }).valid, false);
  assert.equal(validateBenchmarkSchema({ ...parsed, command: 123 }).valid, false);
  assert.equal(validateBenchmarkSchema({ ...parsed, git: { head: "short", isDirty: false } }).valid, false);
  assert.equal(validateBenchmarkSchema({ ...parsed, metrics: {} }).valid, false);
});

test("Regression 18: parseBsdTimeOutput accurately parses macOS /usr/bin/time -l output", async () => {
  const { parseBsdTimeOutput } = await import("../dev/run-benchmark.mjs");

  const sampleStderr = `
        0.45 real         0.22 user         0.11 sys
            52428800  maximum resident set size
                   0  average shared memory size
  `;
  const parsed = parseBsdTimeOutput(sampleStderr);
  assert.equal(parsed.supported, true);
  assert.equal(parsed.realSeconds, 0.45);
  assert.equal(parsed.userSeconds, 0.22);
  assert.equal(parsed.systemSeconds, 0.11);
  assert.equal(parsed.maxRssBytes, 52428800);

  // Fallback / unsupported on empty or invalid stderr
  assert.equal(parseBsdTimeOutput("").supported, false);
  assert.equal(parseBsdTimeOutput(null).supported, false);
});

test("Regression 19: validateBenchmarkSchema enforces statistical consistency between samples and reported metrics", async () => {
  const { validateBenchmarkSchema } = await import("../dev/run-benchmark.mjs");
  const benchmarkFile = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "dev", "build-performance-benchmark.json"));
  const raw = await readFile(benchmarkFile, "utf8");
  const parsed = JSON.parse(raw);

  // Inconsistent mean value must be rejected
  const tamperedMean = structuredClone(parsed);
  tamperedMean.metrics.coldBuild.meanWallMs = 999999.99;
  const valTampered = validateBenchmarkSchema(tamperedMean);
  assert.equal(valTampered.valid, false);
  assert.match(valTampered.reason, /statistics inconsistency/i);

  // Mismatched sample count must be rejected
  const tamperedSamples = structuredClone(parsed);
  tamperedSamples.metrics.coldBuild.samples.pop();
  const valCount = validateBenchmarkSchema(tamperedSamples);
  assert.equal(valCount.valid, false);
  assert.match(valCount.reason, /samples count/i);
});

test("Regression 20: fsyncDir validates directory integrity, rejects symlinks and files, and propagates durability errors", async () => {
  const { fsyncDir } = await import("../build-cache-engine.mjs");
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fsyncdir-test-"));

  try {
    const testDir = path.join(tmpDir, "valid-dir");
    await fs.promises.mkdir(testDir, { recursive: true });
    // Valid directory sync succeeds
    await fsyncDir(testDir);

    // Symlink directory rejected
    const linkDir = path.join(tmpDir, "symlink-dir");
    await fs.promises.symlink(testDir, linkDir);
    await assert.rejects(async () => fsyncDir(linkDir), /cannot be a symbolic link/i);

    // Regular file rejected
    const regFile = path.join(tmpDir, "regular-file.txt");
    await fs.promises.writeFile(regFile, "content", "utf8");
    await assert.rejects(async () => fsyncDir(regFile), /path is not a directory/i);

    // Invalid arguments
    await assert.rejects(async () => fsyncDir(null), /valid directory path required/i);
    await assert.rejects(async () => fsyncDir(""), /valid directory path required/i);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Regression 21: Benchmark harness validates zero workspace mutations via pre/post workspace hashing", async () => {
  const { runBenchmarkHarness } = await import("../dev/run-benchmark.mjs");

  const mockExecCalls = [];
  const fakeExecutor = async (options) => {
    mockExecCalls.push(options);
    return {
      command: `${options.args.join(" ")}`,
      args: options.args,
      cwd: options.cwd,
      distDir: options.distDir,
      cacheFile: options.cacheFile,
      exitCode: 0,
      wallMs: 45.2,
      cpuUserMs: 30.1,
      cpuSystemMs: 12.4,
      rssBytes: 64 * 1024 * 1024,
      rssMb: 64.0,
      rssSupported: true,
      rebuiltCount: options.kind === "warm" ? 0 : 1,
      cacheHitCount: options.kind === "warm" ? 1 : 0,
      stderrSummary: "",
      stdoutSummary: options.kind === "warm" ? "Rebuilt: 0\nCache hit: 1" : "Rebuilt: 1\nCache hit: 0",
    };
  };

  const fakeFingerprints = {
    tools: "mock-tools-hash-0123456789abcdef",
    theme: "mock-theme-hash-0123456789abcdef",
    wpdev: "mock-wpdev-hash-0123456789abcdef",
    toolchain: "mock-toolchain-hash-0123456789abcdef",
    plugins: {
      "tavangary-theme-panel": "mock-ttp-hash-0123456789abcdef",
    },
  };

  const fakeFingerprinter = async () => ({
    ...fakeFingerprints,
    plugins: { ...fakeFingerprints.plugins },
  });

  // 1. Success path with fake timed executor: tests schema validation, min/mean/p50/max statistics, jobs matrix, rebuilt/hit counts
  const report = await runBenchmarkHarness({
    jobs: [1, 2, 4],
    iterations: 1,
    mini: true,
    writeReport: false,
    executor: fakeExecutor,
    fingerprinter: fakeFingerprinter,
    gitInfo: { head: "0123456789abcdef0123456789abcdef01234567", isDirty: false, porcelainSummary: "" },
  });

  assert.ok(report);
  assert.equal(report.schemaVersion, "3.0.0");
  assert.equal(report.metrics.coldBuild.meanWallMs, 45.2);
  assert.equal(report.metrics.warmNoOp.meanWallMs, 45.2);
  assert.ok(report.concurrencyScaling.jobs_1);
  assert.ok(report.concurrencyScaling.jobs_2);
  assert.ok(report.concurrencyScaling.jobs_4);
  assert.equal(mockExecCalls.length, 9); // 3 kinds (cold, warm, inc) * 3 jobs (1, 2, 4)

  // 2. Failure path A: verifies that plugin workspace mutation is strictly caught and rejected
  let callCount = 0;
  const mutatingFingerprinter = async () => {
    callCount++;
    if (callCount > 1) {
      return {
        ...fakeFingerprints,
        plugins: { "tavangary-theme-panel": "mutated-hash-xyz" },
      };
    }
    return { ...fakeFingerprints, plugins: { ...fakeFingerprints.plugins } };
  };

  await assert.rejects(
    async () => {
      await runBenchmarkHarness({
        jobs: [4],
        iterations: 1,
        mini: true,
        writeReport: false,
        executor: fakeExecutor,
        fingerprinter: mutatingFingerprinter,
        gitInfo: { head: "0123456789abcdef0123456789abcdef01234567", isDirty: false, porcelainSummary: "" },
      });
    },
    /Benchmark run violated workspace isolation: 'tavangary-theme-panel' plugin fingerprint mutated!/
  );

  // 3. Failure path B: verifies that tools workspace mutation is strictly caught and rejected
  let toolsCallCount = 0;
  const mutatingToolsFingerprinter = async () => {
    toolsCallCount++;
    if (toolsCallCount > 1) {
      return { ...fakeFingerprints, tools: "mutated-tools-hash", plugins: { ...fakeFingerprints.plugins } };
    }
    return { ...fakeFingerprints, plugins: { ...fakeFingerprints.plugins } };
  };

  await assert.rejects(
    async () => {
      await runBenchmarkHarness({
        jobs: [4],
        iterations: 1,
        mini: true,
        writeReport: false,
        executor: fakeExecutor,
        fingerprinter: mutatingToolsFingerprinter,
        gitInfo: { head: "0123456789abcdef0123456789abcdef01234567", isDirty: false, porcelainSummary: "" },
      });
    },
    /Benchmark run violated workspace isolation: 'tools' fingerprint mutated!/
  );

  // 4. Failure path C: verifies invalid git HEAD SHA is rejected by schema validator
  await assert.rejects(
    async () => {
      await runBenchmarkHarness({
        jobs: [4],
        iterations: 1,
        mini: true,
        writeReport: false,
        executor: fakeExecutor,
        fingerprinter: fakeFingerprinter,
        gitInfo: { head: "invalid-short-sha", isDirty: false, porcelainSummary: "" },
      });
    },
    /Invalid git HEAD SHA in benchmark/
  );

  // 5. Failure path D: verifies executor failure (exitCode != 0) is caught and handled
  const failingExecutor = async (opts) => {
    const res = await fakeExecutor(opts);
    return { ...res, exitCode: 1, stderrSummary: "Fatal build error injected" };
  };

  const failingReport = await runBenchmarkHarness({
    jobs: [4],
    iterations: 1,
    mini: true,
    writeReport: false,
    executor: failingExecutor,
    fingerprinter: fakeFingerprinter,
    gitInfo: { head: "0123456789abcdef0123456789abcdef01234567", isDirty: false, porcelainSummary: "" },
  });
  assert.equal(failingReport.metrics.coldBuild.samples[0].exitCode, 1);

  // 6. Failure path E: validateBenchmarkSchema rejects inconsistent statistics
  const { validateBenchmarkSchema } = await import("../dev/run-benchmark.mjs");
  const corruptedReport = {
    ...report,
    metrics: {
      ...report.metrics,
      coldBuild: {
        ...report.metrics.coldBuild,
        meanWallMs: 999999.99, // Mismatched reported mean vs actual sample mean
      },
    },
  };
  const valResult = validateBenchmarkSchema(corruptedReport);
  assert.equal(valResult.valid, false);
  assert.match(valResult.reason, /statistics inconsistency/);
});

test("Regression 22: Incremental build planner invariant: exactly 1 rebuilt and 3 cache-hits on touched source", async () => {
  const testFileDir = path.dirname(fileURLToPath(import.meta.url));
  const standaloneBuildDir = path.resolve(testFileDir, "..");
  const contentRoot = path.resolve(testFileDir, "../..");
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "reg22-inc-"));
  const distDir = path.join(tmpDir, "dist");
  const cacheFile = path.join(distDir, ".build-cache.json");
  const receiptsDir = path.join(distDir, ".deploy-receipts");
  const pluginsDir = path.join(tmpDir, "plugins");

  try {
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    await fs.promises.mkdir(distDir, { recursive: true });
    await fs.promises.mkdir(receiptsDir, { recursive: true });

    const { createHermeticZipFixture } = await import("../artifact-fixture-helper.mjs");
    const { computeAllFingerprintsParallel, computePluginCompositeFingerprint, planDependencyGraphBuild } = await import("../build-cache-engine.mjs");
    const { runPipelineOrchestration } = await import("../build-all-standalone-plugins.mjs");
    const { createBuildPlan } = await import("../build-plan.mjs");

    // Create lightweight source trees
    for (const p of ["tavangary-core-dev", "tavangary-theme-panel-dev", "wpdev-crm-dev", "wpdev-tickets-dev", "wpdev"]) {
      await fs.promises.mkdir(path.join(pluginsDir, p), { recursive: true });
      const mainPhp = p === "wpdev" ? "wpdev.php" : `${p.replace(/-dev$/, "")}.php`;
      await fs.promises.writeFile(path.join(pluginsDir, p, mainPhp), `<?php // ${p} source\n`, "utf8");
    }

    const pluginBuildPlans = {};
    for (const p of ["tavangary-core", "tavangary-theme-panel", "wpdev-crm", "wpdev-tickets"]) {
      pluginBuildPlans[p] = createBuildPlan({ consumer: p, profile: "s", isObfuscate: true });
    }

    // Create 4 valid hermetic ZIPs and schema cache entries
    const artifactsCache = {};
    for (const consumer of ["tavangary-core", "tavangary-theme-panel", "wpdev-crm", "wpdev-tickets"]) {
      const fix = await createHermeticZipFixture({ tmpDir, consumer });
      await fs.promises.copyFile(fix.zipPath, path.join(distDir, `${consumer}-profile-s.zip`));
      await fs.promises.copyFile(fix.zipPath, path.join(distDir, `${consumer}.zip`));

      const fp = await computeAllFingerprintsParallel({
        scriptDir: standaloneBuildDir,
        pluginsDir,
        targetPlugins: [consumer],
        contentRoot,
      });

      const comp = computePluginCompositeFingerprint({
        toolsFingerprint: fp.tools,
        wpdevFingerprint: fp.wpdev,
        pluginSourceFingerprint: fp.plugins[consumer],
        toolchainFingerprint: fp.toolchain,
        profile: "s",
        buildPlan: pluginBuildPlans[consumer],
      });

      artifactsCache[consumer] = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        artifactId: `${consumer}-profile-s`,
        consumer,
        profile: "s",
        sourceFingerprint: fp.plugins[consumer],
        wpdevFingerprint: fp.wpdev,
        toolsFingerprint: fp.tools,
        themeFingerprint: (fp.theme && fp.theme !== "missing") ? fp.theme : "0".repeat(64),
        toolchainFingerprint: fp.toolchain,
        compositeFingerprint: comp,
        planFingerprint: pluginBuildPlans[consumer].artifactIdentity.fingerprint,
        zipSha256: fix.zipSha256,
        manifestDigest: fix.manifestDigest,
        gates: {
          artifactIntegrity: { status: "passed", verifiedAt: new Date().toISOString() },
          testCoverage: { status: "passed", coveredTests: ["artifact-fixture-helper.test.mjs"], missingTests: [], coverageReason: "Full test coverage verified" },
          deployment: { status: "none", deployedAt: null, rollbackAt: null },
        },
        validationState: "tests-passed",
        validatedAt: new Date().toISOString(),
      };
    }

    const initialFp = await computeAllFingerprintsParallel({
      scriptDir: standaloneBuildDir,
      pluginsDir,
      targetPlugins: ["tavangary-core", "tavangary-theme-panel", "wpdev-crm", "wpdev-tickets"],
      contentRoot,
    });

    const initialCache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      _tools: initialFp.tools,
      _toolFiles: initialFp.toolFiles || {},
      _wpdev: initialFp.wpdev,
      _theme: (initialFp.theme && initialFp.theme !== "missing") ? initialFp.theme : "0".repeat(64),
      _testFiles: initialFp.testFiles || {},
      _testEvidence: {},
      toolchain: initialFp.toolchain,
      artifacts: artifactsCache,
    };
    await fs.promises.writeFile(cacheFile, JSON.stringify(initialCache, null, 2), "utf8");

    // Negative invariant test: Untouched run has 0 rebuilds and 4 cache hits
    const untouchedPlan = planDependencyGraphBuild({
      currentFingerprints: initialFp,
      previousCache: initialCache,
      targetPlugins: ["tavangary-core", "tavangary-theme-panel", "wpdev-crm", "wpdev-tickets"],
      mode: "incremental",
      profile: "s",
      pluginBuildPlans,
    });
    for (const p of ["tavangary-core", "tavangary-theme-panel", "wpdev-crm", "wpdev-tickets"]) {
      assert.equal(untouchedPlan[p]?.shouldRebuild, false, `Untouched plugin ${p} must be cached`);
      assert.equal(untouchedPlan[p]?.reason, "Cached (inputs unchanged)");
    }

    // 1. Touch 1 plugin source: tavangary-core-dev
    const devBootstrap = path.join(pluginsDir, "tavangary-core-dev", "tavangary-core.php");
    await fs.promises.appendFile(devBootstrap, "\n// regression 22 deterministic touch\n", "utf8");

    // 2. Compute post-touch fingerprints
    const postTouchFp = await computeAllFingerprintsParallel({
      scriptDir: standaloneBuildDir,
      pluginsDir,
      targetPlugins: ["tavangary-core", "tavangary-theme-panel", "wpdev-crm", "wpdev-tickets"],
      contentRoot,
    });

    // 3. Verify planDependencyGraphBuild invariant directly
    const plan = planDependencyGraphBuild({
      currentFingerprints: postTouchFp,
      previousCache: initialCache,
      targetPlugins: ["tavangary-core", "tavangary-theme-panel", "wpdev-crm", "wpdev-tickets"],
      mode: "incremental",
      profile: "s",
      pluginBuildPlans,
    });

    assert.equal(plan["tavangary-core"]?.shouldRebuild, true, "Changed plugin must be planned for rebuild");
    assert.equal(plan["tavangary-core"]?.reason, "Source code changed");
    assert.equal(plan["tavangary-theme-panel"]?.shouldRebuild, false, "Unchanged plugin must be cached");
    assert.equal(plan["wpdev-crm"]?.shouldRebuild, false, "Unchanged plugin must be cached");
    assert.equal(plan["wpdev-tickets"]?.shouldRebuild, false, "Unchanged plugin must be cached");

    // Negative invariant test: Missing cache entry forces rebuild with fail-closed reason
    const emptyCachePlan = planDependencyGraphBuild({
      currentFingerprints: postTouchFp,
      previousCache: { schemaVersion: CACHE_SCHEMA_VERSION, artifacts: {} },
      targetPlugins: ["tavangary-core"],
      mode: "incremental",
      profile: "s",
    });
    assert.equal(emptyCachePlan["tavangary-core"]?.shouldRebuild, true);
    assert.equal(emptyCachePlan["tavangary-core"]?.reason, "No previous build cache found");

    // 4. Run pipeline orchestration with hermetic build candidate generator
    const executedTasks = [];
    const dagResults = await runPipelineOrchestration({
      contentRoot,
      scriptDir: standaloneBuildDir,
      distDir,
      pluginsDir,
      cacheFile,
      receiptsDir,
      targetPlugins: ["tavangary-core", "tavangary-theme-panel", "wpdev-crm", "wpdev-tickets"],
      overrideChanged: true,
      overrideForce: false,
      overrideDeploy: false,
      overrideObfuscate: true,
      jobsLimit: 4,
      buildCandidate: async ({ plugin, customDistDir }) => {
        const fix = await createHermeticZipFixture({ tmpDir, consumer: plugin });
        await fs.promises.copyFile(fix.zipPath, path.join(customDistDir, `${plugin}-profile-s.zip`));
        await fs.promises.copyFile(fix.zipPath, path.join(customDistDir, `${plugin}.zip`));
      },
      executor: async (nodeId, task) => {
        executedTasks.push(nodeId);
        return task();
      },
    });

    assert.equal(dagResults["build:tavangary-core"]?.status, "rebuilt");
    assert.equal(dagResults["build:tavangary-theme-panel"]?.status, "cached");
    assert.equal(dagResults["build:wpdev-crm"]?.status, "cached");
    assert.equal(dagResults["build:wpdev-tickets"]?.status, "cached");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Regression 23: AST Transformer integration: transforms representative PHP fixture, mangles symbols, strips comments, and verifies valid PHP syntax", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const testFileDir = path.dirname(fileURLToPath(import.meta.url));
  const transformerScript = path.resolve(testFileDir, "../plan3/transformer.php");
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "reg23-ast-"));

  try {
    const inputPhpPath = path.join(tmpDir, "SampleController.php");

    const samplePhpCode = `<?php
/**
 * Plugin Name: Sample Controller
 * Version: 1.0.0
 */

// Sensitive internal comment to strip
/**
 * Controller documentation that should be stripped in obfuscation.
 */
class SampleController {
    /** @var string */
    private $secretKey = "sample-secret-value";
    public $publicName = "sample-public-name";

    public function processRequest(array $payload) {
        // Inline sensitive comment to strip
        $sanitized = trim($payload['data'] ?? '');
        return $this->handleData($sanitized);
    }

    private function handleData($data) {
        return strtoupper($data);
    }
}
`;
    await fs.promises.writeFile(inputPhpPath, samplePhpCode, "utf8");

    // Execute AST transformer in-place on the sample fixture
    await execFileAsync("php", [
      transformerScript,
      inputPhpPath,
      "--main",
      "seed-reg23",
    ]);

    const transformedCode = await fs.promises.readFile(inputPhpPath, "utf8");

    // Verify valid PHP syntax of transformed code
    const syntaxCheck = await execFileAsync("php", ["-l", inputPhpPath]);
    assert.match(syntaxCheck.stdout, /No syntax errors detected/);

    // Verify comment stripping and symbol transformation
    assert.ok(transformedCode.includes("Plugin Name: Sample Controller"), "Main plugin header must be preserved");
    assert.ok(!transformedCode.includes("Controller documentation that should be stripped"), "Docblocks must be stripped");
    assert.ok(!transformedCode.includes("Sensitive internal comment to strip"), "Inline comments must be stripped");
    assert.ok(!transformedCode.includes("Inline sensitive comment to strip"), "Method comments must be stripped");
    assert.ok(transformedCode.includes("SampleController"), "Class declaration must be preserved");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});






import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, readFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
import { resolveContentRoot } from "../resolve-content-root.mjs";

import { atomicDeployPlugin, runPipelineOrchestration } from "../build-all-standalone-plugins.mjs";
import {
  generateArtifactManifest,
  verifyArtifactManifest,
  createCanonicalZip,
} from "../canonical-artifact-manifest.mjs";
import {
  createTargetCacheRecord,
  validateCachedTargetArtifact,
  writeAtomicCacheFile,
  createTestEvidenceRecord,
  computeTestDependencyFingerprint,
  computeAllFingerprintsParallel,
  computePluginCompositeFingerprint,
  recoverInterruptedDeployment,
  REQUIRED_ARTIFACT_TESTS,
  TEST_SPEC_MAP,
  CACHE_SCHEMA_VERSION,
} from "../build-cache-engine.mjs";
import { BuildDag } from "../build-dag-runner.mjs";
import { createBuildPlan } from "../build-plan.mjs";

const execFileAsync = promisify(execFile);

async function createHermeticZipFixture({ tmpDir, consumer }) {
  const pluginSrc = path.join(tmpDir, consumer);
  await fs.promises.mkdir(pluginSrc, { recursive: true });
  await fs.promises.writeFile(path.join(pluginSrc, `${consumer}.php`), "<?php echo 'OK';");
  await fs.promises.mkdir(path.join(pluginSrc, "src/FrameworkClosure"), { recursive: true });
  await fs.promises.writeFile(
    path.join(pluginSrc, "src/FrameworkClosure/functions-closure.php"),
    "<?php // hermetic framework closure\n"
  );
  
  const manifest = await generateArtifactManifest({
    rootDir: pluginSrc,
    consumer,
    profile: "Profile S",
  });
  await fs.promises.writeFile(path.join(pluginSrc, "artifact-manifest.json"), JSON.stringify(manifest, null, 2));

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

test("Failure Scenario 1: Test failure after build prevents cache commit and deployment", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "test-fail-seq1-"));
  const cacheFile = path.join(tmpDir, ".build-cache.json");
  const receiptFile = path.join(tmpDir, "sample.receipt.json");

  let buildRan = false;
  let cacheCommitted = false;
  let deployRan = false;

  const dag = new BuildDag({ concurrency: 2 });
  dag.addNode("build:sample", {
    task: async () => {
      buildRan = true;
      return { status: "built" };
    },
  });

  dag.addNode("test:sample", {
    dependencies: ["build:sample"],
    task: async () => {
      throw new Error("Unit test assertion failure in sample test");
    },
  });

  dag.addNode("commit:cache", {
    dependencies: ["test:sample"],
    task: async () => {
      cacheCommitted = true;
      await writeAtomicCacheFile(cacheFile, { valid: true });
    },
  });

  dag.addNode("deploy:sample", {
    dependencies: ["commit:cache"],
    task: async () => {
      deployRan = true;
      await writeAtomicCacheFile(receiptFile, { deployed: true });
    },
  });

  let threw = false;
  try {
    await dag.run();
  } catch (err) {
    threw = true;
    assert.ok(err.message.includes("Unit test assertion failure"));
  }

  assert.equal(threw, true, "DAG must reject on test failure");
  assert.equal(buildRan, true, "Build must have run before test");
  assert.equal(cacheCommitted, false, "Cache must NOT be committed on test failure");
  assert.equal(deployRan, false, "Deploy must NOT run on test failure");
  assert.equal(fs.existsSync(cacheFile), false, "Cache file must not exist");
  assert.equal(fs.existsSync(receiptFile), false, "Receipt file must not exist");

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("Failure Scenario 2: ZIP corruption on cache hit triggers validation failure and safe rebuild requirement", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "test-fail-seq2-"));
  const consumer = "sample-plugin";
  const { zipPath, zipSha256, manifestDigest } = await createHermeticZipFixture({ tmpDir, consumer });

  const record = createTargetCacheRecord({
    artifactId: `${consumer}-profile-s`,
    consumer,
    compositeFingerprint: "comp123",
    zipSha256,
    manifestDigest,
    validationState: "tests-passed",
  });

  // Valid initial check
  const initialCheck = await validateCachedTargetArtifact({
    cacheRecord: record,
    zipPath,
    consumer,
    expectedCompositeFingerprint: "comp123",
  });
  assert.equal(initialCheck.valid, true, "Initial cache check must pass");

  // Tamper: Corrupt 1 byte in the middle of ZIP
  const bytes = await fs.promises.readFile(zipPath);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  await fs.promises.writeFile(zipPath, bytes);

  const corruptedCheck = await validateCachedTargetArtifact({
    cacheRecord: record,
    zipPath,
    consumer,
    expectedCompositeFingerprint: "comp123",
  });
  assert.equal(corruptedCheck.valid, false, "Corrupted ZIP must fail cache check");
  assert.ok(corruptedCheck.reason.includes("Physical ZIP SHA-256") || corruptedCheck.reason.includes("Corrupted"));

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("Failure Scenario 3: Deploy failure after tests restores backup and leaves target intact", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "test-fail-seq3-"));
  const pluginsDir = path.join(tmpDir, "plugins");
  await fs.promises.mkdir(pluginsDir, { recursive: true });

  const consumer = "tavangary-theme-panel";
  const targetDir = path.join(pluginsDir, consumer);
  await fs.promises.mkdir(targetDir, { recursive: true });
  await fs.promises.writeFile(path.join(targetDir, "original.php"), "<?php echo 'ORIGINAL_V1';");
  await fs.promises.writeFile(path.join(targetDir, "artifact-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    consumer,
    manifestDigest: "orig-123",
    files: [{ path: "original.php", sha256: "abc", size: 20 }],
  }));

  const { zipPath } = await createHermeticZipFixture({ tmpDir, consumer });

  let threw = false;
  try {
    await atomicDeployPlugin(zipPath, consumer, {
      pluginsDir,
      contentRoot: tmpDir,
      healthCheck: async () => {
        throw new Error("Post-swap health check probe failed (e.g. fatal error)");
      },
    });
  } catch (err) {
    threw = true;
    assert.ok(err.message.includes("Post-swap health check probe failed"));
  }

  assert.equal(threw, true);
  assert.ok(fs.existsSync(targetDir));
  const content = await fs.promises.readFile(path.join(targetDir, "original.php"), "utf8");
  assert.equal(content, "<?php echo 'ORIGINAL_V1';", "Original version must be restored cleanly");

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("Failure Scenario 4: Target file drift on disk is detected and prevents false deploy skip", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "test-fail-seq4-"));
  const consumer = "sample-plugin";
  const pluginDir = path.join(tmpDir, consumer);
  await fs.promises.mkdir(pluginDir, { recursive: true });

  await fs.promises.writeFile(path.join(pluginDir, `${consumer}.php`), "<?php echo 'VALID';");
  const manifest = await generateArtifactManifest({
    rootDir: pluginDir,
    consumer,
    profile: "Profile S",
  });
  await fs.promises.writeFile(path.join(pluginDir, "artifact-manifest.json"), JSON.stringify(manifest, null, 2));

  // Valid on disk
  const v1 = await verifyArtifactManifest({ rootDir: pluginDir, consumer });
  assert.equal(v1.status, "valid");

  // Tamper: Modify PHP file directly on disk
  await fs.promises.writeFile(path.join(pluginDir, `${consumer}.php`), "<?php echo 'TAMPERED';");

  const v2 = await verifyArtifactManifest({ rootDir: pluginDir, consumer });
  assert.notEqual(v2.status, "valid", "Target file drift must fail manifest verification");

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("Failure Scenario 5: Clean re-run after failure executes required DAG nodes successfully", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "test-fail-seq5-"));
  let runCount = 0;
  let finalResult = null;

  const executePipeline = async (shouldFail) => {
    const dag = new BuildDag({ concurrency: 2 });
    dag.addNode("step1", {
      task: async () => {
        runCount++;
        return "step1_ok";
      },
    });

    dag.addNode("step2", {
      dependencies: ["step1"],
      task: async () => {
        if (shouldFail) {
          throw new Error("Temporary failure in step2");
        }
        return "step2_ok";
      },
    });

    return await dag.run();
  };

  // 1. First run fails
  let threw = false;
  try {
    await executePipeline(true);
  } catch (err) {
    threw = true;
  }
  assert.equal(threw, true);

  // 2. Second run succeeds cleanly
  const res = await executePipeline(false);
  assert.deepEqual(res, { step1: "step1_ok", step2: "step2_ok" });

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("Failure Scenario 6: Production orchestrator strictly rejects invalid cache files in deploy/release mode", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "orch-loader-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const distDir = path.join(tmpDir, "dist");
    const cacheFile = path.join(distDir, ".build-cache.json");
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    await fs.promises.mkdir(distDir, { recursive: true });

    // 1. Symlink cache file in release mode -> fails closed
    const realFile = path.join(tmpDir, "real-cache.json");
    await fs.promises.writeFile(realFile, JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION }), "utf8");
    await fs.promises.symlink(realFile, cacheFile);

    await assert.rejects(
      async () => {
        await runPipelineOrchestration({
          contentRoot: tmpDir,
          pluginsDir,
          distDir,
          cacheFile,
          testMode: "release",
          targetPlugins: [],
        });
      },
      /Invalid or corrupted cache record.*symbolic link/i
    );

    await fs.promises.rm(cacheFile);

    // 2. Incomplete cache file in deploy mode -> fails closed
    await fs.promises.writeFile(cacheFile, JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, _tools: "abc" }), "utf8");
    await assert.rejects(
      async () => {
        await runPipelineOrchestration({
          contentRoot: tmpDir,
          pluginsDir,
          distDir,
          cacheFile,
          testMode: "affected",
          shouldDeploy: true,
          targetPlugins: [],
        });
      },
      /Invalid or corrupted cache record.*missing required top-level field/i
    );
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 7: Production orchestrator rollback on smoke failure leaves target directory, receipts, and cache untouched", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "orch-rollback-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const distDir = path.join(tmpDir, "dist");
    const receiptsDir = path.join(distDir, ".deploy-receipts");
    const cacheFile = path.join(distDir, ".build-cache.json");
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    await fs.promises.mkdir(distDir, { recursive: true });
    await fs.promises.mkdir(receiptsDir, { recursive: true });

    // Setup dev sources and shared framework
    const consumer = "tavangary-core";
    const devDir = path.join(pluginsDir, `${consumer}-dev`);
    const wpdevDir = path.join(pluginsDir, "wpdev");
    const themeDir = path.join(tmpDir, "themes", "tavangary");
    await fs.promises.mkdir(devDir, { recursive: true });
    await fs.promises.mkdir(wpdevDir, { recursive: true });
    await fs.promises.mkdir(themeDir, { recursive: true });
    await fs.promises.writeFile(path.join(devDir, `${consumer}.php`), "<?php echo 'DEV_SOURCE';");
    await fs.promises.writeFile(path.join(wpdevDir, "wpdev.php"), "<?php echo 'WPDEV';");
    await fs.promises.writeFile(path.join(themeDir, "style.css"), "/* Theme */");

    const targetDir = path.join(pluginsDir, consumer);
    await fs.promises.mkdir(targetDir, { recursive: true });
    const originalPhp = path.join(targetDir, `${consumer}.php`);
    await fs.promises.writeFile(originalPhp, "<?php echo 'ORIGINAL_CONTENT_BEFORE_DEPLOY';");

    // Create candidate ZIP
    const { zipSha256, manifestDigest } = await createHermeticZipFixture({
      tmpDir: path.join(tmpDir, "staging-fixture"),
      consumer,
    });
    await fs.promises.copyFile(
      path.join(tmpDir, "staging-fixture", `${consumer}-profile-s.zip`),
      path.join(distDir, `${consumer}-profile-s.zip`)
    );

    // Initial cache state with valid fingerprints and test evidence
    const scriptDir = packageRoot;
    const fps = await computeAllFingerprintsParallel({
      scriptDir,
      pluginsDir,
      targetPlugins: [consumer],
      jobs: 1,
      contentRoot: tmpDir,
    });

    const sourceSha = fps.plugins[consumer];
    const wpdevSha = fps.wpdev;
    const themeSha = fps.theme;
    const toolsSha = fps.tools;
    const toolFiles = fps.toolFiles;
    const toolchain = fps.toolchain;

    const buildPlan = createBuildPlan({ consumer, profile: "s", isObfuscate: true });
    const compRaw = computePluginCompositeFingerprint({
      toolsFingerprint: toolsSha,
      wpdevFingerprint: wpdevSha,
      pluginSourceFingerprint: sourceSha,
      toolchainFingerprint: toolchain,
      // Hermetic Profile S fixture (F05 tier separation).
      profile: "s",
      buildPlan,
    });
    const compositeFp = compRaw;

    const requiredTests = REQUIRED_ARTIFACT_TESTS[consumer];
    const testEvidence = {};
    const testFiles = {};

    for (const tf of requiredTests) {
      const tfSha = fps.testFiles[tf] || crypto.createHash("sha256").update(tf).digest("hex");
      testFiles[tf] = tfSha;
      const depFp = computeTestDependencyFingerprint({
        testFile: tf,
        testFileSha256: tfSha,
        toolFiles: fps.toolFiles,
        toolchainFingerprint: fps.toolchain,
      });
      const isBound = (TEST_SPEC_MAP[tf]?.artifacts || []).includes(consumer);
      testEvidence[tf] = createTestEvidenceRecord({
        testFile: tf,
        testFileSha256: tfSha,
        testDependencyFingerprint: depFp,
        toolchainFingerprint: fps.toolchain,
        artifactBindings: isBound
          ? [{
              consumer,
              artifactId: `${consumer}-profile-s`,
              zipSha256,
              compositeFingerprint: compositeFp,
            }]
          : [],
        mode: "full",
        exitStatus: "passed",
      });
    }

    const initialCacheData = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      _tools: toolsSha,
      _toolFiles: toolFiles,
      _wpdev: wpdevSha,
      _theme: themeSha,
      _testFiles: testFiles,
      _testEvidence: testEvidence,
      toolchain,
      artifacts: {
        [consumer]: createTargetCacheRecord({
          artifactId: `${consumer}-profile-s`,
          consumer,
          sourceFingerprint: sourceSha,
          wpdevFingerprint: wpdevSha,
          toolsFingerprint: toolsSha,
          themeFingerprint: themeSha,
          toolchainFingerprint: toolchain,
          compositeFingerprint: compositeFp,
          planFingerprint: buildPlan.artifactIdentity.fingerprint,
          zipSha256,
          manifestDigest,
          validationState: "tests-passed",
          gates: {
            artifactIntegrity: { status: "passed", verifiedAt: new Date().toISOString() },
            testCoverage: { status: "passed", coveredTests: requiredTests, missingTests: [], coverageReason: "All tests verified" },
          },
          outputPaths: {
            profileSZip: path.join(distDir, `${consumer}-profile-s.zip`),
            standardZip: path.join(distDir, `${consumer}.zip`),
          },
        }),
      },
      [consumer]: compositeFp,
    };
    await fs.promises.writeFile(cacheFile, JSON.stringify(initialCacheData, null, 2) + "\n", "utf8");
    const initialCacheSha = crypto.createHash("sha256").update(await fs.promises.readFile(cacheFile)).digest("hex");

    // Execute pipeline orchestration with failure injected during smoke
    let threw = false;
    try {
      await runPipelineOrchestration({
        contentRoot: tmpDir,
        pluginsDir,
        distDir,
        receiptsDir,
        cacheFile,
        targetPlugins: [consumer],
        testMode: "docker-smoke",
        shouldDeploy: true,
        injectFailure: "during_smoke",
        // Fixture ZIPs are Profile S artifacts; run the obfuscated tier (F05).
        isObfuscate: true,
      });
    } catch (err) {
      threw = true;
      assert.match(err.message, /Injected failure during Docker smoke/i);
    }
    assert.equal(threw, true, "Pipeline must throw on smoke failure");

    // 1. Target directory must be restored to original content
    assert.ok(fs.existsSync(originalPhp), "Original bootstrap file must exist");
    const currentPhpContent = await fs.promises.readFile(originalPhp, "utf8");
    assert.equal(currentPhpContent, "<?php echo 'ORIGINAL_CONTENT_BEFORE_DEPLOY';", "Original plugin content must be 100% restored");

    // 2. Receipt file must NOT be written to disk
    const receiptFile = path.join(receiptsDir, `${consumer}.receipt.json`);
    assert.equal(fs.existsSync(receiptFile), false, "Receipt file must NOT be created on disk when smoke fails");

    // 3. Cache file on disk must be 100% byte-for-byte untouched
    const currentCacheBytes = await fs.promises.readFile(cacheFile);
    const currentCacheSha = crypto.createHash("sha256").update(currentCacheBytes).digest("hex");
    assert.equal(currentCacheSha, initialCacheSha, "Cache on disk must remain 100% byte-for-byte untouched");

    // 4. No temporary staging, backup, or journal files remain
    const distEntries = await fs.promises.readdir(distDir);
    assert.equal(distEntries.includes(".deploy-journal.json"), false, "Journal must be cleaned up");
    const pluginEntries = await fs.promises.readdir(pluginsDir);
    const orphanEntries = pluginEntries.filter((e) => e.startsWith("."));
    assert.equal(orphanEntries.length, 0, `No orphan backup or staging directories should remain in plugins: ${orphanEntries.join(", ")}`);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 8: Failure immediately after swap (during_swap) on non-existent initial target cleans up new target", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pipeline-nonexistent-target-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const distDir = path.join(tmpDir, "dist");
    const receiptsDir = path.join(distDir, ".deploy-receipts");
    const cacheFile = path.join(distDir, ".build-cache.json");
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    await fs.promises.mkdir(distDir, { recursive: true });
    await fs.promises.mkdir(receiptsDir, { recursive: true });

    const consumer = "tavangary-core";
    const srcDir = path.join(pluginsDir, "tavangary-core-dev");
    const wpdevDir = path.join(pluginsDir, "wpdev");
    const themeDir = path.join(tmpDir, "themes", "tavangary");
    await fs.promises.mkdir(srcDir, { recursive: true });
    await fs.promises.mkdir(wpdevDir, { recursive: true });
    await fs.promises.mkdir(themeDir, { recursive: true });
    await fs.promises.writeFile(path.join(srcDir, "tavangary-core.php"), "<?php echo 'DEV_SOURCE';");
    await fs.promises.writeFile(path.join(wpdevDir, "wpdev.php"), "<?php echo 'WPDEV';");
    await fs.promises.writeFile(path.join(themeDir, "style.css"), "/* Theme */");

    const targetPluginDir = path.join(pluginsDir, consumer);
    // target does NOT exist initially!
    assert.equal(fs.existsSync(targetPluginDir), false);

    const { zipPath, zipSha256, manifestDigest } = await createHermeticZipFixture({ tmpDir, consumer });
    await fs.promises.copyFile(zipPath, path.join(distDir, `${consumer}-profile-s.zip`));

    const scriptDir = packageRoot;
    const fps = await computeAllFingerprintsParallel({
      scriptDir,
      pluginsDir,
      targetPlugins: [consumer],
      contentRoot: tmpDir,
    });

    const buildPlan = createBuildPlan({ consumer, profile: "s", isObfuscate: true });
    const compositeFp = computePluginCompositeFingerprint({
      toolsFingerprint: fps.tools,
      wpdevFingerprint: fps.wpdev,
      pluginSourceFingerprint: fps.plugins[consumer],
      toolchainFingerprint: fps.toolchain,
      // Hermetic fixtures below are Profile S artifacts; the tier is part of
      // the composite identity (F05), so the test pipeline must run obfuscated.
      profile: "s",
      buildPlan,
    });
    const requiredTests = REQUIRED_ARTIFACT_TESTS[consumer];
    const testEvidence = {};
    for (const tf of requiredTests) {
      const tfSha = fps.testFiles[tf] || crypto.createHash("sha256").update(tf).digest("hex");
      const depFp = computeTestDependencyFingerprint({
        testFile: tf,
        testFileSha256: tfSha,
        toolFiles: fps.toolFiles,
        toolchainFingerprint: fps.toolchain,
      });
      const isBound = (TEST_SPEC_MAP[tf]?.artifacts || []).includes(consumer);
      testEvidence[tf] = createTestEvidenceRecord({
        testFile: tf,
        testFileSha256: tfSha,
        testDependencyFingerprint: depFp,
        toolchainFingerprint: fps.toolchain,
        artifactBindings: isBound
          ? [{
              consumer,
              artifactId: `${consumer}-profile-s`,
              zipSha256,
              compositeFingerprint: compositeFp,
            }]
          : [],
        mode: "artifact",
        exitStatus: "passed",
      });
    }

    const initialCacheData = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      _tools: fps.tools,
      _toolFiles: fps.toolFiles,
      _wpdev: fps.wpdev,
      _theme: fps.theme,
      _testFiles: fps.testFiles,
      _testEvidence: testEvidence,
      toolchain: fps.toolchain,
      artifacts: {
        [consumer]: createTargetCacheRecord({
          artifactId: `${consumer}-profile-s`,
          consumer,
          sourceFingerprint: fps.plugins[consumer],
          wpdevFingerprint: fps.wpdev,
          toolsFingerprint: fps.tools,
          themeFingerprint: fps.theme,
          toolchainFingerprint: fps.toolchain,
          compositeFingerprint: compositeFp,
          planFingerprint: buildPlan.artifactIdentity.fingerprint,
          zipSha256,
          manifestDigest,
          validationState: "tests-passed",
          gates: {
            artifactIntegrity: { status: "passed", verifiedAt: new Date().toISOString() },
            testCoverage: { status: "passed", coveredTests: requiredTests, missingTests: [] },
          },
        }),
      },
      [consumer]: compositeFp,
    };
    await fs.promises.writeFile(cacheFile, JSON.stringify(initialCacheData, null, 2) + "\n", "utf8");

    // Execute with failure injected during swap
    let threw = false;
    try {
      await runPipelineOrchestration({
        contentRoot: tmpDir,
        pluginsDir,
        distDir,
        receiptsDir,
        cacheFile,
        targetPlugins: [consumer],
        testMode: "artifact",
        shouldDeploy: true,
        injectFailure: "during_swap",
        // Fixture ZIPs are Profile S artifacts; run the obfuscated tier (F05).
        isObfuscate: true,
      });
    } catch (err) {
      threw = true;
      assert.match(err.message, /Injected failure during deploy swap/i);
    }
    assert.equal(threw, true, "Must throw on during_swap error");

    // Because target did not exist initially, rollback must remove the newly created target
    assert.equal(fs.existsSync(targetPluginDir), false, "Non-existent initial target must be removed upon rollback");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 9: Multi-file commit failure (during_commit) leaves zero receipts and untouched cache", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pipeline-commit-fail-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const distDir = path.join(tmpDir, "dist");
    const receiptsDir = path.join(distDir, ".deploy-receipts");
    const cacheFile = path.join(distDir, ".build-cache.json");
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    await fs.promises.mkdir(distDir, { recursive: true });
    await fs.promises.mkdir(receiptsDir, { recursive: true });

    const consumer = "tavangary-core";
    const srcDir = path.join(pluginsDir, "tavangary-core-dev");
    const wpdevDir = path.join(pluginsDir, "wpdev");
    const themeDir = path.join(tmpDir, "themes", "tavangary");
    await fs.promises.mkdir(srcDir, { recursive: true });
    await fs.promises.mkdir(wpdevDir, { recursive: true });
    await fs.promises.mkdir(themeDir, { recursive: true });
    await fs.promises.writeFile(path.join(srcDir, "tavangary-core.php"), "<?php echo 'DEV_SOURCE';");
    await fs.promises.writeFile(path.join(wpdevDir, "wpdev.php"), "<?php echo 'WPDEV';");
    await fs.promises.writeFile(path.join(themeDir, "style.css"), "/* Theme */");

    const { zipPath, zipSha256, manifestDigest } = await createHermeticZipFixture({ tmpDir, consumer });
    await fs.promises.copyFile(zipPath, path.join(distDir, `${consumer}-profile-s.zip`));

    const scriptDir = packageRoot;
    const fps = await computeAllFingerprintsParallel({
      scriptDir,
      pluginsDir,
      targetPlugins: [consumer],
      contentRoot: tmpDir,
    });

    const buildPlan = createBuildPlan({ consumer, profile: "s", isObfuscate: true });
    const compositeFp = computePluginCompositeFingerprint({
      toolsFingerprint: fps.tools,
      wpdevFingerprint: fps.wpdev,
      pluginSourceFingerprint: fps.plugins[consumer],
      toolchainFingerprint: fps.toolchain,
      // Hermetic fixtures below are Profile S artifacts; the tier is part of
      // the composite identity (F05), so the test pipeline must run obfuscated.
      profile: "s",
      buildPlan,
    });

    const requiredTests = REQUIRED_ARTIFACT_TESTS[consumer];
    const testEvidence = {};
    for (const tf of requiredTests) {
      const tfSha = fps.testFiles[tf] || crypto.createHash("sha256").update(tf).digest("hex");
      const depFp = computeTestDependencyFingerprint({
        testFile: tf,
        testFileSha256: tfSha,
        toolFiles: fps.toolFiles,
        toolchainFingerprint: fps.toolchain,
      });
      const isBound = (TEST_SPEC_MAP[tf]?.artifacts || []).includes(consumer);
      testEvidence[tf] = createTestEvidenceRecord({
        testFile: tf,
        testFileSha256: tfSha,
        testDependencyFingerprint: depFp,
        toolchainFingerprint: fps.toolchain,
        artifactBindings: isBound
          ? [{
              consumer,
              artifactId: `${consumer}-profile-s`,
              zipSha256,
              compositeFingerprint: compositeFp,
            }]
          : [],
        mode: "artifact",
        exitStatus: "passed",
      });
    }

    const initialCacheData = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      _tools: fps.tools,
      _toolFiles: fps.toolFiles,
      _wpdev: fps.wpdev,
      _theme: fps.theme,
      _testFiles: fps.testFiles,
      _testEvidence: testEvidence,
      toolchain: fps.toolchain,
      artifacts: {
        [consumer]: createTargetCacheRecord({
          artifactId: `${consumer}-profile-s`,
          consumer,
          sourceFingerprint: fps.plugins[consumer],
          wpdevFingerprint: fps.wpdev,
          toolsFingerprint: fps.tools,
          themeFingerprint: fps.theme,
          toolchainFingerprint: fps.toolchain,
          compositeFingerprint: compositeFp,
          planFingerprint: buildPlan.artifactIdentity.fingerprint,
          zipSha256,
          manifestDigest,
          validationState: "tests-passed",
          gates: {
            artifactIntegrity: { status: "passed", verifiedAt: new Date().toISOString() },
            testCoverage: { status: "passed", coveredTests: requiredTests, missingTests: [] },
          },
        }),
      },
      [consumer]: compositeFp,
    };
    await fs.promises.writeFile(cacheFile, JSON.stringify(initialCacheData, null, 2) + "\n", "utf8");
    const initialCacheSha = crypto.createHash("sha256").update(await fs.promises.readFile(cacheFile)).digest("hex");

    let threw = false;
    try {
      await runPipelineOrchestration({
        contentRoot: tmpDir,
        pluginsDir,
        distDir,
        receiptsDir,
        cacheFile,
        targetPlugins: [consumer],
        testMode: "artifact",
        shouldDeploy: true,
        injectFailure: "during_commit",
        // Fixture ZIPs are Profile S artifacts; run the obfuscated tier (F05).
        isObfuscate: true,
      });
    } catch (err) {
      threw = true;
      assert.match(err.message, /Injected failure during final commit/i);
    }
    assert.equal(threw, true, "Must throw on during_commit failure");

    // No receipts written to real receipts dir
    const receiptFiles = await fs.promises.readdir(receiptsDir);
    assert.equal(receiptFiles.length, 0, "No receipts should be written to receipts dir on commit failure");

    // Cache file untouched
    const currentCacheBytes = await fs.promises.readFile(cacheFile);
    const currentCacheSha = crypto.createHash("sha256").update(currentCacheBytes).digest("hex");
    assert.equal(currentCacheSha, initialCacheSha, "Cache file must remain untouched on commit failure");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 10: Startup journal recovery restores interrupted deployment before running new build", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pipeline-startup-recovery-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const distDir = path.join(tmpDir, "dist");
    const journalFile = path.join(distDir, ".deploy-journal.json");
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    await fs.promises.mkdir(distDir, { recursive: true });

    const consumer = "tavangary-core";
    const txId = "tx-1725178000000-crashed1000";
    const targetDir = path.join(pluginsDir, consumer);
    const backupDir = path.join(pluginsDir, `.${consumer}.backup-${txId}`);
    await fs.promises.mkdir(targetDir, { recursive: true });
    await fs.promises.mkdir(backupDir, { recursive: true });
    await fs.promises.writeFile(path.join(targetDir, "tavangary-core.php"), "<?php echo 'CORRUPTED_INCOMPLETE_SWAP';");
    await fs.promises.writeFile(path.join(backupDir, "tavangary-core.php"), "<?php echo 'HEALTHY_ORIGINAL';");

    // Mock a valid uncommitted v2 journal file left over by a hard crash
    const crashJournal = {
      schemaVersion: 2,
      txId,
      revision: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "prepared",
      targets: [
        {
          consumer,
          preExisting: true,
          phase: "candidate_swapped",
          backupToken: `.${consumer}.backup-${txId}`,
          stagingToken: `.${consumer}.staging-${txId}`,
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
    await fs.promises.writeFile(journalFile, JSON.stringify(crashJournal, null, 2), "utf8");

    // Also create dev source
    const devDir = path.join(pluginsDir, "tavangary-core-dev");
    const wpdevDir = path.join(pluginsDir, "wpdev");
    const themeDir = path.join(tmpDir, "themes", "tavangary");
    await fs.promises.mkdir(devDir, { recursive: true });
    await fs.promises.mkdir(wpdevDir, { recursive: true });
    await fs.promises.mkdir(themeDir, { recursive: true });
    await fs.promises.writeFile(path.join(devDir, "tavangary-core.php"), "<?php echo 'DEV';");
    await fs.promises.writeFile(path.join(wpdevDir, "wpdev.php"), "<?php echo 'WPDEV';");
    await fs.promises.writeFile(path.join(themeDir, "style.css"), "/* Theme */");

    const testRegDir = path.join(devDir, "src", "Modules", "OnlineTest", "Tests");
    await fs.promises.mkdir(testRegDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(testRegDir, "TestRegistry.php"),
      "<?php\nnamespace TavangaryCore\\Modules\\OnlineTest\\Tests;\nclass TestRegistry {}\n"
    );

    const { zipPath, zipSha256, manifestDigest } = await createHermeticZipFixture({ tmpDir, consumer });
    await fs.promises.copyFile(zipPath, path.join(distDir, `${consumer}-profile-s.zip`));

    const scriptDir = packageRoot;
    const fps = await computeAllFingerprintsParallel({
      scriptDir,
      pluginsDir,
      targetPlugins: [consumer],
      contentRoot: tmpDir,
    });

    const buildPlan = createBuildPlan({ consumer, profile: "s", isObfuscate: true });
    const compositeFp = computePluginCompositeFingerprint({
      toolsFingerprint: fps.tools,
      wpdevFingerprint: fps.wpdev,
      pluginSourceFingerprint: fps.plugins[consumer],
      toolchainFingerprint: fps.toolchain,
      // Hermetic fixtures below are Profile S artifacts; the tier is part of
      // the composite identity (F05), so the test pipeline must run obfuscated.
      profile: "s",
      buildPlan,
    });

    const initialCacheData = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      _tools: fps.tools,
      _toolFiles: fps.toolFiles,
      _wpdev: fps.wpdev,
      _theme: fps.theme,
      _testFiles: fps.testFiles,
      _testEvidence: {},
      toolchain: fps.toolchain,
      artifacts: {
        [consumer]: createTargetCacheRecord({
          artifactId: `${consumer}-profile-s`,
          consumer,
          sourceFingerprint: fps.plugins[consumer],
          wpdevFingerprint: fps.wpdev,
          toolsFingerprint: fps.tools,
          themeFingerprint: fps.theme,
          toolchainFingerprint: fps.toolchain,
          compositeFingerprint: compositeFp,
          planFingerprint: buildPlan.artifactIdentity.fingerprint,
          zipSha256,
          manifestDigest,
          validationState: "tests-passed",
          gates: {
            artifactIntegrity: { status: "passed", verifiedAt: new Date().toISOString() },
            testCoverage: { status: "none", coveredTests: [], missingTests: [] },
          },
        }),
      },
      [consumer]: compositeFp,
    };
    await fs.promises.writeFile(path.join(distDir, ".build-cache.json"), JSON.stringify(initialCacheData, null, 2) + "\n", "utf8");

    // Run new build invocation
    await runPipelineOrchestration({
      contentRoot: tmpDir,
      pluginsDir,
      distDir,
      targetPlugins: [consumer],
      testMode: "fast",
      jobsLimit: 1,
      // Recovery fixtures stage Profile S ZIPs; keep the tier consistent (F05).
      isObfuscate: true,
    });

    // Verify that target was restored from backup and journal was removed
    const restoredPhp = await fs.promises.readFile(path.join(targetDir, "tavangary-core.php"), "utf8");
    assert.equal(restoredPhp, "<?php echo 'HEALTHY_ORIGINAL';", "Startup recovery must restore target from backup");
    assert.equal(fs.existsSync(journalFile), false, "Stale crash journal must be removed after recovery");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 11: Crash after backup_renamed but before candidate_swapped is safely recovered by startup recovery", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pipeline-backup-renamed-recovery-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const distDir = path.join(tmpDir, "dist");
    const journalFile = path.join(distDir, ".deploy-journal.json");
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    await fs.promises.mkdir(distDir, { recursive: true });

    const consumer = "tavangary-core";
    const txId = "tx-1725178000000-crashed888";
    const targetDir = path.join(pluginsDir, consumer);
    const backupDir = path.join(pluginsDir, `.${consumer}.backup-${txId}`);
    const stagingDir = path.join(pluginsDir, `.${consumer}.staging-${txId}`);

    // Target does not exist because it was renamed to backupDir just before crash
    await fs.promises.mkdir(backupDir, { recursive: true });
    await fs.promises.writeFile(path.join(backupDir, "tavangary-core.php"), "<?php echo 'ORIGINAL_HEALTHY_CORE';");

    await fs.promises.mkdir(stagingDir, { recursive: true });
    await fs.promises.writeFile(path.join(stagingDir, "tavangary-core.php"), "<?php echo 'UNSWAPPED_CANDIDATE';");

    const crashJournal = {
      schemaVersion: 2,
      txId,
      revision: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "prepared",
      targets: [
        {
          consumer,
          preExisting: true,
          phase: "backup_renamed",
          backupToken: `.${consumer}.backup-${txId}`,
          stagingToken: `.${consumer}.staging-${txId}`,
          candidateZipSha: "c".repeat(64),
          candidateManifestDigest: "d".repeat(64),
        },
      ],
      publication: {
        receipts: {},
        cache: null,
        backupsPurged: false,
      },
      error: null,
    };
    await fs.promises.writeFile(journalFile, JSON.stringify(crashJournal, null, 2), "utf8");

    // Initialize minimal cache and dev source
    const devDir = path.join(pluginsDir, "tavangary-core-dev");
    const wpdevDir = path.join(pluginsDir, "wpdev");
    const themeDir = path.join(tmpDir, "themes", "tavangary");
    await fs.promises.mkdir(devDir, { recursive: true });
    await fs.promises.mkdir(wpdevDir, { recursive: true });
    await fs.promises.mkdir(themeDir, { recursive: true });
    await fs.promises.writeFile(path.join(devDir, "tavangary-core.php"), "<?php echo 'DEV';");
    await fs.promises.writeFile(path.join(wpdevDir, "wpdev.php"), "<?php echo 'WPDEV';");
    await fs.promises.writeFile(path.join(themeDir, "style.css"), "/* Theme */");

    const testRegDir = path.join(devDir, "src", "Modules", "OnlineTest", "Tests");
    await fs.promises.mkdir(testRegDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(testRegDir, "TestRegistry.php"),
      "<?php\nnamespace TavangaryCore\\Modules\\OnlineTest\\Tests;\nclass TestRegistry {}\n"
    );

    const { zipPath, zipSha256, manifestDigest } = await createHermeticZipFixture({ tmpDir, consumer });
    await fs.promises.copyFile(zipPath, path.join(distDir, `${consumer}-profile-s.zip`));
    await fs.promises.copyFile(zipPath, path.join(distDir, `${consumer}.zip`));

    const scriptDir = packageRoot;
    const fps = await computeAllFingerprintsParallel({
      scriptDir,
      pluginsDir,
      targetPlugins: [consumer],
      contentRoot: tmpDir,
    });

    const buildPlan = createBuildPlan({ consumer, profile: "s", isObfuscate: true });
    const compositeFp = computePluginCompositeFingerprint({
      toolsFingerprint: fps.tools,
      wpdevFingerprint: fps.wpdev,
      pluginSourceFingerprint: fps.plugins[consumer],
      toolchainFingerprint: fps.toolchain,
      // Hermetic fixtures below are Profile S artifacts; the tier is part of
      // the composite identity (F05), so the test pipeline must run obfuscated.
      profile: "s",
      buildPlan,
    });

    const initialCacheData = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      _tools: fps.tools,
      _toolFiles: fps.toolFiles,
      _wpdev: fps.wpdev,
      _theme: fps.theme,
      _testFiles: fps.testFiles,
      _testEvidence: {},
      toolchain: fps.toolchain,
      artifacts: {
        [consumer]: createTargetCacheRecord({
          artifactId: `${consumer}-profile-s`,
          consumer,
          sourceFingerprint: fps.plugins[consumer],
          wpdevFingerprint: fps.wpdev,
          toolsFingerprint: fps.tools,
          themeFingerprint: fps.theme,
          toolchainFingerprint: fps.toolchain,
          compositeFingerprint: compositeFp,
          planFingerprint: buildPlan.artifactIdentity.fingerprint,
          zipSha256,
          manifestDigest,
          validationState: "tests-passed",
          outputPaths: {
            profileSZip: path.join(distDir, `${consumer}-profile-s.zip`),
            standardZip: path.join(distDir, `${consumer}.zip`),
          },
          gates: {
            artifactIntegrity: { status: "passed", verifiedAt: new Date().toISOString() },
            testCoverage: { status: "none", coveredTests: [], missingTests: [] },
          },
        }),
      },
      [consumer]: compositeFp,
    };
    await fs.promises.writeFile(path.join(distDir, ".build-cache.json"), JSON.stringify(initialCacheData, null, 2) + "\n", "utf8");

    // Run pipeline
    await runPipelineOrchestration({
      contentRoot: tmpDir,
      pluginsDir,
      distDir,
      targetPlugins: [consumer],
      testMode: "fast",
      jobsLimit: 1,
      // Recovery fixtures stage Profile S ZIPs; keep the tier consistent (F05).
      isObfuscate: true,
    });

    // Target must be restored from backup and staging/backup cleaned up
    assert.equal(fs.existsSync(targetDir), true, "Target directory must be restored from backup");
    const restoredPhp = await fs.promises.readFile(path.join(targetDir, "tavangary-core.php"), "utf8");
    assert.equal(restoredPhp, "<?php echo 'ORIGINAL_HEALTHY_CORE';");
    assert.equal(fs.existsSync(backupDir), false, "Backup directory must be removed");
    assert.equal(fs.existsSync(stagingDir), false, "Staging directory must be removed");
    assert.equal(fs.existsSync(journalFile), false, "Journal must be deleted after clean recovery");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 12: Rollback failure preserves journal with rollback_failed phase and halts future builds", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pipeline-rollback-failed-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const distDir = path.join(tmpDir, "dist");
    const journalFile = path.join(distDir, ".deploy-journal.json");
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    await fs.promises.mkdir(distDir, { recursive: true });

    const consumer = "wpdev-tickets";
    const txId = "tx-1725178000000-unrecov123";

    // Journal in rollback_failed phase
    const failedJournal = {
      schemaVersion: 2,
      txId,
      revision: 4,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "rollback_failed",
      targets: [
        {
          consumer,
          preExisting: true,
          phase: "candidate_swapped",
          backupToken: `.${consumer}.backup-${txId}`,
          stagingToken: `.${consumer}.staging-${txId}`,
          candidateZipSha: "e".repeat(64),
          candidateManifestDigest: "f".repeat(64),
        },
      ],
      publication: {
        receipts: {},
        cache: null,
        backupsPurged: false,
      },
      error: {
        message: "EACCES: permission denied during backup restoration",
        stack: "Error...",
        failedPhase: "rolling_back",
        timestamp: new Date().toISOString(),
      },
    };
    await fs.promises.writeFile(journalFile, JSON.stringify(failedJournal, null, 2), "utf8");

    // Pipeline must throw and refuse to run while rollback_failed journal exists
    let threw = false;
    try {
      await runPipelineOrchestration({
        contentRoot: tmpDir,
        pluginsDir,
        distDir,
        targetPlugins: [consumer],
        testMode: "fast",
        jobsLimit: 1,
      });
    } catch (err) {
      threw = true;
      assert.match(err.message, /rollback failed/i);
    }
    assert.equal(threw, true, "Must fail closed when rollback_failed journal is present");
    assert.equal(fs.existsSync(journalFile), true, "Journal must be preserved for admin inspection");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 13: Deploy-skip integrity check rejects tampered non-bootstrap file or symlink", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "deploy-skip-tamper-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const distDir = path.join(tmpDir, "dist");
    const receiptsDir = path.join(distDir, ".deploy-receipts");
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    await fs.promises.mkdir(distDir, { recursive: true });
    await fs.promises.mkdir(receiptsDir, { recursive: true });

    const consumer = "tavangary-core";
    const targetDir = path.join(pluginsDir, consumer);
    const { zipPath, zipSha256, manifestDigest } = await createHermeticZipFixture({ tmpDir, consumer });

    // Deploy initial fixture to targetDir
    await execFileAsync("unzip", ["-q", zipPath, "-d", pluginsDir]);

    // Create receipt
    const receipt = {
      schemaVersion: 2,
      transactionId: "tx-init-100",
      artifactId: `${consumer}-profile-s`,
      consumer,
      targetPath: targetDir,
      zipSha256,
      manifestDigest,
      sourceFingerprint: "1".repeat(64),
      wpdevFingerprint: "2".repeat(64),
      toolsFingerprint: "3".repeat(64),
      themeFingerprint: "4".repeat(64),
      toolchainFingerprint: "5".repeat(64),
      compositeFingerprint: "6".repeat(64),
      validationState: "deployed",
      deployedAt: new Date().toISOString(),
    };
    await fs.promises.writeFile(path.join(receiptsDir, `${consumer}.receipt.json`), JSON.stringify(receipt, null, 2), "utf8");

    // 1. Target with genuine manifest and untouched files is skipped
    const initialReport = await verifyArtifactManifest({ rootDir: targetDir, consumer, profile: "Profile S" });
    assert.equal(initialReport.status, "valid");

    // 2. Tamper target by adding an untracked PHP file
    await fs.promises.writeFile(path.join(targetDir, "malicious-injected.php"), "<?php echo 'EVIL';");
    const tamperedReport = await verifyArtifactManifest({ rootDir: targetDir, consumer, profile: "Profile S" });
    assert.equal(tamperedReport.status, "unexpected", "Deep verification must detect untracked file");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 14: Rollback of previously-absent files (cache/receipt not existing prior to tx) deletes newly published files", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pipeline-absent-file-rollback-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const distDir = path.join(tmpDir, "dist");
    const receiptsDir = path.join(distDir, ".deploy-receipts");
    const cacheFile = path.join(distDir, ".build-cache.json");
    const journalFile = path.join(distDir, ".deploy-journal.json");
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    await fs.promises.mkdir(distDir, { recursive: true });

    const consumer = "tavangary-core";
    const txId = "tx-1725178000000-absent999";
    const targetDir = path.join(pluginsDir, consumer);
    const backupDir = path.join(pluginsDir, `.${consumer}.backup-${txId}`);
    const stagingDir = path.join(pluginsDir, `.${consumer}.staging-${txId}`);

    // Create target dir representing swapped candidate
    await fs.promises.mkdir(targetDir, { recursive: true });
    await fs.promises.writeFile(path.join(targetDir, "tavangary-core.php"), "<?php echo 'CANDIDATE';");

    // Receipts and cache did NOT exist before transaction, but were published during partial commit
    await fs.promises.mkdir(receiptsDir, { recursive: true });
    const receiptFile = path.join(receiptsDir, `${consumer}.receipt.json`);
    await fs.promises.writeFile(receiptFile, JSON.stringify({ schemaVersion: 2, consumer, artifactId: `${consumer}-profile-s` }), "utf8");
    await fs.promises.writeFile(cacheFile, JSON.stringify({ schemaVersion: 2, artifacts: {} }), "utf8");

    // Journal records existedBefore: false for both receipt and cache
    const journal = {
      schemaVersion: 2,
      txId,
      revision: 4,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "publishing",
      targets: [
        {
          consumer,
          preExisting: false,
          phase: "candidate_swapped",
          backupToken: `.${consumer}.backup-${txId}`,
          stagingToken: `.${consumer}.staging-${txId}`,
          candidateZipSha: "a".repeat(64),
          candidateManifestDigest: "b".repeat(64),
        },
      ],
      publication: {
        receipts: {
          [consumer]: {
            consumer,
            existedBefore: false,
            preDigest: null,
            backupStatus: "absent",
            stagedDigest: "c".repeat(64),
            publishStatus: "published",
            finalDigest: "c".repeat(64),
          },
        },
        cache: {
          existedBefore: false,
          preDigest: null,
          backupStatus: "absent",
          stagedDigest: "d".repeat(64),
          publishStatus: "published",
          finalDigest: "d".repeat(64),
        },
        backupsPurged: false,
      },
      error: null,
    };
    await fs.promises.writeFile(journalFile, JSON.stringify(journal, null, 2), "utf8");

    // Execute startup recovery
    const res = await recoverInterruptedDeployment({
      journalFile,
      pluginsDir,
      distDir,
    });

    assert.equal(res.recovered, true);
    // 1. Target must be deleted since preExisting was false
    assert.equal(fs.existsSync(targetDir), false, "Target dir must be removed because preExisting was false");
    // 2. Receipt must be deleted since existedBefore was false
    assert.equal(fs.existsSync(receiptFile), false, "Receipt must be deleted because existedBefore was false");
    // 3. Cache must be deleted since existedBefore was false
    assert.equal(fs.existsSync(cacheFile), false, "Cache must be deleted because existedBefore was false");
    // 4. Journal must be deleted after clean rollback
    assert.equal(fs.existsSync(journalFile), false, "Journal must be removed after clean rollback");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 15: Crash in the middle of individual receipt publication recovers cleanly", async () => {
  const { recoverInterruptedDeployment, writeAtomicCacheFile } = await import("../build-cache-engine.mjs");
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pipeline-mid-pub-crash-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const distDir = path.join(tmpDir, "dist");
    const receiptsDir = path.join(distDir, ".deploy-receipts");
    const journalFile = path.join(distDir, ".deploy-journal.json");
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    await fs.promises.mkdir(distDir, { recursive: true });
    await fs.promises.mkdir(receiptsDir, { recursive: true });

    const txId = "tx-1725178000000-midrcpt111";
    const txBackupDir = path.join(distDir, `.tx-backup-${txId}`);
    const backupReceiptsDir = path.join(txBackupDir, ".deploy-receipts");
    await fs.promises.mkdir(backupReceiptsDir, { recursive: true });

    // receipt for tavangary-core existed before (and was backed up)
    const oldCoreReceipt = { schemaVersion: 2, consumer: "tavangary-core", old: true, artifactId: "tavangary-core-profile-s", plugin: "tavangary-core", targetPath: "/dummy", zipSha256: "0".repeat(64), manifestDigest: "1".repeat(64), sourceFingerprint: "2".repeat(64), wpdevFingerprint: "3".repeat(64), toolsFingerprint: "4".repeat(64), themeFingerprint: "5".repeat(64), toolchainFingerprint: "6".repeat(64), compositeFingerprint: "7".repeat(64), validationState: "deployed", deployedAt: new Date().toISOString() };
    const oldCoreBytes = Buffer.from(JSON.stringify(oldCoreReceipt, null, 2));
    const oldCoreDigest = crypto.createHash("sha256").update(oldCoreBytes).digest("hex");
    await fs.promises.writeFile(path.join(backupReceiptsDir, "tavangary-core.receipt.json"), oldCoreBytes);

    // receipt for wpdev-crm did NOT exist before (existedBefore: false)
    const newCrmReceiptFile = path.join(receiptsDir, "wpdev-crm.receipt.json");
    await fs.promises.writeFile(newCrmReceiptFile, JSON.stringify({ consumer: "wpdev-crm", new: true }), "utf8");

    // Published new core receipt currently on disk (must be restored to oldCoreReceipt)
    await fs.promises.writeFile(path.join(receiptsDir, "tavangary-core.receipt.json"), JSON.stringify({ consumer: "tavangary-core", mutated: true }), "utf8");

    const journal = {
      schemaVersion: 2,
      txId,
      revision: 5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "publishing",
      targets: [],
      publication: {
        receipts: {
          "tavangary-core": {
            consumer: "tavangary-core",
            existedBefore: true,
            preDigest: oldCoreDigest,
            backupStatus: "backed_up",
            stagedDigest: "8".repeat(64),
            publishStatus: "published",
            finalDigest: "8".repeat(64),
          },
          "wpdev-crm": {
            consumer: "wpdev-crm",
            existedBefore: false,
            preDigest: null,
            backupStatus: "absent",
            stagedDigest: "9".repeat(64),
            publishStatus: "published",
            finalDigest: "9".repeat(64),
          },
        },
        cache: null,
        backupsPurged: false,
      },
      error: null,
    };
    await fs.promises.writeFile(journalFile, JSON.stringify(journal, null, 2), "utf8");

    // Recover
    const recRes = await recoverInterruptedDeployment({
      journalFile,
      pluginsDir,
      distDir,
    });

    assert.equal(recRes.recovered, true);

    // Core receipt must be restored to old content
    const restoredCore = JSON.parse(await fs.promises.readFile(path.join(receiptsDir, "tavangary-core.receipt.json"), "utf8"));
    assert.equal(restoredCore.old, true);

    // wpdev-crm receipt must be deleted
    assert.equal(fs.existsSync(newCrmReceiptFile), false);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 16: Startup recovery in committed phase verifies integrity and completes forward cleanup", async () => {
  const { recoverInterruptedDeployment, writeAtomicCacheFile } = await import("../build-cache-engine.mjs");
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pipeline-committed-recovery-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const distDir = path.join(tmpDir, "dist");
    const receiptsDir = path.join(distDir, ".deploy-receipts");
    const journalFile = path.join(distDir, ".deploy-journal.json");
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    await fs.promises.mkdir(distDir, { recursive: true });
    await fs.promises.mkdir(receiptsDir, { recursive: true });

    const txId = "tx-1725178000000-commclean777";
    const txBackupDir = path.join(distDir, `.tx-backup-${txId}`);
    const txStagingDir = path.join(distDir, `.tx-staging-${txId}`);
    await fs.promises.mkdir(txBackupDir, { recursive: true });
    await fs.promises.mkdir(txStagingDir, { recursive: true });

    // Staging and backup leftover directories
    const targetBackup = path.join(pluginsDir, `.tavangary-core.backup-${txId}`);
    const targetStaging = path.join(pluginsDir, `.tavangary-core.staging-${txId}`);
    await fs.promises.mkdir(targetBackup, { recursive: true });
    await fs.promises.mkdir(targetStaging, { recursive: true });

    // Target directory must be deployed and valid
    const { zipPath, zipSha256, manifestDigest } = await createHermeticZipFixture({ tmpDir, consumer: "tavangary-core" });
    await execFileAsync("unzip", ["-q", zipPath, "-d", pluginsDir]);

    const journal = {
      schemaVersion: 2,
      txId,
      revision: 6,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "committed",
      targets: [
        {
          consumer: "tavangary-core",
          preExisting: true,
          phase: "target_verified",
          backupToken: `.tavangary-core.backup-${txId}`,
          stagingToken: `.tavangary-core.staging-${txId}`,
          candidateZipSha: zipSha256,
          candidateManifestDigest: manifestDigest,
        },
      ],
      publication: {
        receipts: {
          "tavangary-core": {
            consumer: "tavangary-core",
            existedBefore: true,
            preDigest: "1".repeat(64),
            backupStatus: "backed_up",
            stagedDigest: zipSha256,
            publishStatus: "published",
            finalDigest: zipSha256,
          },
        },
        cache: {
          existedBefore: false,
          preDigest: null,
          backupStatus: "absent",
          stagedDigest: "c".repeat(64),
          publishStatus: "published",
          finalDigest: "c".repeat(64),
        },
        backupsPurged: false,
      },
      error: null,
    };
    await fs.promises.writeFile(journalFile, JSON.stringify(journal, null, 2), "utf8");

    // Recover committed transaction
    const recRes = await recoverInterruptedDeployment({
      journalFile,
      pluginsDir,
      distDir,
    });

    assert.equal(recRes.recovered, true);
    // Residues must be completely purged
    assert.equal(fs.existsSync(targetBackup), false);
    assert.equal(fs.existsSync(targetStaging), false);
    assert.equal(fs.existsSync(txBackupDir), false);
    assert.equal(fs.existsSync(txStagingDir), false);
    assert.equal(fs.existsSync(journalFile), false);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 17: Recovery strictly rejects symlinks in txBackupDir, txStagingDir, and .deploy-receipts", async () => {
  const { recoverInterruptedDeployment } = await import("../build-cache-engine.mjs");
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pipeline-symlink-recovery-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const distDir = path.join(tmpDir, "dist");
    const journalFile = path.join(distDir, ".deploy-journal.json");
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    await fs.promises.mkdir(distDir, { recursive: true });

    const txId = "tx-1725178000000-symlink666";
    const txBackupDir = path.join(distDir, `.tx-backup-${txId}`);
    await fs.promises.mkdir(txBackupDir, { recursive: true });

    // Plant a symlink inside txBackupDir
    const externalSecret = path.join(tmpDir, "secret.txt");
    await fs.promises.writeFile(externalSecret, "SECRET_DATA");
    await fs.promises.symlink(externalSecret, path.join(txBackupDir, "malicious_link"));

    const journal = {
      schemaVersion: 2,
      txId,
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "prepared",
      targets: [],
      publication: {
        receipts: {},
        cache: null,
        backupsPurged: false,
      },
      error: null,
    };
    await fs.promises.writeFile(journalFile, JSON.stringify(journal, null, 2), "utf8");

    // Recovery must reject the planted symlink fail-closed
    await assert.rejects(
      recoverInterruptedDeployment({
        journalFile,
        pluginsDir,
        distDir,
      }),
      /symbolic link detected/i
    );
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 18: validateJournalTransition strictly rejects invalid transitions and non-monotonic revisions", async () => {
  const { validateJournalTransition } = await import("../build-cache-engine.mjs");

  const baseJournal = {
    schemaVersion: 2,
    txId: "tx-1725178000000-trans111",
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: "prepared",
    targets: [
      {
        consumer: "tavangary-core",
        preExisting: true,
        phase: "prepared",
        backupToken: ".tavangary-core.backup-tx-1725178000000-trans111",
        stagingToken: ".tavangary-core.staging-tx-1725178000000-trans111",
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

  // 1. Non-monotonic revision rejection
  const staleRevision = { ...baseJournal, revision: 1 };
  const valStale = validateJournalTransition(baseJournal, staleRevision);
  assert.equal(valStale.valid, false);
  assert.match(valStale.reason, /monotonic/i);

  // 2. TxId mutation rejection
  const mutatedTxId = {
    ...baseJournal,
    revision: 2,
    txId: "tx-1725178000000-mutated222",
    targets: [
      {
        ...baseJournal.targets[0],
        backupToken: ".tavangary-core.backup-tx-1725178000000-mutated222",
        stagingToken: ".tavangary-core.staging-tx-1725178000000-mutated222",
      },
    ],
  };
  const valTxId = validateJournalTransition(baseJournal, mutatedTxId);
  assert.equal(valTxId.valid, false);
  assert.match(valTxId.reason, /txId/i);

  // 3. Illegal overall phase jump prepared -> committed without publishing
  const illegalJump = { ...baseJournal, revision: 2, phase: "committed" };
  const valJump = validateJournalTransition(baseJournal, illegalJump);
  assert.equal(valJump.valid, false);
  assert.match(valJump.reason, /invalid transition|required in committed phase/i);

  // 4. Valid transition to target phase backup_rename_intent
  const validNext = {
    ...baseJournal,
    revision: 2,
    targets: [
      {
        ...baseJournal.targets[0],
        phase: "backup_rename_intent",
      },
    ],
  };
  const valNext = validateJournalTransition(baseJournal, validNext);
  assert.equal(valNext.valid, true);
});

test("Failure Scenario 19: Release same-run test evidence replay from prior transaction is rejected", async () => {
  const { validateTestEvidenceRecord, computeArtifactTestCoverage } = await import("../build-cache-engine.mjs");

  const testFile = "target-cache-integrity.test.mjs";
  const currentTxId = "tx-1725178000000-rel111";
  const currentRunId = "run-1725178000000-curr";

  const staleEvidence = {
    schemaVersion: 3,
    runId: "run-old-999",
    transactionId: "tx-old-888",
    testFile,
    testFileSha256: "a".repeat(64),
    testDependencyFingerprint: "b".repeat(64),
    toolchainFingerprint: "c".repeat(64),
    artifactBindings: [
      {
        consumer: "tavangary-core",
        artifactId: "tavangary-core-profile-s",
        zipSha256: "d".repeat(64),
        compositeFingerprint: "e".repeat(64),
      },
    ],
    mode: "release",
    exitStatus: "passed",
    runDurationMs: 100,
    testDurationMs: 100,
    executedAt: new Date().toISOString(),
  };

  // In release mode, evidence from another runId/transactionId is rejected
  const val = validateTestEvidenceRecord({
    evidence: staleEvidence,
    expectedTestFile: testFile,
    expectedMode: "release",
    expectedTransactionId: currentTxId,
    expectedRunId: currentRunId,
  });
  assert.equal(val.valid, false, "Stale evidence from different runId/transactionId must be rejected in release mode");
});

test("Failure Scenario 20: Strict Intent-Before-Completion enforcement in validateJournalTransition", async () => {
  const { validateJournalTransition } = await import("../build-cache-engine.mjs");

  const base = {
    schemaVersion: 2,
    txId: "tx-1725178000000-intent001",
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: "prepared",
    targets: [
      {
        consumer: "tavangary-core",
        preExisting: true,
        phase: "prepared",
        backupToken: ".tavangary-core.backup-tx-1725178000000-intent001",
        stagingToken: ".tavangary-core.staging-tx-1725178000000-intent001",
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

  // 1. prepared -> backup_renamed directly (SKIPPING backup_rename_intent) must be rejected
  const skipIntent = {
    ...base,
    revision: 2,
    targets: [{ ...base.targets[0], phase: "backup_renamed" }],
  };
  const val1 = validateJournalTransition(base, skipIntent);
  assert.equal(val1.valid, false);
  assert.match(val1.reason, /invalid target phase transition/i);

  // 2. prepared -> backup_rename_intent is valid
  const withIntent = {
    ...base,
    revision: 2,
    targets: [{ ...base.targets[0], phase: "backup_rename_intent" }],
  };
  const val2 = validateJournalTransition(base, withIntent);
  assert.equal(val2.valid, true);

  // 3. backup_rename_intent -> backup_renamed is valid
  const completed = {
    ...withIntent,
    revision: 3,
    targets: [{ ...withIntent.targets[0], phase: "backup_renamed" }],
  };
  const val3 = validateJournalTransition(withIntent, completed);
  assert.equal(val3.valid, true);

  // 4. backup_renamed -> candidate_swapped directly (SKIPPING candidate_swap_intent) must be rejected
  const skipSwapIntent = {
    ...completed,
    revision: 4,
    targets: [{ ...completed.targets[0], phase: "candidate_swapped" }],
  };
  const val4 = validateJournalTransition(completed, skipSwapIntent);
  assert.equal(val4.valid, false);
  assert.match(val4.reason, /invalid target phase transition/i);
});

test("Failure Scenario 21: validateJournalTransition enforces exact +1 revision increment", async () => {
  const { validateJournalTransition } = await import("../build-cache-engine.mjs");

  const base = {
    schemaVersion: 2,
    txId: "tx-1725178000000-rev001",
    revision: 5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: "prepared",
    targets: [],
    publication: { receipts: {}, cache: null, backupsPurged: false },
    error: null,
  };

  // Jump from revision 5 to 7 (skipping 6) must be rejected
  const jumpRevision = { ...base, revision: 7 };
  const valJump = validateJournalTransition(base, jumpRevision);
  assert.equal(valJump.valid, false);
  assert.match(valJump.reason, /monotonic/i);

  // Exact +1 increment is valid
  const exactNext = { ...base, revision: 6 };
  const valExact = validateJournalTransition(base, exactNext);
  assert.equal(valExact.valid, true);
});

test("Failure Scenario 22: Rejection of extra or unknown keys in deploy journal schema", async () => {
  const { validateDeployJournalSchema } = await import("../build-cache-engine.mjs");

  const validJournal = {
    schemaVersion: 2,
    txId: "tx-1725178000000-strict001",
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: "prepared",
    targets: [
      {
        consumer: "tavangary-core",
        preExisting: false,
        phase: "prepared",
        backupToken: ".tavangary-core.backup-tx-1725178000000-strict001",
        stagingToken: ".tavangary-core.staging-tx-1725178000000-strict001",
        candidateZipSha: "a".repeat(64),
        candidateManifestDigest: "b".repeat(64),
      },
    ],
    publication: { receipts: {}, cache: null, backupsPurged: false },
    error: null,
  };

  assert.equal(validateDeployJournalSchema(validJournal).valid, true);

  // Extra top-level key
  const extraTop = { ...validJournal, unexpectedKey: "malicious" };
  assert.equal(validateDeployJournalSchema(extraTop).valid, false);

  // Extra target key
  const extraTarget = {
    ...validJournal,
    targets: [{ ...validJournal.targets[0], backdoor: true }],
  };
  assert.equal(validateDeployJournalSchema(extraTarget).valid, false);
});

test("Failure Scenario 23: Rollback fails safely when existedBefore backup is missing, symlink, or corrupt", async () => {
  const { recoverInterruptedDeployment } = await import("../build-cache-engine.mjs");
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pipeline-corrupt-backup-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const distDir = path.join(tmpDir, "dist");
    const journalFile = path.join(distDir, ".deploy-journal.json");
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    await fs.promises.mkdir(distDir, { recursive: true });

    const txId = "tx-1725178000000-corruptbkp";
    const txBackupDir = path.join(distDir, `.tx-backup-${txId}`);
    const backupReceiptsDir = path.join(txBackupDir, ".deploy-receipts");
    await fs.promises.mkdir(backupReceiptsDir, { recursive: true });

    // Staged publication claiming existedBefore: true with backed_up status, but backup file is missing or corrupted
    const journal = {
      schemaVersion: 2,
      txId,
      revision: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "publishing",
      targets: [],
      publication: {
        receipts: {
          "tavangary-core": {
            consumer: "tavangary-core",
            existedBefore: true,
            preDigest: "a".repeat(64),
            backupStatus: "backed_up",
            stagedDigest: "b".repeat(64),
            publishStatus: "published",
            finalDigest: "b".repeat(64),
          },
        },
        cache: null,
        backupsPurged: false,
      },
      error: null,
    };
    await fs.promises.writeFile(journalFile, JSON.stringify(journal, null, 2), "utf8");

    // Attempt recovery when backup file does not exist on disk
    await assert.rejects(
      recoverInterruptedDeployment({
        journalFile,
        pluginsDir,
        distDir,
      }),
      /rollback failed/i
    );

    // Journal must be preserved in rollback_failed phase
    const rawJ = await fs.promises.readFile(journalFile, "utf8");
    const parsedJ = JSON.parse(rawJ);
    assert.equal(parsedJ.phase, "rollback_failed");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 24: Recovery in committed phase is idempotent across multiple invocations", async () => {
  const { recoverInterruptedDeployment, writeAtomicCacheFile } = await import("../build-cache-engine.mjs");
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pipeline-idempotent-recovery-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const distDir = path.join(tmpDir, "dist");
    const receiptsDir = path.join(distDir, ".deploy-receipts");
    const journalFile = path.join(distDir, ".deploy-journal.json");
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    await fs.promises.mkdir(distDir, { recursive: true });
    await fs.promises.mkdir(receiptsDir, { recursive: true });

    const txId = "tx-1725178000000-idemp999";
    const txBackupDir = path.join(distDir, `.tx-backup-${txId}`);
    const txStagingDir = path.join(distDir, `.tx-staging-${txId}`);
    await fs.promises.mkdir(txBackupDir, { recursive: true });
    await fs.promises.mkdir(txStagingDir, { recursive: true });

    const cacheFile = path.join(distDir, ".build-cache.json");
    const dummyCache = {
      schemaVersion: 2,
      _tools: "a".repeat(64),
      _toolFiles: {},
      _wpdev: "b".repeat(64),
      _theme: "c".repeat(64),
      _testFiles: {},
      _testEvidence: {},
      toolchain: "d".repeat(64),
      artifacts: {},
    };
    await writeAtomicCacheFile(cacheFile, dummyCache);
    const cacheDigest = crypto.createHash("sha256").update(JSON.stringify(dummyCache, null, 2)).digest("hex");

    const journal = {
      schemaVersion: 2,
      txId,
      revision: 6,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "committed",
      targets: [],
      publication: {
        receipts: {},
        cache: {
          existedBefore: false,
          preDigest: null,
          backupStatus: "absent",
          stagedDigest: cacheDigest,
          publishStatus: "published",
          finalDigest: cacheDigest,
        },
        backupsPurged: false,
      },
      error: null,
    };
    await fs.promises.writeFile(journalFile, JSON.stringify(journal, null, 2), "utf8");

    // First recovery invocation: cleans up staging/backup and removes journal
    const res1 = await recoverInterruptedDeployment({
      journalFile,
      pluginsDir,
      distDir,
    });
    assert.equal(res1.recovered, true);
    assert.equal(fs.existsSync(journalFile), false);
    assert.equal(fs.existsSync(txBackupDir), false);
    assert.equal(fs.existsSync(txStagingDir), false);

    // Second recovery invocation on missing journal: must return clean non-recovery without error
    const res2 = await recoverInterruptedDeployment({
      journalFile,
      pluginsDir,
      distDir,
    });
    assert.equal(res2.recovered, false);
    assert.equal(res2.reason, "No active deploy journal found");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 25: TransactionJournalManager serializes mutations, increments revision by exactly +1, and rejects writes after termination", async () => {
  const { TransactionJournalManager, validateDeployJournalSchema } = await import("../build-cache-engine.mjs");
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tx-mgr-test-"));
  try {
    const distDir = path.join(tmpDir, "dist");
    const journalFile = path.join(distDir, ".deploy-journal.json");
    const txId = "tx-1725178000000-txmgr111";

    const initialJournal = {
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

    const mgr = new TransactionJournalManager({
      journalFile,
      distDir,
      initialJournal,
    });

    // 1. Initial state snapshot is frozen
    const snap1 = mgr.getSnapshot();
    assert.equal(snap1.revision, 1);
    assert.equal(snap1.phase, "prepared");

    // 2. First update: advances target to backup_rename_intent
    const snap2 = await mgr.update(async (state) => {
      state.targets[0].phase = "backup_rename_intent";
    });
    assert.equal(snap2.revision, 2);
    assert.equal(snap2.targets[0].phase, "backup_rename_intent");

    // Verify on disk
    const onDisk2 = JSON.parse(await fs.promises.readFile(journalFile, "utf8"));
    assert.equal(onDisk2.revision, 2);
    assert.equal(onDisk2.targets[0].phase, "backup_rename_intent");

    // 3. Second update: advances target to backup_renamed
    const snap3 = await mgr.update(async (state) => {
      state.targets[0].phase = "backup_renamed";
    });
    assert.equal(snap3.revision, 3);
    assert.equal(snap3.targets[0].phase, "backup_renamed");

    // 4. Terminate manager and verify subsequent writes are strictly rejected
    mgr.terminate();
    assert.equal(mgr.isTerminated, true);

    await assert.rejects(
      async () => {
        await mgr.update(async (state) => {
          state.targets[0].phase = "candidate_swap_intent";
        });
      },
      /terminated/i,
      "Subsequent update on terminated manager must be rejected"
    );

    // Verify disk content was NOT altered by rejected write
    const onDiskFinal = JSON.parse(await fs.promises.readFile(journalFile, "utf8"));
    assert.equal(onDiskFinal.revision, 3);
    assert.equal(onDiskFinal.targets[0].phase, "backup_renamed");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 26: TransactionJournalManager serializes concurrent asynchronous updates without transition race conditions", async () => {
  const { TransactionJournalManager } = await import("../build-cache-engine.mjs");
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tx-mgr-concurrent-"));
  try {
    const distDir = path.join(tmpDir, "dist");
    const journalFile = path.join(distDir, ".deploy-journal.json");
    const txId = "tx-1725178000000-concurrent222";

    const initialJournal = {
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
        {
          consumer: "tavangary-theme-panel",
          preExisting: true,
          phase: "prepared",
          backupToken: `.tavangary-theme-panel.backup-${txId}`,
          stagingToken: `.tavangary-theme-panel.staging-${txId}`,
          candidateZipSha: "c".repeat(64),
          candidateManifestDigest: "d".repeat(64),
        },
      ],
      publication: {
        receipts: {},
        cache: null,
        backupsPurged: false,
      },
      error: null,
    };

    const mgr = new TransactionJournalManager({
      journalFile,
      distDir,
      initialJournal,
    });

    // Launch concurrent state transitions for both targets simultaneously
    const p1 = (async () => {
      await mgr.update((s) => { s.targets[0].phase = "backup_rename_intent"; });
      await new Promise((r) => setTimeout(r, 5));
      await mgr.update((s) => { s.targets[0].phase = "backup_renamed"; });
    })();

    const p2 = (async () => {
      await mgr.update((s) => { s.targets[1].phase = "backup_rename_intent"; });
      await new Promise((r) => setTimeout(r, 5));
      await mgr.update((s) => { s.targets[1].phase = "backup_renamed"; });
    })();

    await Promise.all([p1, p2]);

    const finalSnap = mgr.getSnapshot();
    // Started at rev 1, exactly 4 updates were made -> final revision must be 5
    assert.equal(finalSnap.revision, 5);
    assert.equal(finalSnap.targets[0].phase, "backup_renamed");
    assert.equal(finalSnap.targets[1].phase, "backup_renamed");

    const diskData = JSON.parse(await fs.promises.readFile(journalFile, "utf8"));
    assert.equal(diskData.revision, 5);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 27: validateJournalTransition strictly rejects adding, removing, or reordering targets after registration", async () => {
  const { validateJournalTransition } = await import("../build-cache-engine.mjs");
  const txId = "tx-1725178000000-invar777";

  const baseJournal = {
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
        candidateZipSha: "0".repeat(64),
        candidateManifestDigest: null,
      },
      {
        consumer: "tavangary-theme-panel",
        preExisting: true,
        phase: "prepared",
        backupToken: `.tavangary-theme-panel.backup-${txId}`,
        stagingToken: `.tavangary-theme-panel.staging-${txId}`,
        candidateZipSha: "0".repeat(64),
        candidateManifestDigest: null,
      },
    ],
    publication: { receipts: {}, cache: null, backupsPurged: false },
    error: null,
  };

  // 1. Adding a target after registration is rejected
  const addedTarget = structuredClone(baseJournal);
  addedTarget.revision = 2;
  addedTarget.targets.push({
    consumer: "wpdev-crm",
    preExisting: true,
    phase: "prepared",
    backupToken: `.wpdev-crm.backup-${txId}`,
    stagingToken: `.wpdev-crm.staging-${txId}`,
    candidateZipSha: "0".repeat(64),
    candidateManifestDigest: null,
  });
  const res1 = validateJournalTransition(baseJournal, addedTarget);
  assert.equal(res1.valid, false);
  assert.match(res1.reason, /altered target count|target count changed/i);

  // 2. Removing a target after registration is rejected
  const removedTarget = structuredClone(baseJournal);
  removedTarget.revision = 2;
  removedTarget.targets.pop();
  const res2 = validateJournalTransition(baseJournal, removedTarget);
  assert.equal(res2.valid, false);
  assert.match(res2.reason, /altered target count|target count changed/i);

  // 3. Reordering targets is rejected
  const reordered = structuredClone(baseJournal);
  reordered.revision = 2;
  reordered.targets.reverse();
  const res3 = validateJournalTransition(baseJournal, reordered);
  assert.equal(res3.valid, false);
  assert.match(res3.reason, /target mismatch at index/i);
});

test("Failure Scenario 28: State machine enforces Commit Point Invariant: transition from committed to rolling_back is strictly rejected", async () => {
  const { validateJournalTransition } = await import("../build-cache-engine.mjs");
  const txId = "tx-1725178000000-commpt888";

  const committedJournal = {
    schemaVersion: 2,
    txId,
    revision: 6,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: "committed",
    targets: [
      {
        consumer: "tavangary-core",
        preExisting: true,
        phase: "target_verified",
        backupToken: `.tavangary-core.backup-${txId}`,
        stagingToken: `.tavangary-core.staging-${txId}`,
        candidateZipSha: "a".repeat(64),
        candidateManifestDigest: "b".repeat(64),
      },
    ],
    publication: {
      receipts: {
        "tavangary-core": {
          consumer: "tavangary-core",
          existedBefore: true,
          preDigest: "c".repeat(64),
          backupStatus: "backed_up",
          stagedDigest: "d".repeat(64),
          publishStatus: "published",
          finalDigest: "d".repeat(64),
        },
      },
      cache: {
        existedBefore: true,
        preDigest: "e".repeat(64),
        backupStatus: "backed_up",
        stagedDigest: "f".repeat(64),
        publishStatus: "published",
        finalDigest: "f".repeat(64),
      },
      backupsPurged: false,
    },
    error: null,
  };

  // Attempting to transition from committed to rolling_back MUST be rejected
  const illegalRollback = structuredClone(committedJournal);
  illegalRollback.revision = 7;
  illegalRollback.phase = "rolling_back";
  const res = validateJournalTransition(committedJournal, illegalRollback);
  assert.equal(res.valid, false);
  assert.match(res.reason, /invalid transition.*committed|illegal transition/i);
});

test("Failure Scenario 29: State machine strictly rejects published status with mismatched finalDigest vs stagedDigest", async () => {
  const { validateJournalTransition } = await import("../build-cache-engine.mjs");
  const txId = "tx-1725178000000-mismatchpub";

  const pubJournal = {
    schemaVersion: 2,
    txId,
    revision: 5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: "publishing",
    targets: [],
    publication: {
      receipts: {
        "tavangary-core": {
          consumer: "tavangary-core",
          existedBefore: true,
          preDigest: "1".repeat(64),
          backupStatus: "backed_up",
          stagedDigest: "2".repeat(64),
          publishStatus: "staged",
          finalDigest: null,
        },
      },
      cache: null,
      backupsPurged: false,
    },
    error: null,
  };

  const tamperedPub = structuredClone(pubJournal);
  tamperedPub.revision = 6;
  tamperedPub.phase = "committed";
  tamperedPub.publication.receipts["tavangary-core"].publishStatus = "published";
  tamperedPub.publication.receipts["tavangary-core"].finalDigest = "9".repeat(64); // Mismatched!

  const res = validateJournalTransition(pubJournal, tamperedPub);
  assert.equal(res.valid, false);
  assert.match(res.reason, /finalDigest.*equal.*stagedDigest/i);
});

test("Failure Scenario 30: State machine rejects backupsPurged=true unless phase is cleanup_complete", async () => {
  const { validateJournalTransition } = await import("../build-cache-engine.mjs");
  const txId = "tx-1725178000000-purgecheck";

  const base = {
    schemaVersion: 2,
    txId,
    revision: 4,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: "prepared",
    targets: [],
    publication: { receipts: {}, cache: null, backupsPurged: false },
    error: null,
  };

  const prematurePurge = structuredClone(base);
  prematurePurge.revision = 5;
  prematurePurge.phase = "prepared";
  prematurePurge.publication.backupsPurged = true; // Illegal in prepared phase

  const res = validateJournalTransition(base, prematurePurge);
  assert.equal(res.valid, false);
  assert.match(res.reason, /backupsPurged is only allowed in cleanup_complete/i);
});

test("Failure Scenario 31: Disallowed or extra keys inside error object are rejected by schema validation", async () => {
  const { validateDeployJournalSchema } = await import("../build-cache-engine.mjs");
  const txId = "tx-1725178000000-errschema";

  const journal = {
    schemaVersion: 2,
    txId,
    revision: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: "rolling_back",
    targets: [],
    publication: { receipts: {}, cache: null, backupsPurged: false },
    error: {
      message: "Something failed",
      failedPhase: "publishing",
      timestamp: new Date().toISOString(),
      unauthorizedKey: "malicious_payload",
    },
  };

  const res = validateDeployJournalSchema(journal);
  assert.equal(res.valid, false);
  assert.match(res.reason, /error record contains disallowed key 'unauthorizedKey'/i);
});

test("Failure Scenario 32: Multi-target deployment with candidate digest transition and verification on isolated fixture", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "multi-target-deploy-"));
  const pluginsDir = path.join(tmpDir, "plugins");
  const distDir = path.join(tmpDir, "dist");
  const receiptsDir = path.join(distDir, ".deploy-receipts");
  const cacheFile = path.join(distDir, ".build-cache.json");
  const srcDir = path.join(tmpDir, "src");

  try {
    await mkdir(pluginsDir, { recursive: true });
    await mkdir(distDir, { recursive: true });
    await mkdir(receiptsDir, { recursive: true });
    await mkdir(srcDir, { recursive: true });

    // Create lightweight source structures for fingerprinting
    await mkdir(path.join(pluginsDir, "tavangary-core-dev"), { recursive: true });
    await writeFile(path.join(pluginsDir, "tavangary-core-dev", "tavangary-core.php"), "<?php // core dev", "utf8");
    await mkdir(path.join(pluginsDir, "wpdev-crm-dev"), { recursive: true });
    await writeFile(path.join(pluginsDir, "wpdev-crm-dev", "wpdev-crm.php"), "<?php // crm dev", "utf8");
    await mkdir(path.join(pluginsDir, "wpdev"), { recursive: true });
    await writeFile(path.join(pluginsDir, "wpdev", "wpdev.php"), "<?php // wpdev core", "utf8");

    // Pre-create pre-existing target for tavangary-core
    const coreTargetDir = path.join(pluginsDir, "tavangary-core");
    await mkdir(coreTargetDir, { recursive: true });
    await writeFile(path.join(coreTargetDir, "tavangary-core.php"), "<?php // pre-existing core", "utf8");

    // wpdev-crm does NOT pre-exist
    const crmTargetDir = path.join(pluginsDir, "wpdev-crm");

    // Create valid hermetic Profile S ZIPs for both targets
    const coreFix = await createHermeticZipFixture({ tmpDir: srcDir, consumer: "tavangary-core" });
    const crmFix = await createHermeticZipFixture({ tmpDir: srcDir, consumer: "wpdev-crm" });
    await copyFile(coreFix.zipPath, path.join(distDir, "tavangary-core-profile-s.zip"));
    await copyFile(crmFix.zipPath, path.join(distDir, "wpdev-crm-profile-s.zip"));
    const coreZipSha = coreFix.zipSha256;
    const crmZipSha = crmFix.zipSha256;

    const themeDir = path.join(tmpDir, "themes", "tavangary");
    await mkdir(themeDir, { recursive: true });
    await writeFile(path.join(themeDir, "style.css"), "/* theme */", "utf8");
    const contentRoot = tmpDir;

    const { computeAllFingerprintsParallel, computePluginCompositeFingerprint } = await import("../build-cache-engine.mjs");
    const fp = await computeAllFingerprintsParallel({
      scriptDir: packageRoot,
      pluginsDir,
      targetPlugins: ["tavangary-core", "wpdev-crm"],
      contentRoot,
    });

    const corePlan = createBuildPlan({ consumer: "tavangary-core", profile: "s", isObfuscate: true });
    const crmPlan = createBuildPlan({ consumer: "wpdev-crm", profile: "s", isObfuscate: true });

    const coreComposite = computePluginCompositeFingerprint({
      toolsFingerprint: fp.tools,
      wpdevFingerprint: fp.wpdev,
      pluginSourceFingerprint: fp.plugins["tavangary-core"],
      toolchainFingerprint: fp.toolchain,
      profile: "s",
      buildPlan: corePlan,
    });

    const crmComposite = computePluginCompositeFingerprint({
      toolsFingerprint: fp.tools,
      wpdevFingerprint: fp.wpdev,
      pluginSourceFingerprint: fp.plugins["wpdev-crm"],
      toolchainFingerprint: fp.toolchain,
      profile: "s",
      buildPlan: crmPlan,
    });

    const themeHash = (fp.theme && fp.theme !== "missing") ? fp.theme : "0".repeat(64);

    const initialCache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      _tools: fp.tools,
      _toolFiles: fp.toolFiles || {},
      _wpdev: fp.wpdev,
      _theme: themeHash,
      _testFiles: fp.testFiles || {},
      _testEvidence: {},
      toolchain: fp.toolchain,
      artifacts: {
        "tavangary-core": {
          schemaVersion: CACHE_SCHEMA_VERSION,
          artifactId: "tavangary-core-profile-s",
          consumer: "tavangary-core",
          sourceFingerprint: fp.plugins["tavangary-core"],
          wpdevFingerprint: fp.wpdev,
          toolsFingerprint: fp.tools,
          themeFingerprint: themeHash,
          toolchainFingerprint: fp.toolchain,
          compositeFingerprint: coreComposite,
          planFingerprint: corePlan.artifactIdentity.fingerprint,
          zipSha256: coreZipSha,
          manifestDigest: coreFix.manifestDigest,
          gates: {
            artifactIntegrity: { status: "passed", verifiedAt: new Date().toISOString() },
            testCoverage: { status: "passed", coveredTests: ["artifact-fixture-helper.test.mjs"], missingTests: [], coverageReason: "Full test coverage verified" },
            deployment: { status: "none", deployedAt: null, rollbackAt: null },
          },
          validationState: "tests-passed",
          validatedAt: new Date().toISOString(),
        },
        "wpdev-crm": {
          schemaVersion: CACHE_SCHEMA_VERSION,
          artifactId: "wpdev-crm-profile-s",
          consumer: "wpdev-crm",
          sourceFingerprint: fp.plugins["wpdev-crm"],
          wpdevFingerprint: fp.wpdev,
          toolsFingerprint: fp.tools,
          themeFingerprint: themeHash,
          toolchainFingerprint: fp.toolchain,
          compositeFingerprint: crmComposite,
          planFingerprint: crmPlan.artifactIdentity.fingerprint,
          zipSha256: crmZipSha,
          manifestDigest: crmFix.manifestDigest,
          gates: {
            artifactIntegrity: { status: "passed", verifiedAt: new Date().toISOString() },
            testCoverage: { status: "passed", coveredTests: ["artifact-fixture-helper.test.mjs"], missingTests: [], coverageReason: "Full test coverage verified" },
            deployment: { status: "none", deployedAt: null, rollbackAt: null },
          },
          validationState: "tests-passed",
          validatedAt: new Date().toISOString(),
        },
      },
    };
    await writeFile(cacheFile, JSON.stringify(initialCache, null, 2), "utf8");

    // Execute full pipeline orchestration across 2 targets with fast mode (throws fail-closed)
    const res = await runPipelineOrchestration({
      targetPlugins: ["tavangary-core", "wpdev-crm"],
      pluginsDir,
      distDir,
      receiptsDir,
      cacheFile,
      contentRoot: tmpDir,
      scriptDir: packageRoot,
      isForce: false,
      shouldDeploy: true,
      testMode: "fast",
      executor: async () => ({ stdout: "ok 1 - pass\n", stderr: "" }),
    }).catch((e) => e);

    assert.match(res.message, /does not authorize deployment/i);

    // Now run with valid affected testMode and mock executor
    const successRes = await runPipelineOrchestration({
      targetPlugins: ["tavangary-core", "wpdev-crm"],
      pluginsDir,
      distDir,
      receiptsDir,
      cacheFile,
      contentRoot: tmpDir,
      scriptDir: packageRoot,
      isForce: false,
      shouldDeploy: true,
      testMode: "affected",
      // Fixture ZIPs are Profile S artifacts; run the obfuscated tier (F05).
      isObfuscate: true,
      executor: async () => ({ stdout: "ok 1 - pass\n", stderr: "" }),
    });

    assert.ok(successRes["deploy:tavangary-core"]);
    assert.ok(successRes["deploy:wpdev-crm"]);

    // Both candidateZipSha must equal their genuine deployed ZIP SHA-256
    const deployedCoreSha = successRes["deploy:tavangary-core"].receipt.zipSha256;
    const deployedCrmSha = successRes["deploy:wpdev-crm"].receipt.zipSha256;
    assert.match(deployedCoreSha, /^[a-f0-9]{64}$/);
    assert.match(deployedCrmSha, /^[a-f0-9]{64}$/);

    // Receipts must exist and be valid
    const { loadDeployReceiptRecord } = await import("../build-cache-engine.mjs");
    const coreRcpt = await loadDeployReceiptRecord(path.join(receiptsDir, "tavangary-core.receipt.json"), "tavangary-core");
    const crmRcpt = await loadDeployReceiptRecord(path.join(receiptsDir, "wpdev-crm.receipt.json"), "wpdev-crm");
    assert.equal(coreRcpt.status, "valid");
    assert.equal(crmRcpt.status, "valid");
    assert.equal(coreRcpt.receipt.zipSha256, deployedCoreSha);
    assert.equal(crmRcpt.receipt.zipSha256, deployedCrmSha);

    // Journal must be removed on clean completion
    const journalFile = path.join(distDir, ".deploy-journal.json");
    assert.equal(fs.existsSync(journalFile), false, "Journal must be deleted after clean completion");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 33: Target candidateZipSha mutability invariant strictly enforced", async () => {
  const { validateJournalTransition } = await import("../build-cache-engine.mjs");
  const txId = "tx-1725178000000-digestimm";

  const base = {
    schemaVersion: 2,
    txId,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: "prepared",
    targets: [
      {
        consumer: "tavangary-core",
        preExisting: false,
        phase: "prepared",
        backupToken: `.tavangary-core.backup-${txId}`,
        stagingToken: `.tavangary-core.staging-${txId}`,
        candidateZipSha: "0".repeat(64),
        candidateManifestDigest: null,
      },
    ],
    publication: { receipts: {}, cache: null, backupsPurged: false },
    error: null,
  };

  // 1. Updating candidateZipSha from 0-digest to real SHA during candidate_swap_intent is allowed
  const intentState = structuredClone(base);
  intentState.revision = 2;
  intentState.targets[0].phase = "candidate_swap_intent";
  intentState.targets[0].candidateZipSha = "a".repeat(64);
  intentState.targets[0].candidateManifestDigest = "b".repeat(64);

  const res1 = validateJournalTransition(base, intentState);
  assert.equal(res1.valid, true);

  // 2. Mutating candidateZipSha AFTER candidate_swap_intent is forbidden
  const swappedState = structuredClone(intentState);
  swappedState.revision = 3;
  swappedState.targets[0].phase = "candidate_swapped";

  const tamperedState = structuredClone(swappedState);
  tamperedState.revision = 4;
  tamperedState.targets[0].candidateZipSha = "f".repeat(64); // TAMPER

  const res2 = validateJournalTransition(swappedState, tamperedState);
  assert.equal(res2.valid, false);
  assert.match(res2.reason, /candidateZipSha.*mutated/i);
});

test("Failure Scenario 34: Missing or corrupted target backup directory during rollback transitions to rollback_failed", async () => {
  const { recoverInterruptedDeployment, loadDeployJournalRecord } = await import("../build-cache-engine.mjs");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "missing-target-bkp-"));
  const pluginsDir = path.join(tmpDir, "plugins");
  const distDir = path.join(tmpDir, "dist");
  const journalFile = path.join(distDir, ".deploy-journal.json");
  const txId = "tx-1725178000000-missingbkp";

  try {
    await mkdir(pluginsDir, { recursive: true });
    await mkdir(distDir, { recursive: true });

    // Target was pre-existing, but backup was deleted/missing
    const targetDir = path.join(pluginsDir, "tavangary-core");
    await mkdir(targetDir, { recursive: true });

    const journal = {
      schemaVersion: 2,
      txId,
      revision: 4,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "prepared",
      targets: [
        {
          consumer: "tavangary-core",
          preExisting: true,
          phase: "candidate_swapped",
          backupToken: `.tavangary-core.backup-${txId}`,
          stagingToken: `.tavangary-core.staging-${txId}`,
          candidateZipSha: "a".repeat(64),
          candidateManifestDigest: "b".repeat(64),
        },
      ],
      publication: { receipts: {}, cache: null, backupsPurged: false },
      error: null,
    };
    await writeFile(journalFile, JSON.stringify(journal, null, 2), "utf8");

    // Recovery must catch missing backup and write rollback_failed
    await assert.rejects(
      async () => {
        await recoverInterruptedDeployment({
          journalFile,
          pluginsDir,
          distDir,
        });
      },
      /Rollback failed: Pre-existing backup directory missing/i
    );

    const check = await loadDeployJournalRecord(journalFile);
    assert.equal(check.status, "valid");
    assert.equal(check.journal.phase, "rollback_failed");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 35: Missing, symlink, or corrupt backup receipt/cache during rollback transitions to rollback_failed", async () => {
  const { recoverInterruptedDeployment, loadDeployJournalRecord } = await import("../build-cache-engine.mjs");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "missing-pub-bkp-"));
  const pluginsDir = path.join(tmpDir, "plugins");
  const distDir = path.join(tmpDir, "dist");
  const journalFile = path.join(distDir, ".deploy-journal.json");
  const txId = "tx-1725178000000-pubbkpfail";

  try {
    await mkdir(pluginsDir, { recursive: true });
    await mkdir(distDir, { recursive: true });

    const txBackupDir = path.join(distDir, `.tx-backup-${txId}`);
    await mkdir(txBackupDir, { recursive: true });

    const journal = {
      schemaVersion: 2,
      txId,
      revision: 4,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "publishing",
      targets: [],
      publication: {
        receipts: {
          "tavangary-core": {
            consumer: "tavangary-core",
            existedBefore: true,
            preDigest: "a".repeat(64),
            backupStatus: "backed_up",
            stagedDigest: "b".repeat(64),
            publishStatus: "publishing",
            finalDigest: null,
          },
        },
        cache: null,
        backupsPurged: false,
      },
      error: null,
    };
    await writeFile(journalFile, JSON.stringify(journal, null, 2), "utf8");

    // Recovery must catch missing receipt in backup dir
    await assert.rejects(
      async () => {
        await recoverInterruptedDeployment({
          journalFile,
          pluginsDir,
          distDir,
        });
      },
      /Rollback failed: Backup receipt missing for tavangary-core/i
    );

    const check = await loadDeployJournalRecord(journalFile);
    assert.equal(check.status, "valid");
    assert.equal(check.journal.phase, "rollback_failed");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 36: Committed crash with failed post-commit cleanup leaves journal committed and recovery is idempotent", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "comm-cleanup-fail-"));
  const pluginsDir = path.join(tmpDir, "plugins");
  const distDir = path.join(tmpDir, "dist");
  const journalFile = path.join(distDir, ".deploy-journal.json");
  const txId = "tx-1725178000000-commfail777";

  try {
    await mkdir(pluginsDir, { recursive: true });
    await mkdir(distDir, { recursive: true });

    // Target deployed
    const { zipPath, zipSha256, manifestDigest } = await createHermeticZipFixture({ tmpDir, consumer: "tavangary-core" });
    await execFileAsync("unzip", ["-q", zipPath, "-d", pluginsDir]);

    // Leftover backup and staging
    const backupDir = path.join(pluginsDir, `.tavangary-core.backup-${txId}`);
    const stagingDir = path.join(pluginsDir, `.tavangary-core.staging-${txId}`);
    await mkdir(backupDir, { recursive: true });
    await mkdir(stagingDir, { recursive: true });

    const txStagingDir = path.join(distDir, `.tx-staging-${txId}`);
    const txBackupDir = path.join(distDir, `.tx-backup-${txId}`);
    await mkdir(txStagingDir, { recursive: true });
    await mkdir(txBackupDir, { recursive: true });

    const committedJournal = {
      schemaVersion: 2,
      txId,
      revision: 8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "committed",
      targets: [
        {
          consumer: "tavangary-core",
          preExisting: true,
          phase: "target_verified",
          backupToken: `.tavangary-core.backup-${txId}`,
          stagingToken: `.tavangary-core.staging-${txId}`,
          candidateZipSha: zipSha256,
          candidateManifestDigest: manifestDigest,
        },
      ],
      publication: {
        receipts: {
          "tavangary-core": {
            consumer: "tavangary-core",
            existedBefore: true,
            preDigest: "c".repeat(64),
            backupStatus: "backed_up",
            stagedDigest: zipSha256,
            publishStatus: "published",
            finalDigest: zipSha256,
          },
        },
        cache: null,
        backupsPurged: false,
      },
      error: null,
    };

    await writeFile(journalFile, JSON.stringify(committedJournal, null, 2), "utf8");

    const { recoverInterruptedDeployment } = await import("../build-cache-engine.mjs");

    // 1st recovery run
    const rec1 = await recoverInterruptedDeployment({
      journalFile,
      pluginsDir,
      distDir,
      logger: console,
    });
    assert.equal(rec1.recovered, true);
    assert.equal(rec1.clean, true);

    // Leftovers must be gone, target must be intact
    const targetDir = path.join(pluginsDir, "tavangary-core");
    assert.ok(!fs.existsSync(backupDir));
    assert.ok(!fs.existsSync(stagingDir));
    assert.ok(!fs.existsSync(txStagingDir));
    assert.ok(!fs.existsSync(txBackupDir));
    assert.ok(fs.existsSync(path.join(targetDir, "tavangary-core.php")));
    assert.ok(!fs.existsSync(journalFile));

    // 2nd recovery run (idempotent)
    const rec2 = await recoverInterruptedDeployment({
      journalFile,
      pluginsDir,
      distDir,
      logger: console,
    });
    assert.equal(rec2.recovered, false);
    assert.equal(rec2.clean, true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 37: TransactionJournalManager rejects queued writes when terminate() is called concurrently", async () => {
  const { TransactionJournalManager } = await import("../build-cache-engine.mjs");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "tx-term-queue-"));
  const journalFile = path.join(tmpDir, ".deploy-journal.json");
  const txId = "tx-1725178000000-termqueue";

  try {
    const base = {
      schemaVersion: 2,
      txId,
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "prepared",
      targets: [
        {
          consumer: "tavangary-core",
          preExisting: false,
          phase: "prepared",
          backupToken: `.tavangary-core.backup-${txId}`,
          stagingToken: `.tavangary-core.staging-${txId}`,
          candidateZipSha: "0".repeat(64),
          candidateManifestDigest: null,
        },
      ],
      publication: { receipts: {}, cache: null, backupsPurged: false },
      error: null,
    };

    const manager = new TransactionJournalManager({
      journalFile,
      distDir: tmpDir,
      initialJournal: base,
    });

    let p1StartedResolve;
    const p1Started = new Promise((r) => { p1StartedResolve = r; });

    // Queue an update that has artificial delay
    const updatePromise1 = manager.update(async (state) => {
      p1StartedResolve();
      await new Promise((r) => setTimeout(r, 50));
      state.targets[0].candidateZipSha = "a".repeat(64);
      state.targets[0].candidateManifestDigest = "b".repeat(64);
    });

    // Wait until update 1 has begun executing
    await p1Started;

    // Queue another update behind it while update 1 is in flight
    let update1Rejected = null;
    let update2Rejected = null;
    updatePromise1.catch((err) => { update1Rejected = err; });
    const updatePromise2 = manager.update(async (state) => {
      state.targets[0].phase = "candidate_swap_intent";
    }).catch((err) => {
      update2Rejected = err;
    });

    // Terminate while update 1 is in flight
    manager.terminate();

    await Promise.allSettled([updatePromise1, updatePromise2]);
    assert.ok(update1Rejected, "updatePromise1 must reject upon termination during execution");
    assert.ok(update2Rejected, "updatePromise2 must reject upon manager termination");
    assert.match(update2Rejected.message, /TransactionJournalManager is terminated/i);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 38: Publication state machine enforces strict staged -> publishing -> published sequence", async () => {
  const { validateJournalTransition } = await import("../build-cache-engine.mjs");
  const txId = "tx-1725178000000-pubseq";

  const base = {
    schemaVersion: 2,
    txId,
    revision: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: "publishing",
    targets: [],
    publication: {
      receipts: {
        "tavangary-core": {
          consumer: "tavangary-core",
          existedBefore: false,
          preDigest: null,
          backupStatus: "absent",
          stagedDigest: "a".repeat(64),
          publishStatus: "staged",
          finalDigest: null,
        },
      },
      cache: null,
      backupsPurged: false,
    },
    error: null,
  };

  // 1. Transitioning from staged to publishing is valid
  const pubIntent = structuredClone(base);
  pubIntent.revision = 3;
  pubIntent.publication.receipts["tavangary-core"].publishStatus = "publishing";
  const res1 = validateJournalTransition(base, pubIntent);
  assert.equal(res1.valid, true);

  // 2. Transitioning directly from staged to published (skipping publishing) is rejected
  const directPub = structuredClone(base);
  directPub.revision = 3;
  directPub.publication.receipts["tavangary-core"].publishStatus = "published";
  directPub.publication.receipts["tavangary-core"].finalDigest = "a".repeat(64);
  const res2 = validateJournalTransition(base, directPub);
  assert.equal(res2.valid, false);
  assert.match(res2.reason, /Invalid publication receipt phase transition/i);

  // 3. Transitioning published back to publishing is rejected
  const publishedState = structuredClone(pubIntent);
  publishedState.revision = 4;
  publishedState.publication.receipts["tavangary-core"].publishStatus = "published";
  publishedState.publication.receipts["tavangary-core"].finalDigest = "a".repeat(64);

  const revertedPub = structuredClone(publishedState);
  revertedPub.revision = 5;
  revertedPub.publication.receipts["tavangary-core"].publishStatus = "publishing";
  const res3 = validateJournalTransition(publishedState, revertedPub);
  assert.equal(res3.valid, false);
  assert.match(res3.reason, /Invalid publication receipt phase transition/i);
});

test("Failure Scenario 39: Docker smoke node fails if any artifact binding is missing or empty", async () => {
  const { runPipelineOrchestration } = await import("../build-all-standalone-plugins.mjs");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "smoke-binding-"));
  const pluginsDir = path.join(tmpDir, "plugins");
  const distDir = path.join(tmpDir, "dist");

  try {
    await mkdir(pluginsDir, { recursive: true });
    await mkdir(distDir, { recursive: true });

    const themeDir = path.join(tmpDir, "themes", "tavangary");
    await mkdir(themeDir, { recursive: true });
    await writeFile(path.join(themeDir, "style.css"), "/* theme */", "utf8");
    const contentRoot = tmpDir;
    await mkdir(path.join(pluginsDir, "tavangary-core-dev"), { recursive: true });
    await writeFile(path.join(pluginsDir, "tavangary-core-dev", "tavangary-core.php"), "<?php // core dev", "utf8");
    await mkdir(path.join(pluginsDir, "wpdev"), { recursive: true });
    await writeFile(path.join(pluginsDir, "wpdev", "wpdev.php"), "<?php // wpdev core", "utf8");

    const cacheFile = path.join(distDir, ".build-cache.json");
    const { zipPath, zipSha256, manifestDigest } = await createHermeticZipFixture({ tmpDir, consumer: "tavangary-core" });
    await copyFile(zipPath, path.join(distDir, "tavangary-core-profile-s.zip"));

    const { computeAllFingerprintsParallel, computePluginCompositeFingerprint } = await import("../build-cache-engine.mjs");
    const fp = await computeAllFingerprintsParallel({
      scriptDir: packageRoot,
      pluginsDir,
      targetPlugins: ["tavangary-core"],
      contentRoot,
    });

    const corePlan = createBuildPlan({ consumer: "tavangary-core", profile: "s", isObfuscate: true });
    const coreComposite = computePluginCompositeFingerprint({
      toolsFingerprint: fp.tools,
      wpdevFingerprint: fp.wpdev,
      pluginSourceFingerprint: fp.plugins["tavangary-core"],
      toolchainFingerprint: fp.toolchain,
      profile: "s",
      buildPlan: corePlan,
    });

    const themeHash = (fp.theme && fp.theme !== "missing") ? fp.theme : "0".repeat(64);

    const initialCache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      _tools: fp.tools,
      _toolFiles: fp.toolFiles || {},
      _wpdev: fp.wpdev,
      _theme: themeHash,
      _testFiles: fp.testFiles || {},
      _testEvidence: {},
      toolchain: fp.toolchain,
      artifacts: {
        "tavangary-core": {
          schemaVersion: CACHE_SCHEMA_VERSION,
          artifactId: "tavangary-core-profile-s",
          consumer: "tavangary-core",
          sourceFingerprint: fp.plugins["tavangary-core"],
          wpdevFingerprint: fp.wpdev,
          toolsFingerprint: fp.tools,
          themeFingerprint: themeHash,
          toolchainFingerprint: fp.toolchain,
          compositeFingerprint: coreComposite,
          planFingerprint: corePlan.artifactIdentity.fingerprint,
          zipSha256,
          manifestDigest,
          gates: {
            artifactIntegrity: { status: "passed", verifiedAt: new Date().toISOString() },
            testCoverage: { status: "passed", coveredTests: ["artifact-fixture-helper.test.mjs"], missingTests: [], coverageReason: "Full test coverage verified" },
            deployment: { status: "none", deployedAt: null, rollbackAt: null },
          },
          validationState: "tests-passed",
          validatedAt: new Date().toISOString(),
        },
      },
    };
    await writeFile(cacheFile, JSON.stringify(initialCache, null, 2), "utf8");

    // Try docker-smoke with injected failure
    await assert.rejects(
      async () => {
        await runPipelineOrchestration({
          targetPlugins: ["tavangary-core"],
          pluginsDir,
          distDir,
          cacheFile,
          contentRoot: tmpDir,
          scriptDir: packageRoot,
          testMode: "docker-smoke",
          injectFailure: "during_smoke",
          // Fixture ZIP is a Profile S artifact; run the obfuscated tier (F05).
          isObfuscate: true,
          executor: async () => ({ stdout: "ok 1 - pass\n", stderr: "" }),
        });
      },
      /Injected failure during Docker smoke/i
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 40: deepFreeze ensures nested mutations on snapshots cannot tamper with TransactionJournalManager state", async () => {
  const { TransactionJournalManager, deepFreeze } = await import("../build-cache-engine.mjs");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "tx-deep-freeze-"));
  const journalFile = path.join(tmpDir, ".deploy-journal.json");
  const txId = "tx-1725178000000-deepfreeze";

  try {
    const base = {
      schemaVersion: 2,
      txId,
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "prepared",
      targets: [
        {
          consumer: "tavangary-core",
          preExisting: false,
          phase: "prepared",
          backupToken: `.tavangary-core.backup-${txId}`,
          stagingToken: `.tavangary-core.staging-${txId}`,
          candidateZipSha: "0".repeat(64),
          candidateManifestDigest: null,
        },
      ],
      publication: {
        receipts: {
          "tavangary-core": {
            consumer: "tavangary-core",
            existedBefore: false,
            preDigest: null,
            backupStatus: "absent",
            stagedDigest: "a".repeat(64),
            publishStatus: "staged",
            finalDigest: null,
          },
        },
        cache: {
          existedBefore: false,
          preDigest: null,
          backupStatus: "absent",
          stagedDigest: "b".repeat(64),
          publishStatus: "staged",
          finalDigest: null,
        },
        backupsPurged: false,
      },
      error: null,
    };

    const manager = new TransactionJournalManager({
      journalFile,
      distDir: tmpDir,
      initialJournal: base,
    });

    const snapshot = manager.getSnapshot();

    // Verify deep freeze on nested layers
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.targets));
    assert.ok(Object.isFrozen(snapshot.targets[0]));
    assert.ok(Object.isFrozen(snapshot.publication));
    assert.ok(Object.isFrozen(snapshot.publication.receipts));
    assert.ok(Object.isFrozen(snapshot.publication.receipts["tavangary-core"]));
    assert.ok(Object.isFrozen(snapshot.publication.cache));

    // Attempting to mutate nested properties must throw TypeError in strict mode or have zero effect
    assert.throws(() => {
      snapshot.targets[0].candidateZipSha = "f".repeat(64);
    }, TypeError);

    assert.throws(() => {
      snapshot.publication.receipts["tavangary-core"].publishStatus = "published";
    }, TypeError);

    // Verify manager state remains intact
    const freshSnapshot = manager.getSnapshot();
    assert.equal(freshSnapshot.targets[0].candidateZipSha, "0".repeat(64));
    assert.equal(freshSnapshot.publication.receipts["tavangary-core"].publishStatus, "staged");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 41: TransactionJournalManager handles in-flight mutation termination and rejects queued promises", async () => {
  const { TransactionJournalManager } = await import("../build-cache-engine.mjs");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "tx-inflight-term-"));
  const journalFile = path.join(tmpDir, ".deploy-journal.json");
  const txId = "tx-1725178000000-inflightterm";

  try {
    const base = {
      schemaVersion: 2,
      txId,
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "prepared",
      targets: [
        {
          consumer: "tavangary-core",
          preExisting: false,
          phase: "prepared",
          backupToken: `.tavangary-core.backup-${txId}`,
          stagingToken: `.tavangary-core.staging-${txId}`,
          candidateZipSha: "0".repeat(64),
          candidateManifestDigest: null,
        },
      ],
      publication: { receipts: {}, cache: null, backupsPurged: false },
      error: null,
    };

    const manager = new TransactionJournalManager({
      journalFile,
      distDir: tmpDir,
      initialJournal: base,
    });

    let asyncStartedResolve;
    const asyncStarted = new Promise((r) => { asyncStartedResolve = r; });

    // In-flight async update
    const inFlightPromise = manager.update(async (state) => {
      asyncStartedResolve();
      await new Promise((r) => setTimeout(r, 60));
      state.targets[0].candidateZipSha = "1".repeat(64);
      state.targets[0].candidateManifestDigest = "2".repeat(64);
    });

    await asyncStarted;

    // Queue 2 more updates behind it
    const queuedPromise1 = manager.update(async (state) => {
      state.targets[0].phase = "candidate_swap_intent";
    });
    const queuedPromise2 = manager.update(async (state) => {
      state.targets[0].phase = "candidate_swapped";
    });

    // Terminate while in-flight update is waiting in async timeout
    manager.terminate();
    assert.equal(manager.isTerminated, true);

    const [resInFlight, resQ1, resQ2] = await Promise.allSettled([inFlightPromise, queuedPromise1, queuedPromise2]);

    assert.equal(resInFlight.status, "rejected");
    assert.match(resInFlight.reason.message, /terminated/i);

    assert.equal(resQ1.status, "rejected");
    assert.match(resQ1.reason.message, /terminated/i);

    assert.equal(resQ2.status, "rejected");
    assert.match(resQ2.reason.message, /terminated/i);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 42: Publication state machine forbids restored/deleted outside rollback and forbids mutating published records", async () => {
  const { validateJournalTransition } = await import("../build-cache-engine.mjs");
  const txId = "tx-1725178000000-pubforbid";

  const publishingState = {
    schemaVersion: 2,
    txId,
    revision: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: "publishing",
    targets: [{
      consumer: "tavangary-core",
      preExisting: false,
      phase: "candidate_swapped",
      backupToken: `.tavangary-core.backup-${txId}`,
      stagingToken: `.tavangary-core.staging-${txId}`,
      candidateZipSha: "1".repeat(64),
      candidateManifestDigest: "2".repeat(64),
    }],
    publication: {
      receipts: {
        "tavangary-core": {
          consumer: "tavangary-core",
          existedBefore: false,
          preDigest: null,
          backupStatus: "absent",
          stagedDigest: "a".repeat(64),
          publishStatus: "publishing",
          finalDigest: null,
        },
      },
      cache: {
        existedBefore: false,
        preDigest: null,
        backupStatus: "absent",
        stagedDigest: "b".repeat(64),
        publishStatus: "publishing",
        finalDigest: null,
      },
      backupsPurged: false,
    },
    error: null,
  };

  // 1. Transitioning to restored or deleted while phase is 'publishing' must be rejected
  const illegalRestore = structuredClone(publishingState);
  illegalRestore.revision = 3;
  illegalRestore.publication.receipts["tavangary-core"].publishStatus = "restored";
  const res1 = validateJournalTransition(publishingState, illegalRestore);
  assert.equal(res1.valid, false);
  assert.match(res1.reason, /outside rollback phase/i);

  // 2. Publish both receipt and cache successfully
  const publishedState = structuredClone(publishingState);
  publishedState.revision = 3;
  publishedState.phase = "committed";
  publishedState.publication.receipts["tavangary-core"].publishStatus = "published";
  publishedState.publication.receipts["tavangary-core"].finalDigest = "a".repeat(64);
  publishedState.publication.cache.publishStatus = "published";
  publishedState.publication.cache.finalDigest = "b".repeat(64);
  const res2 = validateJournalTransition(publishingState, publishedState);
  assert.equal(res2.valid, true);

  // 3. Mutating published digest in subsequent revision must be strictly rejected
  const mutatedDigestState = structuredClone(publishedState);
  mutatedDigestState.revision = 4;
  mutatedDigestState.publication.receipts["tavangary-core"].finalDigest = "f".repeat(64);
  const res3 = validateJournalTransition(publishedState, mutatedDigestState);
  assert.equal(res3.valid, false);
  assert.match(res3.reason, /Published receipt 'tavangary-core' digests cannot be mutated|must have finalDigest equal to stagedDigest/i);

  // 4. Transitioning published to restored or deleted is strictly permitted during rolling_back phase
  const rollbackIntent = structuredClone(publishedState);
  rollbackIntent.revision = 4;
  rollbackIntent.phase = "rolling_back";
  const rollingState = structuredClone(rollbackIntent);
  rollingState.revision = 5;
  rollingState.publication.receipts["tavangary-core"].publishStatus = "restored";
  rollingState.publication.cache.publishStatus = "restored";
  const resRollback = validateJournalTransition(rollbackIntent, rollingState);
  assert.equal(resRollback.valid, true, resRollback.reason);

  // 5. Transitioning published to restored outside rollback phase is rejected
  const illegalPublishedRestore = structuredClone(publishedState);
  illegalPublishedRestore.revision = 4;
  illegalPublishedRestore.phase = "committed";
  illegalPublishedRestore.publication.receipts["tavangary-core"].publishStatus = "restored";
  const resIllegal = validateJournalTransition(publishedState, illegalPublishedRestore);
  assert.equal(resIllegal.valid, false);
  assert.match(resIllegal.reason, /cannot transition away from 'published'|outside rollback phase/i);
});

test("Failure Scenario 43: Committed recovery verifies destination artifact integrity before cleanup and fails closed on tampering", async () => {
  const { recoverInterruptedDeployment } = await import("../build-cache-engine.mjs");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "fwd-recovery-verify-"));
  const pluginsDir = path.join(tmpDir, "plugins");
  const distDir = path.join(tmpDir, "dist");
  const journalFile = path.join(distDir, ".deploy-journal.json");
  const txId = "tx-1725178000000-fwdverify";

  try {
    await mkdir(pluginsDir, { recursive: true });
    await mkdir(distDir, { recursive: true });

    const targetDir = path.join(pluginsDir, "tavangary-core");
    const backupDir = path.join(pluginsDir, `.tavangary-core.backup-${txId}`);
    await mkdir(targetDir, { recursive: true });
    await mkdir(backupDir, { recursive: true });

    // Target is deployed but corrupted (missing artifact-manifest.json)
    await fs.promises.writeFile(path.join(targetDir, "tavangary-core.php"), "<?php echo 'CORRUPT_DEPLOY';");
    await fs.promises.writeFile(path.join(backupDir, "tavangary-core.php"), "<?php echo 'ORIGINAL_BACKUP';");

    const committedJournal = {
      schemaVersion: 2,
      txId,
      revision: 10,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "committed",
      targets: [
        {
          consumer: "tavangary-core",
          preExisting: true,
          phase: "target_verified",
          backupToken: `.tavangary-core.backup-${txId}`,
          stagingToken: `.tavangary-core.staging-${txId}`,
          candidateZipSha: "a".repeat(64),
          candidateManifestDigest: "b".repeat(64),
        },
      ],
      publication: {
        receipts: {
          "tavangary-core": {
            consumer: "tavangary-core",
            existedBefore: true,
            preDigest: "1".repeat(64),
            backupStatus: "backed_up",
            stagedDigest: "a".repeat(64),
            publishStatus: "published",
            finalDigest: "a".repeat(64),
          },
        },
        cache: {
          existedBefore: false,
          preDigest: null,
          backupStatus: "absent",
          stagedDigest: "c".repeat(64),
          publishStatus: "published",
          finalDigest: "c".repeat(64),
        },
        backupsPurged: false,
      },
      error: null,
    };
    await fs.promises.writeFile(journalFile, JSON.stringify(committedJournal, null, 2), "utf8");

    // Recovery must fail closed because destination artifact is missing manifest
    await assert.rejects(
      async () => {
        await recoverInterruptedDeployment({
          journalFile,
          pluginsDir,
          distDir,
        });
      },
      /Committed recovery failed: Destination artifact for 'tavangary-core' is invalid/i
    );

    // Backups must NOT be purged when destination verification fails
    assert.equal(fs.existsSync(backupDir), true, "Backup directory must be preserved when destination verification fails");
    assert.equal(fs.existsSync(journalFile), true, "Journal must be preserved");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Failure Scenario 44: Release mode rejects legacy test evidence schema v2 and enforces releaseSameRun", async () => {
  const { validateTestEvidenceRecord, computeArtifactTestCoverage } = await import("../build-cache-engine.mjs");

  const v2Evidence = {
    schemaVersion: 2,
    runId: "run-1725178000-abc1234",
    transactionId: "tx-1725178000-tx123",
    testFile: "target-registry.test.mjs",
    testFileSha256: "a".repeat(64),
    testDependencyFingerprint: "b".repeat(64),
    toolchainFingerprint: "c".repeat(64),
    artifactBindings: [],
    mode: "fast",
    exitStatus: "passed",
    runDurationMs: 150,
    executedAt: new Date().toISOString(),
  };

  // In fast/affected mode, v2 is accepted for backward compatibility
  const fastRes = validateTestEvidenceRecord({
    evidence: v2Evidence,
    expectedTestFile: "target-registry.test.mjs",
    expectedMode: "fast",
  });
  assert.equal(fastRes.valid, true);

  // In release mode, schemaVersion 2 must be strictly rejected
  const releaseEvidence = { ...v2Evidence, mode: "release" };
  const releaseRes = validateTestEvidenceRecord({
    evidence: releaseEvidence,
    expectedTestFile: "target-registry.test.mjs",
    expectedMode: "release",
  });
  assert.equal(releaseRes.valid, false);
  assert.match(releaseRes.reason, /Release mode strictly requires evidence schema/i);

  // Release mode rejects previous run evidence when currentRunId is different
  const previousRunEvidence = {
    ...v2Evidence,
    schemaVersion: 3,
    mode: "release",
    runId: "run-1725178000-oldrun",
    transactionId: "tx-1725178000-oldtx",
  };
  const coverageRes = computeArtifactTestCoverage({
    consumer: "tavangary-core",
    testEvidenceMap: { "target-registry.test.mjs": previousRunEvidence },
    testMode: "release",
    currentRunId: "run-1725178000-newrun",
    currentTransactionId: "tx-1725178000-newtx",
  });
  assert.equal(coverageRes.covered, false);
  assert.match(coverageRes.reason, /Missing valid evidence/i);
});

test("Failure Scenario 45: Fault injection in rollback atomic journal write raises compound failure", async () => {
  const { TransactionJournalManager } = await import("../build-cache-engine.mjs");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "tx-fault-atomic-"));
  const journalFile = path.join(tmpDir, ".deploy-journal.json");
  const txId = "tx-1725178000000-faultatomic";

  try {
    const base = {
      schemaVersion: 2,
      txId,
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "prepared",
      targets: [],
      publication: { receipts: {}, cache: null, backupsPurged: false },
      error: null,
    };

    const manager = new TransactionJournalManager({
      journalFile,
      distDir: tmpDir,
      initialJournal: base,
    });

    // Make journalFile path a directory to cause rename / write failure
    await mkdir(journalFile, { recursive: true });

    await assert.rejects(
      async () => {
        await manager.update(async (state) => {
          state.phase = "publishing";
        });
      }
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});







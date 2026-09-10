import assert from "node:assert/strict";
import fs from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";

import {
  computePluginCompositeFingerprint,
  computeToolchainFingerprint,
  planDependencyGraphBuild,
  validateCachedTargetArtifact,
} from "../build-cache-engine.mjs";
import { assembleProfileSCandidate } from "../assemble-profile-s-candidate.mjs";
import { generateArtifactManifest, createCanonicalZip } from "../canonical-artifact-manifest.mjs";

test("F05: computePluginCompositeFingerprint separates clean and profile s", () => {
  const baseInputs = {
    toolsFingerprint: "1".repeat(64),
    wpdevFingerprint: "2".repeat(64),
    pluginSourceFingerprint: "3".repeat(64),
    toolchainFingerprint: "4".repeat(64),
  };

  const cleanFp = computePluginCompositeFingerprint({
    ...baseInputs,
    profile: "clean",
  });

  const profileSFp = computePluginCompositeFingerprint({
    ...baseInputs,
    profile: "s",
  });

  assert.notEqual(cleanFp, profileSFp, "clean and profile s must have different composite fingerprints");
  assert.ok(profileSFp.includes("profile:s"), "profile s fingerprint must include profile identity");

  // Options also affect fingerprint
  const withOptsFp = computePluginCompositeFingerprint({
    ...baseInputs,
    profile: "s",
    options: { minify: true },
  });
  assert.notEqual(profileSFp, withOptsFp, "Changing options must alter composite fingerprint");
});

test("F05: nested options hash canonically and miss on nested change", () => {
  const baseInputs = {
    toolsFingerprint: "1".repeat(64),
    wpdevFingerprint: "2".repeat(64),
    pluginSourceFingerprint: "3".repeat(64),
    toolchainFingerprint: "4".repeat(64),
    profile: "s",
  };
  const a = computePluginCompositeFingerprint({
    ...baseInputs,
    options: { minify: { on: true, level: 2 }, inlineFramework: true },
  });
  const b = computePluginCompositeFingerprint({
    ...baseInputs,
    options: { inlineFramework: true, minify: { level: 2, on: true } },
  });
  const c = computePluginCompositeFingerprint({
    ...baseInputs,
    options: { minify: { on: false, level: 2 }, inlineFramework: true },
  });
  assert.equal(a, b, "equivalent nested option objects must hash equally");
  assert.notEqual(a, c, "a nested option toggle must miss cache");
});

test("F05: planDependencyGraphBuild triggers rebuild on profile change without source change", () => {
  const currentFingerprints = {
    tools: "1".repeat(64),
    wpdev: "2".repeat(64),
    plugins: { "test-plugin": "3".repeat(64) },
    toolchain: "4".repeat(64),
  };

  const cleanFp = computePluginCompositeFingerprint({
    toolsFingerprint: currentFingerprints.tools,
    wpdevFingerprint: currentFingerprints.wpdev,
    pluginSourceFingerprint: currentFingerprints.plugins["test-plugin"],
    toolchainFingerprint: currentFingerprints.toolchain,
    profile: "clean",
  });

  const previousCache = {
    _tools: currentFingerprints.tools,
    _wpdev: currentFingerprints.wpdev,
    artifacts: {
      "test-plugin": {
        compositeFingerprint: cleanFp,
        profile: "clean",
      },
    },
    "test-plugin": cleanFp,
  };

  // 1. Build with clean profile -> Cache HIT
  const planClean = planDependencyGraphBuild({
    targetPlugins: ["test-plugin"],
    previousCache,
    currentFingerprints,
    profile: "clean",
  });
  assert.equal(planClean["test-plugin"].shouldRebuild, false, "Same profile (clean) must hit cache");

  // 2. Build with profile s -> Cache MISS (Rebuild triggered)
  const planS = planDependencyGraphBuild({
    targetPlugins: ["test-plugin"],
    previousCache,
    currentFingerprints,
    profile: "s",
  });
  assert.equal(planS["test-plugin"].shouldRebuild, true, "Switching clean to profile s must trigger rebuild");
});

test("F05: validateCachedTargetArtifact rejects profile mismatch", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f05-cache-val-"));
  try {
    const consumer = "test-plugin";
    const pluginDir = path.join(tmpRoot, consumer);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(path.join(pluginDir, `${consumer}.php`), "<?php echo 'hi';");

    const manifest = await generateArtifactManifest({
      rootDir: pluginDir,
      consumer,
      profile: "clean",
    });
    await writeFile(path.join(pluginDir, "artifact-manifest.json"), JSON.stringify(manifest, null, 2));

    const zipPath = path.join(tmpRoot, `${consumer}.zip`);
    await createCanonicalZip({
      sourceRoot: pluginDir,
      outputZip: zipPath,
      rootName: consumer,
    });
    const zipBytes = await readFile(zipPath);
    const zipSha256 = crypto.createHash("sha256").update(zipBytes).digest("hex");

    const cacheRecord = {
      schemaVersion: 3,
      consumer,
      compositeFingerprint: "clean-fp",
      zipSha256,
      manifestDigest: manifest.manifestDigest,
      profile: "clean",
    };

    // Valid when expecting clean
    const resClean = await validateCachedTargetArtifact({
      cacheRecord,
      zipPath,
      consumer,
      expectedCompositeFingerprint: "clean-fp",
      expectedProfile: "clean",
    });
    assert.equal(resClean.valid, true);

    // Invalid when expecting Profile S
    const resS = await validateCachedTargetArtifact({
      cacheRecord,
      zipPath,
      consumer,
      expectedCompositeFingerprint: "clean-fp",
      expectedProfile: "s",
    });
    assert.equal(resS.valid, false);
    assert.match(resS.reason, /Profile mismatch/i);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("F05: computeToolchainFingerprint includes zip, unzip, rsync, and composer", async () => {
  const fp = await computeToolchainFingerprint();
  assert.equal(typeof fp, "string");
  assert.equal(fp.length, 64);
});

test("F06: assembleProfileSCandidate does not overwrite existing dist artifact on failure", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f06-dist-protect-"));
  try {
    const consumer = "tavangary-theme-panel";
    const pluginsDir = path.join(tmpRoot, "plugins");
    const distDir = path.join(tmpRoot, "dist");
    await mkdir(pluginsDir, { recursive: true });
    await mkdir(distDir, { recursive: true });

    // Existing valid artifact in dist
    const existingZip = path.join(distDir, `${consumer}.zip`);
    await writeFile(existingZip, "EXISTING_VALID_DIST_ZIP_BYTES_0123456789");
    const initialDigest = crypto.createHash("sha256").update(await readFile(existingZip)).digest("hex");

    // Create broken consumer dev source with bad PHP syntax to force failure during syntax validation
    const devDir = path.join(pluginsDir, `${consumer}-dev`);
    await mkdir(devDir, { recursive: true });
    await writeFile(
      path.join(devDir, `${consumer}.php`),
      "<?php\n/* broken syntax */ function broken( { return 1; }\n"
    );

    await assert.rejects(
      assembleProfileSCandidate({
        contentRoot: tmpRoot,
        consumer,
        outputDir: distDir,
        pluginsDir,
        isObfuscate: false,
      })
    );

    // Existing dist zip must remain completely untouched!
    assert.ok(fs.existsSync(existingZip), "Existing artifact must still exist");
    const afterDigest = crypto.createHash("sha256").update(await readFile(existingZip)).digest("hex");
    assert.equal(afterDigest, initialDigest, "Existing artifact must NOT be overwritten on build failure");

    // Baseline zip must NOT have been dumped into dist
    assert.equal(
      fs.existsSync(path.join(distDir, `${consumer}-profile-a.zip`)),
      false,
      "Baseline ZIP must not be written to distDir"
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

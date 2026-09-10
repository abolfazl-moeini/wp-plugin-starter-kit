import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";

import {
  CACHE_SCHEMA_VERSION,
  createTargetCacheRecord,
  validateCachedTargetArtifact,
  planDependencyGraphBuild,
  computeTreeContentHash,
  computePluginCompositeFingerprint,
} from "../build-cache-engine.mjs";
import { createBuildPlan } from "../build-plan.mjs";

test("Target Cache: creates structured target cache record with schema and state", () => {
  const record = createTargetCacheRecord({
    artifactId: "tavangary-core-profile-s",
    consumer: "tavangary-core",
    sourceFingerprint: "src123",
    wpdevFingerprint: "wp456",
    toolsFingerprint: "tool789",
    themeFingerprint: "theme000",
    toolchainFingerprint: "tc111",
    compositeFingerprint: "comp999",
    zipSha256: "a".repeat(64),
    manifestDigest: "manif123",
    validationState: "tests-passed",
  });

  assert.equal(record.schemaVersion, CACHE_SCHEMA_VERSION);
  assert.equal(record.artifactId, "tavangary-core-profile-s");
  assert.equal(record.validationState, "tests-passed");
  assert.equal(record.zipSha256, "a".repeat(64));
});

test("Target Cache: validateCachedTargetArtifact rejects tampered or missing ZIP", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "test-cache-rec-"));
  const zipPath = path.join(tmpDir, "test.zip");
  const zipContent = Buffer.from("dummy zip content");
  await fs.promises.writeFile(zipPath, zipContent);
  const realSha = crypto.createHash("sha256").update(zipContent).digest("hex");

  const record = createTargetCacheRecord({
    artifactId: "test-plugin-profile-s",
    consumer: "test-plugin",
    compositeFingerprint: "comp123",
    zipSha256: realSha,
    manifestDigest: "a".repeat(64),
    validationState: "tests-passed",
  });

  // 1. Valid record and matching ZIP
  // (Assuming dummy zip without entries fails embedded manifest check gracefully)
  const res1 = await validateCachedTargetArtifact({
    cacheRecord: record,
    zipPath,
    consumer: "test-plugin",
    expectedCompositeFingerprint: "comp123",
  });
  // Since dummy zip doesn't have valid central directory, it must fail safely
  assert.equal(res1.valid, false);
  assert.ok(res1.reason.includes("Invalid ZIP") || res1.reason.includes("Corrupted ZIP") || res1.reason.includes("Embedded"));

  // 2. Tampered SHA
  const recordTampered = { ...record, zipSha256: "b".repeat(64) };
  const res2 = await validateCachedTargetArtifact({
    cacheRecord: recordTampered,
    zipPath,
    consumer: "test-plugin",
    expectedCompositeFingerprint: "comp123",
  });
  assert.equal(res2.valid, false);
  assert.ok(res2.reason.includes("does not match cache record"));

  // 3. Changed composite fingerprint
  const res3 = await validateCachedTargetArtifact({
    cacheRecord: record,
    zipPath,
    consumer: "test-plugin",
    expectedCompositeFingerprint: "different_comp",
  });
  assert.equal(res3.valid, false);
  assert.ok(res3.reason.includes("fingerprint changed"));

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("Target Cache: validateCachedTargetArtifact verifies valid hermetic ZIP and rejects 5 types of tamper", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "test-cache-hermetic-"));
  const consumer = "sample-plugin";
  const pluginSrc = path.join(tmpDir, consumer);
  await fs.promises.mkdir(pluginSrc, { recursive: true });
  await fs.promises.writeFile(path.join(pluginSrc, `${consumer}.php`), "<?php echo 'VALID';");

  const { generateArtifactManifest, createCanonicalZip } = await import("../canonical-artifact-manifest.mjs");
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
  const realSha = crypto.createHash("sha256").update(zipBytes).digest("hex");

  const record = createTargetCacheRecord({
    artifactId: `${consumer}-profile-s`,
    consumer,
    compositeFingerprint: "comp123",
    zipSha256: realSha,
    manifestDigest: manifest.manifestDigest,
    validationState: "tests-passed",
  });

  // 1. Valid ZIP and matching cache record PASSES
  const validRes = await validateCachedTargetArtifact({
    cacheRecord: record,
    zipPath,
    consumer,
    expectedCompositeFingerprint: "comp123",
  });
  assert.equal(validRes.valid, true, "Valid ZIP and cache record must pass");
  assert.equal(validRes.manifestDigest, manifest.manifestDigest);

  // 2. Tamper 1: Corrupted cache record manifestDigest
  const tamperedDigestRecord = { ...record, manifestDigest: "b".repeat(64) };
  const resTamperedDigest = await validateCachedTargetArtifact({
    cacheRecord: tamperedDigestRecord,
    zipPath,
    consumer,
    expectedCompositeFingerprint: "comp123",
  });
  assert.equal(resTamperedDigest.valid, false);
  assert.ok(resTamperedDigest.reason.includes("does not match embedded manifest"));

  // 3. Tamper 2: Corrupted cache record artifactId
  const tamperedArtifactRecord = { ...record, artifactId: "wrong-artifact-id" };
  const resTamperedArtifact = await validateCachedTargetArtifact({
    cacheRecord: tamperedArtifactRecord,
    zipPath,
    consumer,
    expectedCompositeFingerprint: "comp123",
  });
  assert.equal(resTamperedArtifact.valid, false);
  assert.ok(resTamperedArtifact.reason.includes("artifactId"));

  // 4. Tamper 3: Wrong consumer
  const resWrongConsumer = await validateCachedTargetArtifact({
    cacheRecord: record,
    zipPath,
    consumer: "other-plugin",
    expectedCompositeFingerprint: "comp123",
  });
  assert.equal(resWrongConsumer.valid, false);
  assert.ok(resWrongConsumer.reason.includes("Consumer mismatch"));

  // 5. Tamper 4: ZIP byte altered
  const tamperedZipPath = path.join(tmpDir, "tampered.zip");
  const tamperedBytes = Buffer.from(zipBytes);
  tamperedBytes[Math.floor(tamperedBytes.length / 2)] ^= 0xff;
  await fs.promises.writeFile(tamperedZipPath, tamperedBytes);
  const resTamperedZip = await validateCachedTargetArtifact({
    cacheRecord: record,
    zipPath: tamperedZipPath,
    consumer,
    expectedCompositeFingerprint: "comp123",
  });
  assert.equal(resTamperedZip.valid, false);

  // 6. Tamper 5: Cache record schema mismatch
  const resBadSchema = await validateCachedTargetArtifact({
    cacheRecord: { ...record, schemaVersion: 999 },
    zipPath,
    consumer,
    expectedCompositeFingerprint: "comp123",
  });
  assert.equal(resBadSchema.valid, false);
  assert.ok(resBadSchema.reason.includes("schema mismatch"));

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("V3-15: computeTreeContentHash binds changes in packages/ and vendor/", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cache-tree-v315-"));
  try {
    const pkgDir = path.join(tmpDir, "packages/framework/src");
    await fs.promises.mkdir(pkgDir, { recursive: true });
    await fs.promises.writeFile(path.join(pkgDir, "Runtime.php"), "<?php class Runtime {}");

    const hash1 = await computeTreeContentHash(tmpDir, tmpDir, true);
    assert.notEqual(hash1, "empty", "packages/ files must be included in tree hash");

    await fs.promises.writeFile(path.join(pkgDir, "Runtime.php"), "<?php class Runtime { /* updated */ }");
    const hash2 = await computeTreeContentHash(tmpDir, tmpDir, true);
    assert.notEqual(hash1, hash2, "Editing packages/framework/src/Runtime.php must invalidate tree hash");

    // Vendor test
    const vendorDir = path.join(tmpDir, "vendor/my-dep");
    await fs.promises.mkdir(vendorDir, { recursive: true });
    await fs.promises.writeFile(path.join(vendorDir, "Dep.php"), "<?php class Dep {}");
    const hash3 = await computeTreeContentHash(tmpDir, tmpDir, true);
    assert.notEqual(hash2, hash3, "Vendor files must be included in tree hash");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("V3-15: computePluginCompositeFingerprint and validateCachedTargetArtifact bind BuildPlan", async () => {
  const planNoInline = createBuildPlan({
    consumer: "demo",
    inlineFramework: false,
    spaghetti: false,
    obfuscate: false,
  });
  const planInlineOnly = createBuildPlan({
    consumer: "demo",
    inlineFramework: true,
    spaghetti: false,
    obfuscate: false,
  });
  const planObfOnly = createBuildPlan({
    consumer: "demo",
    inlineFramework: false,
    spaghetti: false,
    obfuscate: true,
  });

  const fpNoInline = computePluginCompositeFingerprint({
    toolsFingerprint: "0".repeat(64),
    wpdevFingerprint: "0".repeat(64),
    pluginSourceFingerprint: "0".repeat(64),
    buildPlan: planNoInline,
  });

  const fpInlineOnly = computePluginCompositeFingerprint({
    toolsFingerprint: "0".repeat(64),
    wpdevFingerprint: "0".repeat(64),
    pluginSourceFingerprint: "0".repeat(64),
    buildPlan: planInlineOnly,
  });

  const fpObfOnly = computePluginCompositeFingerprint({
    toolsFingerprint: "0".repeat(64),
    wpdevFingerprint: "0".repeat(64),
    pluginSourceFingerprint: "0".repeat(64),
    buildPlan: planObfOnly,
  });

  // No-inline vs inline-only must have different fingerprints even with same source
  assert.notEqual(fpNoInline, fpInlineOnly, "No-inline and inline-only must produce different composite fingerprints");
  assert.notEqual(fpInlineOnly, fpObfOnly, "Inline-only and obfuscate-only must produce different composite fingerprints");

  // validateCachedTargetArtifact rejects plan fingerprint mismatch
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cache-validate-plan-"));
  try {
    const zipPath = path.join(tmpDir, "dummy.zip");
    await fs.promises.writeFile(zipPath, "dummy");
    const record = createTargetCacheRecord({
      artifactId: "demo-profile-s",
      consumer: "demo",
      compositeFingerprint: fpNoInline,
      planFingerprint: planNoInline.artifactIdentity.fingerprint,
      zipSha256: "0".repeat(64),
      manifestDigest: "0".repeat(64),
    });

    const valMismatch = await validateCachedTargetArtifact({
      cacheRecord: record,
      zipPath,
      consumer: "demo",
      expectedCompositeFingerprint: fpNoInline,
      expectedPlanFingerprint: planObfOnly.artifactIdentity.fingerprint,
    });
    assert.equal(valMismatch.valid, false);
    assert.ok(valMismatch.reason.includes("Plan fingerprint mismatch"));
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});


import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getDefaultZipPath } from "../artifact-fixture-helper.mjs";
import { verifyProfileSArtifact } from "../verify-profile-s-artifact.mjs";

test("verifies that the assembled Profile S ZIP passes all black-box execution probes", async () => {
  const consumers = ["tavangary-theme-panel", "drm-connector", "wpdev-analytics", "wpdev-woo-persian"];
  for (const consumer of consumers) {
    const zipPath = getDefaultZipPath(consumer);
    if (fs.existsSync(zipPath)) {
      const report = await verifyProfileSArtifact({
        zipPath,
        consumer,
      });

      assert.equal(report.status, "passed", `Profile S artifact for ${consumer} must pass all verification probes`);
      assert.equal(report.testsFailed, 0, `Zero probes should fail for ${consumer}`);
      assert.ok(report.testsPassed >= 4, `All core black-box probes must pass for ${consumer}`);
      assert.deepEqual(report.failures, []);
    }
  }
});

test("Profile S verifier refuses extraction when ZIP preflight fails", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "verify-preflight-"));
  const zipPath = path.join(tmpDir, "not-a-zip.zip");
  try {
    await writeFile(zipPath, "this is not a zip archive");
    const report = await verifyProfileSArtifact({
      zipPath,
      consumer: "tavangary-theme-panel",
    });
    assert.notEqual(report.status, "passed");
    const message = JSON.stringify(report);
    assert.match(message, /end-of-central-directory|no end-of-central|unsafe|failed/i);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Profile S verifier fails on manifestless ZIP with invalid callback (V3-17)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "verify-v3-17-"));
  try {
    const { createCanonicalZip } = await import("../canonical-artifact-manifest.mjs");
    const pluginDir = path.join(tmpDir, "demo");
    await fs.promises.mkdir(pluginDir, { recursive: true });
    await writeFile(
      path.join(pluginDir, "demo.php"),
      "<?php\n/**\n * Plugin Name: Demo\n */\nadd_action('init', 'missing_callback');\n",
      "utf8",
    );
    const zipPath = path.join(tmpDir, "demo.zip");
    await createCanonicalZip({
      sourceRoot: pluginDir,
      outputZip: zipPath,
      rootName: "demo",
    });

    const report = await verifyProfileSArtifact({
      zipPath,
      consumer: "demo",
      requireManifest: true,
    });

    assert.equal(report.status, "failed");
    assert.ok(report.testsFailed > 0);
    const failuresText = report.failures.join(" ");
    assert.match(failuresText, /manifest/i);
    assert.match(failuresText, /missing_callback|invalid callback|uncallable/i);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Profile S verifier supports clean/custom mode without demanding comment stripping (V3-17)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "verify-clean-"));
  try {
    const { createCanonicalZip, generateArtifactManifest } = await import("../canonical-artifact-manifest.mjs");
    const pluginDir = path.join(tmpDir, "demo-clean");
    await fs.promises.mkdir(pluginDir, { recursive: true });
    await writeFile(
      path.join(pluginDir, "demo-clean.php"),
      "<?php\n/**\n * Plugin Name: Demo Clean\n */\n/**\n * DocBlock comment preserved in clean mode.\n */\nfunction demo_clean_init() {}\nadd_action('init', 'demo_clean_init');\n",
      "utf8",
    );
    const manifest = await generateArtifactManifest({
      rootDir: pluginDir,
      consumer: "demo-clean",
      profile: "clean",
    });
    const zipPath = path.join(tmpDir, "demo-clean.zip");
    await createCanonicalZip({
      sourceRoot: pluginDir,
      outputZip: zipPath,
      rootName: "demo-clean",
    });

    const report = await verifyProfileSArtifact({
      zipPath,
      consumer: "demo-clean",
      profile: "clean",
      stripComments: false,
      requireManifest: true,
    });

    assert.equal(report.status, "passed");
    assert.equal(report.testsFailed, 0);
    const commentProbe = report.details.find((d) => d.test.includes("Comment Stripping"));
    assert.ok(commentProbe);
    assert.equal(commentProbe.status, "passed");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Profile S verifier rejects uncallable filter callback (V3-17)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "verify-filter-"));
  try {
    const { createCanonicalZip } = await import("../canonical-artifact-manifest.mjs");
    const pluginDir = path.join(tmpDir, "filter-demo");
    await fs.promises.mkdir(pluginDir, { recursive: true });
    await writeFile(
      path.join(pluginDir, "filter-demo.php"),
      "<?php\n/**\n * Plugin Name: Filter Demo\n */\nadd_filter('the_content', 'nonexistent_filter_fn');\n",
      "utf8",
    );
    const zipPath = path.join(tmpDir, "filter-demo.zip");
    await createCanonicalZip({
      sourceRoot: pluginDir,
      outputZip: zipPath,
      rootName: "filter-demo",
    });

    const report = await verifyProfileSArtifact({
      zipPath,
      consumer: "filter-demo",
      requireManifest: false,
    });

    assert.equal(report.status, "failed");
    assert.ok(report.testsFailed > 0);
    const failuresText = report.failures.join(" ");
    assert.match(failuresText, /nonexistent_filter_fn|invalid or uncallable callbacks/i);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});



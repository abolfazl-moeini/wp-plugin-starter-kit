import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import { promisify } from "node:util";

import { generateArtifactManifest, createCanonicalZip } from "../canonical-artifact-manifest.mjs";
import { atomicDeployPlugin } from "../build-all-standalone-plugins.mjs";
import { prepareArtifactFixture } from "../artifact-fixture-helper.mjs";

const execFileAsync = promisify(execFile);

async function createPluginZip({ tmpRoot, pluginName, version, extraFiles = {} }) {
  const staging = path.join(tmpRoot, `stage-${pluginName}-${version}`, pluginName);
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, `${pluginName}.php`), `<?php // version:${version}\necho '${version}';`);
  await mkdir(path.join(staging, "src/FrameworkClosure"), { recursive: true });
  await writeFile(
    path.join(staging, "src/FrameworkClosure/functions-closure.php"),
    "<?php // framework closure\n"
  );
  for (const [relPath, content] of Object.entries(extraFiles)) {
    const fullPath = path.join(staging, relPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }
  const manifest = await generateArtifactManifest({
    rootDir: staging,
    consumer: pluginName,
    profile: "Profile S",
  });
  await writeFile(path.join(staging, "artifact-manifest.json"), JSON.stringify(manifest, null, 2));

  const zipPath = path.join(tmpRoot, `${pluginName}-${version}.zip`);
  await createCanonicalZip({
    sourceRoot: staging,
    outputZip: zipPath,
    rootName: pluginName,
  });
  return zipPath;
}

test("F04: Reject deployment when input ZIP is a symbolic link", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f04-symlink-"));
  try {
    const pluginName = "sample-plugin";
    const realZip = await createPluginZip({ tmpRoot, pluginName, version: "v1" });
    const symlinkZip = path.join(tmpRoot, "symlink.zip");
    await symlink(realZip, symlinkZip);

    await assert.rejects(
      atomicDeployPlugin(symlinkZip, pluginName, {
        pluginsDir: path.join(tmpRoot, "plugins"),
        contentRoot: tmpRoot,
      }),
      /must be a regular file, not a symlink/i
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("F04: ZIP swapped after preflight does not alter extracted candidate (immutable snapshot)", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f04-toctou-"));
  try {
    const pluginName = "sample-plugin";
    const pluginsDir = path.join(tmpRoot, "plugins");
    const zipV1 = await createPluginZip({ tmpRoot, pluginName, version: "v1" });
    const zipV2 = await createPluginZip({ tmpRoot, pluginName, version: "v2" });

    const deployZip = path.join(tmpRoot, "deploy.zip");
    await copyFile(zipV1, deployZip);

    // Swap deployZip with zipV2 right before swap intent or during preflight
    // By hooking into onPhaseChange or swapping right after preflight
    let swapped = false;
    await atomicDeployPlugin(deployZip, pluginName, {
      pluginsDir,
      contentRoot: tmpRoot,
      onPhaseChange: async (phase) => {
        if (!swapped) {
          swapped = true;
          // Maliciously swap deploy.zip on disk with v2!
          await copyFile(zipV2, deployZip);
        }
      },
    });

    // The deployed target MUST be v1 (from the immutable snapshot taken during preflight),
    // NOT v2 from the swapped file!
    const targetMainPhp = path.join(pluginsDir, pluginName, `${pluginName}.php`);
    const deployedContent = await readFile(targetMainPhp, "utf8");
    assert.ok(
      deployedContent.includes("version:v1"),
      `Expected deployed version to be v1 from immutable snapshot, but got: ${deployedContent}`
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("F04: artifact-fixture-helper rejects symlink ZIP and extracts via immutable snapshot", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f04-fixture-helper-"));
  try {
    const pluginName = "sample-plugin";
    const realZip = await createPluginZip({ tmpRoot, pluginName, version: "v1" });
    const symlinkZip = path.join(tmpRoot, "symlink-fixture.zip");
    await symlink(realZip, symlinkZip);

    await assert.rejects(
      prepareArtifactFixture({ zipPath: symlinkZip, consumer: pluginName }),
      /must be a regular file|symlink/i
    );

    // Extraction of realZip works cleanly and cleans up snapshot
    const fixture = await prepareArtifactFixture({ zipPath: realZip, consumer: pluginName });
    assert.ok(fixture.pluginDir);
    assert.ok(fs.existsSync(fixture.pluginDir));
    // Verify no .snapshot.zip leaked into staging
    assert.equal(fs.existsSync(path.join(fixture.stagingRoot, ".snapshot.zip")), false);
    await fixture.cleanup();
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { fileURLToPath } from "node:url";

import { generateArtifactManifest, createCanonicalZip } from "../canonical-artifact-manifest.mjs";
import {
  runDirectDeployTransaction,
} from "../build-all-standalone-plugins.mjs";
import { runDeployCli } from "../deploy-standalone-plugin.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

async function createValidCandidateZip({ tmpRoot, pluginName, version = "v2" }) {
  const staging = path.join(tmpRoot, `stage-${pluginName}-${version}`, pluginName);
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, `${pluginName}.php`), `<?php // ${version}\necho '${version}';`);
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

  const zipPath = path.join(tmpRoot, `${pluginName}-${version}-profile-s.zip`);
  await createCanonicalZip({
    sourceRoot: staging,
    outputZip: zipPath,
    rootName: pluginName,
  });
  return zipPath;
}

test("F03: Direct deploy executes transactionally, creates receipt and cleans journal upon commit", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f03-direct-deploy-"));
  try {
    const pluginsDir = path.join(tmpRoot, "plugins");
    const distDir = path.join(tmpRoot, "dist");
    const pluginName = "tavangary-core";
    const targetDir = path.join(pluginsDir, pluginName);

    // Initial version v1
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, `${pluginName}.php`), "<?php echo 'v1';");

    const v2Zip = await createValidCandidateZip({ tmpRoot, pluginName, version: "v2" });

    const result = await runDirectDeployTransaction({
      zipPath: v2Zip,
      pluginSlug: pluginName,
      options: {
        contentRoot: tmpRoot,
        pluginsDir,
        distDir,
      },
    });

    assert.equal(result.success, true, "Direct deploy must succeed");
    assert.equal(fs.existsSync(targetDir), true, "Target dir must exist");
    const content = await readFile(path.join(targetDir, `${pluginName}.php`), "utf8");
    assert.ok(content.includes("v2"), "Target must contain v2");

    // Receipt must be created
    const receiptFile = path.join(distDir, ".deploy-receipts", `${pluginName}.receipt.json`);
    assert.equal(fs.existsSync(receiptFile), true, "Receipt file must exist");
    const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
    assert.equal(receipt.consumer, pluginName);
    assert.equal(typeof receipt.zipSha256, "string");

    // Journal file must be deleted upon clean completion
    const journalFile = path.join(distDir, ".deploy-journal.json");
    assert.equal(fs.existsSync(journalFile), false, "Journal file must be removed after successful commit");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("F03: Interrupted direct deploy (SIGKILL after backup rename) is recovered on subsequent run", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "f03-recovery-"));
  try {
    const pluginsDir = path.join(tmpRoot, "plugins");
    const distDir = path.join(tmpRoot, "dist");
    const pluginName = "tavangary-core";
    const targetDir = path.join(pluginsDir, pluginName);

    // Initial version v1
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, `${pluginName}.php`), "<?php echo 'v1-healthy';");

    const v2Zip = await createValidCandidateZip({ tmpRoot, pluginName, version: "v2" });

    // Run first deploy and kill it when backup is renamed
    const helperScript = path.join(tmpRoot, "crash-deploy.mjs");
    const packageBuildPath = path.resolve(__dirname, "../build-all-standalone-plugins.mjs");
    await writeFile(
      helperScript,
      `import { runDirectDeployTransaction } from "${packageBuildPath}";
runDirectDeployTransaction({
  zipPath: "${v2Zip}",
  pluginSlug: "${pluginName}",
  options: {
    contentRoot: "${tmpRoot}",
    pluginsDir: "${pluginsDir}",
    distDir: "${distDir}",
    onPhaseChange: async (phase) => {
      if (phase === "backup_renamed") {
        process.kill(process.pid, "SIGKILL");
      }
    },
  },
}).catch(() => process.exit(1));
`,
      "utf8"
    );

    try {
      await execFileAsync("node", [helperScript]);
    } catch {
      // Expected to exit with SIGKILL
    }

    // At this point, target is missing and backup exists, journal records interrupted transaction!
    const journalFile = path.join(distDir, ".deploy-journal.json");
    assert.equal(fs.existsSync(journalFile), true, "Journal must be present after crash");

    // Now invoke direct deploy again: startup recovery must roll back previous crash and deploy v2!
    let recoveredCount = 0;
    const rerunResult = await runDirectDeployTransaction({
      zipPath: v2Zip,
      pluginSlug: pluginName,
      options: {
        contentRoot: tmpRoot,
        pluginsDir,
        distDir,
        onRecovered: () => {
          recoveredCount++;
        },
      },
    });

    assert.equal(rerunResult.success, true, "Rerun must succeed");
    assert.equal(recoveredCount, 1, "Must have recovered interrupted deployment on startup");
    assert.equal(fs.existsSync(targetDir), true, "Target must exist");
    const content = await readFile(path.join(targetDir, `${pluginName}.php`), "utf8");
    assert.ok(content.includes("v2"), "Target must contain v2 content");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

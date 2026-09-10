import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { collectComposerAutoloadFileTargets, createCanonicalZip, generateArtifactManifest, readZipEntries } from "../canonical-artifact-manifest.mjs";
import { atomicDeployPlugin } from "../build-all-standalone-plugins.mjs";
import { runDeployCli } from "../deploy-standalone-plugin.mjs";

const execFileAsync = promisify(execFile);

test("In-Place Unzip Race: reproduces exact autoload_real.php Fatal error when tree is partially extracted", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "unzip-race-repro-"));
  const pluginDir = path.join(tmpRoot, "tavangary-core");

  try {
    // 1. Set up simulated partially-extracted tree where vendor/ is extracted but src/ is not yet on disk
    const vendorComposerDir = path.join(pluginDir, "vendor/composer");
    await mkdir(vendorComposerDir, { recursive: true });

    // Autoload files registering functions-closure.php
    await writeFile(
      path.join(vendorComposerDir, "autoload_files.php"),
      `<?php
$vendorDir = dirname(__DIR__);
$baseDir = dirname($vendorDir);
return array(
    'closure_hash' => $baseDir . '/src/FrameworkClosure/functions-closure.php',
);
`
    );

    // Mock autoload_real.php that loads autoload_files.php (mirroring Composer's line 41 require)
    await writeFile(
      path.join(vendorComposerDir, "autoload_real.php"),
      `<?php
class ComposerAutoloaderInitMock {
    public static function getLoader() {
        $files = require __DIR__ . '/autoload_files.php';
        foreach ($files as $fileIdentifier => $file) {
            // line 41 in composer autoloader: require $file;
            require $file;
        }
    }
}
`
    );

    await writeFile(
      path.join(pluginDir, "vendor/autoload.php"),
      `<?php
require_once __DIR__ . '/composer/autoload_real.php';
return ComposerAutoloaderInitMock::getLoader();
`
    );

    // Create a test runner script attempting to load vendor/autoload.php while src/ is absent
    const runnerScript = path.join(tmpRoot, "test-load.php");
    await writeFile(
      runnerScript,
      `<?php
require_once '${pluginDir}/vendor/autoload.php';
echo "SUCCESS";
`
    );

    // Execute PHP runner — must reproduce the exact require() Failed opening required Fatal error
    let phpFailed = false;
    let phpStderr = "";
    try {
      await execFileAsync("php", [runnerScript]);
    } catch (err) {
      phpFailed = true;
      phpStderr = err.stderr || err.message;
    }

    assert.equal(phpFailed, true, "PHP must fail when vendor/ is present but autoload target is missing");
    assert.match(
      phpStderr,
      /Fatal error.*Failed opening required.*functions-closure\.php/i,
      "Must reproduce the exact Composer autoload_real.php fatal error"
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("collectComposerAutoloadFileTargets: parses Composer __DIR__ '/../..' concatenation", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "autoload-targets-"));
  try {
    const vendorComposerDir = path.join(tmpRoot, "vendor/composer");
    await mkdir(vendorComposerDir, { recursive: true });
    await writeFile(
      path.join(vendorComposerDir, "autoload_static.php"),
      `<?php
class ComposerStaticInitMock {
    public static $files = array(
        '5aa49cf2cf2c104751daf08ebeb7468a' => __DIR__ . '/../..' . '/src/FrameworkClosure/functions-closure.php',
    );
}
`
    );
    const targets = await collectComposerAutoloadFileTargets(tmpRoot);
    assert.ok(
      targets.has("src/FrameworkClosure/functions-closure.php"),
      "Must resolve the Composer autoload_static.php plugin-root concatenation"
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("Canonical ZIP Ordering: functions-closure.php and all autoload.files precede vendor autoloaders", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "zip-order-test-"));
  const stagingDir = path.join(tmpRoot, "tavangary-core");
  const outputZip = path.join(tmpRoot, "tavangary-core-profile-s.zip");

  try {
    await mkdir(path.join(stagingDir, "src/FrameworkClosure"), { recursive: true });
    await mkdir(path.join(stagingDir, "src/Modules"), { recursive: true });
    await mkdir(path.join(stagingDir, "vendor/composer"), { recursive: true });
    await mkdir(path.join(stagingDir, "vendor/nyholm/psr7/src"), { recursive: true });
    await mkdir(path.join(stagingDir, "assets"), { recursive: true });

    await writeFile(path.join(stagingDir, "tavangary-core.php"), "<?php // Main plugin bootstrap");
    await writeFile(path.join(stagingDir, "LICENSE"), "GPL-2.0");
    await writeFile(path.join(stagingDir, "readme.txt"), "Readme");
    await writeFile(path.join(stagingDir, "assets/app.js"), "console.log('app');");
    await writeFile(path.join(stagingDir, "src/FrameworkClosure/functions-closure.php"), "<?php // Closure helper");
    await writeFile(path.join(stagingDir, "src/admin-panel-register.php"), "<?php // Register");
    await writeFile(path.join(stagingDir, "src/help-register.php"), "<?php // Help");
    await writeFile(path.join(stagingDir, "vendor/nyholm/psr7/src/Message.php"), "<?php // Nyholm");

    // Autoload files
    await writeFile(
      path.join(stagingDir, "vendor/composer/autoload_files.php"),
      `<?php
$vendorDir = dirname(__DIR__);
$baseDir = dirname($vendorDir);
return array(
    'closure' => $baseDir . '/src/FrameworkClosure/functions-closure.php',
    'admin' => $baseDir . '/src/admin-panel-register.php',
    'help' => $baseDir . '/src/help-register.php',
);
`
    );
    await writeFile(path.join(stagingDir, "vendor/composer/autoload_real.php"), "<?php // Autoload real");
    await writeFile(
      path.join(stagingDir, "vendor/composer/autoload_static.php"),
      `<?php
class ComposerStaticInitMock {
    public static $files = array(
        'closure' => __DIR__ . '/../..' . '/src/FrameworkClosure/functions-closure.php',
        'admin' => __DIR__ . '/../..' . '/src/admin-panel-register.php',
        'help' => __DIR__ . '/../..' . '/src/help-register.php',
    );
}
`
    );
    await writeFile(path.join(stagingDir, "vendor/composer/ClassLoader.php"), "<?php // ClassLoader");
    await writeFile(path.join(stagingDir, "vendor/autoload.php"), "<?php // Autoload entry");

    // Generate manifest
    await generateArtifactManifest({ rootDir: stagingDir, consumer: "tavangary-core" });

    // Create canonical ordered ZIP
    await createCanonicalZip({
      sourceRoot: stagingDir,
      outputZip,
      rootName: "tavangary-core",
    });

    // Inspect archive entries order
    const zipBytes = await readFile(outputZip);
    const entries = readZipEntries(zipBytes);
    const entryNames = entries.map((e) => e.name);

    const bootstrapIdx = entryNames.indexOf("tavangary-core/tavangary-core.php");
    const closureIdx = entryNames.indexOf("tavangary-core/src/FrameworkClosure/functions-closure.php");
    const adminRegIdx = entryNames.indexOf("tavangary-core/src/admin-panel-register.php");
    const helpRegIdx = entryNames.indexOf("tavangary-core/src/help-register.php");
    const autoloadRealIdx = entryNames.indexOf("tavangary-core/vendor/composer/autoload_real.php");
    const vendorAutoloadIdx = entryNames.indexOf("tavangary-core/vendor/autoload.php");

    assert.ok(bootstrapIdx !== -1, "Bootstrap must exist in ZIP");
    assert.ok(closureIdx !== -1, "Closure must exist in ZIP");
    assert.ok(adminRegIdx !== -1, "admin-panel-register must exist in ZIP");
    assert.ok(helpRegIdx !== -1, "help-register must exist in ZIP");
    assert.ok(autoloadRealIdx !== -1, "autoload_real must exist in ZIP");
    assert.ok(vendorAutoloadIdx !== -1, "vendor/autoload must exist in ZIP");

    // Critical order assertions
    assert.ok(
      bootstrapIdx < autoloadRealIdx,
      `Bootstrap (idx: ${bootstrapIdx}) must precede autoload_real (idx: ${autoloadRealIdx})`
    );
    assert.ok(
      closureIdx < autoloadRealIdx,
      `functions-closure (idx: ${closureIdx}) must precede autoload_real (idx: ${autoloadRealIdx})`
    );
    assert.ok(
      adminRegIdx < autoloadRealIdx,
      `admin-panel-register (idx: ${adminRegIdx}) must precede autoload_real (idx: ${autoloadRealIdx})`
    );
    assert.ok(
      helpRegIdx < autoloadRealIdx,
      `help-register (idx: ${helpRegIdx}) must precede autoload_real (idx: ${autoloadRealIdx})`
    );
    assert.ok(
      autoloadRealIdx < vendorAutoloadIdx,
      `autoload_real (idx: ${autoloadRealIdx}) must precede vendor/autoload (idx: ${vendorAutoloadIdx})`
    );
    assert.equal(
      vendorAutoloadIdx,
      entries.length - 1,
      "vendor/autoload.php must be the final entry in the ZIP archive"
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("Atomic deploy: preflight fails closed if mandatory autoload target is missing from candidate", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "deploy-fail-closed-"));
  const pluginsDir = path.join(tmpRoot, "plugins");
  const targetPluginDir = path.join(pluginsDir, "sample-plugin");
  const candidateZip = path.join(tmpRoot, "candidate.zip");

  try {
    await mkdir(targetPluginDir, { recursive: true });
    await writeFile(path.join(targetPluginDir, "sample-plugin.php"), "<?php echo 'v1-active';");

    // Build candidate staging with a missing autoload target referenced in autoload_files.php
    const stagingDir = path.join(tmpRoot, "staging/sample-plugin");
    await mkdir(path.join(stagingDir, "vendor/composer"), { recursive: true });
    await writeFile(path.join(stagingDir, "sample-plugin.php"), "<?php echo 'v2';");
    await writeFile(path.join(stagingDir, "vendor/autoload.php"), "<?php");
    await writeFile(path.join(stagingDir, "vendor/composer/autoload_real.php"), "<?php");
    await writeFile(
      path.join(stagingDir, "vendor/composer/autoload_files.php"),
      `<?php
$baseDir = dirname(dirname(__DIR__));
return array(
    'missing' => $baseDir . '/src/MissingTarget.php',
);
`
    );
    await generateArtifactManifest({ rootDir: stagingDir, consumer: "sample-plugin" });
    await createCanonicalZip({ sourceRoot: stagingDir, outputZip: candidateZip, rootName: "sample-plugin" });

    let deployFailed = false;
    let deployErrorMsg = "";
    try {
      await atomicDeployPlugin(candidateZip, "sample-plugin", { pluginsDir, contentRoot: tmpRoot });
    } catch (err) {
      deployFailed = true;
      deployErrorMsg = err.message;
    }

    assert.equal(deployFailed, true, "Deploy must fail when candidate has missing autoload target");
    assert.match(
      deployErrorMsg,
      /mandatory autoload target 'src\/MissingTarget\.php' is missing/i,
      "Must explicitly report missing mandatory autoload target"
    );

    // Target must remain 100% untouched
    const activeContent = await readFile(path.join(targetPluginDir, "sample-plugin.php"), "utf8");
    assert.equal(activeContent, "<?php echo 'v1-active';", "Original active plugin must remain untouched");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("deploy-standalone-plugin CLI: executes successful atomic deployment via CLI wrapper", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "deploy-cli-test-"));
  const pluginsDir = path.join(tmpRoot, "plugins");
  const candidateZip = path.join(tmpRoot, "demo-plugin.zip");
  const stagingDir = path.join(tmpRoot, "staging/demo-plugin");

  try {
    await mkdir(pluginsDir, { recursive: true });
    await mkdir(stagingDir, { recursive: true });
    await writeFile(path.join(stagingDir, "demo-plugin.php"), "<?php // Demo plugin");
    await writeFile(path.join(stagingDir, "LICENSE"), "MIT");
    await generateArtifactManifest({ rootDir: stagingDir, consumer: "demo-plugin" });
    await createCanonicalZip({ sourceRoot: stagingDir, outputZip: candidateZip, rootName: "demo-plugin" });

    const exitCode = await runDeployCli([
      candidateZip,
      "demo-plugin",
      `--plugins-dir=${pluginsDir}`,
      `--content-root=${tmpRoot}`,
    ]);

    assert.equal(exitCode, 0, "CLI deploy must exit with code 0 on success");
    const deployedMain = path.join(pluginsDir, "demo-plugin/demo-plugin.php");
    assert.ok(fs.existsSync(deployedMain), "Deployed plugin bootstrap must exist");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("deploy-standalone-plugin CLI: resolves pluginsDir and contentRoot without explicit content-root flag", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "deploy-no-cr-test-"));
  const pluginsDir = path.join(tmpRoot, "wp-content/plugins");
  const candidateZip = path.join(tmpRoot, "custom-plugin.zip");
  const stagingDir = path.join(tmpRoot, "staging/custom-plugin");

  try {
    await mkdir(pluginsDir, { recursive: true });
    await mkdir(stagingDir, { recursive: true });
    await writeFile(path.join(stagingDir, "custom-plugin.php"), "<?php // Custom plugin");
    await writeFile(path.join(stagingDir, "LICENSE"), "MIT");
    await generateArtifactManifest({ rootDir: stagingDir, consumer: "custom-plugin" });
    await createCanonicalZip({ sourceRoot: stagingDir, outputZip: candidateZip, rootName: "custom-plugin" });

    const exitCode = await runDeployCli([
      candidateZip,
      "custom-plugin",
      `--plugins-dir=${pluginsDir}`,
    ]);

    assert.equal(exitCode, 0, "CLI deploy must succeed with only --plugins-dir");
    const deployedMain = path.join(pluginsDir, "custom-plugin/custom-plugin.php");
    assert.ok(fs.existsSync(deployedMain), "Deployed plugin bootstrap must exist");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("deploy-standalone-plugin CLI: missing zip returns 1 without exiting the process", async () => {
  const missing = await runDeployCli([]);
  assert.equal(missing, 1, "CLI must return 1 when zip path is omitted");

  const absent = await runDeployCli([path.join(os.tmpdir(), "definitely-missing-plugin.zip")]);
  assert.equal(absent, 1, "CLI must return 1 when zip path does not exist");
});

test("Atomic deploy: fails closed if FrameworkClosure directory exists without functions-closure.php", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "deploy-missing-closure-dir-"));
  const pluginsDir = path.join(tmpRoot, "plugins");
  const targetPluginDir = path.join(pluginsDir, "sample-plugin");
  const candidateZip = path.join(tmpRoot, "candidate.zip");

  try {
    await mkdir(targetPluginDir, { recursive: true });
    await writeFile(path.join(targetPluginDir, "sample-plugin.php"), "<?php echo 'v1-active';");

    const stagingDir = path.join(tmpRoot, "staging/sample-plugin");
    await mkdir(path.join(stagingDir, "src/FrameworkClosure"), { recursive: true });
    await writeFile(path.join(stagingDir, "sample-plugin.php"), "<?php echo 'v2';");
    await generateArtifactManifest({ rootDir: stagingDir, consumer: "sample-plugin" });
    await createCanonicalZip({ sourceRoot: stagingDir, outputZip: candidateZip, rootName: "sample-plugin" });

    await assert.rejects(
      () => atomicDeployPlugin(candidateZip, "sample-plugin", { pluginsDir, contentRoot: tmpRoot }),
      /FrameworkClosure\/functions-closure\.php is missing/i
    );

    const activeContent = await readFile(path.join(targetPluginDir, "sample-plugin.php"), "utf8");
    assert.equal(activeContent, "<?php echo 'v1-active';", "Original active plugin must remain untouched");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("Atomic deploy: registered shared-framework consumer fails closed without functions-closure.php", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "deploy-registered-closure-"));
  const pluginsDir = path.join(tmpRoot, "plugins");
  const targetPluginDir = path.join(pluginsDir, "tavangary-core");
  const candidateZip = path.join(tmpRoot, "candidate.zip");

  try {
    await mkdir(targetPluginDir, { recursive: true });
    await writeFile(path.join(targetPluginDir, "tavangary-core.php"), "<?php echo 'v1-active';");

    const stagingDir = path.join(tmpRoot, "staging/tavangary-core");
    await mkdir(stagingDir, { recursive: true });
    await writeFile(path.join(stagingDir, "tavangary-core.php"), "<?php echo 'v2';");
    await generateArtifactManifest({ rootDir: stagingDir, consumer: "tavangary-core" });
    await createCanonicalZip({ sourceRoot: stagingDir, outputZip: candidateZip, rootName: "tavangary-core" });

    await assert.rejects(
      () => atomicDeployPlugin(candidateZip, "tavangary-core", { pluginsDir, contentRoot: tmpRoot }),
      /FrameworkClosure\/functions-closure\.php is missing/i
    );

    const activeContent = await readFile(path.join(targetPluginDir, "tavangary-core.php"), "utf8");
    assert.equal(activeContent, "<?php echo 'v1-active';", "Original active plugin must remain untouched");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

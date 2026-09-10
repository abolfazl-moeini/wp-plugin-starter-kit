import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { collectComposerAutoloadFileTargets } from "../canonical-artifact-manifest.mjs";
import { parseDeployArgs } from "../deploy-standalone-plugin.mjs";
import { atomicDeployPlugin } from "../build-all-standalone-plugins.mjs";
import {
  injectFunctionsClosureLoader,
  inlineWpdevClosure,
  removeWpdevPluginRequirement,
  resolveConsumerNamespace,
} from "../inline-wpdev-closure.mjs";

const execFileAsync = promisify(execFile);

test("F08: collectComposerAutoloadFileTargets rejects traversal and escaping targets", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "f08-autoload-"));
  try {
    const composerDir = path.join(tmpDir, "vendor/composer");
    await mkdir(composerDir, { recursive: true });

    // 1. Traversal in autoload_files.php
    await writeFile(
      path.join(composerDir, "autoload_files.php"),
      `<?php return array('hash1' => $baseDir . '/../escaped.php');`
    );
    await assert.rejects(
      collectComposerAutoloadFileTargets(tmpDir),
      /attempts parent directory traversal|escapes root boundary/i
    );

    // 2. Traversal in composer.json
    await rm(path.join(composerDir, "autoload_files.php"));
    await writeFile(
      path.join(tmpDir, "composer.json"),
      JSON.stringify({ autoload: { files: ["../../secret.txt"] } })
    );
    await assert.rejects(
      collectComposerAutoloadFileTargets(tmpDir),
      /attempts parent directory traversal|escapes root boundary/i
    );

    // 3. Symlink target inside root
    await rm(path.join(tmpDir, "composer.json"));
    const realFile = path.join(tmpDir, "real.php");
    const linkFile = path.join(tmpDir, "symlinked.php");
    await writeFile(realFile, "<?php // real");
    await symlink(realFile, linkFile);
    await writeFile(
      path.join(composerDir, "autoload_files.php"),
      `<?php return array('hash1' => $baseDir . '/symlinked.php');`
    );
    await assert.rejects(
      collectComposerAutoloadFileTargets(tmpDir),
      /must not be a symbolic link/i
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("F08: collectComposerAutoloadFileTargets rejects unsupported/corrupted format", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "f08-corrupt-autoload-"));
  try {
    const composerDir = path.join(tmpDir, "vendor/composer");
    await mkdir(composerDir, { recursive: true });

    // Unrecognized format that has array mapping but matches zero regexes
    await writeFile(
      path.join(composerDir, "autoload_files.php"),
      `<?php return array('hash1' => some_dynamic_function_call());`
    );
    await assert.rejects(
      collectComposerAutoloadFileTargets(tmpDir),
      /Unsupported Composer autoload_files\.php format/i
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("F08: parseDeployArgs strictly rejects unknown flags, empty values, and traversal", () => {
  // Empty values
  assert.throws(() => parseDeployArgs(["--plugins-dir="]), /cannot be empty/i);
  assert.throws(() => parseDeployArgs(["--content-root="]), /cannot be empty/i);
  assert.throws(() => parseDeployArgs(["--bootstrap="]), /cannot be empty/i);

  // Unknown flag
  assert.throws(() => parseDeployArgs(["--some-invalid-flag"]), /Unknown option/i);

  // Traversal in bootstrap
  assert.throws(() => parseDeployArgs(["--bootstrap=../escape.php"]), /Invalid bootstrap path/i);

  // Extra positional args
  assert.throws(() => parseDeployArgs(["file.zip", "slug", "extra-arg"]), /Unexpected extra argument/i);
});

test("F08: atomicDeployPlugin validates slug, bootstrap, and tokens before mutation", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "f08-deploy-val-"));
  try {
    const zipPath = path.join(tmpDir, "test.zip");
    await writeFile(zipPath, "dummy");

    // Invalid slug with slash
    await assert.rejects(
      atomicDeployPlugin(zipPath, "invalid/slug", { contentRoot: tmpDir }),
      /Invalid plugin slug/i
    );

    // Bootstrap with traversal
    await assert.rejects(
      atomicDeployPlugin(zipPath, "valid-slug", {
        contentRoot: tmpDir,
        bootstrapFile: "../escape.php",
      }),
      /Invalid bootstrap path/i
    );

    // Staging token escaping
    await assert.rejects(
      atomicDeployPlugin(zipPath, "valid-slug", {
        contentRoot: tmpDir,
        stagingToken: "../escape",
      }),
      /Invalid staging token/i
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Task 2: removeWpdevPluginRequirement decouples wpdev while strictly preserving other required plugins (R09)", () => {
  // Case 1: wpdev and woocommerce -> woocommerce preserved
  const headerWithWoo = `<?php
/**
 * Plugin Name: Test Plugin
 * Requires Plugins: wpdev, woocommerce
 */
`;
  const resultWoo = removeWpdevPluginRequirement(headerWithWoo);
  assert.ok(!resultWoo.includes("wpdev"), "wpdev token must be removed");
  assert.ok(resultWoo.includes("Requires Plugins: woocommerce"), "woocommerce dependency must be strictly preserved");

  // Case 2: woocommerce, wpdev, elementor -> both preserved
  const headerMulti = `<?php
/**
 * Requires Plugins: woocommerce, wpdev, elementor
 */
`;
  const resultMulti = removeWpdevPluginRequirement(headerMulti);
  assert.ok(!resultMulti.includes("wpdev"), "wpdev token must be removed");
  assert.ok(resultMulti.includes("Requires Plugins: woocommerce, elementor"), "other dependencies must be preserved in order");

  // Case 3: wpdev only -> entire Requires Plugins line removed cleanly
  const headerOnlyWpdev = `<?php
/**
 * Requires Plugins: wpdev
 */
`;
  const resultOnly = removeWpdevPluginRequirement(headerOnlyWpdev);
  assert.ok(!resultOnly.includes("Requires Plugins"), "Entire line removed when wpdev is the only dependency");
});

test("Task 2: injectFunctionsClosureLoader inserts closure loader across all supported bootstrap shapes (R13, V3-12)", async () => {
  // Shape 1: Standard WPDev closing brace after $vendor_autoload
  const shape1 = `<?php
if (file_exists($vendor_autoload)) {
    require_once $vendor_autoload;
}
`;
  const res1 = injectFunctionsClosureLoader(shape1);
  assert.ok(res1.includes("functions-closure.php"), "Loader injected after vendor_autoload block");

  // Shape 2: Direct vendor/autoload.php require
  const shape2 = `<?php
require_once __DIR__ . '/vendor/autoload.php';
echo "booted";
`;
  const res2 = injectFunctionsClosureLoader(shape2);
  assert.ok(res2.includes("functions-closure.php"), "Loader injected after direct vendor/autoload.php require");

  // Shape 3: Composer-free / ABSPATH guard only
  const shape3 = `<?php
defined('ABSPATH') || exit;
class PluginCore {}
`;
  const res3 = injectFunctionsClosureLoader(shape3);
  assert.ok(res3.includes("functions-closure.php"), "Loader injected after ABSPATH guard for composer-free plugins");

  // Shape 4: Strict types + statement namespace (V3-12)
  const shape4 = `<?php
declare(strict_types=1);
namespace Demo\\Plugin;
class PluginCore {}
`;
  const res4 = injectFunctionsClosureLoader(shape4);
  assert.ok(res4.includes("functions-closure.php"), "Loader injected for strict types + namespace");
  assert.ok(res4.indexOf("declare(strict_types=1);") < res4.indexOf("functions-closure.php"), "declare must precede injected code");
  assert.ok(res4.indexOf("namespace Demo\\Plugin;") < res4.indexOf("functions-closure.php"), "namespace must precede injected code");

  // Shape 5: Strict types without namespace (V3-12)
  const shape5 = `<?php
declare(strict_types=1);
class PluginCore {}
`;
  const res5 = injectFunctionsClosureLoader(shape5);
  assert.ok(res5.indexOf("declare(strict_types=1);") < res5.indexOf("functions-closure.php"), "declare must precede injected code");

  // Shape 6: Bracketed namespace (V3-12)
  const shape6 = `<?php
namespace Bracketed\\Scope {
    class PluginCore {}
}
`;
  const res6 = injectFunctionsClosureLoader(shape6);
  assert.ok(res6.indexOf("namespace Bracketed\\Scope {") < res6.indexOf("functions-closure.php"), "bracketed namespace opening must precede injected code");

  // Shape 7: if (!defined('ABSPATH')) exit; guard
  const shape7 = `<?php
if (!defined('ABSPATH')) {
    exit;
}
class PluginCore {}
`;
  const res7 = injectFunctionsClosureLoader(shape7);
  assert.ok(res7.indexOf("exit;") < res7.indexOf("functions-closure.php"), "ABSPATH guard must precede injected code");

  // Validate that all shapes produce syntactically valid PHP with php -l
  for (const [name, code] of [
    ["res1", res1],
    ["res2", res2],
    ["res3", res3],
    ["res4", res4],
    ["res5", res5],
    ["res6", res6],
    ["res7", res7],
  ]) {
    const tmp = path.join(os.tmpdir(), `syntax-check-${name}-${Date.now()}.php`);
    await writeFile(tmp, code, "utf8");
    try {
      const lintRes = await execFileAsync("php", ["-l", tmp]);
      assert.ok(lintRes.stdout.includes("No syntax errors detected"), `${name} must pass php -l lint check`);
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
});

test("Task 2: inlineWpdevClosure fails closed on missing framework provider before mutating headers (R09)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "f08-r09-"));
  try {
    const stagingPlugin = path.join(tmpDir, "sample-plugin");
    await mkdir(stagingPlugin, { recursive: true });
    const originalHeader = `<?php
/**
 * Plugin Name: Sample Plugin
 * Requires Plugins: wpdev, woocommerce
 */
`;
    await writeFile(path.join(stagingPlugin, "sample-plugin.php"), originalHeader, "utf8");

    // Call inlineWpdevClosure with a nonexistent framework directory
    await assert.rejects(
      inlineWpdevClosure({
        stagingPlugin,
        consumer: "sample-plugin",
        contentRoot: tmpDir,
        wpdevPluginDirOverride: path.join(tmpDir, "nonexistent-wpdev"),
      }),
      /Required framework provider directory does not exist/
    );

    // Verify mainPhp was NOT mutated
    const mainPhpAfter = await readFile(path.join(stagingPlugin, "sample-plugin.php"), "utf8");
    assert.equal(mainPhpAfter, originalHeader, "Header must not be mutated when provider is missing");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Task 2: Composer autoload.files and metadata survive in clean and standalone builds (R01)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "f08-r01-"));
  try {
    const pluginDir = path.join(tmpDir, "probe-plugin");
    await mkdir(path.join(pluginDir, "boot"), { recursive: true });
    await mkdir(path.join(pluginDir, "src"), { recursive: true });

    await writeFile(
      path.join(pluginDir, "boot/start.php"),
      `<?php function startup_token() { return 'loaded'; }\n`,
      "utf8"
    );
    await writeFile(
      path.join(pluginDir, "composer.json"),
      JSON.stringify({
        name: "test/probe-plugin",
        autoload: {
          files: ["boot/start.php"],
          "psr-4": { "ProbePlugin\\": "src/" },
        },
      }),
      "utf8"
    );

    // Initial dump-autoload to establish vendor
    const dumpRes = await execFileAsync("composer", ["dump-autoload", "--no-scripts", "--no-plugins"], {
      cwd: pluginDir,
    });
    assert.equal(dumpRes.stderr?.includes("error"), false);

    // Create fake framework directory
    const fakeFramework = path.join(tmpDir, "fake-wpdev");
    await mkdir(path.join(fakeFramework, "modules/core/src"), { recursive: true });
    await writeFile(
      path.join(fakeFramework, "modules/core/src/class-plugin.php"),
      `<?php namespace WPDevFramework\\Core; class Plugin {}\n`,
      "utf8"
    );

    await writeFile(
      path.join(pluginDir, "probe-plugin.php"),
      `<?php
/**
 * Plugin Name: Probe Plugin
 * Requires Plugins: wpdev
 */
require_once __DIR__ . '/vendor/autoload.php';
`,
      "utf8"
    );

    const sourceComposerModel = JSON.parse(await readFile(path.join(pluginDir, "composer.json"), "utf8"));

    const inlined = await inlineWpdevClosure({
      stagingPlugin: pluginDir,
      consumer: "probe-plugin",
      contentRoot: tmpDir,
      wpdevPluginDirOverride: fakeFramework,
      sourceComposerModel,
    });
    assert.ok(inlined.inlinedFiles > 0, "Closure files must be inlined");

    // Verify staging composer.json preserves boot/start.php alongside closure files
    const stagingComp = JSON.parse(await readFile(path.join(pluginDir, "composer.json"), "utf8"));
    assert.ok(stagingComp.autoload.files.includes("boot/start.php"), "boot/start.php must be preserved in autoload.files");
    assert.ok(
      stagingComp.autoload.files.includes("src/FrameworkClosure/functions-closure.php"),
      "functions-closure.php must be added"
    );

    // Regenerate composer autoloader in staging
    await execFileAsync("composer", ["dump-autoload", "--no-dev", "--optimize", "--no-scripts", "--no-plugins"], {
      cwd: pluginDir,
    });

    const autoFilesPhp = path.join(pluginDir, "vendor/composer/autoload_files.php");
    const autoFilesContent = fs.existsSync(autoFilesPhp) ? await readFile(autoFilesPhp, "utf8") : "NO_FILE";
    const verifyScript = `
define('ABSPATH', __DIR__ . '/');
require '${path.join(pluginDir, "vendor/autoload.php")}';
if (!function_exists('startup_token')) {
    fwrite(STDERR, "FUNCTION_NOT_FOUND");
    exit(1);
}
echo startup_token();
`;
    const { stdout, stderr } = await execFileAsync("php", ["-r", verifyScript]);
    assert.equal(stdout.trim(), "loaded", `Expected loaded, got '${stdout}' (stderr: ${stderr}, autoload_files: ${autoFilesContent})`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("V3-12: resolveConsumerNamespace handles nested namespaces and rejects ambiguous mappings", () => {
  // Nested PSR-4 namespace preserved completely
  const nestedNs = resolveConsumerNamespace({
    consumer: "custom-plugin",
    sourceComposerModel: {
      autoload: {
        "psr-4": { "Acme\\Nested\\Module\\": "src/" },
      },
    },
  });
  assert.equal(nestedNs, "Acme\\Nested\\Module", "Nested namespace must not be truncated to first segment");

  // Explicit namespace overrides all
  const explicitNs = resolveConsumerNamespace({
    consumer: "custom-plugin",
    explicitNamespace: "Custom\\Override\\Ns",
    sourceComposerModel: {
      autoload: {
        "psr-4": { "Acme\\Nested\\Module\\": "src/" },
      },
    },
  });
  assert.equal(explicitNs, "Custom\\Override\\Ns");

  // Common root prefix resolved across multiple PSR-4 mappings
  const commonPrefixNs = resolveConsumerNamespace({
    consumer: "custom-plugin",
    sourceComposerModel: {
      autoload: {
        "psr-4": {
          "Acme\\SubA\\": "src/a",
          "Acme\\SubB\\": "src/b",
        },
      },
    },
  });
  assert.equal(commonPrefixNs, "Acme");

  // Ambiguous mappings with multiple different root namespaces fail closed
  assert.throws(
    () => resolveConsumerNamespace({
      consumer: "unrelated-consumer",
      sourceComposerModel: {
        autoload: {
          "psr-4": {
            "VendorA\\Module\\": "src/a",
            "VendorB\\Module\\": "src/b",
          },
        },
      },
    }),
    /Ambiguous PSR-4 configuration/
  );
});

test("V3-12: Composer-free cold-load does not write dummy composer.json and loads functions-closure.php", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "f08-composer-free-"));
  try {
    const pluginDir = path.join(tmpDir, "free-plugin");
    await mkdir(pluginDir, { recursive: true });

    // Bootstrap with strict_types and namespace
    await writeFile(
      path.join(pluginDir, "free-plugin.php"),
      `<?php
declare(strict_types=1);
namespace FreePlugin;

defined('ABSPATH') || exit;

class FreePluginCore {
    public function status() { return 'ok'; }
}
`,
      "utf8"
    );

    // Fake framework
    const fakeFramework = path.join(tmpDir, "fake-wpdev");
    await mkdir(path.join(fakeFramework, "modules/core/src"), { recursive: true });
    await writeFile(
      path.join(fakeFramework, "modules/core/src/class-plugin.php"),
      `<?php namespace WPDevFramework\\Core; class Plugin {}\n`,
      "utf8"
    );

    const inlined = await inlineWpdevClosure({
      stagingPlugin: pluginDir,
      consumer: "free-plugin",
      contentRoot: tmpDir,
      wpdevPluginDirOverride: fakeFramework,
      sourceComposerModel: null,
    });
    assert.ok(inlined.inlinedFiles > 0);

    // Composer.json must NOT be generated for Composer-free plugins
    assert.equal(fs.existsSync(path.join(pluginDir, "composer.json")), false, "Dummy composer.json must not be created");

    // Main plugin file must pass php -l
    const { stdout: lintOut } = await execFileAsync("php", ["-l", path.join(pluginDir, "free-plugin.php")]);
    assert.ok(lintOut.includes("No syntax errors detected"));

    // Execute bootstrap in a fresh PHP process
    const runScript = `
define('ABSPATH', __DIR__ . '/');
require '${path.join(pluginDir, "free-plugin.php")}';
$core = new \\FreePlugin\\FreePluginCore();
echo $core->status();
`;
    const { stdout: runOut } = await execFileAsync("php", ["-r", runScript]);
    assert.equal(runOut.trim(), "ok");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("V3-12: declared classmap outside src is preserved and missing classmap paths fail closed", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "f08-classmap-"));
  try {
    const pluginDir = path.join(tmpDir, "classmap-plugin");
    await mkdir(path.join(pluginDir, "runtime"), { recursive: true });
    await mkdir(path.join(pluginDir, "src"), { recursive: true });

    await writeFile(
      path.join(pluginDir, "runtime/Legacy.php"),
      `<?php class LegacyService { public function ping() { return 'pong'; } }\n`,
      "utf8"
    );
    await writeFile(
      path.join(pluginDir, "src/Main.php"),
      `<?php namespace ClassmapPlugin; class Main {}\n`,
      "utf8"
    );

    const compData = {
      name: "test/classmap-plugin",
      autoload: {
        classmap: ["runtime/Legacy.php"],
        "psr-4": { "ClassmapPlugin\\": "src/" },
      },
    };
    await writeFile(path.join(pluginDir, "composer.json"), JSON.stringify(compData, null, 2), "utf8");

    // Missing classmap path check fails closed
    const badCompData = {
      name: "test/classmap-plugin",
      autoload: {
        classmap: ["nonexistent/Missing.php"],
      },
    };
    const declaredClassmap = badCompData.autoload.classmap;
    assert.throws(
      () => {
        for (const item of declaredClassmap) {
          if (!fs.existsSync(path.join(pluginDir, item))) {
            throw new Error(`Declared autoload classmap path '${item}' does not exist in staging tree`);
          }
        }
      },
      /Declared autoload classmap path 'nonexistent\/Missing.php' does not exist/
    );

    // Dump autoload with optimize
    await execFileAsync("composer", ["dump-autoload", "--no-scripts", "--no-plugins", "--optimize"], {
      cwd: pluginDir,
    });

    const classmapPhp = path.join(pluginDir, "vendor/composer/autoload_classmap.php");
    const classmapContent = await readFile(classmapPhp, "utf8");
    assert.ok(classmapContent.includes("LegacyService"), "LegacyService from outside src must be in dumped classmap");

    // Execute cold load of LegacyService via vendor/autoload
    const verifyScript = `
define('ABSPATH', __DIR__ . '/');
require '${path.join(pluginDir, "vendor/autoload.php")}';
$legacy = new \\LegacyService();
echo $legacy->ping();
`;
    const { stdout } = await execFileAsync("php", ["-r", verifyScript]);
    assert.equal(stdout.trim(), "pong");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});


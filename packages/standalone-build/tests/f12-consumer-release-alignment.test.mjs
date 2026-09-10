import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { parseArgs as parseRunReleaseArgs } from "../../create-wp-project/src/release/run-release.js";
import {
  parseArgs as parsePrepareReleaseArgs,
  resolveCanonicalAssembler,
  prepareRelease,
  CANONICAL_CONSUMERS,
  registerCanonicalConsumer,
} from "../../create-wp-project/src/release/prepare-release.js";
import { readZipEntries } from "../canonical-artifact-manifest.mjs";
import { parsePipelineArgs } from "../build-all-standalone-plugins.mjs";
import {
  validateCachedTargetArtifact,
  createTargetCacheRecord,
} from "../build-cache-engine.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scriptDir = path.resolve(__dirname, "..");
const kitRoot = path.resolve(scriptDir, "../..");

test("F12: Profile flag parsing rejects conflicts in both orders and whitespace/equals variants", () => {
  const parsers = [
    { name: "run-release", parse: parseRunReleaseArgs },
    { name: "prepare-release", parse: parsePrepareReleaseArgs },
  ];

  for (const { name, parse } of parsers) {
    // 1. Order: --profile=clean then --obfuscate
    assert.throws(
      () => parse(["--profile=clean", "--obfuscate"]),
      /Conflicting profile flags/,
      `${name} must reject --profile=clean followed by --obfuscate`
    );

    // 2. Order: --obfuscate then --profile=clean
    assert.throws(
      () => parse(["--obfuscate", "--profile=clean"]),
      /Conflicting profile flags/,
      `${name} must reject --obfuscate followed by --profile=clean`
    );

    // 3. Order: --profile clean (with space) then --obfuscate
    assert.throws(
      () => parse(["--profile", "clean", "--obfuscate"]),
      /Conflicting profile flags/,
      `${name} must reject --profile clean followed by --obfuscate`
    );

    // 4. Order: --obfuscate then --profile clean (with space)
    assert.throws(
      () => parse(["--obfuscate", "--profile", "clean"]),
      /Conflicting profile flags/,
      `${name} must reject --obfuscate followed by --profile clean`
    );

    // 5. Order: --profile=clean then --profile=s
    assert.throws(
      () => parse(["--profile=clean", "--profile=s"]),
      /Conflicting profile flags/,
      `${name} must reject --profile=clean followed by --profile=s`
    );

    // 6. Accepts space and equals variants for Profile S
    const sEquals = parse(["--profile=s"]);
    assert.equal(sEquals.profile, "s", `${name} --profile=s should set profile: s`);
    assert.equal(sEquals.obfuscate, true, `${name} --profile=s should set obfuscate: true`);

    const sSpace = parse(["--profile", "s"]);
    assert.equal(sSpace.profile, "s", `${name} --profile s should set profile: s`);
    assert.equal(sSpace.obfuscate, true, `${name} --profile s should set obfuscate: true`);

    const sObf = parse(["--obfuscate"]);
    assert.equal(sObf.profile, "s", `${name} --obfuscate should set profile: s`);
    assert.equal(sObf.obfuscate, true, `${name} --obfuscate should set obfuscate: true`);

    // 7. Accepts space and equals variants for clean profile
    const cleanEquals = parse(["--profile=clean"]);
    assert.equal(cleanEquals.profile, "clean", `${name} --profile=clean should set profile: clean`);
    assert.equal(cleanEquals.obfuscate, false, `${name} --profile=clean should set obfuscate: false`);

    const cleanSpace = parse(["--profile", "clean"]);
    assert.equal(cleanSpace.profile, "clean", `${name} --profile clean should set profile: clean`);
    assert.equal(cleanSpace.obfuscate, false, `${name} --profile clean should set obfuscate: false`);

    // 8. Rejects invalid profiles and missing arguments
    assert.throws(
      () => parse(["--profile", "invalid"]),
      /Invalid --profile 'invalid'/,
      `${name} must reject invalid profile`
    );
    assert.throws(
      () => parse(["--profile"]),
      /Invalid --profile: a value is required/,
      `${name} must reject --profile without value`
    );
    assert.throws(
      () => parse(["--profile="]),
      /Invalid --profile: a value is required/,
      `${name} must reject --profile= without value`
    );
  }
});

test("F12: resolveCanonicalAssembler resolves standalone assembleProfileSCandidate", () => {
  const resolved = resolveCanonicalAssembler({
    fromDir: path.join(kitRoot, "packages/create-wp-project/src/release"),
    pluginRoot: kitRoot,
  });
  assert.ok(resolved, "Must resolve canonical assembler");
  assert.ok(fs.existsSync(resolved), `Resolved path must exist: ${resolved}`);
  assert.ok(resolved.endsWith("assemble-profile-s-candidate.mjs"), "Must point to assemble-profile-s-candidate.mjs");
});

test("F12: Generic release with --obfuscate dumps Composer classmap for mangled symbols", async () => {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "f12-generic-test-"));
  try {
    const slug = "sample-generic-plugin";
    const srcDir = path.join(tmpRoot, slug);
    await fs.promises.mkdir(path.join(srcDir, "src"), { recursive: true });
    await fs.promises.mkdir(path.join(srcDir, "vendor/composer"), { recursive: true });

    await fs.promises.writeFile(
      path.join(srcDir, "wpdev.json"),
      JSON.stringify({ slug, phpMinVersion: "7.4" }),
      "utf8"
    );
    await fs.promises.writeFile(
      path.join(srcDir, `${slug}.php`),
      `<?php\n/**\n * Plugin Name: Sample Generic\n */\nif (!defined('ABSPATH')) exit;\n`,
      "utf8"
    );
    await fs.promises.writeFile(
      path.join(srcDir, "src", "WidgetController.php"),
      `<?php\nnamespace SampleGeneric\\Controllers;\nclass WidgetController {\n    public function render() { return 'rendered'; }\n}\n`,
      "utf8"
    );
    await fs.promises.writeFile(
      path.join(srcDir, "composer.json"),
      JSON.stringify({
        name: "test/sample-generic",
        autoload: { "psr-4": { "SampleGeneric\\": "src/" } }
      }),
      "utf8"
    );
    await fs.promises.mkdir(path.join(srcDir, "dev"), { recursive: true });
    await fs.promises.mkdir(path.join(srcDir, "vendor/bin"), { recursive: true });

    await fs.promises.writeFile(
      path.join(srcDir, "dev/rector-build.php"),
      `<?php return static function (): void {};\n`,
      "utf8"
    );
    const rectorBinPath = path.join(srcDir, "vendor/bin/rector");
    await fs.promises.writeFile(
      rectorBinPath,
      `#!/usr/bin/env php\n<?php exit(0);\n`,
      { encoding: "utf8", mode: 0o755 }
    );

    // Initial dump-autoload in source to establish real vendor structure
    const initDump = spawnSync("composer", ["dump-autoload", "--no-scripts", "--no-plugins"], {
      cwd: srcDir,
      encoding: "utf8",
    });
    assert.equal(initDump.status, 0, `Initial composer dump-autoload must succeed: ${initDump.stderr}`);

    // Run prepareRelease with actual obfuscate: true and skipRector: false
    const result = await prepareRelease({
      root: srcDir,
      out: "dist",
      skipTests: true,
      skipComposer: false,
      skipRector: false,
      obfuscate: true,
      useCanonicalAssembler: false,
    });

    assert.equal(result.slug, slug);
    assert.ok(fs.existsSync(result.distRoot), "distRoot must exist");
    assert.ok(fs.existsSync(result.zipPath), "zipPath must exist");

    // Verify source code was actually mangled
    const widgetDistCode = await fs.promises.readFile(
      path.join(result.distRoot, "src/WidgetController.php"),
      "utf8"
    );
    assert.ok(!widgetDistCode.includes("class WidgetController"), "Original class name must be mangled");
    assert.ok(widgetDistCode.includes("_c_"), "Mangled class prefix _c_ must be present in code");

    // Verify Composer classmap includes the mangled class and can be autoloaded in a fresh process
    const phpVerifyScript = `
require '${path.join(result.distRoot, "vendor/autoload.php")}';
$classmap = require '${path.join(result.distRoot, "vendor/composer/autoload_classmap.php")}';
$found = false;
foreach ($classmap as $className => $file) {
    if (strpos($className, '_c_') !== false) {
        $inst = new $className();
        if ($inst->render() === 'rendered') {
            $found = true;
            break;
        }
    }
}
if (!$found) {
    fwrite(STDERR, "Mangled class not found or render failed in classmap: " . json_encode(array_keys($classmap)) . "\\n");
    exit(1);
}
echo "AUTOLOAD_OK";
`;
    const phpRun = spawnSync("php", ["-r", phpVerifyScript], { encoding: "utf8" });
    assert.equal(phpRun.status, 0, `Fresh PHP process must autoload and call mangled class: ${phpRun.stderr}`);
    assert.equal(phpRun.stdout.trim(), "AUTOLOAD_OK");
  } finally {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("F12: Consumer release adapter routes registered consumers to canonical assembler", async () => {
  const all7 = [
    "tavangary-core",
    "tavangary-theme-panel",
    "wpdev-crm",
    "wpdev-tickets",
    "wpdev-analytics",
    "wpdev-woo-persian",
    "drm-connector",
  ];

  for (const c of all7) {
    assert.ok(CANONICAL_CONSUMERS.has(c), `${c} must be recognized as canonical consumer`);
  }
});

test("F12: prepareRelease preflight rejects invalid options before wiping or mutating existing dist", async () => {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "f12-preflight-test-"));
  try {
    const slug = "my-guarded-plugin";
    const srcDir = path.join(tmpRoot, slug);
    const distDir = path.join(srcDir, "dist", slug);
    await fs.promises.mkdir(distDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(srcDir, "wpdev.json"),
      JSON.stringify({ slug, phpMinVersion: "7.4" }),
      "utf8"
    );
    await fs.promises.writeFile(
      path.join(srcDir, `${slug}.php`),
      `<?php\n// Plugin\n`,
      "utf8"
    );
    const existingMarker = path.join(distDir, "previously-good-build.txt");
    await fs.promises.writeFile(existingMarker, "last-good-dist-content", "utf8");

    // 1. Obfuscate + skipRector combination must reject and preserve existing dist
    await assert.rejects(
      async () => {
        await prepareRelease({
          root: srcDir,
          obfuscate: true,
          skipRector: true,
          skipTests: true,
        });
      },
      /Profile S cannot combine --obfuscate with --skip-rector/,
      "Must reject obfuscate + skipRector before touching dist"
    );
    assert.ok(
      fs.existsSync(existingMarker),
      "Existing dist artifact must be preserved when options are invalid"
    );

    // 2. Conflicting profile flags must reject and preserve existing dist
    await assert.rejects(
      async () => {
        await prepareRelease({
          root: srcDir,
          obfuscate: true,
          profile: "clean",
          skipTests: true,
        });
      },
      /Conflicting profile flags/,
      "Must reject conflicting profile flags before touching dist"
    );
    assert.ok(
      fs.existsSync(existingMarker),
      "Existing dist artifact must be preserved on conflicting profile flags"
    );

    // 3. Unknown profile value must reject and preserve existing dist
    await assert.rejects(
      async () => {
        await prepareRelease({
          root: srcDir,
          profile: "unknown",
          skipTests: true,
        });
      },
      /Invalid profile 'unknown'/,
      "Must reject unknown profile value before touching dist"
    );
    assert.ok(
      fs.existsSync(existingMarker),
      "Existing dist artifact must be preserved on invalid profile value"
    );
  } finally {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("F12: prepareRelease routes custom consumers to canonical assembler by default", async () => {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "f12-canonical-routing-"));
  try {
    const slug = "my-custom-addon";
    const srcDir = path.join(tmpRoot, "plugins", slug);
    await fs.promises.mkdir(srcDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(srcDir, "wpdev.json"),
      JSON.stringify({ slug, phpMinVersion: "7.4" }),
      "utf8"
    );
    await fs.promises.writeFile(
      path.join(srcDir, `${slug}.php`),
      `<?php\n/**\n * Plugin Name: Custom Addon\n */\nif (!defined('ABSPATH')) exit;\n`,
      "utf8"
    );

    // 1. Explicit useCanonicalAssembler: true delegates to canonical assembler
    const res = await prepareRelease({
      root: srcDir,
      skipTests: true,
      skipZip: true,
      inlineFramework: false,
      useCanonicalAssembler: true,
    });

    assert.equal(res.slug, slug);
    assert.ok(res.manifest, "Must contain manifest from canonical assembler");
    assert.equal(
      res.manifest.status,
      "experimental-candidate-assembled",
      "Must be assembled via canonical assembler pipeline"
    );
    assert.equal(res.zipPath, null, "skipZip must yield null zipPath");
    assert.ok(fs.existsSync(res.distRoot), "distRoot directory must exist");

    // 2. Via registered consumer registry
    const regSlug = "registered-custom-plugin";
    const regDir = path.join(tmpRoot, "plugins", regSlug);
    await fs.promises.mkdir(regDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(regDir, "wpdev.json"),
      JSON.stringify({ slug: regSlug, phpMinVersion: "7.4" }),
      "utf8"
    );
    await fs.promises.writeFile(
      path.join(regDir, `${regSlug}.php`),
      `<?php\n/**\n * Plugin Name: Registered Custom\n */\nif (!defined('ABSPATH')) exit;\n`,
      "utf8"
    );
    registerCanonicalConsumer(regSlug);
    const regRes = await prepareRelease({
      root: regDir,
      skipTests: true,
      skipZip: true,
      inlineFramework: false,
    });
    assert.ok(regRes.manifest, "Registered consumer must delegate to canonical assembler");

    // 3. Via wpdev.json canonicalAssembler flag
    const confSlug = "configured-custom-plugin";
    const confDir = path.join(tmpRoot, "plugins", confSlug);
    await fs.promises.mkdir(confDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(confDir, "wpdev.json"),
      JSON.stringify({
        slug: confSlug,
        phpMinVersion: "7.4",
        canonicalAssembler: true,
      }),
      "utf8"
    );
    await fs.promises.writeFile(
      path.join(confDir, `${confSlug}.php`),
      `<?php\n/**\n * Plugin Name: Configured Custom\n */\nif (!defined('ABSPATH')) exit;\n`,
      "utf8"
    );
    const confRes = await prepareRelease({
      root: confDir,
      skipTests: true,
      skipZip: true,
      inlineFramework: false,
    });
    assert.ok(confRes.manifest, "Configured consumer must delegate to canonical assembler");
  } finally {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("F12: prepareRelease skipZip removes any stale pre-existing ZIP archive", async () => {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "f12-skipzip-test-"));
  try {
    const slug = "my-zip-clean-plugin";
    const srcDir = path.join(tmpRoot, "plugins", slug);
    const distBase = path.join(srcDir, "dist");
    await fs.promises.mkdir(distBase, { recursive: true });
    await fs.promises.writeFile(
      path.join(srcDir, "wpdev.json"),
      JSON.stringify({ slug, phpMinVersion: "7.4" }),
      "utf8"
    );
    await fs.promises.writeFile(
      path.join(srcDir, `${slug}.php`),
      `<?php\n/**\n * Plugin Name: Zip Clean\n */\n`,
      "utf8"
    );

    // Place a stale ZIP in dist
    const staleZipPath = path.join(distBase, `${slug}.zip`);
    await fs.promises.writeFile(staleZipPath, "STALE_ZIP_DATA", "utf8");
    assert.ok(fs.existsSync(staleZipPath), "Stale zip must exist initially");

    // 1. In canonical delegation path
    const res = await prepareRelease({
      root: srcDir,
      skipTests: true,
      skipZip: true,
      inlineFramework: false,
      useCanonicalAssembler: true,
    });

    assert.equal(res.zipPath, null, "zipPath must be null with skipZip");
    assert.ok(!fs.existsSync(staleZipPath), "Stale zip must be deleted in canonical path");

    // 2. In generic release fallback path
    await fs.promises.writeFile(staleZipPath, "STALE_ZIP_DATA_GENERIC", "utf8");
    const genericRes = await prepareRelease({
      root: srcDir,
      skipTests: true,
      skipZip: true,
      useCanonicalAssembler: false,
    });

    assert.equal(genericRes.zipPath, null, "zipPath must be null with skipZip in generic path");
    assert.ok(!fs.existsSync(staleZipPath), "Stale zip must be deleted in generic path");
  } finally {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("F12: Pipeline orchestrator skipZip option validation and cache verification", async () => {
  // 1. Option validation in parsePipelineArgs
  assert.throws(
    () => parsePipelineArgs(["--skip-zip", "--deploy"]),
    /--skip-zip cannot be combined with --deploy/,
    "Must reject --skip-zip with --deploy"
  );
  assert.throws(
    () => parsePipelineArgs(["--skip-zip", "--test"]),
    /--skip-zip cannot be combined with --test/,
    "Must reject --skip-zip with --test"
  );
  assert.throws(
    () => parsePipelineArgs(["--skip-zip", "--suite=fast"]),
    /--skip-zip cannot be combined with --test/,
    "Must reject --skip-zip with --suite"
  );

  // 2. validateCachedTargetArtifact behavior with skipZip
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "f12-cache-test-"));
  try {
    const consumer = "sample-cache-plugin";
    const distPluginDir = path.join(tmpDir, consumer);
    await fs.promises.mkdir(distPluginDir, { recursive: true });

    const dummyDigest = "a".repeat(64);
    await fs.promises.writeFile(
      path.join(distPluginDir, "release-manifest.json"),
      JSON.stringify({
        consumer,
        manifestDigest: dummyDigest,
      }),
      "utf8"
    );

    const skipZipRecord = createTargetCacheRecord({
      artifactId: `${consumer}-profile-s`,
      consumer,
      sourceFingerprint: "src-fp",
      compositeFingerprint: "comp-fp",
      manifestDigest: dummyDigest,
      skipZip: true,
    });
    assert.equal(skipZipRecord.skipZip, true);
    assert.equal(skipZipRecord.gates.artifactIntegrity.status, "passed");

    // Case A: skipZip requested on a skipZip cache record with existing directory manifest -> valid
    const validCheck = await validateCachedTargetArtifact({
      cacheRecord: skipZipRecord,
      zipPath: path.join(tmpDir, `${consumer}.zip`),
      consumer,
      expectedCompositeFingerprint: "comp-fp",
      distDir: distPluginDir,
      skipZip: true,
    });
    assert.equal(validCheck.valid, true, "Valid directory manifest must satisfy skipZip cache check");

    // Case B: non-skipZip requested on a skipZip cache record -> invalid
    const invalidCheck1 = await validateCachedTargetArtifact({
      cacheRecord: skipZipRecord,
      zipPath: path.join(tmpDir, `${consumer}.zip`),
      consumer,
      expectedCompositeFingerprint: "comp-fp",
      skipZip: false,
    });
    assert.equal(invalidCheck1.valid, false);
    assert.match(invalidCheck1.reason, /was built with skipZip/);

    // Case C: skipZip requested on a non-skipZip cache record -> invalid
    const zipRecord = createTargetCacheRecord({
      artifactId: `${consumer}-profile-s`,
      consumer,
      sourceFingerprint: "src-fp",
      compositeFingerprint: "comp-fp",
      zipSha256: "b".repeat(64),
      manifestDigest: dummyDigest,
      skipZip: false,
    });
    const invalidCheck2 = await validateCachedTargetArtifact({
      cacheRecord: zipRecord,
      zipPath: path.join(tmpDir, `${consumer}.zip`),
      consumer,
      expectedCompositeFingerprint: "comp-fp",
      distDir: distPluginDir,
      skipZip: true,
    });
    assert.equal(invalidCheck2.valid, false);
    assert.match(invalidCheck2.reason, /was built with ZIP/);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

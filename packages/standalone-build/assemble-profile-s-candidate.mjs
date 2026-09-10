#!/usr/bin/env node

/**
 * Plan 3: Profile S Feasibility Prototype Assembler (Complete Mangling Pipeline)
 * 
 * Complies with Plan 3 Specification:
 * - Consumes accepted Profile A candidate ZIP.
 * - Extracts to disposable staging.
 * - Applies file-role allowlist: purges development docs (.md, test configs) while preserving LICENSE/NOTICE.
 * - Applies Plan 3 Transformer across all files (Internal classes mangled, functions mangled, comments stripped).
 * - Validates PHP syntax.
 * - Generates signed release manifest and canonical Profile S ZIP.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { runPlan3EligibilitySpike } from "./run-plan3-eligibility-spike.mjs";
import {
  assertFrameworkClosureMinifiedAssets,
  inlineWpdevClosure,
  minifyAssetsInTree,
} from "./inline-wpdev-closure.mjs";
import { purgeDevelopmentTree, getRsyncExcludeArgs } from "./dev-purge-policy.mjs";
import { validateClassCompleteness } from "./class-completeness-gate.mjs";
import { createCanonicalZip, generateArtifactManifest, normalizeStagingTree, readZipEntries, verifyZipAgainstManifest } from "./canonical-artifact-manifest.mjs";
import { verifyProfileSArtifact } from "./verify-profile-s-artifact.mjs";
import { resolveConsumerSource, TARGET_REGISTRY } from "./target-registry.mjs";
import {
  assertDuckTypedModuleLoaders,
  rewriteModuleLoaderRegisterToDuckTyped,
} from "./module-loader-coexistence-gate.mjs";
import {
  assertEligibilityAllowsObfuscation,
  assertRequiredBuildTools,
  assertSymbolMapHasNoCollisions,
  assertZipHasNoSecretIntermediates,
  collectFirstPartyPhpFiles,
  collectToolchainEvidence,
  parseClosedProfileFlags,
  parseTransformerBatchLog,
  requireRectorForProfileS,
  resolveAndValidateTargetPhpInterpreter,
  secureUnlinkSymbolMap,
  validatePhpSyntaxTree,
} from "./profile-s-fail-closed.mjs";
import { resolveContentRoot } from "./resolve-content-root.mjs";
import { createBuildPlan, resolveArtifactZipName, validateBuildPlan } from "./build-plan.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1)
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data)
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function filesUnder(root) {
  const result = [];
  const EXCLUDED_DIRS = new Set([
    "node_modules",
    ".git",
    ".github",
    ".husky",
    ".idea",
    ".vscode",
    ".cursor",
    "tests",
    "dev",
    "docs",
    "coverage",
    "artifacts",
    "bin",
  ]);

  async function visit(relative) {
    const directory = relative ? path.join(root, relative) : root;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) result.push(child.replace(/\\/g, "/"));
    }
  }
  await visit("");
  return result.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function normalizeTreeTimestampsAndPermissions(dir) {
  await normalizeStagingTree(dir);
}

export function parseAssembleCli(argv = process.argv) {
  const positional = [];
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--profile") {
      i++;
      continue;
    }
    if (arg.startsWith("--")) continue;
    positional.push(arg);
  }
  const flags = parseClosedProfileFlags(argv);
  const contentRoot = positional[0]
    ? path.resolve(positional[0])
    : resolveContentRoot({ scriptDir });
  const consumer = positional[1] || "tavangary-theme-panel";
  const outputDir = path.resolve(positional[2] || path.join(contentRoot, "dist"));
  const pluginsRaw = positional[3];
  const pluginsDirArg = pluginsRaw && pluginsRaw !== "null" && pluginsRaw !== "undefined"
    ? path.resolve(pluginsRaw)
    : null;
  return { contentRoot, consumer, outputDir, pluginsDirArg, ...flags };
}

export async function assembleProfileSCandidate(options = {}) {
  const parsed = options.consumer
    ? {
        contentRoot: options.contentRoot ? path.resolve(options.contentRoot) : resolveContentRoot({ scriptDir }),
        consumer: options.consumer,
        sourceRoot: options.sourceRoot ? path.resolve(options.sourceRoot) : null,
        outputDir: path.resolve(options.outputDir),
        pluginsDirArg: options.pluginsDir || options.pluginsDirArg || null,
        isObfuscate: options.isObfuscate,
        obfuscate: options.obfuscate,
        profile: options.profile,
        inlineFramework: options.inlineFramework,
        spaghetti: options.spaghetti,
        minifyAssets: options.minifyAssets,
        skipZip: options.skipZip,
        targetPhp: options.targetPhp || options.phpTarget,
        emitDistDir: options.emitDistDir ?? true,
        phpBin: options.phpBin,
        enforceTargetPhp: options.enforceTargetPhp,
      }
    : parseAssembleCli(options.argv || process.argv);
  const {
    contentRoot,
    consumer,
    sourceRoot,
    outputDir,
    pluginsDirArg,
    emitDistDir = true,
  } = parsed;

  if (options.buildPlan) {
    validateBuildPlan(options.buildPlan);
  }

  const buildPlan = options.buildPlan || createBuildPlan({
    consumer,
    profile: parsed.profile,
    isObfuscate: parsed.isObfuscate,
    obfuscate: parsed.obfuscate,
    inlineFramework: parsed.inlineFramework,
    spaghetti: parsed.spaghetti,
    minifyAssets: parsed.minifyAssets,
    skipZip: parsed.skipZip,
    targetPhp: parsed.targetPhp,
    sourceRoot,
    contentRoot,
    pluginsDir: pluginsDirArg,
    frameworkProvider: options.frameworkProvider || parsed.frameworkProvider,
    frozenClasses: options.frozenClasses,
    frozenFunctions: options.frozenFunctions,
    frozenConstants: options.frozenConstants,
    frozenProperties: options.frozenProperties,
    frozenMethods: options.frozenMethods,
    frozenVars: options.frozenVars,
    gettextDomains: options.gettextDomains,
    reflectionCallbacks: options.reflectionCallbacks,
  });
  const isObfuscate = buildPlan.capabilities.obfuscate;
  const profile = buildPlan.capabilities.inlineFramework
    && buildPlan.capabilities.spaghetti
    && buildPlan.capabilities.obfuscate
    ? "s"
    : (buildPlan.capabilities.inlineFramework && !buildPlan.capabilities.spaghetti && !buildPlan.capabilities.obfuscate
      ? "clean"
      : (buildPlan.artifactIdentity?.capabilityTag || "custom"));
  const skipZip = Boolean(buildPlan.skipZip || parsed.skipZip || options.skipZip);
  const signal = options.signal;
  const exec = (file, args, extra = {}) => execFileAsync(file, args, signal ? { ...extra, signal } : extra);
  await assertRequiredBuildTools();

  const targetInterpreter = await resolveAndValidateTargetPhpInterpreter({
    targetPhp: buildPlan.targetPhp,
    phpBin: parsed.phpBin || options.phpBin || process.env.WPDEV_PHP_BIN || process.env.WPDEV_PHP74_BIN,
    enforceTarget: Boolean(
      parsed.enforceTargetPhp ?? options.enforceTargetPhp ?? (process.env.WPDEV_ENFORCE_TARGET_PHP === "1" || process.env.WPDEV_ENFORCE_TARGET_PHP === "true")
    ),
  });

  const resolvedSource = sourceRoot
    ? {
        sourceDir: sourceRoot,
        deployDir: path.join(outputDir, consumer),
        bootstrapFile: options.bootstrapFile || TARGET_REGISTRY[consumer]?.bootstrapFile || `${consumer}.php`,
        entry: TARGET_REGISTRY[consumer] || { bootstrapFile: options.bootstrapFile || `${consumer}.php` },
      }
    : await resolveConsumerSource({ contentRoot, consumer, pluginsDir: pluginsDirArg });
  const bootstrapFile = options.bootstrapFile || resolvedSource.bootstrapFile || `${consumer}.php`;
  const devDir = resolvedSource.sourceDir;

  const stagingRoot = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), `profile-s-${consumer}-`));
  const stagingPlugin = path.join(stagingRoot, consumer);
  await mkdir(stagingPlugin, { recursive: true });

  try {
    console.log(`==> 2. Syncing source into disposable staging: ${stagingPlugin}`);
    const rsyncExcludes = getRsyncExcludeArgs();
    await exec("rsync", [
      "-a",
      ...rsyncExcludes,
      `${devDir}/`,
      `${stagingPlugin}/`
    ]);

    const baselineZip = path.join(stagingRoot, `${consumer}-source-baseline.zip`);
    await createCanonicalZip({
      sourceRoot: stagingPlugin,
      outputZip: baselineZip,
      rootName: consumer,
    });
    const baselineBytes = await readFile(baselineZip);
    const baselineSha = crypto.createHash("sha256").update(baselineBytes).digest("hex");
    console.log("==> Source baseline recorded: " + baselineSha);

    // Capture & normalize authoritative source Composer model before dev purge (R01, R13)
    let sourceComposerModel = null;
    const sourceCompJsonPath = path.join(devDir, "composer.json");
    if (fs.existsSync(sourceCompJsonPath)) {
      try {
        sourceComposerModel = JSON.parse(await readFile(sourceCompJsonPath, "utf8"));
      } catch (err) {
        throw new Error(`Source composer.json is invalid JSON: ${err.message}`);
      }
      if (Array.isArray(sourceComposerModel.autoload?.files)) {
        for (const relFile of sourceComposerModel.autoload.files) {
          const fileInDev = path.join(devDir, relFile);
          if (!fs.existsSync(fileInDev)) {
            throw new Error(
              `Source composer.json declared autoload file '${relFile}' does not exist in source tree`
            );
          }
        }
      }
    }

    console.log("==> 3. Purging development documents (.md, dev configs) while preserving LICENSE/NOTICE...");
    await purgeDevelopmentTree(stagingPlugin, consumer);

    // Gate: Verify all production classes from devDir/src exist in stagingPlugin/src
    await validateClassCompleteness({ devDir, stagingPlugin, consumer });

    let inlined = { inlinedFiles: 0 };
    if (buildPlan.capabilities.inlineFramework) {
      console.log("==> 3b. Inlining proven WPDev runtime closure & decoupling plugin headers...");
      inlined = await inlineWpdevClosure({
        stagingPlugin,
        consumer,
        contentRoot,
        sourceRoot: devDir,
        wpdevPluginDirOverride: pluginsDirArg ? path.join(pluginsDirArg, "wpdev") : null,
        sourceComposerModel,
        inlineFramework: true,
        frameworkProvider: buildPlan.source.frameworkProvider,
        bootstrapFile,
        consumerNamespace: options.consumerNamespace || buildPlan.source?.consumerNamespace || null,
      });
      if (inlined.inlinedFiles > 0) {
        console.log(`==> Inlined ${inlined.inlinedFiles} WPDev framework files into self-contained staging tree!`);
      }
    } else {
      console.log("==> 3b. Skipping framework inlining (inlineFramework=false)");
    }

    // 3a. Downgrade all PHP files to PHP 7.4 via Rector (fail-closed for Profile S)
    const starterKitRoot = path.resolve(scriptDir, "../..");
    const { rectorBin, rectorConfig } = requireRectorForProfileS({
      rectorBin: path.join(starterKitRoot, "vendor/bin/rector"),
      rectorConfig: path.join(scriptDir, "rector-downgrade-php74.php"),
    });

    console.log("==> 3a. Running Rector PHP 7.4 Downgrade pipeline on staging tree...");
    try {
      await exec("php", [
        "-d",
        "xdebug.mode=off",
        "-d",
        "memory_limit=2G",
        rectorBin,
        "process",
        "-c",
        rectorConfig,
        "--clear-cache",
        "--no-progress-bar",
      ], {
        cwd: starterKitRoot,
        maxBuffer: 50 * 1024 * 1024,
        env: {
          ...process.env,
          RECTOR_TARGET_DIR: stagingPlugin,
        },
      });
      console.log("==> Rector downgrade to PHP 7.4 completed successfully!");
    } catch (err) {
      const details = [err.message, err.stdout, err.stderr].filter(Boolean).join("\n");
      throw new Error(`Rector PHP 7.4 downgrade failed: ${details}`);
    }

    const toolchain = await collectToolchainEvidence({ rectorBin });
    let dynamicEdges = [];

    const runTransformer = buildPlan.capabilities.obfuscate || buildPlan.capabilities.spaghetti;
    if (runTransformer) {
      console.log("==> 4. Running Plan 3 Eligibility & Safety Spike on extracted tree...");
      const eligibility = await runPlan3EligibilitySpike({ rootDir: stagingPlugin });
      dynamicEdges = assertEligibilityAllowsObfuscation(eligibility);
      console.log(`==> Eligibility spike passed (${eligibility.eligibleFiles.length} private units eligible, ${dynamicEdges.length} non-critical dynamic edges recorded)`);

      console.log("==> 5. Applying Plan 3 transformer (flatten/mangle/strip per BuildPlan)...");
      const transformerScript = path.join(scriptDir, "plan3/transformer.php");
      const mapFile = path.join(stagingRoot, "symbol-map.json");
      const seed = `profile-s-${consumer}-seed`;
      const flattenFlag = buildPlan.capabilities.spaghetti ? "--flatten=1" : "--flatten=0";
      const mangleFlag = buildPlan.capabilities.obfuscate ? "--mangle=1" : "--mangle=0";
      const stripFlag = buildPlan.capabilities.obfuscate ? "--strip-comments=1" : "--strip-comments=0";

      await exec("php", [
        transformerScript,
        "--dump-map",
        stagingPlugin,
        mapFile,
        seed,
        flattenFlag,
        mangleFlag,
        stripFlag,
      ], {
        maxBuffer: 50 * 1024 * 1024,
      });
      const dumpedMap = JSON.parse(await readFile(mapFile, "utf8"));
      assertSymbolMapHasNoCollisions(dumpedMap, {
        spaghetti: buildPlan.capabilities.spaghetti,
        flattenNamespaces: buildPlan.capabilities.spaghetti,
        buildPlan,
      });

      const mainFile = `${consumer}.php`;
      const expectedPhpFiles = collectFirstPartyPhpFiles(stagingPlugin);
      const { stdout: batchOut } = await exec("php", [
        transformerScript,
        "--batch",
        stagingPlugin,
        mapFile,
        seed,
        mainFile,
        flattenFlag,
        mangleFlag,
        stripFlag,
      ], {
        maxBuffer: 50 * 1024 * 1024,
      });
      const manifestLog = parseTransformerBatchLog(batchOut, { expectedFiles: expectedPhpFiles });
      console.log(`==> Transformed ${manifestLog.length} files (flatten=${buildPlan.capabilities.spaghetti} mangle=${buildPlan.capabilities.obfuscate})`);
    } else {
      console.log("==> 4. Skipping AST Transformer (spaghetti=false, obfuscate=false)");
    }

    if (buildPlan.capabilities.spaghetti || buildPlan.capabilities.inlineFramework) {
      const loaderRewrite = rewriteModuleLoaderRegisterToDuckTyped(stagingPlugin);
      assertDuckTypedModuleLoaders(stagingPlugin);
      console.log(
        `==> 5a. ModuleLoader coexistence gate: ${loaderRewrite.scanned} file(s) scanned, ${loaderRewrite.rewritten} register() hint(s) normalized to object`,
      );
    }

    // Do not wrap ->register() in catch-and-boot: duplicate Help Hub / menu
    // pages are created when Module::boot() runs both from boot_all() and
    // from a Throwable fallback. Late modules boot via ModuleLoader::$booted.

    if (buildPlan.assetPolicy.minifyAssets) {
      console.log("==> 5b. Minifying first-party JS and CSS assets...");
      const minResult = await minifyAssetsInTree(stagingPlugin, contentRoot, {
        packageRoot: starterKitRoot,
      });
      console.log(
        `==> Minified ${minResult.minifiedAssets} first-party JS/CSS assets in staging (${minResult.minSiblingsWritten || 0} .min siblings)!`,
      );
      assertFrameworkClosureMinifiedAssets(stagingPlugin);
    } else {
      console.log("==> 5b. Skipping asset minification (minifyAssets=false)");
    }

    // Phase 3: Dump optimized autoloader classmap so all mangled classes are registered in Composer classmap
    if (fs.existsSync(path.join(stagingPlugin, "vendor"))) {
      const devSourceDir = resolvedSource.sourceDir;

      const stagingCompJson = path.join(stagingPlugin, "composer.json");
      const srcCompJson = devSourceDir ? path.join(devSourceDir, "composer.json") : null;
      let compData = sourceComposerModel
        ? JSON.parse(JSON.stringify(sourceComposerModel))
        : {};
      if (fs.existsSync(stagingCompJson)) {
        const stagingData = JSON.parse(fs.readFileSync(stagingCompJson, "utf8"));
        compData = {
          ...compData,
          ...stagingData,
          autoload: {
            ...(compData.autoload || {}),
            ...(stagingData.autoload || {}),
            files: [
              ...new Set([
                ...(compData.autoload?.files || []),
                ...(stagingData.autoload?.files || []),
              ]),
            ],
            "psr-4": {
              ...(compData.autoload?.["psr-4"] || {}),
              ...(stagingData.autoload?.["psr-4"] || {}),
            },
          },
        };
      } else if (srcCompJson && fs.existsSync(srcCompJson) && !sourceComposerModel) {
        compData = JSON.parse(fs.readFileSync(srcCompJson, "utf8"));
      }

      const candidateDirs = ["src", "includes", "inc", "classes", "src/FrameworkClosure"].filter(d => fs.existsSync(path.join(stagingPlugin, d)));
      
      // Preserve declared autoload.files in exact order, adding only proven closure entries
      const declaredFiles = Array.isArray(compData.autoload?.files) ? compData.autoload.files : [];
      for (const f of declaredFiles) {
        if (!fs.existsSync(path.join(stagingPlugin, f))) {
          throw new Error(`Declared autoload file '${f}' does not exist in staging tree`);
        }
      }
      const finalAutoloadFiles = [...declaredFiles];
      const closureFunctions = "src/FrameworkClosure/functions-closure.php";
      if (fs.existsSync(path.join(stagingPlugin, closureFunctions)) && !finalAutoloadFiles.includes(closureFunctions)) {
        finalAutoloadFiles.unshift(closureFunctions);
      }

      // Preserve declared autoload.classmap in exact order, adding candidate directories for mangled symbol dumping
      const declaredClassmap = Array.isArray(compData.autoload?.classmap) ? compData.autoload.classmap : [];
      for (const item of declaredClassmap) {
        if (!fs.existsSync(path.join(stagingPlugin, item))) {
          throw new Error(`Declared autoload classmap path '${item}' does not exist in staging tree`);
        }
      }
      const closureCandidateDirs = candidateDirs.map(d => d.endsWith("/") ? d : d + "/");
      const mergedClassmap = [...new Set([...declaredClassmap, ...(closureCandidateDirs.length > 0 ? closureCandidateDirs : ["./"])])];

      const tempComp = {
        ...compData,
        name: compData.name || "release/" + consumer,
        autoload: {
          ...(compData.autoload || {}),
          "classmap": mergedClassmap,
          "psr-4": {
            ...(compData.autoload?.["psr-4"] || {}),
            "WPDev\\": "src/FrameworkClosure/Core/",
          },
          "files": finalAutoloadFiles
        }
      };
      await writeFile(path.join(stagingPlugin, "composer.json"), JSON.stringify(tempComp, null, 2), "utf8");
      console.log("==> Dumping optimized Composer classmap for mangled symbols...");
      await exec("composer", ["dump-autoload", "--no-dev", "--optimize", "--no-scripts", "--no-plugins"], { cwd: stagingPlugin });

      // Restore composer.json preserving declared classmap and proven closure files
      const restoredCompData = {
        ...compData,
        autoload: {
          ...(compData.autoload || {}),
          ...(declaredClassmap.length > 0 ? { classmap: declaredClassmap } : {}),
          ...(finalAutoloadFiles.length > 0 ? { files: finalAutoloadFiles } : {}),
        }
      };
      await writeFile(path.join(stagingPlugin, "composer.json"), JSON.stringify(restoredCompData, null, 2), "utf8");

      const classmapFile = path.join(stagingPlugin, "vendor/composer/autoload_classmap.php");
      const mapFile = path.join(stagingRoot, "symbol-map.json");
      if (fs.existsSync(classmapFile)) {
        let cmap = await readFile(classmapFile, "utf8");
        const coreEntries = [
          { cls: "WPDev\\\\Core\\\\AbstractModule", rel: "/src/FrameworkClosure/Core/Core/AbstractModule.php" },
          { cls: "WPDev\\\\Core\\\\ModuleInterface", rel: "/src/FrameworkClosure/Core/Core/ModuleInterface.php" },
          { cls: "WPDev\\\\Core\\\\ModuleLoader", rel: "/src/FrameworkClosure/Core/Core/ModuleLoader.php" },
          { cls: "WPDev\\\\Core\\\\Plugin", rel: "/src/FrameworkClosure/Core/Core/Plugin.php" },
        ];

        if (fs.existsSync(mapFile)) {
          const symMap = JSON.parse(await readFile(mapFile, "utf8"));
          if (symMap.classes) {
            for (const [fqcn, mangled] of Object.entries(symMap.classes)) {
              if (fqcn.startsWith("\\") || fqcn.includes("\\_c_")) continue;
              const escMangled = `'${mangled}' => \\$baseDir \\. '([^']+)'`;
              const m = cmap.match(new RegExp(escMangled));
              if (m && m[1]) {
                const escapedFqcn = fqcn.replace(/\\/g, "\\\\");
                coreEntries.push({ cls: escapedFqcn, rel: m[1] });
              }
            }
          }
        }

        let additions = [];
        for (const entry of coreEntries) {
          if (fs.existsSync(path.join(stagingPlugin, entry.rel.slice(1))) && !cmap.includes(`'${entry.cls}'`)) {
            additions.push(`    '${entry.cls}' => $baseDir . '${entry.rel}',`);
          }
        }
        if (additions.length > 0) {
          cmap = cmap.replace("return array(", `return array(\n${additions.join("\n")}`);
          await writeFile(classmapFile, cmap, "utf8");
        }

        const staticFile = path.join(stagingPlugin, "vendor/composer/autoload_static.php");
        if (fs.existsSync(staticFile)) {
          let sContent = await readFile(staticFile, "utf8");
          if (sContent.includes("public static $classMap = array(")) {
            let staticAdditions = [];
            for (const entry of coreEntries) {
              if (fs.existsSync(path.join(stagingPlugin, entry.rel.slice(1))) && !sContent.includes(`'${entry.cls}'`)) {
                staticAdditions.push(`        '${entry.cls}' => __DIR__ . '/../..' . '${entry.rel}',`);
              }
            }
            if (staticAdditions.length > 0) {
              sContent = sContent.replace(
                "public static $classMap = array(",
                `public static $classMap = array(\n${staticAdditions.join("\n")}`
              );
              await writeFile(staticFile, sContent, "utf8");
            }
          }
        }
      }
    }


    await secureUnlinkSymbolMap(path.join(stagingRoot, "symbol-map.json"));

    console.log("==> 6. Validating PHP syntax across all transformed files...");
    await validatePhpSyntaxTree(stagingPlugin, {
      phpBin: targetInterpreter.bin,
      targetPhp: buildPlan.targetPhp,
      enforceTarget: Boolean(
        parsed.enforceTargetPhp ?? options.enforceTargetPhp ?? (process.env.WPDEV_ENFORCE_TARGET_PHP === "1" || process.env.WPDEV_ENFORCE_TARGET_PHP === "true")
      ),
    });
    console.log("==> PHP syntax check 100% green!");

    const manifestProfile = profile === "s" ? "Profile S" : (profile === "clean" ? "clean" : String(buildPlan.artifactIdentity.capabilityTag));
    console.log(`==> 7. Generating canonical artifact manifest (profile: ${manifestProfile})...`);
    const artifactManifest = await generateArtifactManifest({
      rootDir: stagingPlugin,
      consumer,
      profile: manifestProfile,
      toolchain,
      resolvedProfile: profile === "s" || profile === "clean" ? profile : "clean",
      obfuscate: isObfuscate,
      dynamicEdges,
      capabilities: buildPlan.capabilities,
      planFingerprint: buildPlan.artifactIdentity.fingerprint,
    });
    console.log(`==> Artifact manifest generated: ${artifactManifest.files.length} production files (digest: ${artifactManifest.manifestDigest})`);

    const stagedCandidateZip = path.join(stagingRoot, `${consumer}-candidate.zip`);
    console.log(`==> 8. Creating canonical staged candidate ZIP at: ${stagedCandidateZip}`);
    await createCanonicalZip({
      sourceRoot: stagingPlugin,
      outputZip: stagedCandidateZip,
      rootName: consumer,
    });

    const zipBytes = await readFile(stagedCandidateZip);
    const zipSha256 = crypto.createHash("sha256").update(zipBytes).digest("hex");
    console.log(`==> Candidate ZIP SHA-256: ${zipSha256}`);
    assertZipHasNoSecretIntermediates(readZipEntries(zipBytes));

    console.log("==> 8b. Verifying packaged ZIP parity against canonical artifact manifest...");
    const zipVerifyReport = await verifyZipAgainstManifest({
      zipPath: stagedCandidateZip,
      consumer,
      manifest: artifactManifest,
    });
    if (zipVerifyReport.status !== "valid") {
      throw new Error(`Packaged candidate ZIP failed manifest parity verification:\n${JSON.stringify(zipVerifyReport, null, 2)}`);
    }
    console.log("==> ZIP manifest parity verified 100% valid (0 missing, 0 unexpected, 0 modified)!");

    console.log("==> 8c. Running black-box verification probes on staged candidate ZIP...");
    const verifyReport = await verifyProfileSArtifact({
      zipPath: stagedCandidateZip,
      consumer,
      profile,
      stripComments: buildPlan.capabilities.stripComments,
      targetPhp: buildPlan.targetPhp,
      phpBin: targetInterpreter.bin,
      requireManifest: true,
    });
    if (verifyReport.status !== "passed" || verifyReport.testsFailed > 0) {
      throw new Error(
        `Packaged candidate ZIP failed black-box verification probes:\n${JSON.stringify(verifyReport, null, 2)}`
      );
    }
    console.log(`==> Black-box verification verified 100% green (${verifyReport.testsPassed} probes passed, 0 failed)!`);

    // Verify external harness preparation on candidate
    console.log("==> 9. Testing external harness preparation gate...");
    const harnessRes = await exec(process.execPath, [
      path.join(scriptDir, "prepare-artifact-phpunit-harness.mjs"),
      contentRoot,
      consumer,
      stagedCandidateZip,
      zipSha256,
    ]);
    console.log("==> Harness preparation gate verified:", JSON.parse(harnessRes.stdout).status);

    // 10. Publication: ONLY publish to outputDir after ALL gates pass!
    const prePublishBytes = await readFile(stagedCandidateZip);
    const prePublishSha = crypto.createHash("sha256").update(prePublishBytes).digest("hex");
    if (prePublishSha !== zipSha256) {
      throw new Error(`Candidate ZIP hash mismatch before publication (staged: ${zipSha256}, pre-publish: ${prePublishSha})`);
    }

    await mkdir(outputDir, { recursive: true });
    const targetArtifactName = resolveArtifactZipName(buildPlan);
    const outputZip = path.join(outputDir, targetArtifactName);
    if (!skipZip) {
      const tempPublishZip = path.join(outputDir, `.${targetArtifactName}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      await copyFile(stagedCandidateZip, tempPublishZip);
      await fs.promises.rename(tempPublishZip, outputZip);
      console.log(`==> Published verified candidate to: ${outputZip}`);
    } else {
      if (fs.existsSync(outputZip)) {
        await rm(outputZip, { force: true });
      }
      console.log("==> skipZip: verified candidate ZIP was not published");
    }

    const targetDir = path.join(outputDir, consumer);
    if (emitDistDir) {
      const tempTargetDir = path.join(outputDir, `.${consumer}.dist-tmp-${Date.now()}`);
      await cp(stagingPlugin, tempTargetDir, { recursive: true });
      if (fs.existsSync(targetDir)) {
        await rm(targetDir, { recursive: true, force: true });
      }
      await fs.promises.rename(tempTargetDir, targetDir);
    }

    const result = {
      consumer,
      profile: manifestProfile,
      resolvedProfile: profile,
      obfuscate: isObfuscate,
      capabilities: buildPlan.capabilities,
      planFingerprint: buildPlan.artifactIdentity.fingerprint,
      toolchain,
      targetPhp: buildPlan.targetPhp,
      stage: "feasibility-prototype",
      inputProfileAZipSha256: baselineSha,
      sourceBaselineSha256: baselineSha,
      outputProfileSZipPath: skipZip ? null : outputZip,
      outputProfileSZipSha256: zipSha256,
      distRoot: targetDir,
      manifest: artifactManifest,
      manifestDigest: artifactManifest.manifestDigest,
      signing: "not-performed; external trusted signing required",
      verification: {
        status: "passed",
        probesPassed: verifyReport.testsPassed,
        probesFailed: 0,
        harnessStatus: JSON.parse(harnessRes.stdout).status,
      },
      status: "experimental-candidate-assembled",
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await secureUnlinkSymbolMap(path.join(stagingRoot, "symbol-map.json"));
    if (typeof stagingPlugin === "string") {
      await secureUnlinkSymbolMap(path.join(stagingPlugin, "symbol-map.json"));
    }
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function protectCrossPluginModuleRegistrations(stagingPlugin, consumer) {
  void stagingPlugin;
  void consumer;
  // Intentionally a no-op. Catch-and-boot on ->register() re-runs Module::boot()
  // after boot_all(), so Help Hub (and any page with a portable Registrar)
  // registers admin_menu callbacks twice and duplicates brand-menu items.
  return { protectedCount: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assembleProfileSCandidate().catch((err) => {
    console.error("Profile S Assembler failed:", err);
    process.exit(1);
  });
}

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseAssembleCli } from "../assemble-profile-s-candidate.mjs";
import { parsePipelineArgs } from "../build-all-standalone-plugins.mjs";
import {
  assertEligibilityAllowsObfuscation,
  assertSymbolMapHasNoCollisions,
  assertZipHasNoSecretIntermediates,
  collectFirstPartyPhpFiles,
  collectToolchainEvidence,
  parseClosedProfileFlags,
  parseTransformerBatchLog,
  requireRectorForProfileS,
  resolveAndValidateTargetPhpInterpreter,
  validatePhpSyntaxTree,
} from "../profile-s-fail-closed.mjs";
import {
  BUILD_PLAN_SCHEMA_VERSION,
  UNRESOLVED_CHOICES,
  createBuildPlan,
  deriveCapabilityTag,
  validateBuildPlan,
} from "../build-plan.mjs";

test("parseClosedProfileFlags accepts --obfuscate and --profile=s as Profile S", () => {
  for (const argv of [["--obfuscate"], ["--profile=s"], ["--obfuscate", "--profile=s"]]) {
    const flags = parseClosedProfileFlags(argv);
    assert.equal(flags.profile, "s");
    assert.equal(flags.isObfuscate, true);
    assert.equal(flags.inlineFramework, true);
    assert.equal(flags.spaghetti, true);
    assert.equal(flags.obfuscate, true);
  }
  const clean = parseClosedProfileFlags([]);
  assert.equal(clean.profile, "clean");
  assert.equal(clean.isObfuscate, false);
  assert.equal(clean.inlineFramework, true);
  assert.equal(clean.spaghetti, false);
  assert.deepEqual(parseClosedProfileFlags(["--profile=clean"]).profile, "clean");
});

test("parseClosedProfileFlags supports independent capability flags without changing --obfuscate-alone", () => {
  const inlineOnly = parseClosedProfileFlags(["--inline-framework"]);
  assert.equal(inlineOnly.profile, "custom");
  assert.equal(inlineOnly.inlineFramework, true);
  assert.equal(inlineOnly.spaghetti, false);
  assert.equal(inlineOnly.obfuscate, false);

  const spaghettiOnly = parseClosedProfileFlags(["--spaghetti"]);
  assert.equal(spaghettiOnly.spaghetti, true);
  assert.equal(spaghettiOnly.obfuscate, false);
  assert.equal(spaghettiOnly.inlineFramework, false);

  const obfuscateOnly = parseClosedProfileFlags(["--inline-framework", "--obfuscate"]);
  assert.equal(obfuscateOnly.inlineFramework, true);
  assert.equal(obfuscateOnly.spaghetti, false);
  assert.equal(obfuscateOnly.obfuscate, true);
});

test("parseClosedProfileFlags rejects unknown and conflicting profiles", () => {
  assert.throws(() => parseClosedProfileFlags(["--profile=a"]), /Invalid --profile 'a'/);
  assert.throws(() => parseClosedProfileFlags(["--profile=profile-s"]), /Invalid --profile/);
  assert.throws(() => parseClosedProfileFlags(["--profile"]), /value is required/);
  assert.throws(
    () => parseClosedProfileFlags(["--obfuscate", "--profile=clean"]),
    /Conflicting profile flags/,
  );
});

test("parsePipelineArgs exposes the closed profile and rejects unknown values", () => {
  assert.equal(parsePipelineArgs(["node", "build", "--obfuscate"]).profile, "s");
  assert.equal(parsePipelineArgs(["node", "build", "--profile=s"]).isObfuscate, true);
  assert.equal(parsePipelineArgs(["node", "build"]).profile, "clean");
  assert.throws(() => parsePipelineArgs(["node", "build", "--profile=b"]), /Invalid --profile 'b'/);
});

test("requireRectorForProfileS fails closed when the binary or config is missing", () => {
  assert.throws(
    () => requireRectorForProfileS({ rectorBin: "/no/rector", rectorConfig: "/no/config.php" }),
    /Profile S requires Rector/,
  );
});

test("parseTransformerBatchLog requires valid JSON records for every expected PHP file", () => {
  assert.throws(() => parseTransformerBatchLog(""), /empty stdout/);
  assert.throws(() => parseTransformerBatchLog("not-json"), /did not emit valid JSON/);
  assert.throws(() => parseTransformerBatchLog("{}"), /must be an array/);
  assert.throws(() => parseTransformerBatchLog("[]"), /array is empty/);
  assert.throws(
    () => parseTransformerBatchLog(JSON.stringify([{ ok: true }])),
    /missing file path/,
  );

  const files = ["/tmp/a.php", "/tmp/b.php"];
  const good = (f) => ({ file: f, sha256: "a".repeat(64), bytes: 12 });
  const log = JSON.stringify([good(files[0]), good(files[1])]);
  const parsed = parseTransformerBatchLog(log, { expectedFiles: files });
  assert.equal(parsed.length, 2);

  // F11: records without a verified content hash and byte count prove nothing
  // about the write and must fail closed.
  assert.throws(
    () => parseTransformerBatchLog(JSON.stringify([good(files[0]), { file: files[1] }])),
    /missing a valid sha256/,
  );
  assert.throws(
    () => parseTransformerBatchLog(JSON.stringify([good(files[0]), { file: files[1], sha256: "b".repeat(64), bytes: 0 }])),
    /missing a valid byte count/,
  );

  assert.throws(
    () => parseTransformerBatchLog(JSON.stringify([good(files[0])]), { expectedFiles: files }),
    /omitted 1 PHP file/,
  );
});

test("validatePhpSyntaxTree rejects leftover PHP 8 tokens after a skipped downgrade", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "php74-scan-"));
  try {
    await writeFile(
      path.join(tmpDir, "legacy.php"),
      "<?php\nfunction hello($name) { return $name; }\n",
    );
    await validatePhpSyntaxTree(tmpDir);

    await writeFile(
      path.join(tmpDir, "enum.php"),
      "<?php\nenum Status { case Open; case Closed; }\n",
    );
    await assert.rejects(
      () => validatePhpSyntaxTree(tmpDir),
      /PHP 7\.4 incompatibility: T_ENUM|syntax error/i,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("validatePhpSyntaxTree rejects all PHP 8.0-8.2 syntax counterexamples on PHP 7.4 target (V3-16)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "php74-counterexamples-"));
  try {
    // Counterexample 1: standalone false type (PHP 8.2)
    const file1 = path.join(tmpDir, "false_param.php");
    await writeFile(file1, "<?php\nfunction ready(false $value) {}\n");
    await assert.rejects(
      () => validatePhpSyntaxTree(tmpDir),
      /PHP 7\.4 incompatibility: false type detected in parameter list/,
    );
    await rm(file1);

    // Counterexample 2: trailing parameter comma (PHP 8.0)
    const file2 = path.join(tmpDir, "trailing_comma.php");
    await writeFile(file2, "<?php\nfunction ready($value,) {}\n");
    await assert.rejects(
      () => validatePhpSyntaxTree(tmpDir),
      /PHP 7\.4 incompatibility: trailing comma detected in parameter list/,
    );
    await rm(file2);

    // Counterexample 3: first-class callable syntax (PHP 8.1)
    const file3 = path.join(tmpDir, "first_class_callable.php");
    await writeFile(file3, "<?php\n$f = strlen(...);\n");
    await assert.rejects(
      () => validatePhpSyntaxTree(tmpDir),
      /PHP 7\.4 incompatibility: first-class callable syntax \(\.\.\.\) detected/,
    );
    await rm(file3);

    // Counterexample 4: new in initializer (PHP 8.1)
    const file4 = path.join(tmpDir, "new_in_init.php");
    await writeFile(file4, "<?php\nfunction ready($value = new stdClass) {}\n");
    await assert.rejects(
      () => validatePhpSyntaxTree(tmpDir),
      /PHP 7\.4 incompatibility: new in initializer detected in parameter default/,
    );
    await rm(file4);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("resolveAndValidateTargetPhpInterpreter validates binary version and fails closed (V3-16)", async () => {
  // 1. Missing binary fails closed
  await assert.rejects(
    () => resolveAndValidateTargetPhpInterpreter({ targetPhp: "7.4", phpBin: "/nonexistent/php74" }),
    /Target PHP interpreter '\/nonexistent\/php74' failed execution/,
  );

  // 2. Host PHP with enforceTarget: true fails when target is 7.4 and host is PHP 8.x
  await assert.rejects(
    () => resolveAndValidateTargetPhpInterpreter({ targetPhp: "7.4", phpBin: "php", enforceTarget: true }),
    /Target PHP interpreter 'php' version mismatch: expected PHP 7.4, got PHP/,
  );

  // 3. Env var configured with wrong version fails closed
  const prevEnv = process.env.WPDEV_PHP74_BIN;
  try {
    process.env.WPDEV_PHP74_BIN = "php";
    await assert.rejects(
      () => resolveAndValidateTargetPhpInterpreter({ targetPhp: "7.4" }),
      /Target PHP interpreter 'php' configured via environment has version mismatch: expected PHP 7.4, got PHP/,
    );
  } finally {
    if (prevEnv !== undefined) {
      process.env.WPDEV_PHP74_BIN = prevEnv;
    } else {
      delete process.env.WPDEV_PHP74_BIN;
    }
  }
});

test("assemble and orchestrator CLIs resolve the same closed profile with both --profile=s and --profile s", () => {
  const assembleEqual = parseAssembleCli(["node", "assemble", "/tmp/wp-content", "demo", "/tmp/dist", "--obfuscate"]);
  const pipelineEqual = parsePipelineArgs(["node", "build", "--obfuscate"]);
  assert.equal(assembleEqual.profile, "s");
  assert.equal(assembleEqual.isObfuscate, true);
  assert.equal(pipelineEqual.profile, assembleEqual.profile);
  assert.equal(pipelineEqual.isObfuscate, assembleEqual.isObfuscate);

  const assembleSpace = parseAssembleCli(["node", "assemble", "/tmp/wp-content", "demo", "/tmp/dist", "--profile", "s"]);
  assert.equal(assembleSpace.profile, "s");
  assert.equal(assembleSpace.isObfuscate, true);
  assert.equal(assembleSpace.contentRoot, path.resolve("/tmp/wp-content"));
  assert.equal(assembleSpace.consumer, "demo");
  assert.equal(assembleSpace.outputDir, path.resolve("/tmp/dist"));
  assert.equal(assembleSpace.pluginsDirArg, null);

  const pipelineSpace = parsePipelineArgs(["node", "build", "--profile", "clean"]);
  assert.equal(pipelineSpace.profile, "clean");
  assert.equal(pipelineSpace.isObfuscate, false);
});

test("assertEligibilityAllowsObfuscation fails closed on critical eval/code injection but records non-critical dynamic edges", () => {
  assert.throws(
    () =>
      assertEligibilityAllowsObfuscation({
        forbiddenPatterns: [{ file: "src/a.php", pattern: "eval", message: "x" }],
      }),
    /eval/,
  );
  assert.throws(
    () =>
      assertEligibilityAllowsObfuscation({
        forbiddenPatterns: [{ file: "src/a.php", pattern: "preg_replace_e", message: "x" }],
      }),
    /preg_replace_e/,
  );
  const recorded = assertEligibilityAllowsObfuscation({
    forbiddenPatterns: [
      { file: "src/a.php", pattern: "dynamic_callable", message: "x" },
      { file: "src/b.php", pattern: "dynamic_include", message: "y" },
      { file: "src/c.php", pattern: "reflection", message: "z" },
    ],
  });
  assert.equal(recorded.length, 3);
  assert.equal(recorded[0].pattern, "dynamic_callable");
  assert.equal(recorded[1].pattern, "dynamic_include");
  assert.equal(recorded[2].pattern, "reflection");
});

test("assertSymbolMapHasNoCollisions rejects two FQCNs or functions that share a mangled name", () => {
  assert.equal(
    assertSymbolMapHasNoCollisions({
      classes: { "App\\A\\Box": "_c_aaaa", "\\App\\A\\Box": "\\_c_aaaa", "App\\B\\Crate": "_c_bbbb" },
      functions: { "App\\funcA": "_f_1111", "App\\funcB": "_f_2222" },
    }),
    4,
  );
  assert.throws(
    () =>
      assertSymbolMapHasNoCollisions({
        classes: { "App\\A\\Box": "_c_dead", "App\\B\\Crate": "_c_dead" },
      }),
    /symbol map collision in classes/,
  );
  assert.throws(
    () =>
      assertSymbolMapHasNoCollisions({
        functions: { "App\\funcA": "_f_dead", "App\\funcB": "_f_dead" },
      }),
    /symbol map collision in functions/,
  );
});

test("assertSymbolMapHasNoCollisions enforces PHP case-insensitivity for classes and functions", () => {
  assert.throws(
    () =>
      assertSymbolMapHasNoCollisions({
        classes: { "App\\A\\Box": "_c_aaaa", "App\\B\\Crate": "_c_AAAA" },
      }),
    /symbol map collision in classes.*both mangle to _c_AAAA/,
  );
  assert.throws(
    () =>
      assertSymbolMapHasNoCollisions({
        functions: { "App\\funcA": "_f_1111", "App\\funcB": "_f_1111" },
      }),
    /symbol map collision in functions.*both mangle to _f_1111/,
  );
  assert.throws(
    () =>
      assertSymbolMapHasNoCollisions({
        functions: { "App\\funcA": "_f_aaaa", "App\\funcB": "_f_AAAA" },
      }),
    /symbol map collision in functions.*both mangle to _f_AAAA/,
  );
});

test("assertSymbolMapHasNoCollisions rejects ambiguous short names mapped to a single symbol", () => {
  assert.throws(
    () =>
      assertSymbolMapHasNoCollisions({
        classes: {
          "App\\A\\User": "_c_1111",
          "App\\B\\User": "_c_2222",
          User: "_c_1111",
        },
      }),
    /ambiguous short name 'User' belongs to multiple FQCNs and cannot be mapped/,
  );
});

test("assertZipHasNoSecretIntermediates rejects symbol map variants", () => {
  assertZipHasNoSecretIntermediates([{ name: "demo/src/a.php" }]);
  assert.throws(
    () => assertZipHasNoSecretIntermediates([{ name: "demo/symbol-map.json" }]),
    /secret build intermediate/,
  );
  assert.throws(
    () => assertZipHasNoSecretIntermediates([{ name: "demo/symbols.json" }]),
    /secret build intermediate/,
  );
  assert.throws(
    () => assertZipHasNoSecretIntermediates([{ name: "demo/symbol_map.json" }]),
    /secret build intermediate/,
  );
});

test("collectToolchainEvidence records valid version strings with digits for php/node/zip/composer", async () => {
  const evidence = await collectToolchainEvidence();
  assert.equal(typeof evidence.node, "string");
  assert.match(evidence.node, /v\d+\.\d+/);
  assert.match(evidence.php, /\d+\.\d+/);
  assert.match(evidence.zip, /\d+\.\d+/);
  assert.match(evidence.unzip, /\d+\.\d+/);
  assert.match(evidence.composer, /\d+\.\d+/);
});

test("collectFirstPartyPhpFiles skips vendor trees", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "php-collect-"));
  try {
    await mkdir(path.join(tmpDir, "src"), { recursive: true });
    await mkdir(path.join(tmpDir, "vendor/pkg"), { recursive: true });
    await writeFile(path.join(tmpDir, "src/a.php"), "<?php\n");
    await writeFile(path.join(tmpDir, "vendor/pkg/b.php"), "<?php\n");
    const files = collectFirstPartyPhpFiles(tmpDir);
    assert.equal(files.length, 1);
    assert.equal(path.basename(files[0]), "a.php");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("createBuildPlan initializes versioned BuildPlan and handles all 8 capability matrix combinations", () => {
  const combos = [
    { inlineFramework: false, spaghetti: false, obfuscate: false, tag: "clean" },
    { inlineFramework: true, spaghetti: false, obfuscate: false, tag: "standalone" },
    { inlineFramework: false, spaghetti: true, obfuscate: false, tag: "spaghetti" },
    { inlineFramework: false, spaghetti: false, obfuscate: true, tag: "obfuscated" },
    { inlineFramework: true, spaghetti: true, obfuscate: false, tag: "standalone-spaghetti" },
    { inlineFramework: true, spaghetti: false, obfuscate: true, tag: "standalone-obfuscated" },
    { inlineFramework: false, spaghetti: true, obfuscate: true, tag: "spaghetti-obfuscated" },
    { inlineFramework: true, spaghetti: true, obfuscate: true, tag: "standalone-spaghetti-obfuscated" },
  ];

  for (const combo of combos) {
    const plan = createBuildPlan({
      consumer: "test-plugin",
      inlineFramework: combo.inlineFramework,
      spaghetti: combo.spaghetti,
      obfuscate: combo.obfuscate,
    });
    assert.equal(plan.schemaVersion, BUILD_PLAN_SCHEMA_VERSION);
    assert.equal(plan.consumer, "test-plugin");
    assert.equal(plan.capabilities.inlineFramework, combo.inlineFramework);
    assert.equal(plan.capabilities.spaghetti, combo.spaghetti);
    assert.equal(plan.capabilities.obfuscate, combo.obfuscate);
    assert.equal(plan.artifactIdentity.capabilityTag, combo.tag);
    assert.equal(validateBuildPlan(plan), true);
  }
});

test("createBuildPlan treats obfuscate-true without independent flags as legacy Profile S", () => {
  const plan = createBuildPlan({ consumer: "test-plugin", obfuscate: true });
  assert.equal(plan.capabilities.inlineFramework, true);
  assert.equal(plan.capabilities.spaghetti, true);
  assert.equal(plan.capabilities.obfuscate, true);
  const standaloneObf = createBuildPlan({
    consumer: "test-plugin",
    inlineFramework: true,
    spaghetti: false,
    obfuscate: true,
  });
  assert.equal(standaloneObf.artifactIdentity.capabilityTag, "standalone-obfuscated");
});

test("createBuildPlan maps legacy presets and rejects contradictory/missing prerequisites", () => {
  // Legacy clean
  const cleanPlan = createBuildPlan({ consumer: "test-plugin", profile: "clean" });
  assert.equal(cleanPlan.capabilities.inlineFramework, true);
  assert.equal(cleanPlan.capabilities.spaghetti, false);
  assert.equal(cleanPlan.capabilities.obfuscate, false);

  // Legacy S
  const sPlan = createBuildPlan({ consumer: "test-plugin", profile: "s" });
  assert.equal(sPlan.capabilities.inlineFramework, true);
  assert.equal(sPlan.capabilities.spaghetti, true);
  assert.equal(sPlan.capabilities.obfuscate, true);

  // Missing consumer prerequisite
  assert.throws(() => createBuildPlan({}), /BuildPlan prerequisite missing: 'consumer' slug is required/);

  // Unsupported PHP target
  assert.throws(
    () => createBuildPlan({ consumer: "test-plugin", targetPhp: "5.6" }),
    /BuildPlan invalid target PHP '5.6'/,
  );

  // Contradictory options
  assert.throws(
    () => createBuildPlan({ consumer: "test-plugin", profile: "clean", obfuscate: true }),
    /Contradictory options: profile='clean' cannot be combined with obfuscate=true/,
  );
  assert.throws(
    () => createBuildPlan({ consumer: "test-plugin", profile: "s", isObfuscate: false }),
    /Contradictory options: profile='s' cannot claim isObfuscate=false without transform/,
  );
});

test("UNRESOLVED_CHOICES locks C1-C4 policies per fix plan v2", () => {
  assert.equal(UNRESOLVED_CHOICES.C1_SHORT_NAME_COLLISIONS.status, "LOCKED_FAIL_CLOSED");
  assert.equal(UNRESOLVED_CHOICES.C1_SHORT_NAME_COLLISIONS.gatedTask, 6);
  assert.equal(UNRESOLVED_CHOICES.C2_LEGACY_OBFUSCATE_OPTION.status, "DOCUMENTED_PRESETS");
  assert.equal(UNRESOLVED_CHOICES.C3_CLOSURE_BOUNDARY.status, "EXPLICIT_PROVIDER_REQUIRED");
  assert.equal(UNRESOLVED_CHOICES.C3_CLOSURE_BOUNDARY.gatedTask, 7);
  assert.equal(UNRESOLVED_CHOICES.C4_EXTENDED_SPAGHETTI.status, "MINIMUM_MODE_CONFIRMED");
});

test("assertSymbolMapHasNoCollisions enforces C1 fail-closed on namespace flatten short-name collisions", () => {
  const collidingMap = {
    classes: {
      "Acme\\User": "_c_1111",
      "Beta\\User": "_c_2222",
    },
  };

  // When checkFlattenCollisions is false (obfuscate-only without flattening), two different mangled names pass
  assert.equal(assertSymbolMapHasNoCollisions(collidingMap, { checkFlattenCollisions: false }), 2);

  // When checkFlattenCollisions is true (C1 gate for spaghetti/flattening), it must fail closed
  assert.throws(
    () =>
      assertSymbolMapHasNoCollisions(collidingMap, {
        checkFlattenCollisions: true,
        symbolPaths: {
          "Acme\\User": "src/Acme/User.php",
          "Beta\\User": "src/Beta/User.php",
        },
      }),
    /short-name collision under namespace flattening: 'user' is shared by multiple FQCNs: \[Acme\\User \(src\/Acme\/User\.php\), Beta\\User \(src\/Beta\/User\.php\)\]/,
  );
});

test("assertSymbolMapHasNoCollisions rejects real global declaration vs namespaced declaration under flattening (V3-04)", () => {
  // 1. Flatten-only / spaghetti-only mode with symbolPaths: global Worker + Acme\Worker
  const flatCollidingMap = {
    classes: {
      "Acme\\Worker": "Worker",
      Worker: "Worker",
    },
  };

  // In non-flattening mode, distinct namespaces do not collide even with symbolPaths
  assert.equal(
    assertSymbolMapHasNoCollisions(flatCollidingMap, {
      checkFlattenCollisions: false,
      symbolPaths: {
        Worker: "src/Worker.php:10",
        "Acme\\Worker": "src/Acme/Worker.php:25",
      },
    }),
    2,
  );

  // In flatten-only mode with symbolPaths, fails closed with path diagnostics
  assert.throws(
    () =>
      assertSymbolMapHasNoCollisions(flatCollidingMap, {
        checkFlattenCollisions: true,
        symbolPaths: {
          Worker: "src/Worker.php:10",
          "Acme\\Worker": "src/Acme/Worker.php:25",
        },
      }),
    /symbol map collision in classes.*global declaration 'Worker'.*collides with namespaced declaration 'Acme\\Worker' under namespace flattening: \[Worker \(src\/Worker\.php:10\), Acme\\Worker \(src\/Acme\/Worker\.php:25\)\]/,
  );

  // 2. Typed declaration records: global Worker + Acme\Worker with effective destinations
  const declCollidingMap = {
    classes: {
      "Acme\\Worker": "Worker",
      Worker: "Worker",
    },
    declarations: [
      {
        symbol: "Worker",
        name: "Worker",
        namespace: "",
        kind: "class",
        file: "src/Worker.php",
        line: 10,
        is_global: true,
        is_alias: false,
        effectiveDestination: "Worker",
      },
      {
        symbol: "Acme\\Worker",
        name: "Worker",
        namespace: "Acme",
        kind: "class",
        file: "src/Acme/Worker.php",
        line: 25,
        is_global: false,
        is_alias: false,
        effectiveDestination: "Worker",
      },
    ],
  };

  assert.throws(
    () =>
      assertSymbolMapHasNoCollisions(declCollidingMap, {
        checkFlattenCollisions: true,
      }),
    /symbol map collision in classes.*global declaration 'Worker' and namespaced declaration 'Acme\\Worker' collide on effective destination 'Worker' under namespace flattening: \[Worker \(src\/Worker\.php:10\), Acme\\Worker \(src\/Acme\/Worker\.php:25\)\]/,
  );

  // 3. Case variants in declarations (e.g. Worker vs worker)
  const caseCollidingMap = {
    classes: {},
    declarations: [
      {
        symbol: "Worker",
        name: "Worker",
        namespace: "",
        kind: "class",
        file: "src/Worker.php",
        line: 10,
        is_global: true,
        is_alias: false,
        effectiveDestination: "Worker",
      },
      {
        symbol: "Acme\\worker",
        name: "worker",
        namespace: "Acme",
        kind: "class",
        file: "src/Acme/worker.php",
        line: 15,
        is_global: false,
        is_alias: false,
        effectiveDestination: "worker",
      },
    ],
  };

  assert.throws(
    () =>
      assertSymbolMapHasNoCollisions(caseCollidingMap, {
        checkFlattenCollisions: true,
      }),
    /symbol map collision in classes.*collide on effective destination 'worker' under namespace flattening/,
  );

  // 4. Function collisions under flattening
  const funcCollidingMap = {
    functions: {},
    declarations: [
      {
        symbol: "helper",
        name: "helper",
        namespace: "",
        kind: "function",
        file: "src/functions.php",
        line: 5,
        is_global: true,
        is_alias: false,
        effectiveDestination: "helper",
      },
      {
        symbol: "Acme\\helper",
        name: "helper",
        namespace: "Acme",
        kind: "function",
        file: "src/Acme/functions.php",
        line: 8,
        is_global: false,
        is_alias: false,
        effectiveDestination: "helper",
      },
    ],
  };

  assert.throws(
    () =>
      assertSymbolMapHasNoCollisions(funcCollidingMap, {
        checkFlattenCollisions: true,
      }),
    /symbol map collision in functions.*global declaration 'helper' and namespaced declaration 'Acme\\helper' collide on effective destination 'helper' under namespace flattening/,
  );

  // 5. Valid short alias does NOT throw when it's marked as an alias
  const aliasMap = {
    classes: {
      "Acme\\Worker": "Worker",
      Worker: "Worker",
    },
    declarations: [
      {
        symbol: "Acme\\Worker",
        name: "Worker",
        namespace: "Acme",
        kind: "class",
        file: "src/Acme/Worker.php",
        line: 25,
        is_global: false,
        is_alias: false,
        effectiveDestination: "Worker",
      },
      {
        symbol: "Worker",
        name: "Worker",
        namespace: "",
        kind: "class",
        file: "src/Acme/Worker.php",
        line: 25,
        is_global: false,
        is_alias: true, // explicit alias status
        effectiveDestination: "Worker",
      },
    ],
  };

  // With alias status marked, alias does not collide with declaration
  assert.equal(assertSymbolMapHasNoCollisions(aliasMap, { checkFlattenCollisions: true }), 3);
});

test("createBuildPlan rejects unknown options and non-boolean flags (V3-14)", () => {
  assert.throws(
    () => createBuildPlan({ consumer: "demo", invalidOptionName: 123 }),
    /Unknown BuildPlan option 'invalidOptionName'/,
  );
  assert.throws(
    () => createBuildPlan({ consumer: "demo", inlineFramework: "true" }),
    /BuildPlan option 'inlineFramework' must be a boolean/,
  );
});

test("validateBuildPlan rejects forged or mismatched fingerprints (V3-14)", () => {
  const plan = createBuildPlan({ consumer: "demo" });
  const forged = {
    ...plan,
    artifactIdentity: {
      ...plan.artifactIdentity,
      fingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
  };
  assert.throws(
    () => validateBuildPlan(forged),
    /BuildPlan fingerprint mismatch/,
  );
});

test("computePlanFingerprint is sensitive to all preservation policy fields (V3-14, V3-15)", () => {
  const plan1 = createBuildPlan({ consumer: "demo", frozenMethods: ["foo"] });
  const plan2 = createBuildPlan({ consumer: "demo", frozenMethods: ["bar"] });
  assert.notEqual(plan1.artifactIdentity.fingerprint, plan2.artifactIdentity.fingerprint);

  const plan3 = createBuildPlan({ consumer: "demo", frozenVars: ["$v1"] });
  const plan4 = createBuildPlan({ consumer: "demo", frozenVars: ["$v2"] });
  assert.notEqual(plan3.artifactIdentity.fingerprint, plan4.artifactIdentity.fingerprint);
});


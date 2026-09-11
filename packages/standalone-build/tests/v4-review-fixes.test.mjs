/**
 * V4 review regressions.
 *
 * Covers two gaps that survived the v2 fix plan and the v3 review:
 *
 *  1. V3-16 follow-up — `validatePhpSyntaxTree` computed `isExactTarget` from the resolved
 *     interpreter and then discarded it, so a build could record a PHP 7.4 compatibility
 *     claim on the back of a host PHP 8.x run with nothing to distinguish the two. The gate
 *     now returns the interpreter evidence it used.
 *
 *  2. Cache consumer gate — `validateBuildCacheSchema` hard-rejected any consumer outside the
 *     hardcoded `ALLOWED_CONSUMERS` list with no escape hatch, while the journal validator
 *     (`build-cache-engine.mjs`) allowed structurally-valid external consumers. Because
 *     deploy/release modes throw on an invalid cache, a scaffolded consumer's cache record
 *     could block deployment outright.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  CACHE_SCHEMA_VERSION,
  validateBuildCacheSchema,
} from "../build-cache-engine.mjs";
import { validatePhpSyntaxTree } from "../profile-s-fail-closed.mjs";

function hasPhp() {
  try {
    execFileSync("php", ["-r", "echo PHP_VERSION;"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hex = (c) => c.repeat(64);

function minimalCacheDoc(consumer, record = {}) {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    _tools: hex("a"),
    _toolFiles: {},
    _wpdev: hex("b"),
    _theme: hex("c"),
    _testFiles: {},
    _testEvidence: {},
    toolchain: hex("d"),
    artifacts: { [consumer]: { consumer, ...record } },
  };
}

test("V4/V3-16: validatePhpSyntaxTree reports the interpreter it actually validated with", async (t) => {
  if (!hasPhp()) {
    t.skip("php is not available on PATH; cannot exercise the target-syntax gate");
    return;
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "v4-targetphp-"));
  try {
    await writeFile(
      path.join(tmpDir, "Compliant.php"),
      "<?php\nclass Compliant {\n    private $title;\n    public function __construct(string $title) { $this->title = $title; }\n}\n",
    );

    const result = await validatePhpSyntaxTree(tmpDir, { targetPhp: "7.4" });

    assert.ok(result && typeof result === "object", "gate must return interpreter evidence");
    assert.equal(result.targetPhp, "7.4");
    assert.equal(result.enforceTarget, false, "target enforcement is opt-in and off by default");
    assert.ok(result.interpreter && typeof result.interpreter.version === "string", "interpreter version must be reported");
    assert.ok(typeof result.interpreter.bin === "string" && result.interpreter.bin.length > 0);

    // The whole point: the verified flag must reflect the interpreter that ran, not the
    // declared target. A host PHP 8.x run must never report targetPhpVerified: true.
    assert.equal(
      result.targetPhpVerified,
      result.interpreter.version === "7.4",
      `targetPhpVerified must track the real interpreter version (got ${result.interpreter.version})`,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("V4: cache schema does not reject a structurally-valid scaffolded consumer", () => {
  const doc = minimalCacheDoc("my-custom-plugin");

  const val = validateBuildCacheSchema(doc);

  // The document is still invalid overall (the record is deliberately incomplete), but the
  // rejection must come from record validation, not from the consumer allowlist.
  assert.equal(val.valid, false);
  assert.doesNotMatch(
    String(val.reason || ""),
    /Disallowed artifact consumer|Unexpected artifact consumer/,
    `consumer allowlist must not be the rejection reason, got: ${val.reason}`,
  );
  assert.match(
    String(val.reason || ""),
    /artifactId/i,
    `validation should have proceeded to the record checks, got: ${val.reason}`,
  );
});

test("V4: cache schema still rejects a structurally-invalid consumer slug", () => {
  const doc = minimalCacheDoc("Not_A_Valid_Slug");

  const val = validateBuildCacheSchema(doc);

  assert.equal(val.valid, false);
  assert.match(String(val.reason || ""), /Disallowed artifact consumer/);
});

test("V4: cache schema accepts an allowlisted consumer without consumer-related rejection", () => {
  const doc = minimalCacheDoc("tavangary-core");

  const val = validateBuildCacheSchema(doc);

  assert.equal(val.valid, false);
  assert.doesNotMatch(
    String(val.reason || ""),
    /Disallowed artifact consumer|Unexpected artifact consumer/,
    `allowlisted consumer must never be rejected by the consumer gate, got: ${val.reason}`,
  );
});

test("V4: bracketed namespaces with alias statements wrap in global namespace block", async (t) => {
  if (!hasPhp()) {
    t.skip("php is not available on PATH");
    return;
  }
  const transformerPhp = path.resolve(__dirname, "../plan3/transformer.php");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "v4-ns-brace-"));
  try {
    const source = "<?php namespace A{class Worker{public function read(){return 'ok';}}}namespace B{use A\\{Worker};echo (new Worker)->read();}";
    const mainFile = path.join(tmpDir, "main.php");
    const mapFile = path.join(tmpDir, "map.json");
    await writeFile(mainFile, source, "utf8");

    execFileSync("php", [transformerPhp, "--dump-map", tmpDir, mapFile, "seed-v4"]);
    execFileSync("php", [transformerPhp, "--batch", tmpDir, mapFile, "seed-v4", "main.php"]);

    const lint = execFileSync("php", ["-l", mainFile], { encoding: "utf8" });
    assert.match(lint, /No syntax errors detected/);

    const exec = execFileSync("php", [mainFile], { encoding: "utf8" });
    assert.equal(exec.trim(), "ok");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("V4: array callable class string remaps class name in callback position", async (t) => {
  if (!hasPhp()) {
    t.skip("php is not available on PATH");
    return;
  }
  const transformerPhp = path.resolve(__dirname, "../plan3/transformer.php");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "v4-array-callable-"));
  try {
    const source = "<?php namespace Acme;\nclass Handler { public function exec() { return 'handled'; } }\nclass Dispatcher { public function run() { return add_action('hook', array('Acme\\Handler', 'exec')); } }";
    const mainFile = path.join(tmpDir, "Dispatcher.php");
    const mapFile = path.join(tmpDir, "map.json");
    await writeFile(mainFile, source, "utf8");

    execFileSync("php", [transformerPhp, "--dump-map", tmpDir, mapFile, "seed-v4"]);
    execFileSync("php", [transformerPhp, "--batch", tmpDir, mapFile, "seed-v4", "Dispatcher.php"]);

    const transformed = execFileSync("php", ["-r", `echo file_get_contents(${JSON.stringify(mainFile)});`], { encoding: "utf8" });
    const lint = execFileSync("php", ["-l", mainFile], { encoding: "utf8" });
    assert.match(lint, /No syntax errors detected/);
    assert.ok(!transformed.includes("'Acme\\Handler'"), "Acme\\Handler class string must be remapped");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

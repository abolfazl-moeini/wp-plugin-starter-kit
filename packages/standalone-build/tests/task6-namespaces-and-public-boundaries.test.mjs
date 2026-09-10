import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAN_B_FIXTURES,
  runFixtureHarness,
} from "./helpers/transformer-fixture-harness.mjs";

const TASK6_CASES = [
  "frozen_class_neighbor",
  "namespace_constant",
  "namespace_magic",
  "class_function_collision",
  "class_method_collision",
  "case_insensitive_class",
  "array_map_callback",
  "is_callable_check",
  "public_named_arguments",
  "serialized_private",
];

for (const caseName of TASK6_CASES) {
  test(`Task 6 Regression: ${caseName}`, async () => {
    const fix = PLAN_B_FIXTURES.find((f) => f.case === caseName);
    assert.ok(fix, `${caseName} fixture must exist`);
    const result = await runFixtureHarness(fix);
    assert.equal(result.cleanResult.exitCode, 0, `Clean ${caseName} must exit 0: ${result.cleanResult.stderr}`);
    assert.equal(
      result.cleanResult.stdout.trim(),
      String(fix.expectedStdout).trim(),
      `Clean ${caseName} stdout`,
    );
    assert.equal(
      result.transformedResult.exitCode,
      0,
      `Transformed ${caseName} must exit 0: ${result.transformedResult.stderr}`,
    );
    assert.equal(
      result.transformedResult.stdout.trim(),
      String(fix.expectedStdout).trim(),
      `Transformed ${caseName} must match clean baseline`,
    );
    assert.equal(result.matched, true, `${caseName} transformed output must match clean`);
  });
}

test("Task 6 Regression: typed private receiver is rewritten consistently", async () => {
  const fixture = {
    case: "typed_private_receiver",
    files: {
      "main.php": "<?php class Vault { private function secret(){ return 'ok'; } public function read(Vault $other){ return $other->secret(); } } echo (new Vault)->read(new Vault);",
    },
    expectedExit: 0,
    expectedStdout: "ok",
  };
  const result = await runFixtureHarness(fixture);
  assert.equal(result.matched, true, result.transformedResult.stderr);
  assert.equal(result.transformedResult.stdout.trim(), "ok");
});

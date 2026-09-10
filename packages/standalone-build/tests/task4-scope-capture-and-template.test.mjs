import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAN_B_FIXTURES,
  runFixtureHarness,
} from "./helpers/transformer-fixture-harness.mjs";

test("Task 4 Regression: compact_extract (compact() in scope with extract stays intact)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "compact_extract");
  assert.ok(fix, "compact_extract fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), '{"amount":7}', "Clean baseline must output '{\"amount\":7}'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), '{"amount":7}', "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 4 Regression: compact_global (compact() with global variable preserves variable across scopes)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "compact_global");
  assert.ok(fix, "compact_global fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), '{"amount":7}', "Clean baseline must output '{\"amount\":7}'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), '{"amount":7}', "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 4 Regression: compact_undefined (compact() on undefined does not inject null and omits undefined names)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "compact_undefined");
  assert.ok(fix, "compact_undefined fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.ok(result.cleanResult.stdout.trim().endsWith("[]"), "Clean baseline must end with '[]'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.ok(result.transformedResult.stdout.trim().endsWith("[]"), "Transformed output must end with '[]'");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 4 Regression: get_defined_vars (scope introspection preserves local variables)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "get_defined_vars");
  assert.ok(fix, "get_defined_vars fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), '{"amount":7}', "Clean baseline must output '{\"amount\":7}'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), '{"amount":7}', "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 4 Regression: closure_extract_capture (closure use ($var) captures preserved parent scope variable)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "closure_extract_capture");
  assert.ok(fix, "closure_extract_capture fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "7", "Clean baseline must output '7'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "7", "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 4 Regression: qualified_extract (fully qualified \\extract() detected as dynamic scope)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "qualified_extract");
  assert.ok(fix, "qualified_extract fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "7", "Clean baseline must output '7'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "7", "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 4 Regression: view_include (view/template files preserve variable names matching caller scope)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "view_include");
  assert.ok(fix, "view_include fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "7", "Clean baseline must output '7'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "7", "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 4 Regression: cross_file_global (cross-file global variables preserved consistently)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "cross_file_global");
  assert.ok(fix, "cross_file_global fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "7", "Clean baseline must output '7'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "7", "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 4 Regression: by_ref_capture (closure use (&$var) captures preserved parent variable by reference)", async () => {
  const fix = {
    case: "closure_by_ref_capture",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php function run_it(){extract(['amount'=>7]); $fn=function() use (&$amount){$amount+=3;return $amount;}; $res=$fn();return $res + $amount;} echo run_it();",
    },
    expectedExit: 0,
    expectedStdout: "20",
  };

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "20", "Clean baseline must output '20'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "20", "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 4 Regression: nested_closures (nested closures propagate preserved variable across closure layers)", async () => {
  const fix = {
    case: "nested_closures_capture",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php function run_it(){extract(['amount'=>7]); $c1=function() use ($amount){ $c2=function() use ($amount){ return $amount * 2; }; return $c2(); }; return $c1();} echo run_it();",
    },
    expectedExit: 0,
    expectedStdout: "14",
  };

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "14", "Clean baseline must output '14'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "14", "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

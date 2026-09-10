import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAN_B_FIXTURES,
  runFixtureHarness,
  runPhpProcess,
} from "./helpers/transformer-fixture-harness.mjs";

test("Task 1: Fixture harness executes clean baseline and verifies expected stdout and exit code", async () => {
  const fixture = {
    case: "control_simple_class",
    files: {
      "main.php": "<?php class Control { public function ping() { return 'pong'; } } echo (new Control)->ping();",
    },
    expectedExit: 0,
    expectedStdout: "pong",
  };

  const result = await runFixtureHarness(fixture);
  assert.equal(result.cleanResult.exitCode, 0);
  assert.equal(result.cleanResult.stdout, "pong");
  assert.equal(result.matchesExpected, true);
});

test("Task 1: Fixture harness supports an untransformed external runner", async () => {
  const fixture = {
    case: "external_runner_check",
    files: {
      "lib.php": "<?php class ServiceWorker { public function work() { return 'done'; } }",
    },
    externalRunner: "<?php require '%TARGET_DIR%/lib.php'; echo (new ServiceWorker)->work();",
    expectedExit: 0,
    expectedStdout: "done",
  };

  const result = await runFixtureHarness(fixture);
  assert.equal(result.cleanResult.exitCode, 0);
  assert.equal(result.cleanResult.stdout, "done");
  assert.equal(result.matchesExpected, true);
});

test("Task 1: Negative fixture compact_undefined reproduces baseline omission and diagnostic warning", async () => {
  const compactFixture = PLAN_B_FIXTURES.find((f) => f.case === "compact_undefined");
  assert.ok(compactFixture, "compact_undefined fixture must be present in PLAN_B_FIXTURES");

  const result = await runFixtureHarness(compactFixture);
  assert.equal(result.cleanResult.exitCode, 0);
  assert.ok(result.cleanResult.stdout.includes("[]"), "Clean output must contain []");
  // Clean PHP emits undefined variable diagnostic in stdout or stderr
  const combinedOut = `${result.cleanResult.stdout}\n${result.cleanResult.stderr}`;
  assert.ok(
    combinedOut.includes("Undefined variable") || combinedOut.includes("compact(): Undefined variable"),
    "Clean baseline must emit warning for compact() on undefined variable"
  );
});

test("Task 1: Plan B fixtures baseline execution passes on clean PHP", async () => {
  // Test a representative sample of Plan B fixtures against clean baseline
  const sampleCases = [
    "private_reserved_property",
    "compact_extract",
    "fqcn_data",
    "comment_boundary",
    "const_reference",
    "qualified_extract",
    "view_include",
    "cross_file_global",
  ];

  for (const caseName of sampleCases) {
    const fix = PLAN_B_FIXTURES.find((f) => f.case === caseName);
    assert.ok(fix, `Fixture ${caseName} must exist`);

    const result = await runFixtureHarness(fix);
    assert.equal(
      result.cleanResult.exitCode,
      fix.expectedExit,
      `Case ${caseName} clean exit code must match expected: ${result.cleanResult.stderr}`
    );
    assert.equal(
      result.cleanResult.stdout.trim(),
      fix.expectedStdout.trim(),
      `Case ${caseName} clean stdout must match expected`
    );
  }
});

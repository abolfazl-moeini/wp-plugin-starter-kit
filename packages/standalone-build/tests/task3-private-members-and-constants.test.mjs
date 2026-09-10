import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAN_B_FIXTURES,
  runFixtureHarness,
} from "./helpers/transformer-fixture-harness.mjs";

test("Task 3 Regression: private_reserved_property ($data property vs $data reserved var)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "private_reserved_property");
  assert.ok(fix, "private_reserved_property fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "ok", "Clean baseline must output 'ok'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "ok", "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 3 Regression: private_method_other_instance (same-class other-instance private call preserves unprovable receiver)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "private_method_other_instance");
  assert.ok(fix, "private_method_other_instance fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "ok", "Clean baseline must output 'ok'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "ok", "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 3 Regression: public_method_same_name (private method does not rename public method of same name in another class)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "public_method_same_name");
  assert.ok(fix, "public_method_same_name fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "remote", "Clean baseline must output 'remote'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "remote", "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 3 Regression: foreign_property_across_files (unrelated object property not rewritten by private property map)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "foreign_property_across_files");
  assert.ok(fix, "foreign_property_across_files fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "remote", "Clean baseline must output 'remote'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "remote", "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 3 Regression: cross_file_private_trait (private trait method mangled consistently across consumer files)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "cross_file_private_trait");
  assert.ok(fix, "cross_file_private_trait fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "ok", "Clean baseline must output 'ok'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "ok", "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 3 Regression: const_reference (public const EXPOSED = self::SECRET rewrites self::SECRET to mangled private const)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "const_reference");
  assert.ok(fix, "const_reference fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "7", "Clean baseline must output '7'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "7", "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

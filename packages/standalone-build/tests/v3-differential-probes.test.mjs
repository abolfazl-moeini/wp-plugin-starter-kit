import assert from "node:assert/strict";
import test from "node:test";

import {
  V3_DIFFERENTIAL_FIXTURES,
  runFixtureHarness,
} from "./helpers/transformer-fixture-harness.mjs";

for (const fix of V3_DIFFERENTIAL_FIXTURES) {
  test(`V3 Differential Probe: ${fix.case}`, async () => {
    const result = await runFixtureHarness(fix);
    assert.equal(result.cleanResult.exitCode, fix.expectedExit, `Clean baseline must exit ${fix.expectedExit}`);
    if (fix.expectedStdout !== undefined) {
      if (fix.negativeWarning) {
        assert.ok(
          result.cleanResult.stdout.trim().endsWith(fix.expectedStdout),
          `Clean baseline output must end with expected (${fix.expectedStdout}), got: ${result.cleanResult.stdout.trim()}`
        );
      } else {
        assert.equal(result.cleanResult.stdout.trim(), fix.expectedStdout, "Clean baseline output must match expected");
      }
    }
    assert.equal(
      result.transformedResult.exitCode,
      result.cleanResult.exitCode,
      `Transformed exit code (${result.transformedResult.exitCode}) must match clean (${result.cleanResult.exitCode}): ${result.transformedResult.stderr}`
    );
    assert.equal(result.matched, true, `Transformed stdout/stderr must match clean baseline:\nClean:\n${result.cleanResult.stdout}\nTransformed:\n${result.transformedResult.stdout}\nStderr:\n${result.transformedResult.stderr}`);
  });
}

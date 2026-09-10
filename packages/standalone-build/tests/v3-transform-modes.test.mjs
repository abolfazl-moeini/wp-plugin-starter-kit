import assert from "node:assert/strict";
import test from "node:test";

import { runFixtureHarness } from "./helpers/transformer-fixture-harness.mjs";

const MODE_FIXTURES = [
  {
    name: "simple",
    files: {
      "main.php": "<?php namespace Acme; class Worker{public function read(){return 'ok';}} function run_it(){return (new Worker)->read();} echo run_it();",
    },
    expectedStdout: "ok",
  },
  {
    name: "function_only",
    files: {
      "main.php": "<?php namespace Acme; function run_it(){return 7;} echo run_it();",
    },
    expectedStdout: "7",
  },
  {
    name: "frozen_cross_file",
    files: {
      "main.php": "<?php namespace Client; require __DIR__.'/lib.php'; echo (new \\Acme\\Worker)->read();",
      "lib.php": "<?php namespace Acme; class Plugin{} class Worker{public function read(){return 'ok';}}",
    },
    expectedStdout: "ok",
  },
  {
    name: "const_cross_file",
    files: {
      "main.php": "<?php namespace Client; require __DIR__.'/lib.php'; echo (new \\Acme\\Worker)->read();",
      "lib.php": "<?php namespace Acme; const LIMIT=7; class Worker{public function read(){return LIMIT;}}",
    },
    expectedStdout: "7",
  },
  {
    name: "function_external_alias",
    files: {
      "main.php": "<?php namespace Acme; use function strlen as length; echo length('abc');",
    },
    expectedStdout: "3",
  },
  {
    name: "group_use_function",
    files: {
      "lib.php": "<?php namespace Foo; function alpha(){return 1;} function beta(){return 2;}",
      "main.php":
        "<?php namespace Acme; require __DIR__.'/lib.php'; use function Foo\\{alpha, beta as b}; echo alpha() + b();",
    },
    expectedStdout: "3",
  },
  {
    name: "function_return_by_ref",
    files: {
      "main.php":
        "<?php namespace Acme; function &run_it(){static $v=0;$v++;return $v;}$x=&run_it();echo $x;",
    },
    expectedStdout: "1",
  },
  {
    name: "closure_byref_capture",
    files: {
      "main.php":
        "<?php function run_it(){$local=7;$fn=function() use(&$local){$local=9;};$fn();return $local;}echo run_it();",
    },
    expectedStdout: "9",
  },
];

const MODES = [
  { flatten: 0, mangle: 0, stripComments: 0, label: "clean" },
  { flatten: 0, mangle: 1, stripComments: 1, label: "obfuscate-only" },
  { flatten: 1, mangle: 0, stripComments: 0, label: "spaghetti-only" },
  { flatten: 1, mangle: 1, stripComments: 1, label: "combined" },
];

for (const fix of MODE_FIXTURES) {
  for (const mode of MODES) {
    test(`V3 Mode Probe: ${fix.name} [${mode.label}]`, async () => {
      const result = await runFixtureHarness(
        {
          case: `${fix.name}-${mode.label}`,
          files: fix.files,
          flatten: mode.flatten,
          mangle: mode.mangle,
          stripComments: mode.stripComments,
          expectedExit: 0,
          expectedStdout: fix.expectedStdout,
        }
      );
      assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
      assert.equal(result.cleanResult.stdout.trim(), fix.expectedStdout);
      assert.equal(
        result.transformedResult.exitCode,
        0,
        `Transformed [${mode.label}] must exit 0: ${result.transformedResult.stderr}`
      );
      assert.equal(result.transformedResult.stdout.trim(), fix.expectedStdout);
    });
  }
}

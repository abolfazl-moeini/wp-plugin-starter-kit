import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { assertSymbolMapHasNoCollisions, parseTransformerBatchLog } from "../profile-s-fail-closed.mjs";

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const TRANSFORMER_PHP = path.resolve(packageRoot, "plan3/transformer.php");

test("F09: function map preserves namespace identity, prevents collisions, and resolves use function / qualified calls", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "f09-trans-"));
  try {
    const fileA = path.join(tmp, "FileA.php");
    const fileB = path.join(tmp, "FileB.php");
    const fileC = path.join(tmp, "FileC.php");
    const fileD = path.join(tmp, "FileD.php");
    const mapOut = path.join(tmp, "symbol-map.json");

    await fs.writeFile(
      fileA,
      `<?php
namespace ExampleA;
function calculateTotal() {
    return 100;
}
`,
    );

    await fs.writeFile(
      fileB,
      `<?php
namespace ExampleB;
function calculateTotal() {
    return 200;
}
`,
    );

    await fs.writeFile(
      fileC,
      `<?php
function calculateTotal() {
    return 300;
}
`,
    );

    await fs.writeFile(
      fileD,
      `<?php
namespace Caller;
use function ExampleA\\calculateTotal as calc_a;
use function ExampleB\\calculateTotal as calc_b;

function tavangary_run() {
    $a1 = calc_a();
    $b1 = calc_b();
    $a2 = \\ExampleA\\calculateTotal();
    $b2 = \\ExampleB\\CALCULATETOTAL(); // case-insensitive check
    $g  = \\calculateTotal();
    return $a1 + $b1 + $a2 + $b2 + $g;
}
`,
    );

    // Step 1: dump-map
    await exec("php", [TRANSFORMER_PHP, "--dump-map", tmp, mapOut, "test-f09-seed"]);
    const symMap = JSON.parse(await fs.readFile(mapOut, "utf8"));

    // F09 Assertion: dumped map must have distinct FQFN entries and no collisions
    assert.ok(symMap.functions, "symbol map must have functions table");
    assert.ok(
      symMap.functions["ExampleA\\calculateTotal"] || symMap.functions["\\ExampleA\\calculateTotal"],
      "must record FQFN for ExampleA\\calculateTotal",
    );
    assert.ok(
      symMap.functions["ExampleB\\calculateTotal"] || symMap.functions["\\ExampleB\\calculateTotal"],
      "must record FQFN for ExampleB\\calculateTotal",
    );
    assert.notEqual(
      symMap.functions["ExampleA\\calculateTotal"],
      symMap.functions["ExampleB\\calculateTotal"],
      "ExampleA and ExampleB calculateTotal must have DIFFERENT mangled names",
    );

    // Collision check should pass cleanly without ambiguous short name collision
    const totalChecked = assertSymbolMapHasNoCollisions(symMap);
    assert.ok(totalChecked >= 2, "must verify distinct function symbols");

    // Step 2: batch transform
    const { stdout: batchOut } = await exec("php", [
      TRANSFORMER_PHP,
      "--batch",
      tmp,
      mapOut,
      "test-f09-seed",
    ]);
    parseTransformerBatchLog(batchOut);

    // Step 3: Execute all files together in PHP to verify runtime behavior
    const runner = path.join(tmp, "runner.php");
    await fs.writeFile(
      runner,
      `<?php
require_once '${fileA}';
require_once '${fileB}';
require_once '${fileC}';
require_once '${fileD}';

$result = tavangary_run();
echo "RESULT:" . $result . "\\n";
`,
    );

    const { stdout: runOut } = await exec("php", [runner]);
    assert.match(runOut, /RESULT:900/, `Expected 100+200+100+200+300 = 900, got: ${runOut}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("F10: preserves string literals, gettext, array keys, and protects scopes with variable introspection", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "f10-trans-"));
  try {
    const fileSource = path.join(tmp, "TestClass.php");
    const mapOut = path.join(tmp, "symbol-map.json");

    await fs.writeFile(
      fileSource,
      `<?php
namespace App;

class CheckoutSummary {
    public function getTitle() {
        return 'Summary';
    }
}

function processPayment() {
    return 'paid';
}

class TestScope {
    public function compactMethod($arg) {
        return 'custom-compact:' . $arg;
    }

    public function testStringPreservation() {
        // String literal equal to class name
        $name = 'CheckoutSummary';
        // Array subscript equal to class name
        $sub['CheckoutSummary'] = 10;
        // Associative array definition
        $def = array('CheckoutSummary' => 20, 'processPayment' => 30);
        // Gettext call
        $translated = __('CheckoutSummary', 'textdomain');
        // Unrelated function name string
        $funcStr = 'processPayment';

        // Object method named compact
        $objCompact = $this->compactMethod('xyz');

        return array(
            'name' => $name,
            'sub'  => $sub['CheckoutSummary'],
            'def1' => $def['CheckoutSummary'],
            'def2' => $def['processPayment'],
            'trans'=> $translated,
            'fstr' => $funcStr,
            'objC' => $objCompact,
        );
    }

    public function testExtractScope() {
        $params = array('custom_extracted_var' => 42, 'another_var' => 99);
        extract($params);
        return $custom_extracted_var + $another_var;
    }

    public function testVariableVariableScope() {
        $real_var = 123;
        $name = 'real_var';
        return $$name;
    }

    public function testGlobalsScope() {
        global $my_custom_global;
        $my_custom_global = 777;
        return $GLOBALS['my_custom_global'];
    }
}
`,
    );

    // Dump map
    await exec("php", [TRANSFORMER_PHP, "--dump-map", tmp, mapOut, "test-f10-seed"]);

    // Batch transform
    await exec("php", [
      TRANSFORMER_PHP,
      "--batch",
      tmp,
      mapOut,
      "test-f10-seed",
    ]);

    const transformed = await fs.readFile(fileSource, "utf8");

    // F10 Assertions:
    // 1. Literal 'CheckoutSummary' and 'processPayment' must NOT be rewritten when used as plain data or array keys
    assert.ok(
      transformed.includes("'CheckoutSummary'"),
      "Plain string 'CheckoutSummary' must be preserved",
    );
    assert.ok(
      transformed.includes("'processPayment'"),
      "Plain string 'processPayment' must be preserved",
    );
    assert.ok(
      !transformed.includes("->array("),
      "$this->compactMethod() must NOT be rewritten into ->array()",
    );

    // 2. Execute runtime test
    const runner = path.join(tmp, "runner.php");
    await fs.writeFile(
      runner,
      `<?php
function __($text, $domain) { return "TRANSLATED:" . $text; }

require_once '${fileSource}';

$obj = new \\App\\TestScope();
$strings = $obj->testStringPreservation();
assert($strings['name'] === 'CheckoutSummary', "name was corrupted");
assert($strings['sub'] === 10, "sub was corrupted");
assert($strings['def1'] === 20, "def1 was corrupted");
assert($strings['def2'] === 30, "def2 was corrupted");
assert($strings['trans'] === 'TRANSLATED:CheckoutSummary', "trans was corrupted");
assert($strings['fstr'] === 'processPayment', "fstr was corrupted");
assert($strings['objC'] === 'custom-compact:xyz', "objCompact was corrupted");

$extractedSum = $obj->testExtractScope();
assert($extractedSum === 141, "extract scope failed: " . $extractedSum);

$varVar = $obj->testVariableVariableScope();
assert($varVar === 123, "variable variable failed: " . $varVar);

$glob = $obj->testGlobalsScope();
assert($glob === 777, "globals scope failed: " . $glob);

echo "F10_TESTS_PASS\\n";
`,
    );

    const { stdout: runOut } = await exec("php", [runner]);
    assert.match(runOut, /F10_TESTS_PASS/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("F11: transformer exits non-zero on I/O failure and records verified manifest records", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "f11-trans-"));
  try {
    const fileA = path.join(tmp, "Valid.php");
    const mapOut = path.join(tmp, "symbol-map.json");
    await fs.writeFile(fileA, "<?php echo 'hello';\n");

    // Case 1: Corrupted / invalid map file in --batch must exit non-zero
    const corruptMap = path.join(tmp, "corrupt-map.json");
    await fs.writeFile(corruptMap, "{ this is not json }");
    let corruptFailed = false;
    try {
      await exec("php", [TRANSFORMER_PHP, "--batch", tmp, corruptMap, "seed"]);
    } catch (err) {
      corruptFailed = true;
      assert.notEqual(err.code, 0, "must exit non-zero on invalid map file");
    }
    assert.ok(corruptFailed, "transformer --batch must fail on invalid map file");

    // Case 2: Dump map to unwritable path must exit non-zero
    const unwritableMap = path.join(tmp, "nonexistent-dir/deep/symbol-map.json");
    let dumpFailed = false;
    try {
      await exec("php", [TRANSFORMER_PHP, "--dump-map", tmp, unwritableMap, "seed"]);
    } catch (err) {
      dumpFailed = true;
      assert.notEqual(err.code, 0, "must exit non-zero on unwritable dump map target");
    }
    assert.ok(dumpFailed, "transformer --dump-map must fail on unwritable output");

    // Case 3: Valid batch transformation emits manifest with sha256 and bytes
    await exec("php", [TRANSFORMER_PHP, "--dump-map", tmp, mapOut, "seed"]);
    const { stdout: batchOut } = await exec("php", [
      TRANSFORMER_PHP,
      "--batch",
      tmp,
      mapOut,
      "seed",
    ]);

    const log = parseTransformerBatchLog(batchOut);
    assert.equal(log.length, 1);
    assert.ok(typeof log[0].sha256 === "string" && log[0].sha256.length === 64, "record must include sha256");
    assert.ok(typeof log[0].bytes === "number" && log[0].bytes > 0, "record must include bytes written");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

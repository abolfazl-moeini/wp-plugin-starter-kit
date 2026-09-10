/**
 * Shared Transformer Fixture Harness
 *
 * Implements Task 1 from protection-pipeline-fix-plan-v2.md.
 * Provides a reliable, reproducible test harness that:
 * 1. Writes fixtures to disposable temporary staging.
 * 2. Executes clean PHP in a fresh process and captures baseline exit/stdout/stderr.
 * 3. Runs production --dump-map and --batch passes of plan3/transformer.php.
 * 4. Executes transformed PHP in a fresh process and compares results.
 * 5. Supports an untransformed external runner to prevent self-transformed callers from masking public-API breakage.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STANDALONE_BUILD_DIR = path.resolve(__dirname, "../..");
const DEFAULT_TRANSFORMER_PHP = path.resolve(STANDALONE_BUILD_DIR, "plan3/transformer.php");

/**
 * Executes a PHP process with controlled options.
 */
export async function runPhpProcess(scriptPath, { args = [], env = {}, cwd = null, phpBin = "php", enableAssertions = true } = {}) {
  const phpArgs = [
    "-d",
    enableAssertions ? "zend.assertions=1" : "zend.assertions=-1",
    "-d",
    enableAssertions ? "assert.exception=1" : "assert.exception=0",
    scriptPath,
    ...args,
  ];

  try {
    const { stdout, stderr } = await execFileAsync(phpBin, phpArgs, {
      cwd: cwd || path.dirname(scriptPath),
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    return {
      exitCode: error.code !== undefined ? error.code : 1,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || "",
    };
  }
}

/**
 * Runs a full fixture lifecycle (clean baseline vs transformed candidate).
 *
 * @param {Object} fixture
 * @param {Object} options
 * @returns {Promise<Object>}
 */
export async function runFixtureHarness(fixture, options = {}) {
  if (!fixture || typeof fixture !== "object") {
    throw new Error("Fixture must be a non-null object");
  }
  const caseName = fixture.case || "anonymous_fixture";
  const files = fixture.files || {};
  const mainFile = fixture.mainFile || "main.php";
  const seed = fixture.seed || options.seed || "audit-seed";
  const phpBin = options.phpBin || "php";
  const transformerPhp = options.transformerPhp || DEFAULT_TRANSFORMER_PHP;
  const externalRunnerCode = fixture.externalRunner || options.externalRunner || null;

  const flatten = fixture.flatten !== undefined ? fixture.flatten : (options.flatten !== undefined ? options.flatten : 1);
  const mangle = fixture.mangle !== undefined ? fixture.mangle : (options.mangle !== undefined ? options.mangle : 1);
  const stripComments = fixture.stripComments !== undefined ? fixture.stripComments : (options.stripComments !== undefined ? options.stripComments : (mangle ? 1 : 0));
  const exactOutput = Boolean(fixture.exactOutput || options.exactOutput);

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), `fixture-${caseName}-`));
  const cleanDir = path.join(tmpRoot, "clean");
  const transDir = path.join(tmpRoot, "transformed");
  const mapFile = path.join(tmpRoot, "symbol-map.json");

  try {
    await mkdir(cleanDir, { recursive: true });
    await mkdir(transDir, { recursive: true });

    // Populate files in clean and transformed directories
    for (const [relPath, content] of Object.entries(files)) {
      const cleanTarget = path.join(cleanDir, relPath);
      const transTarget = path.join(transDir, relPath);
      await mkdir(path.dirname(cleanTarget), { recursive: true });
      await mkdir(path.dirname(transTarget), { recursive: true });
      await writeFile(cleanTarget, content, "utf8");
      await writeFile(transTarget, content, "utf8");
    }

    // Set up external runner if provided
    let cleanRunnerPath = path.join(cleanDir, mainFile);
    let transRunnerPath = path.join(transDir, mainFile);

    if (externalRunnerCode) {
      cleanRunnerPath = path.join(tmpRoot, "runner_clean.php");
      transRunnerPath = path.join(tmpRoot, "runner_transformed.php");
      await writeFile(cleanRunnerPath, externalRunnerCode.replace(/%TARGET_DIR%/g, cleanDir), "utf8");
      await writeFile(transRunnerPath, externalRunnerCode.replace(/%TARGET_DIR%/g, transDir), "utf8");
    }

    // 1. Execute Clean Baseline in a fresh PHP process
    const cleanResult = await runPhpProcess(cleanRunnerPath, { phpBin });

    // 2. Run Transform Stages (--dump-map and --batch)
    let dumpResult;
    let batchResult;
    try {
      dumpResult = await execFileAsync(phpBin, [
        transformerPhp,
        "--dump-map",
        transDir,
        mapFile,
        seed,
        `--flatten=${flatten ? 1 : 0}`,
        `--mangle=${mangle ? 1 : 0}`,
        `--strip-comments=${stripComments ? 1 : 0}`,
      ]);
    } catch (e) {
      dumpResult = { error: e.message, stderr: e.stderr, stdout: e.stdout };
      throw new Error(`transformer --dump-map failed for ${caseName}: ${e.stderr || e.message}`);
    }

    try {
      batchResult = await execFileAsync(phpBin, [
        transformerPhp,
        "--batch",
        transDir,
        mapFile,
        seed,
        mainFile,
        `--flatten=${flatten ? 1 : 0}`,
        `--mangle=${mangle ? 1 : 0}`,
        `--strip-comments=${stripComments ? 1 : 0}`,
      ]);
    } catch (e) {
      batchResult = { error: e.message, stderr: e.stderr, stdout: e.stdout };
      throw new Error(`transformer --batch failed for ${caseName}: ${e.stderr || e.message}`);
    }

    // 3. Execute Transformed Candidate in a fresh PHP process
    const transformedResult = await runPhpProcess(transRunnerPath, { phpBin });

    const normalizeOutput = (out) =>
      typeof out === "string"
        ? out
            .replaceAll(cleanDir, "%TARGET_DIR%")
            .replaceAll(transDir, "%TARGET_DIR%")
            .replace(/Call Stack:[\s\S]*?(?=\n\n|\n\[|\n\{|$)/g, "")
            .trim()
        : "";

    const normalizeDiagnostic = (err) =>
      typeof err === "string"
        ? err
            .replaceAll(cleanDir, "%TARGET_DIR%")
            .replaceAll(transDir, "%TARGET_DIR%")
            .replace(/in %TARGET_DIR%\/[^:\n]+ on line \d+/g, "on line <NUM>")
            .replace(/Stack trace:[\s\S]*?(?=\n\n|\n\[|\n\{|$)/g, "")
            .trim()
        : "";

    const stdoutMatches = exactOutput
      ? cleanResult.stdout === transformedResult.stdout
      : normalizeOutput(cleanResult.stdout) === normalizeOutput(transformedResult.stdout);

    const cleanErrNorm = normalizeDiagnostic(cleanResult.stderr);
    const transErrNorm = normalizeDiagnostic(transformedResult.stderr);

    let stderrMatches = true;
    if (!fixture.allowStderr && !fixture.negativeWarning) {
      if (cleanErrNorm === "" && transErrNorm !== "") {
        stderrMatches = false;
      } else if (cleanErrNorm !== transErrNorm) {
        stderrMatches = false;
      }
    }

    const matched =
      cleanResult.exitCode === transformedResult.exitCode &&
      stdoutMatches &&
      stderrMatches;

    const matchesExpected =
      fixture.expectedExit !== undefined && fixture.expectedStdout !== undefined
        ? cleanResult.exitCode === fixture.expectedExit &&
          cleanResult.stdout.trim() === String(fixture.expectedStdout).trim()
        : null;

    return {
      caseName,
      cleanResult,
      transformedResult,
      matched,
      matchesExpected,
      dumpResult,
      batchResult,
      cleanDir,
      transDir,
      mapFile,
    };
  } finally {
    if (!options.keepTemp) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Complete Plan B Appendix A JSONL Fixtures
 */
export const PLAN_B_FIXTURES = [
  {
    case: "private_reserved_property",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php class Vault {private $data='ok'; public function read(){return $this->data;}} echo (new Vault)->read();",
    },
    expectedExit: 0,
    expectedStdout: "ok",
  },
  {
    case: "private_method_other_instance",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php class Vault {private function secret(){return 'ok';} public function read($other){return $other->secret();}} echo (new Vault)->read(new Vault);",
    },
    expectedExit: 0,
    expectedStdout: "ok",
  },
  {
    case: "public_method_same_name",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php class Vault {private function secret(){return 'local';}} class Remote {public function secret(){return 'remote';}} echo (new Remote)->secret();",
    },
    expectedExit: 0,
    expectedStdout: "remote",
  },
  {
    case: "compact_extract",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php function run_it(){extract(['amount'=>7]);return compact('amount');} echo json_encode(run_it());",
    },
    expectedExit: 0,
    expectedStdout: '{"amount":7}',
  },
  {
    case: "compact_global",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php $amount=7; function run_it(){global $amount;return compact('amount');} echo json_encode(run_it());",
    },
    expectedExit: 0,
    expectedStdout: '{"amount":7}',
  },
  {
    case: "compact_undefined",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php echo json_encode(compact('missing'));",
    },
    expectedExit: 0,
    expectedStdout: "[]",
    negativeWarning: true,
  },
  {
    case: "get_defined_vars",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php function run_it(){ $amount=7; return get_defined_vars(); } echo json_encode(run_it());",
    },
    expectedExit: 0,
    expectedStdout: '{"amount":7}',
  },
  {
    case: "closure_extract_capture",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php function run_it(){extract(['amount'=>7]); $fn=function() use ($amount){return $amount;};return $fn();} echo run_it();",
    },
    expectedExit: 0,
    expectedStdout: "7",
  },
  {
    case: "private_const_literal",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php class Vault { private const SECRET='value';public function read(){return 'SECRET';}} echo (new Vault)->read();",
    },
    expectedExit: 0,
    expectedStdout: "SECRET",
  },
  {
    case: "fqcn_data",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php namespace Acme; class Widget {} echo 'Acme\\\\Widget';",
    },
    expectedExit: 0,
    expectedStdout: "Acme\\Widget",
  },
  {
    case: "inline_html",
    engine: "plan3/transformer.php",
    files: {
      "main.php": '<?php echo "begin";?> <script>const pattern="/*keep*/";</script>',
    },
    expectedExit: 0,
    expectedStdout: 'begin <script>const pattern="/*keep*/";</script>',
  },
  {
    case: "comment_boundary",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php function run_it(){return/**/true;} echo run_it()?'ok':'bad';",
    },
    expectedExit: 0,
    expectedStdout: "ok",
  },
  {
    case: "frozen_class_neighbor",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php namespace Acme; class Plugin {} class Worker {public function read(){return 'ok';}} echo (new Worker)->read();",
    },
    expectedExit: 0,
    expectedStdout: "ok",
  },
  {
    case: "namespace_constant",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php namespace Acme; const LIMIT=7; echo \\Acme\\LIMIT;",
    },
    expectedExit: 0,
    expectedStdout: "7",
  },
  {
    case: "class_function_collision",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php class WorkItem{} function WorkItem(){return 7;} echo WorkItem();",
    },
    expectedExit: 0,
    expectedStdout: "7",
  },
  {
    case: "class_method_collision",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php class WorkItem{} class Box {public function WorkItem(){return 7;}} echo (new Box)->WorkItem();",
    },
    expectedExit: 0,
    expectedStdout: "7",
  },
  {
    case: "case_insensitive_class",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php class WorkItem {public function read(){return 'ok';}} echo (new workitem)->read();",
    },
    expectedExit: 0,
    expectedStdout: "ok",
  },
  {
    case: "const_reference",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php class Vault {private const SECRET=7;public const EXPOSED=self::SECRET;} echo Vault::EXPOSED;",
    },
    expectedExit: 0,
    expectedStdout: "7",
  },
  {
    case: "public_named_arguments",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php class Box {public function read($amount){return $amount;}} echo (new Box)->read(amount:7);",
    },
    expectedExit: 0,
    expectedStdout: "7",
  },
  {
    case: "namespace_magic",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php namespace Acme; echo __NAMESPACE__;",
    },
    expectedExit: 0,
    expectedStdout: "Acme",
  },
  {
    case: "qualified_extract",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php function run_it(){\\extract(['amount'=>7]);return $amount;} echo run_it();",
    },
    expectedExit: 0,
    expectedStdout: "7",
  },
  {
    case: "view_include",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php function run_it(){ $amount=7; include __DIR__.'/views/value.php';} run_it();",
      "views/value.php": "<?php echo $amount;",
    },
    expectedExit: 0,
    expectedStdout: "7",
  },
  {
    case: "cross_file_global",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php $custom_state=7; require __DIR__.'/other.php'; echo read_state();",
      "other.php": "<?php function read_state(){global $custom_state;return $custom_state;}",
    },
    expectedExit: 0,
    expectedStdout: "7",
  },
  {
    case: "cross_file_private_trait",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php require __DIR__.'/trait.php'; class Box {use SecretTrait;public function read(){return $this->secret();}} echo (new Box)->read();",
      "trait.php": "<?php trait SecretTrait {private function secret(){return 'ok';}}",
    },
    expectedExit: 0,
    expectedStdout: "ok",
  },
  {
    case: "gettext_domain",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php function __($text,$domain){return $domain;} class Vault {private const DOMAIN='unused';public function read(){return __('hello','DOMAIN');}} echo (new Vault)->read();",
    },
    expectedExit: 0,
    expectedStdout: "DOMAIN",
  },
  {
    case: "array_map_callback",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php function convert_amount($x){return $x+1;} echo json_encode(array_map('convert_amount',[1]));",
    },
    expectedExit: 0,
    expectedStdout: "[2]",
  },
  {
    case: "is_callable_check",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php function convert_amount(){return 7;} echo is_callable('convert_amount')?'yes':'no';",
    },
    expectedExit: 0,
    expectedStdout: "yes",
  },
  {
    case: "foreign_property_across_files",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php class Vault {private $secret='local';public function read($other){return $other->secret;}} echo (new Vault)->read((object)['secret'=>'remote']);",
    },
    expectedExit: 0,
    expectedStdout: "remote",
  },
  {
    case: "serialized_private",
    engine: "plan3/transformer.php",
    files: {
      "main.php": "<?php class Vault {private $secret='value';public function __sleep(){return ['secret'];}} echo serialize(new Vault);",
    },
    expectedExit: 0,
    expectedStdout: 'O:5:"Vault":1:{s:13:"\u0000Vault\u0000secret";s:5:"value";}',
  },
];

/**
 * Review v3 Differential Probes (from section 5)
 */
export const V3_DIFFERENTIAL_FIXTURES = [
  {
    case: "compact_mixed",
    files: {
      "main.php": "<?php function run_it($param){$local=7;return compact('param','local');} echo json_encode(run_it(2));",
    },
    expectedExit: 0,
    expectedStdout: '{"param":2,"local":7}',
  },
  {
    case: "compact_array",
    files: {
      "main.php": "<?php function run_it(){$local=7;return compact(['local']);} echo json_encode(run_it());",
    },
    expectedExit: 0,
    expectedStdout: '{"local":7}',
  },
  {
    case: "compact_unset",
    files: {
      "main.php": "<?php function run_it(){$local=7;unset($local);return compact('local');} echo json_encode(run_it());",
    },
    expectedExit: 0,
    expectedStdout: "[]",
    negativeWarning: true,
  },
  {
    case: "closure_child_dynamic",
    files: {
      "main.php": "<?php function run_it(){$local=7;$fn=function() use($local){return get_defined_vars();};return $fn();} echo json_encode(run_it());",
    },
    expectedExit: 0,
    expectedStdout: '{"local":7}',
  },
  {
    case: "trait_alias",
    files: {
      "main.php": "<?php trait SecretTrait{private function secret(){return 'ok';}} class Box{use SecretTrait{secret as public read;}} echo (new Box)->read();",
    },
    expectedExit: 0,
    expectedStdout: "ok",
  },
  {
    case: "private_case",
    files: {
      "main.php": "<?php class Box{private function secret(){return 'ok';}public function read(){return $this->SECRET();}}echo (new Box)->read();",
    },
    expectedExit: 0,
    expectedStdout: "ok",
  },
  {
    case: "dynamic_private",
    files: {
      "main.php": "<?php class Box{private function secret(){return 'ok';}public function read(){$method='secret';return $this->$method();}}echo (new Box)->read();",
    },
    expectedExit: 0,
    expectedStdout: "ok",
  },
  {
    case: "private_array_data",
    files: {
      "main.php": "<?php class Box{private function secret(){return 'ok';}public function read(){return [$this,'secret'][1];}}echo (new Box)->read();",
    },
    expectedExit: 0,
    expectedStdout: "secret",
  },
  {
    case: "typed_receiver_shadow",
    files: {
      "main.php": "<?php class Box{private function secret(){return 'local';}public function read(Box $other){$fn=function($other){return $other->secret();};return $fn(new Remote);}}class Remote{public function secret(){return 'remote';}}echo (new Box)->read(new Box);",
    },
    expectedExit: 0,
    expectedStdout: "remote",
  },
  {
    case: "serialized_plain",
    files: {
      "main.php": "<?php class Box{private $secret='ok';}echo serialize(new Box);",
    },
    expectedExit: 0,
    expectedStdout: 'O:3:"Box":1:{s:11:"\0Box\0secret";s:2:"ok";}',
  },
  {
    case: "class_magic",
    files: {
      "main.php": "<?php namespace Acme;class Worker{public function read(){return __CLASS__;}}echo (new Worker)->read();",
    },
    expectedExit: 0,
    expectedStdout: "Acme\\Worker",
  },
  {
    case: "trait_two_users",
    files: {
      "main.php": "<?php trait SecretTrait{private function secret(){return 'ok';}}class First{use SecretTrait;public function read(){return $this->secret();}}class Second{use SecretTrait;public function read($other){return $other->secret();}}echo (new First)->read().(new Second)->read(new Second);",
    },
    expectedExit: 0,
    expectedStdout: "okok",
  },
  {
    case: "namespaced_extract_alias",
    files: {
      "main.php": "<?php namespace Acme;use function extract as unpack_vars;function run_it(){unpack_vars(['local'=>7]);return $local;}echo run_it();",
    },
    expectedExit: 0,
    expectedStdout: "7",
  },
  {
    case: "namespaced_group_use",
    files: {
      "main.php": "<?php namespace A{class Worker{public function read(){return 'ok';}}}namespace B{use A\\{Worker};echo (new Worker)->read();}",
    },
    expectedExit: 0,
    expectedStdout: "ok",
  },
];


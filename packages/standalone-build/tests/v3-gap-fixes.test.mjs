import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { runFixtureHarness } from "./helpers/transformer-fixture-harness.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRANSFORMER = path.resolve(HERE, "../plan3/transformer.php");

async function dumpMap(files, flags = ["--flatten=1", "--mangle=1", "--strip-comments=1"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "v3gapfix-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(root, rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    const mapFile = path.join(root, "map.json");
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      ({ stdout, stderr } = await execFileAsync(
        "php",
        [TRANSFORMER, "--dump-map", root, mapFile, "audit-seed", ...flags],
        { encoding: "utf8" }
      ));
    } catch (error) {
      exitCode = error.code !== undefined ? error.code : 1;
      stdout = error.stdout || "";
      stderr = error.stderr || String(error.message || error);
    }
    const map = JSON.parse(await readFile(mapFile, "utf8"));
    return { exitCode, stdout, stderr, map };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("V3 Gap: dump-map emits no warnings and records declaration file paths", async () => {
  const { exitCode, stderr, map } = await dumpMap({
    "main.php": "<?php namespace Acme; const LIMIT = 7; function run_it(){return LIMIT;} echo run_it();",
  });
  assert.equal(exitCode, 0, `dump-map must exit 0, stderr: ${stderr}`);
  assert.ok(
    !/undefined variable/i.test(stderr) && !/undefined array key/i.test(stderr),
    `dump-map must not emit undefined-variable warnings, got: ${stderr}`
  );
  assert.ok(
    Array.isArray(map.declarations) && map.declarations.length >= 2,
    "map must contain function + constant declarations"
  );
  for (const decl of map.declarations) {
    assert.equal(
      typeof decl.file,
      "string",
      `declaration ${decl.symbol} must carry a file path, got: ${JSON.stringify(decl.file)}`
    );
    assert.ok(decl.file.length > 0, `declaration ${decl.symbol} file must be non-empty`);
  }
  for (const [symbol, location] of Object.entries(map.symbolPaths || {})) {
    assert.match(
      String(location),
      /^.+:\d+$/,
      `symbolPaths[${symbol}] must be a path:line locator, got: ${location}`
    );
  }
});

test("V3 Gap: dump-map records return-by-reference function declarations", async () => {
  const { exitCode, stderr, map } = await dumpMap({
    "main.php":
      "<?php namespace Acme; function &run_it(){static $v=0;$v++;return $v;}$x=&run_it();echo $x;",
  });
  assert.equal(exitCode, 0, `dump-map must exit 0, stderr: ${stderr}`);
  const decl = (map.declarations || []).find((d) => d.symbol === "Acme\\run_it" && d.kind === "function");
  assert.ok(decl, "return-by-reference function Acme\\run_it must be recorded as a declaration");
});

test("V3 Gap: grouped function imports survive flattening", async () => {
  const result = await runFixtureHarness({
    case: "group_use_function",
    files: {
      "lib.php": "<?php namespace Foo; function alpha(){return 1;} function beta(){return 2;}",
      "main.php":
        "<?php namespace Acme; require __DIR__.'/lib.php'; use function Foo\\{alpha, beta as b}; echo alpha() + b();",
    },
    flatten: 1,
    mangle: 1,
    expectedExit: 0,
    expectedStdout: "3",
  });
  assert.equal(result.cleanResult.exitCode, 0, "clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "3");
  assert.equal(
    result.transformedResult.exitCode,
    0,
    `transformed grouped-use must exit 0: ${result.transformedResult.stderr}`
  );
  assert.equal(result.transformedResult.stdout.trim(), "3");
  assert.equal(result.matched, true, "grouped-use output must match the clean baseline");
});

test("V3 Gap: imported class references stay absolute without flattening", async () => {
  const result = await runFixtureHarness({
    case: "use_class_cross_file_no_flatten",
    files: {
      "lib.php": "<?php namespace Foo; class Bar{public function read(){return 'bar';}}",
      "main.php":
        "<?php namespace Acme; require __DIR__.'/lib.php'; use Foo\\Bar; echo (new Bar)->read();",
    },
    flatten: 0,
    mangle: 1,
    expectedExit: 0,
    expectedStdout: "bar",
  });
  assert.equal(result.cleanResult.exitCode, 0, "clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "bar");
  assert.equal(
    result.transformedResult.exitCode,
    0,
    `transformed import reference must exit 0: ${result.transformedResult.stderr}`
  );
  assert.equal(result.transformedResult.stdout.trim(), "bar");
  assert.equal(result.matched, true, "import reference output must match the clean baseline");
});

test("V3 Gap: by-reference closure captures keep the shared binding", async () => {
  const result = await runFixtureHarness({
    case: "closure_byref_capture",
    files: {
      "main.php":
        "<?php function run_it(){$local=7;$fn=function() use(&$local){$local=9;};$fn();return $local;}echo run_it();",
    },
    flatten: 1,
    mangle: 1,
    expectedExit: 0,
    expectedStdout: "9",
  });
  assert.equal(result.cleanResult.exitCode, 0, "clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "9");
  assert.equal(
    result.transformedResult.exitCode,
    0,
    `transformed by-ref capture must exit 0: ${result.transformedResult.stderr}`
  );
  assert.equal(result.transformedResult.stdout.trim(), "9");
  assert.equal(result.matched, true, "by-ref capture output must match the clean baseline");
});

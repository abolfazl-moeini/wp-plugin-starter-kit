import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAN_B_FIXTURES,
  runFixtureHarness,
} from "./helpers/transformer-fixture-harness.mjs";

test("Task 5 Regression: fqcn_data (ordinary data string matching FQCN is not rewritten)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "fqcn_data");
  assert.ok(fix, "fqcn_data fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "Acme\\Widget", "Clean baseline must output 'Acme\\Widget'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "Acme\\Widget", "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 5 Regression: inline_html (T_INLINE_HTML preserved byte-exact without regex-stripping JS comments)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "inline_html");
  assert.ok(fix, "inline_html fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(
    result.cleanResult.stdout.trim(),
    'begin <script>const pattern="/*keep*/";</script>',
    "Clean baseline must keep /*keep*/"
  );
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(
    result.transformedResult.stdout.trim(),
    'begin <script>const pattern="/*keep*/";</script>',
    "Transformed output must match clean baseline and preserve JS comment"
  );
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 5 Regression: comment_boundary (removing comment does not merge adjacent tokens into fatal identifier)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "comment_boundary");
  assert.ok(fix, "comment_boundary fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "ok", "Clean baseline must output 'ok'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "ok", "Transformed output must output 'ok' without returntrue error");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 5 Regression: private_const_literal (scalar literal matching private const name is not rewritten)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "private_const_literal");
  assert.ok(fix, "private_const_literal fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "SECRET", "Clean baseline must output 'SECRET'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "SECRET", "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 5 Regression: gettext_domain (gettext domain argument is preserved even if matching private const)", async () => {
  const fix = PLAN_B_FIXTURES.find((f) => f.case === "gettext_domain");
  assert.ok(fix, "gettext_domain fixture must exist");

  const result = await runFixtureHarness(fix);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "DOMAIN", "Clean baseline must output 'DOMAIN'");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "DOMAIN", "Transformed output must match clean baseline");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 5 Regression: gettext_all_arguments (all gettext positions: text, context, plural, domain preserved)", async () => {
  const fixture = {
    case: "gettext_all_arguments",
    files: {
      "main.php": `<?php
function _x($text, $context, $domain){ return "$text|$context|$domain"; }
function _n($single, $plural, $number, $domain){ return $number === 1 ? "$single|$domain" : "$plural|$domain"; }
class Vault {
    private const DOMAIN = 'mangled_domain';
    private const CONTEXT = 'mangled_context';
    public function test() {
        return _x('MyText', 'CONTEXT', 'DOMAIN') . ' ' . _n('SingularItem', 'PluralItem', 2, 'DOMAIN');
    }
}
echo (new Vault)->test();
`,
    },
    expectedExit: 0,
    expectedStdout: "MyText|CONTEXT|DOMAIN PluralItem|DOMAIN",
  };

  const result = await runFixtureHarness(fixture);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "MyText|CONTEXT|DOMAIN PluralItem|DOMAIN");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "MyText|CONTEXT|DOMAIN PluralItem|DOMAIN");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 5 Regression: heredoc_nowdoc (comments and literals in heredoc and nowdoc preserved byte-exact)", async () => {
  const fixture = {
    case: "heredoc_nowdoc",
    files: {
      "main.php": `<?php
$h = <<<EOT
/*keep_heredoc*/
// keep heredoc line comment
EOT;
$n = <<<'NOW'
/*keep_nowdoc*/
NOW;
echo $h . "\n" . $n;
`,
    },
    expectedExit: 0,
  };

  const result = await runFixtureHarness(fixture);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), result.cleanResult.stdout.trim());
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 5 Regression: mixed_php_html_close_tag (close tags and mixed HTML preserve syntax and boundaries)", async () => {
  const fixture = {
    case: "mixed_php_html_close_tag",
    files: {
      "main.php": `<?php if (true): ?><span>Hello World</span><?php endif; ?>
<?php function check(){ return/**/42; } echo check(); ?>
<?php echo "end"; ?>`,
    },
    expectedExit: 0,
  };

  const result = await runFixtureHarness(fixture);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), result.cleanResult.stdout.trim());
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 5 Regression: token_boundary_operators (removing comments between operators and keywords)", async () => {
  const fixture = {
    case: "token_boundary_operators",
    files: {
      "main.php": `<?php
function test_ops() {
    $a = 10;
    switch ($a) {
        case/**/10:
            $r = 1;
            break;
        default:
            $r = 0;
    }
    $c = 1 +/*comment*/+ 2;
    $d = 10 -/*comment*/- 5;
    return $r + $c + $d;
}
echo test_ops();
`,
    },
    expectedExit: 0,
  };

  const result = await runFixtureHarness(fixture);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.cleanResult.stdout.trim(), "19", "Clean baseline: 1 + 3 + 15 = 19");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), "19");
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

test("Task 5 Regression: literal_byte_exactness (SQL queries, JSON, HTML strings preserved byte-for-byte)", async () => {
  const fixture = {
    case: "literal_byte_exactness",
    files: {
      "main.php": `<?php
$sql = "SELECT id, name FROM wp_users WHERE status = 'active' AND type = \\"customer\\"";
$json = '{"key": "value", "escaped": "\\/test\\/"}';
$html = '<div class="alert alert-danger" data-id="123">Warning &copy;</div>';
echo md5($sql . $json . $html);
`,
    },
    expectedExit: 0,
  };

  const result = await runFixtureHarness(fixture);
  assert.equal(result.cleanResult.exitCode, 0, "Clean baseline must exit 0");
  assert.equal(result.transformedResult.exitCode, 0, `Transformed must exit 0: ${result.transformedResult.stderr}`);
  assert.equal(result.transformedResult.stdout.trim(), result.cleanResult.stdout.trim());
  assert.equal(result.matched, true, "Transformed must match clean baseline");
});

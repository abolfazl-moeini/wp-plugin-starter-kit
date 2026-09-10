import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import fs from "node:fs";
import crypto from "node:crypto";
import { validateDeployReceiptRecord } from "../build-cache-engine.mjs";
import { resolveContentRoot } from "../resolve-content-root.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveSmokeContentRoot() {
  if (process.env.SMOKE_CONTENT_ROOT) {
    const explicit = path.resolve(process.env.SMOKE_CONTENT_ROOT);
    if (!fs.existsSync(explicit)) {
      throw new Error(`Explicit SMOKE_CONTENT_ROOT does not exist: ${explicit}`);
    }
    return explicit;
  }
  return resolveContentRoot({ scriptDir: packageRoot, cwd: process.cwd(), env: process.env });
}

test("Docker Runtime Smoke: verifies TestRegistry and standalone plugins match deployed receipts", async (t) => {
  let contentRoot;
  try {
    contentRoot = resolveSmokeContentRoot();
  } catch (err) {
    if (process.env.ALLOW_DOCKER_SKIP === "1") {
      t.skip(`Skipping Docker smoke: ${err.message}`);
      return;
    }
    throw err;
  }

  const composeFile = path.resolve(contentRoot, "../../docker-compose.yml");
  const receiptsDir = path.resolve(contentRoot, "dist/.deploy-receipts");

  if (!fs.existsSync(composeFile) || !fs.existsSync(receiptsDir)) {
    if (process.env.ALLOW_DOCKER_SKIP === "1") {
      t.skip("Skipping Docker smoke: compose file or receipts directory not found");
      return;
    }
    throw new Error(`Docker smoke preflight failed: composeFile (${composeFile}) or receiptsDir (${receiptsDir}) does not exist`);
  }

  // Ensure diagnostic verifier is present in dist/ for the container
  const verifierSrc = path.resolve(packageRoot, "diagnostic-artifact-verifier.php");
  const verifierDest = path.resolve(contentRoot, "dist/.diagnostic-artifact-verifier.php");
  if (fs.existsSync(verifierSrc)) {
    await fs.promises.copyFile(verifierSrc, verifierDest);
  }

  const plugins = ["tavangary-core", "tavangary-theme-panel", "wpdev-crm", "wpdev-tickets"];
  const expectedReceipts = {};
  for (const p of plugins) {
    const rFile = path.join(receiptsDir, `${p}.receipt.json`);
    const receiptStat = await fs.promises.lstat(rFile);
    assert.equal(receiptStat.isSymbolicLink(), false, `${p} receipt must not be a symlink`);
    assert.equal(receiptStat.isFile(), true, `${p} receipt must be a regular file`);
    const rData = JSON.parse(await fs.promises.readFile(rFile, "utf8"));
    const zipPath = path.resolve(receiptsDir, "..", `${p}-profile-s.zip`);
    const zipStat = await fs.promises.lstat(zipPath);
    assert.equal(zipStat.isSymbolicLink(), false, `${p} ZIP must not be a symlink`);
    assert.equal(zipStat.isFile(), true, `${p} ZIP must be a regular file`);
    const zipSha256 = crypto.createHash("sha256").update(await fs.promises.readFile(zipPath)).digest("hex");
    const receiptCheck = validateDeployReceiptRecord({ receipt: rData, consumer: p, zipSha256 });
    assert.equal(receiptCheck.valid, true, receiptCheck.reason);
    expectedReceipts[p] = rData;
  }

  const phpProbeScript = `
echo "PHP_CONTAINER_VERSION: " . PHP_VERSION . "\\n";
require_once "/var/www/html/wp-load.php";
echo "WP_VERSION: " . ($GLOBALS["wp_version"] ?? "unknown") . "\\n";
$active = (array) get_option("active_plugins");
echo "ACTIVE_PLUGINS: " . implode(",", $active) . "\\n";
$required = ["tavangary-core/tavangary-core.php", "tavangary-theme-panel/tavangary-theme-panel.php", "wpdev-crm/wpdev-crm.php", "wpdev-tickets/wpdev-tickets.php"];
foreach ($required as $pluginFile) {
    if (!in_array($pluginFile, $active, true)) {
        throw new \\Exception("Standalone artifact is not the active plugin: " . $pluginFile . " active=" . implode(",", $active));
    }
}
if (in_array("wpdev/wpdev.php", $active, true)) {
    throw new \\Exception("Standalone smoke must not depend on active plugins/wpdev");
}

$reg = \\TavangaryCore\\Modules\\OnlineTest\\Tests\\TestRegistry::instance();
$allTests = $reg->all();
echo "TEST_COUNT: " . count($allTests) . "\\n";

$slugs = [];
foreach ($allTests as $slug => $testObj) {
    if (in_array($slug, $slugs, true)) {
        throw new \\Exception("Duplicate test slug: " . $slug);
    }
    $slugs[] = $slug;
    if (!is_object($testObj)) {
        throw new \\Exception("Test item is not an object: " . $slug);
    }
}
echo "ALL_TESTS_UNIQUE_AND_VALID: YES\\n";

require_once "/var/www/html/wp-content/dist/.diagnostic-artifact-verifier.php";
$plugins = ["tavangary-core", "tavangary-theme-panel", "wpdev-crm", "wpdev-tickets"];
foreach ($plugins as $p) {
    $receiptPath = "/var/www/html/wp-content/dist/.deploy-receipts/" . $p . ".receipt.json";
    $zipPath = "/var/www/html/wp-content/dist/" . $p . "-profile-s.zip";
    if (!is_file($receiptPath) || is_link($receiptPath) || !is_file($zipPath) || is_link($zipPath)) {
        throw new \\Exception("Receipt or ZIP missing/non-regular for " . $p);
    }
    $receipt = json_decode(file_get_contents($receiptPath), true);
    if (!is_array($receipt) || ($receipt["consumer"] ?? "") !== $p || ($receipt["artifactId"] ?? "") !== $p . "-profile-s") {
        throw new \\Exception("Receipt identity mismatch for " . $p);
    }
    if (!hash_equals((string) ($receipt["zipSha256"] ?? ""), hash_file("sha256", $zipPath))) {
        throw new \\Exception("Receipt ZIP digest mismatch for " . $p);
    }
    $manifestPath = "/var/www/html/wp-content/plugins/" . $p . "/artifact-manifest.json";
    $manifest = file_exists($manifestPath) ? json_decode(file_get_contents($manifestPath), true) : null;
    $manifestDigest = is_array($manifest) ? ($manifest["manifestDigest"] ?? "missing") : "missing";
    if (!is_array($manifest) || ($manifest["consumer"] ?? "") !== $p || ($manifest["artifactId"] ?? "") !== ($receipt["artifactId"] ?? "")) {
        throw new \\Exception("Deployed manifest identity mismatch for " . $p);
    }
    if (!hash_equals((string) ($receipt["manifestDigest"] ?? ""), (string) $manifestDigest)) {
        throw new \\Exception("Receipt/deployed manifest digest mismatch for " . $p);
    }
    echo "CONTAINER_DIGEST_" . $p . ": " . $manifestDigest . "\\n";
    $res = \\WPDev\\Core\\ArtifactIntegrityVerifier::verify("/var/www/html/wp-content/plugins/" . $p);
    echo "VERIFIER_" . $p . ": status=" . $res["status"] . ", fatal=" . ($res["fatal"] ? "yes" : "no") . ", missing=" . count($res["missingFiles"]) . ", modified=" . count($res["modifiedFiles"]) . ", unexpected=" . count($res["unexpectedFiles"]) . "\\n";
    if ($res["status"] !== "valid") {
        throw new \\Exception("Plugin " . $p . " failed integrity verification: " . json_encode($res));
    }
}
echo "DOCKER_SMOKE_ALL_PASS\\n";
`;

  try {
    const { stdout } = await execFileAsync("docker", [
      "compose",
      "-f",
      composeFile,
      "exec",
      "-T",
      "tavangarywp",
      "php",
      "-r",
      phpProbeScript,
    ]);

    assert.ok(stdout.includes("PHP_CONTAINER_VERSION: "), "PHP version must be reported from container");
    assert.ok(stdout.includes("WP_VERSION: "), "WordPress version must be reported from container");
    assert.ok(stdout.includes("ACTIVE_PLUGINS: "), "Active plugin list must be reported");
    assert.ok(stdout.includes("TEST_COUNT: 22"), "TestRegistry must report exactly 22 psychological tests");
    assert.ok(stdout.includes("ALL_TESTS_UNIQUE_AND_VALID: YES"), "All test items must be unique and valid objects");
    assert.ok(stdout.includes("VERIFIER_tavangary-core: status=valid, fatal=no"));
    assert.ok(stdout.includes("VERIFIER_tavangary-theme-panel: status=valid, fatal=no"));
    assert.ok(stdout.includes("VERIFIER_wpdev-crm: status=valid, fatal=no"));
    assert.ok(stdout.includes("DOCKER_SMOKE_ALL_PASS"));

    for (const p of plugins) {
      assert.ok(
        stdout.includes(`CONTAINER_DIGEST_${p}: ${expectedReceipts[p].manifestDigest}`),
        `Container manifest digest for ${p} must strictly match deploy receipt (${expectedReceipts[p].manifestDigest})`
      );
    }
  } catch (err) {
    const processOutput = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    const message = `${err.message || String(err)}${processOutput ? `\nProcess output:\n${processOutput}` : ""}`;
    const dockerUnavailable =
      message.includes("Cannot connect to the Docker daemon") ||
      message.includes("No such container") ||
      message.includes("Cannot connect") ||
      err.code === "ENOENT";
    const pipelineMode = process.env.TAVANGARY_PIPELINE_TEST_MODE || "";
    const strictMode = pipelineMode === "docker-smoke" || pipelineMode === "release" || process.env.ALLOW_DOCKER_SKIP !== "1";
    if (!strictMode && dockerUnavailable) {
      t.skip("Docker unavailable (structured skip, not a pass)");
      return;
    }
    throw new Error(`Docker runtime smoke check failed (fail-closed): ${message}`);
  } finally {
    try {
      if (fs.existsSync(verifierDest)) {
        await fs.promises.unlink(verifierDest);
      }
    } catch {
      // ignore cleanup errors
    }
  }
});

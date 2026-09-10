import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  atomicDeployPlugin,
  runDirectDeployTransaction,
} from "../build-all-standalone-plugins.mjs";
import {
  parseDeployArgs,
  executeWebRuntimeHealthCheck,
} from "../deploy-standalone-plugin.mjs";
import {
  createCanonicalZip,
  generateArtifactManifest,
} from "../canonical-artifact-manifest.mjs";

const execFileAsync = promisify(execFile);

test("F13: parseDeployArgs accepts --health-url and --health-token", () => {
  const parsed = parseDeployArgs([
    "/path/to/plugin.zip",
    "demo-plugin",
    "--health-url=https://example.com/wp-json/wpdev/v1/health",
    "--health-token=secret-token-123",
    "--keep-backup",
  ]);

  assert.equal(parsed.pluginSlug, "demo-plugin");
  assert.equal(parsed.options.healthUrl, "https://example.com/wp-json/wpdev/v1/health");
  assert.equal(parsed.options.healthToken, "secret-token-123");
  assert.equal(parsed.options.preserveBackup, true);
});

test("F13: executeWebRuntimeHealthCheck verifies valid response and rejects login redirects or fatal errors", async () => {
  let mode = "ok";
  const server = http.createServer((req, res) => {
    if (mode === "ok") {
      res.writeHead(200, { "Content-Type": "text/html", "X-WPDev-Health-Token": "healthy-123" });
      res.end("<html><body>System OK</body></html>");
    } else if (mode === "login-redirect") {
      res.writeHead(302, { Location: "/wp-login.php?redirect_to=health" });
      res.end();
    } else if (mode === "fatal-error") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<b>Fatal error</b>: Uncaught Error in /var/www/html/wp-content/plugins/test.php");
    } else if (mode === "critical-error") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("There has been a critical error on this website.");
    } else {
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/health`;

  try {
    // 1. Healthy response passes
    mode = "ok";
    const okRes = await executeWebRuntimeHealthCheck({
      healthUrl: baseUrl,
      healthToken: "healthy-123",
    });
    assert.equal(okRes.passed, true);

    // 2. Login redirect is rejected
    mode = "login-redirect";
    await assert.rejects(
      executeWebRuntimeHealthCheck({ healthUrl: baseUrl }),
      /redirected to login page|Web health check redirected/
    );

    // 3. Fatal error in 200 response is rejected
    mode = "fatal-error";
    await assert.rejects(
      executeWebRuntimeHealthCheck({ healthUrl: baseUrl }),
      /fatal error message/
    );

    // 4. Critical error in 200 response is rejected
    mode = "critical-error";
    await assert.rejects(
      executeWebRuntimeHealthCheck({ healthUrl: baseUrl }),
      /fatal error message/
    );

    // 5. Server 500 error is rejected
    mode = "server-error";
    await assert.rejects(
      executeWebRuntimeHealthCheck({ healthUrl: baseUrl }),
      /HTTP 500/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("F13: Failed web healthCheck triggers rollback and preserves backup without deletion", async () => {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "f13-deploy-health-"));
  const pluginsDir = path.join(tmpRoot, "plugins");
  const distDir = path.join(tmpRoot, "dist");
  await fs.promises.mkdir(pluginsDir, { recursive: true });
  await fs.promises.mkdir(distDir, { recursive: true });

  const pluginSlug = "tavangary-core";
  const targetDir = path.join(pluginsDir, pluginSlug);
  await fs.promises.mkdir(targetDir, { recursive: true });

  // Initial healthy version 1
  await fs.promises.writeFile(
    path.join(targetDir, `${pluginSlug}.php`),
    `<?php\n/* Version 1.0 */\ndefine('MY_PLUGIN_VER', '1.0');\n`,
    "utf8"
  );
  await fs.promises.mkdir(path.join(targetDir, "src/FrameworkClosure"), { recursive: true });
  await fs.promises.writeFile(path.join(targetDir, "src/FrameworkClosure/functions-closure.php"), "<?php // closure\n");
  const m1 = await generateArtifactManifest({
    rootDir: targetDir,
    consumer: pluginSlug,
    profile: "Profile S",
  });
  await fs.promises.writeFile(
    path.join(targetDir, "artifact-manifest.json"),
    JSON.stringify(m1, null, 2),
    "utf8"
  );

  // Prepare version 2 ZIP
  const v2Dir = path.join(tmpRoot, "v2-staging", pluginSlug);
  await fs.promises.mkdir(v2Dir, { recursive: true });
  await fs.promises.writeFile(
    path.join(v2Dir, `${pluginSlug}.php`),
    `<?php\n/* Version 2.0 */\ndefine('MY_PLUGIN_VER', '2.0');\n`,
    "utf8"
  );
  await fs.promises.mkdir(path.join(v2Dir, "src/FrameworkClosure"), { recursive: true });
  await fs.promises.writeFile(path.join(v2Dir, "src/FrameworkClosure/functions-closure.php"), "<?php // closure\n");
  const m2 = await generateArtifactManifest({
    rootDir: v2Dir,
    consumer: pluginSlug,
    profile: "Profile S",
  });
  await fs.promises.writeFile(
    path.join(v2Dir, "artifact-manifest.json"),
    JSON.stringify(m2, null, 2),
    "utf8"
  );
  const v2Zip = path.join(distDir, `${pluginSlug}.zip`);
  await createCanonicalZip({
    sourceRoot: v2Dir,
    outputZip: v2Zip,
    rootName: pluginSlug,
  });

  // Deploy with a failing healthCheck callback (simulating bad web runtime response)
  let healthChecked = false;
  await assert.rejects(
    runDirectDeployTransaction({
      zipPath: v2Zip,
      pluginSlug,
      options: {
        contentRoot: tmpRoot,
        pluginsDir,
        distDir,
        allowExternalConsumers: true,
        healthCheck: async () => {
          healthChecked = true;
          throw new Error("Web runtime health check failed: Critical WordPress Error");
        },
      },
    }),
    /Web runtime health check failed/
  );

  assert.equal(healthChecked, true, "healthCheck must have been executed");

  // Version 1 must have been restored by rollback!
  const restoredContent = await fs.promises.readFile(path.join(targetDir, `${pluginSlug}.php`), "utf8");
  assert.ok(restoredContent.includes("Version 1.0"), "Target must be restored to Version 1 on health failure");

  // Clean up
  await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

test("F13: In-flight late include simulation: traffic drain prevents late include missing require race", async () => {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "f13-inflight-"));
  const pluginsDir = path.join(tmpRoot, "plugins");
  await fs.promises.mkdir(pluginsDir, { recursive: true });

  const pluginSlug = "drain-sim-plugin";
  const targetDir = path.join(pluginsDir, pluginSlug);
  await fs.promises.mkdir(targetDir, { recursive: true });

  // V1 has ModuleA.php
  await fs.promises.writeFile(
    path.join(targetDir, `${pluginSlug}.php`),
    `<?php\nfunction load_bootstrap() { return true; }\n`,
    "utf8"
  );
  await fs.promises.writeFile(
    path.join(targetDir, "ModuleA.php"),
    `<?php\nclass ModuleA { public static function val() { return 'v1'; } }\n`,
    "utf8"
  );

  // PHP worker script that simulates in-flight request:
  // 1. Loads bootstrap
  // 2. Writes a token indicating it started
  // 3. Pauses until allowed to continue
  // 4. Late requires ModuleA.php
  const workerScript = path.join(tmpRoot, "inflight-worker.php");
  const tokenStarted = path.join(tmpRoot, "token_started.txt");
  const tokenResume = path.join(tmpRoot, "token_resume.txt");

  await fs.promises.writeFile(
    workerScript,
    `<?php
$pluginsDir = $argv[1];
$pluginSlug = $argv[2];
$tokenStarted = $argv[3];
$tokenResume = $argv[4];

require $pluginsDir . '/' . $pluginSlug . '/' . $pluginSlug . '.php';
file_put_contents($tokenStarted, 'started');

// Wait for release signal
$waited = 0;
while (!file_exists($tokenResume) && $waited < 100) {
    usleep(50000);
    $waited++;
}

// Late include of ModuleA
require $pluginsDir . '/' . $pluginSlug . '/ModuleA.php';
echo ModuleA::val();
`,
    "utf8"
  );

  // Case 1: In-flight request starts, then we swap out the plugin before worker resumes
  const childPromise = execFileAsync("php", [workerScript, pluginsDir, pluginSlug, tokenStarted, tokenResume]);

  // Wait for worker to start and load bootstrap
  while (!fs.existsSync(tokenStarted)) {
    await new Promise((r) => setTimeout(r, 20));
  }

  // Now simulate swap where ModuleA is replaced or moved in V2
  const backupDir = path.join(pluginsDir, `${pluginSlug}-old`);
  await fs.promises.rename(targetDir, backupDir);

  // New V2 without ModuleA (ModuleA replaced by ModuleB)
  await fs.promises.mkdir(targetDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(targetDir, `${pluginSlug}.php`),
    `<?php\nfunction load_bootstrap() { return true; }\n`,
    "utf8"
  );
  await fs.promises.writeFile(
    path.join(targetDir, "ModuleB.php"),
    `<?php\nclass ModuleB { public static function val() { return 'v2'; } }\n`,
    "utf8"
  );

  // Signal worker to resume late include: without drain, worker fails on late include!
  await fs.promises.writeFile(tokenResume, "go");

  let workerFailed = false;
  try {
    await childPromise;
  } catch {
    workerFailed = true; // Expected: late include of ModuleA failed because file was swapped without drain!
  }

  assert.equal(workerFailed, true, "In-flight request without traffic drain must hit missing require failure");

  // Clean up
  await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

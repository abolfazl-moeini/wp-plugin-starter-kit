#!/usr/bin/env node
/**
 * CLI wrapper for atomic production deployment of standalone plugin ZIPs.
 * Implements the sibling-staging extraction and atomic rename procedure
 * to guarantee zero transient incomplete-tree Fatal errors.
 * 
 * Usage:
 *   node deploy-standalone-plugin.mjs <path-to-zip> [plugin-slug] [options]
 * 
 * Options:
 *   --plugins-dir=<dir>    Target wp-content/plugins directory
 *   --content-root=<dir>   WordPress wp-content root directory
 *   --bootstrap=<file>     Main bootstrap file (default: <plugin-slug>.php)
 *   --keep-backup          Preserve backup directory after success
 */

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runDirectDeployTransaction } from "./build-all-standalone-plugins.mjs";
import { resolveContentRoot } from "./resolve-content-root.mjs";
import { readZipEntries } from "./canonical-artifact-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function parseDeployArgs(argv = process.argv.slice(2)) {
  let zipPath = null;
  let pluginSlug = null;
  const options = {
    pluginsDir: null,
    contentRoot: null,
    bootstrapFile: null,
    preserveBackup: false,
    healthUrl: null,
    healthToken: null,
  };

  for (const arg of argv) {
    if (arg === "--keep-backup") {
      options.preserveBackup = true;
    } else if (arg.startsWith("--plugins-dir=")) {
      const val = arg.slice("--plugins-dir=".length);
      if (!val) throw new Error("Value for --plugins-dir cannot be empty");
      options.pluginsDir = path.resolve(val);
    } else if (arg.startsWith("--content-root=")) {
      const val = arg.slice("--content-root=".length);
      if (!val) throw new Error("Value for --content-root cannot be empty");
      options.contentRoot = path.resolve(val);
    } else if (arg.startsWith("--bootstrap=")) {
      const val = arg.slice("--bootstrap=".length);
      if (!val) throw new Error("Value for --bootstrap cannot be empty");
      if (path.isAbsolute(val) || val.includes("..") || val.includes("\\") || val.includes("\0") || /^[a-zA-Z]:/.test(val)) {
        throw new Error(`Invalid bootstrap path '${val}': must be relative within target root`);
      }
      options.bootstrapFile = val;
    } else if (arg.startsWith("--health-url=")) {
      const val = arg.slice("--health-url=".length).trim();
      if (!val) throw new Error("Value for --health-url cannot be empty");
      options.healthUrl = val;
    } else if (arg.startsWith("--health-token=")) {
      const val = arg.slice("--health-token=".length).trim();
      if (!val) throw new Error("Value for --health-token cannot be empty");
      options.healthToken = val;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option '${arg}'`);
    } else {
      if (!zipPath) {
        zipPath = path.resolve(arg);
      } else if (!pluginSlug) {
        const candidate = arg.trim();
        if (!/^[a-z0-9_-]+$/i.test(candidate) || candidate.includes("/") || candidate.includes("\\") || candidate === "." || candidate === "..") {
          throw new Error(`Invalid plugin slug '${candidate}': must be a single safe path segment`);
        }
        pluginSlug = candidate;
      } else {
        throw new Error(`Unexpected extra argument '${arg}'`);
      }
    }
  }

  return { zipPath, pluginSlug, options };
}

export async function executeWebRuntimeHealthCheck({
  healthUrl,
  healthToken = null,
  timeoutMs = 5000,
  pluginSlug = null,
}) {
  if (!healthUrl) return { passed: true, reason: "No health URL configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "WPDev-Deploy-HealthCheck/1.0",
        "Cache-Control": "no-cache",
        ...(healthToken ? { "X-WPDev-Health-Token": healthToken } : {}),
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location") || "";
      if (loc.includes("wp-login.php") || loc.includes("/login")) {
        throw new Error(`Web health check redirected to login page: ${loc}`);
      }
      throw new Error(`Web health check redirected (HTTP ${res.status}): ${loc}`);
    }
    if (!res.ok) {
      throw new Error(`Web health check failed: HTTP ${res.status} ${res.statusText}`);
    }
    const body = await res.text();
    if (body.includes("Fatal error") || body.includes("There has been a critical error on this website")) {
      throw new Error("Web health check response contains WordPress fatal error message");
    }
    if (healthToken && !body.includes(healthToken) && !res.headers.get("x-wpdev-health-token")) {
      throw new Error("Web health check response did not match expected health token");
    }
    return { passed: true, status: res.status, url: res.url };
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Web health check timed out after ${timeoutMs}ms`);
    }
    if (err.message && err.message.startsWith("Web health check")) {
      throw err;
    }
    throw new Error(`Web health check failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function runDeployCli(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseDeployArgs(argv);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
  const { zipPath, pluginSlug: explicitSlug, options } = parsed;

  if (!zipPath) {
    console.error("Error: Path to plugin ZIP archive is required.");
    console.error("Usage: node deploy-standalone-plugin.mjs <path-to-zip> [plugin-slug] [options]");
    return 1;
  }

  if (!existsSync(zipPath)) {
    console.error(`Error: Plugin ZIP not found at '${zipPath}'`);
    return 1;
  }

  // Infer plugin slug if not explicitly passed
  let pluginSlug = explicitSlug;
  if (!pluginSlug) {
    const baseName = path.basename(zipPath);
    const matched = baseName.match(/^([a-z0-9_-]+?)(?:-profile-[as])?\.zip$/i);
    if (matched) {
      pluginSlug = matched[1];
    } else {
      // Try to read root directory from ZIP
      try {
        const zipBytes = await fs.readFile(zipPath);
        const entries = readZipEntries(zipBytes);
        const firstEntry = entries[0]?.name || "";
        const slashIdx = firstEntry.indexOf("/");
        if (slashIdx > 0) {
          pluginSlug = firstEntry.slice(0, slashIdx);
        }
      } catch {
        // Ignored
      }
    }
  }

  if (!pluginSlug) {
    console.error("Error: Could not determine plugin slug. Please specify it as the second argument.");
    return 1;
  }

  const pluginsDir = options.pluginsDir
    ? path.resolve(options.pluginsDir)
    : options.contentRoot
      ? path.join(path.resolve(options.contentRoot), "plugins")
      : path.join(resolveContentRoot({ scriptDir: __dirname }), "plugins");

  const contentRoot = options.contentRoot
    ? path.resolve(options.contentRoot)
    : options.pluginsDir
      ? path.dirname(path.resolve(options.pluginsDir))
      : resolveContentRoot({ scriptDir: __dirname });

  console.log(`\n🚀 Starting atomic deployment for '${pluginSlug}'...`);
  console.log(`   Archive:      ${zipPath}`);
  console.log(`   Plugins Dir:  ${pluginsDir}`);
  console.log(`   Content Root: ${contentRoot}\n`);

  const startTime = Date.now();

  try {
    const result = await runDirectDeployTransaction({
      zipPath,
      pluginSlug,
      options: {
        ...options,
        contentRoot,
        pluginsDir,
        healthCheck: async (deployedTargetDir) => {
          if (options.healthUrl) {
            console.log(`  [3b/4] Verifying web runtime health at ${options.healthUrl}...`);
            await executeWebRuntimeHealthCheck({
              healthUrl: options.healthUrl,
              healthToken: options.healthToken,
              pluginSlug,
            });
            console.log("  [3b/4] Web runtime health check verified 100% OK!");
          }
        },
        onPhaseChange: async (phase) => {
          switch (phase) {
            case "backup_rename_intent":
              console.log("  [1/4] Moving existing plugin to backup...");
              break;
            case "candidate_swap_intent":
              console.log("  [2/4] Swapping staged candidate into target...");
              break;
            case "target_verification_intent":
              console.log("  [3/4] Verifying deployed tree integrity and syntax...");
              break;
            case "target_verified":
              console.log("  [4/4] Verification successful, cleaning up temporary staging...");
              break;
          }
        },
      },
    });

    const elapsed = Date.now() - startTime;
    console.log(`\n✅ Deployment successful in ${elapsed}ms!`);
    console.log(`   Target: ${result.deployedTargetDir}`);
    if (result.backupDir) {
      console.log(`   Backup preserved: ${result.backupDir}`);
    }
    return 0;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`\n❌ Deployment FAILED after ${elapsed}ms: ${err.message}`);
    if (err.rollbackError) {
      console.error("   EMERGENCY: Rollback failed. Target state is unverified and backup is preserved.");
    } else {
      console.error("   Target plugin directory was protected or restored to previous backup.");
    }
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDeployCli().then((code) => {
    process.exit(code);
  });
}

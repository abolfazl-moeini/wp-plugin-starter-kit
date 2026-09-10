#!/usr/bin/env node
/**
 * npm `release` entry: unit/e2e gate → optional `npm run build` → pack dist.
 *
 * Composer `release:dist` still calls prepare-release.js directly (no asset
 * build). Bypass tests with --skip-tests or WPDEV_SKIP_TESTS=1.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { prepareRelease } from "./prepare-release.js";
import { gateReleaseTests } from "./releaseTests.js";

export function parseArgs(argv) {
  const opts = {
    out: "dist",
    skipComposer: false,
    skipRector: false,
    skipZip: false,
    skipTests: false,
    candidate: false,
    obfuscate: false,
    profile: "clean",
    root: process.cwd(),
  };
  const selectedProfiles = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skip-composer") opts.skipComposer = true;
    else if (arg === "--skip-rector") opts.skipRector = true;
    else if (arg === "--skip-zip") opts.skipZip = true;
    else if (arg === "--skip-tests") opts.skipTests = true;
    else if (arg === "--candidate") opts.candidate = true;
    else if (arg === "--obfuscate") {
      selectedProfiles.push("s");
    } else if (arg === "--profile") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("Invalid --profile: a value is required (s or clean)");
      }
      const val = next.trim().toLowerCase();
      if (val !== "s" && val !== "clean") {
        throw new Error(`Invalid --profile '${val}'. Allowed: s, clean`);
      }
      selectedProfiles.push(val);
      i++;
    } else if (arg === "--profile=") {
      throw new Error("Invalid --profile: a value is required (s or clean)");
    } else if (typeof arg === "string" && arg.startsWith("--profile=")) {
      const val = arg.slice("--profile=".length).trim().toLowerCase();
      if (val !== "s" && val !== "clean") {
        throw new Error(`Invalid --profile '${val}'. Allowed: s, clean`);
      }
      selectedProfiles.push(val);
    } else if (typeof arg === "string" && arg.startsWith("--out=")) {
      opts.out = arg.slice("--out=".length);
    } else if (typeof arg === "string" && arg.startsWith("--root=")) {
      opts.root = path.resolve(arg.slice("--root=".length));
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    }
  }
  const unique = [...new Set(selectedProfiles)];
  if (unique.length > 1) {
    throw new Error(`Conflicting profile flags: ${unique.join(", ")}`);
  }
  if (unique.length === 1) {
    opts.profile = unique[0];
    opts.obfuscate = unique[0] === "s";
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`Usage: node run-release.js [options]

Run pre-dist tests, then npm run build (if defined), then package dist/.

Options match prepare-release.js (--skip-tests, --skip-zip, …).

--candidate  Emit a deterministic, review-only candidate report. It never builds,
             mutates the registry, promotes an artifact, or creates a ZIP.
`);
}

function createCandidateReport(root) {
  const files = [
    "config/protection-artifact-registry.json",
    "config/protection-artifact-registry-proposals.json",
  ];
  return {
    mode: "candidate",
    reviewOnly: true,
    promotionReady: false,
    buildInput: false,
    registryMutated: false,
    zipCreated: false,
    root,
    inputs: files.map((relativePath) => {
      const absolutePath = path.join(root, relativePath);
      return {
        path: relativePath,
        present: existsSync(absolutePath),
        bytes: existsSync(absolutePath) ? statSync(absolutePath).size : null,
      };
    }),
    blockers: [
      "candidate report is not an approval or immutable artifact record",
      "exact source, tool, and artifact digests remain required before promotion",
    ],
  };
}

function runNpmBuild(root) {
  const pkgPath = path.join(root, "package.json");
  if (!existsSync(pkgPath)) return { skipped: true };
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return { skipped: true };
  }
  if (!pkg?.scripts || typeof pkg.scripts.build !== "string") {
    return { skipped: true };
  }

  process.stderr.write("release: running npm run build…\n");
  const result = spawnSync("npm", ["run", "build"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    env: process.env,
    stdio: "inherit",
  });
  const status =
    result && typeof result.status === "number" ? result.status : 1;
  if (status !== 0) {
    throw new Error(`npm run build failed (exit ${status})`);
  }
  return { skipped: false };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const root = path.resolve(opts.root);
  if (opts.candidate) {
    process.stdout.write(
      `${JSON.stringify(createCandidateReport(root), null, 2)}\n`,
    );
    return;
  }
  gateReleaseTests(root, { skipTests: opts.skipTests });
  runNpmBuild(root);

  const result = await prepareRelease({
    ...opts,
    root,
    skipTests: true,
  });
  process.stdout.write(`Release package ready: ${result.distRoot}\n`);
  if (result.zipPath) {
    process.stdout.write(`Release zip ready: ${result.zipPath}\n`);
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isDirect =
  entry.endsWith(`${path.sep}run-release.js`) ||
  entry.endsWith("/run-release.js") ||
  entry.endsWith("run-release.js");

if (isDirect) {
  main().catch((err) => {
    process.stderr.write(
      `run-release failed: ${err && err.message ? err.message : err}\n`,
    );
    process.exit(1);
  });
}

export { createCandidateReport, runNpmBuild };

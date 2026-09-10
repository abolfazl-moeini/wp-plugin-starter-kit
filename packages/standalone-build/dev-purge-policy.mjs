import fs from "node:fs";
import { copyFile, lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

export const ROOT_DEV_DIRS = new Set([
  "dist",
  "build",
  "tests",
  "unit-tests",
  "dev",
  "docs",
  "packages",
  "artifacts",
  "bin",
  "docker-phpunit",
  "coverage",
  ".git",
  ".github",
  ".husky",
  ".idea",
  ".vscode",
  ".cursor",
  ".kiro",
  ".claude"
]);

export const VENDOR_DEV_DIRS = new Set([
  "rector",
  "phpunit",
  "phpstan",
  "mockery",
  "squizlabs",
  "dealerdirect",
  "wp-coding-standards",
  "bin",
  "plugin-core-test",
  "wc-core-test",
  "framework",
  "yoast",
  "sebastian",
  "phar-io",
  "theseer",
  "myclabs",
  "doctrine",
  "nikic",
  ".git",
  ".github"
]);

export const FORBIDDEN_FILE_EXTENSIONS = new Set([
  ".map",
  ".dist",
  ".yaml",
  ".yml",
  ".neon",
  ".sh",
  ".stub",
  ".bak",
  ".log"
]);

export const FORBIDDEN_CONFIG_FILES = new Set([
  "package.json",
  "package-lock.json",
  "release-manifest.json",
  "composer.json",
  "composer.lock",
  "tsconfig.json",
  ".editorconfig",
  ".gitignore",
  ".gitattributes"
]);

export const FORBIDDEN_CONFIG_PREFIXES = [
  "postcss.config.",
  "commitlint.config.",
  "rector.",
  "phpstan.",
  "phpunit.",
  "jest.config."
];

/**
 * Evaluates whether a directory should be purged based on deterministic policy.
 * 
 * Policy rules:
 * 1. Root-level dev directories (tests, unit-tests, dev, docs, .git, etc.) are purged when isRoot === true.
 * 2. Nested directories inside src/, inc/, includes/, classes/, or FrameworkClosure/ are NEVER purged
 *    regardless of their name (e.g. Tests, Test, Testing, Docs, Dev in any case).
 * 3. Inside vendor/, dev tool directories (phpunit, phpstan, rector, etc.) are purged.
 * 4. Hidden metadata directories (.git, .github, .idea, .vscode, .cursor, .claude) are purged at any depth.
 */
export function shouldPurgeDirectory(relPath, isRoot, dirName) {
  const lowerName = dirName.toLowerCase();
  const normalizedRel = relPath.replace(/\\/g, "/");

  if (lowerName.startsWith(".")) {
    return true;
  }

  if (isRoot) {
    return ROOT_DEV_DIRS.has(lowerName);
  }

  // Check if inside a protected production source tree
  const isInsideProductionSource = (
    normalizedRel.startsWith("src/") ||
    normalizedRel === "src" ||
    normalizedRel.startsWith("inc/") ||
    normalizedRel === "inc" ||
    normalizedRel.startsWith("includes/") ||
    normalizedRel === "includes" ||
    normalizedRel.startsWith("classes/") ||
    normalizedRel === "classes" ||
    normalizedRel.startsWith("FrameworkClosure/") ||
    normalizedRel === "FrameworkClosure" ||
    normalizedRel.includes("/src/") ||
    normalizedRel.includes("/inc/") ||
    normalizedRel.includes("/FrameworkClosure/")
  );

  if (isInsideProductionSource) {
    return false;
  }

  // In vendor directories
  if (normalizedRel.startsWith("vendor/") || normalizedRel.includes("/vendor/")) {
    if (lowerName === "tests" || lowerName === "test" || lowerName === "unit-tests" || lowerName === "unit" || lowerName === "docs" || lowerName === "doc") {
      return true;
    }
    return VENDOR_DEV_DIRS.has(lowerName);
  }

  return false;
}

/**
 * Evaluates whether a file should be purged or migrated.
 */
export function shouldPurgeFile(relPath, fileName) {
  const lowerName = fileName.toLowerCase();

  if (lowerName === "wpdev.json") {
    return { purge: true, action: "migrate_config" };
  }

  if (lowerName.startsWith(".") && lowerName !== ".htaccess") {
    return { purge: true, action: "delete" };
  }

  if (lowerName.endsWith(".md")) {
    if (lowerName.includes("license") || lowerName.includes("notice")) {
      return { purge: false, action: "keep" };
    }
    return { purge: true, action: "delete" };
  }

  for (const ext of FORBIDDEN_FILE_EXTENSIONS) {
    if (lowerName.endsWith(ext)) {
      return { purge: true, action: "delete" };
    }
  }

  if (FORBIDDEN_CONFIG_FILES.has(lowerName)) {
    return { purge: true, action: "delete" };
  }

  for (const prefix of FORBIDDEN_CONFIG_PREFIXES) {
    if (lowerName.startsWith(prefix)) {
      return { purge: true, action: "delete" };
    }
  }

  return { purge: false, action: "keep" };
}

/**
 * Recursively purges development files and directories using the deterministic policy.
 */
export async function purgeDevelopmentTree(dir, consumer = "", rootDir = null) {
  const actualRoot = rootDir || dir;
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(actualRoot, fullPath);
    const isRoot = dir === actualRoot;

    // Check for symlinks - reject symlinks
    const stat = await lstat(fullPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symbolic link rejected in staging: ${relPath}`);
    }

    if (entry.isDirectory()) {
      if (shouldPurgeDirectory(relPath, isRoot, entry.name)) {
        await rm(fullPath, { recursive: true, force: true });
      } else {
        await purgeDevelopmentTree(fullPath, consumer, actualRoot);
      }
    } else if (entry.isFile()) {
      const decision = shouldPurgeFile(relPath, entry.name);
      if (decision.purge) {
        if (decision.action === "migrate_config") {
          const configPath = path.join(dir, "project.config.json");
          if (!fs.existsSync(configPath)) {
            await copyFile(fullPath, configPath);
          }
        }
        await rm(fullPath, { force: true });
      }
    }
  }
}

/**
 * Returns root-anchored rsync exclude arguments.
 */
export function getRsyncExcludeArgs() {
  return [
    "--exclude=/node_modules",
    "--exclude=/.git",
    "--exclude=/dist",
    "--exclude=/build",
    "--exclude=/tests",
    "--exclude=/unit-tests",
    "--exclude=/dev",
    "--exclude=/docs",
    "--exclude=/coverage",
    "--exclude=/artifacts",
    "--exclude=/bin",
    "--exclude=/packages",
    "--exclude=/docker-phpunit"
  ];
}

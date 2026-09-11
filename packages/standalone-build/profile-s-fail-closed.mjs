/**
 * Fail-closed Profile S gates shared by the assembler and CLI parsers.
 *
 * Profile S must not ship a ZIP after a skipped Rector pass, invalid transformer
 * JSON, or an unknown protection profile.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ALLOWED_BUILD_PROFILES = new Set(["s", "clean"]);

const REQUIRED_BUILD_TOOLS = [
  ["php", ["-v"]],
  ["zip", ["-v"]],
  ["unzip", ["-v"]],
  ["rsync", ["--version"]],
  ["composer", ["--version"]],
];

// Remediation hints for the toolchain preflight. Without these, a missing binary surfaces as a
// bare `spawn composer ENOENT`, which reads like a pipeline bug rather than a missing
// prerequisite — and it does so from five different test files at once.
const TOOLCHAIN_HINTS = {
  php: "install PHP and put it on PATH, or pass --php-bin / set WPDEV_PHP_BIN",
  zip: "install the `zip` CLI (e.g. `brew install zip`)",
  unzip: "install the `unzip` CLI",
  rsync: "install `rsync`",
  composer: "install Composer (https://getcomposer.org/download/) and put it on PATH",
};

function describeToolchainFailure(command, err) {
  const message = String(err?.message || err || "");
  const notFound = err?.code === "ENOENT" || /ENOENT/.test(message);
  const hint = TOOLCHAIN_HINTS[command] || "install it and ensure it is on PATH";
  return notFound
    ? `${command} is not installed or not on PATH (${hint})`
    : `${command} failed to execute: ${message} (${hint})`;
}

function readArgValue(argv, index, flag) {
  const arg = argv[index];
  if (arg === flag) {
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Invalid ${flag}: a value is required`);
    }
    return { value: next, consumed: 1 };
  }
  if (arg === `${flag}=`) {
    throw new Error(`Invalid ${flag}: a value is required`);
  }
  if (typeof arg === "string" && arg.startsWith(`${flag}=`)) {
    return { value: arg.slice(`${flag}=`.length), consumed: 0 };
  }
  return null;
}

export function parseClosedProfileFlags(argv = []) {
  const selected = [];
  let inlineFramework;
  let spaghetti;
  let minifyAssets;
  let skipZip = false;
  let targetPhp;
  let phpBin;
  let enforceTargetPhp;
  let sawObfuscateFlag = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--obfuscate") {
      sawObfuscateFlag = true;
      continue;
    }
    if (arg === "--inline-framework") {
      inlineFramework = true;
      continue;
    }
    if (arg === "--no-inline-framework") {
      inlineFramework = false;
      continue;
    }
    if (arg === "--spaghetti") {
      spaghetti = true;
      continue;
    }
    if (arg === "--no-spaghetti") {
      spaghetti = false;
      continue;
    }
    if (arg === "--minify-assets") {
      minifyAssets = true;
      continue;
    }
    if (arg === "--no-minify-assets") {
      minifyAssets = false;
      continue;
    }
    if (arg === "--skip-zip") {
      skipZip = true;
      continue;
    }
    const targetPhpArg = readArgValue(argv, i, "--target-php");
    if (targetPhpArg) {
      targetPhp = String(targetPhpArg.value).trim();
      i += targetPhpArg.consumed;
      continue;
    }
    const phpBinArg = readArgValue(argv, i, "--php-bin");
    if (phpBinArg) {
      phpBin = String(phpBinArg.value).trim();
      i += phpBinArg.consumed;
      continue;
    }
    if (arg === "--enforce-target-php") {
      enforceTargetPhp = true;
      continue;
    }
    if (arg === "--no-enforce-target-php") {
      enforceTargetPhp = false;
      continue;
    }
    if (arg === "--profile") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("Invalid --profile: a value is required (s or clean)");
      }
      const value = next.trim().toLowerCase();
      if (!ALLOWED_BUILD_PROFILES.has(value)) {
        throw new Error(
          `Invalid --profile '${value}'. Allowed: ${Array.from(ALLOWED_BUILD_PROFILES).join(", ")}`,
        );
      }
      selected.push(value);
      i++;
      continue;
    }
    if (arg === "--profile=") {
      throw new Error("Invalid --profile: a value is required (s or clean)");
    }
    if (typeof arg === "string" && arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length).trim().toLowerCase();
      if (!ALLOWED_BUILD_PROFILES.has(value)) {
        throw new Error(
          `Invalid --profile '${value}'. Allowed: ${Array.from(ALLOWED_BUILD_PROFILES).join(", ")}`,
        );
      }
      selected.push(value);
    }
  }
  const hasIndependentCapability = inlineFramework !== undefined || spaghetti !== undefined;
  if (sawObfuscateFlag && !hasIndependentCapability) {
    selected.push("s");
  }
  const unique = [...new Set(selected)];
  if (unique.length > 1) {
    throw new Error(`Conflicting profile flags: ${unique.join(", ")}`);
  }

  const legacyProfile = unique[0] || (hasIndependentCapability ? null : "clean");

  if (hasIndependentCapability) {
    const obfuscate = Boolean(sawObfuscateFlag || legacyProfile === "s");
    if (legacyProfile === "clean" && (obfuscate || spaghetti === true)) {
      throw new Error("Conflicting profile flags: clean, s");
    }
    const inlineResolved = inlineFramework ?? (legacyProfile === "s" ? true : false);
    const spaghettiResolved = spaghetti ?? (legacyProfile === "s" ? true : false);
    return {
      profile: legacyProfile || "custom",
      isObfuscate: obfuscate,
      inlineFramework: Boolean(inlineResolved),
      spaghetti: Boolean(spaghettiResolved),
      obfuscate,
      minifyAssets,
      skipZip,
      targetPhp,
      phpBin,
      enforceTargetPhp,
    };
  }

  const profile = legacyProfile || "clean";
  return {
    profile,
    isObfuscate: profile === "s",
    inlineFramework: profile === "s" || profile === "clean" ? true : false,
    spaghetti: profile === "s",
    obfuscate: profile === "s",
    minifyAssets: minifyAssets ?? (profile === "s"),
    skipZip,
    targetPhp,
    phpBin,
    enforceTargetPhp,
  };
}

export function requireRectorForProfileS({ rectorBin, rectorConfig }) {
  const missing = [];
  if (!rectorBin || !fs.existsSync(rectorBin)) missing.push(rectorBin || "vendor/bin/rector");
  if (!rectorConfig || !fs.existsSync(rectorConfig)) missing.push(rectorConfig || "rector-downgrade-php74.php");
  if (missing.length > 0) {
    throw new Error(
      `Profile S requires Rector PHP 7.4 downgrade (missing ${missing.join(", ")})`,
    );
  }
  return { rectorBin, rectorConfig };
}

export function collectFirstPartyPhpFiles(rootDir) {
  const skipDirs = new Set(["vendor", "vendor-prefixed", "node_modules", ".git"]);
  const files = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".php")) {
        files.push(full);
      }
    }
  }

  walk(rootDir);
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function parseTransformerBatchLog(stdout, { expectedFiles = null } = {}) {
  const parsed = extractJsonArray(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("transformer --batch JSON must be an array of file records");
  }
  for (const rec of parsed) {
    if (!rec || typeof rec !== "object" || Array.isArray(rec) || typeof rec.file !== "string" || rec.file.length === 0) {
      throw new Error("transformer --batch record missing file path");
    }
    // F11: a record without a verified content hash and byte count proves
    // nothing about the write. Forged/truncated entries must fail closed.
    if (typeof rec.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(rec.sha256)) {
      throw new Error(`transformer --batch record for '${rec.file}' is missing a valid sha256 digest`);
    }
    if (!Number.isSafeInteger(rec.bytes) || rec.bytes <= 0) {
      throw new Error(`transformer --batch record for '${rec.file}' is missing a valid byte count`);
    }
  }

  if (Array.isArray(expectedFiles)) {
    const got = new Set(parsed.map((rec) => path.resolve(rec.file)));
    const missing = expectedFiles.filter((file) => !got.has(path.resolve(file)));
    if (missing.length > 0) {
      throw new Error(
        `transformer --batch omitted ${missing.length} PHP file(s), e.g. ${missing[0]}`,
      );
    }
    if (parsed.length !== expectedFiles.length) {
      throw new Error(
        `transformer --batch record count ${parsed.length} !== expected ${expectedFiles.length}`,
      );
    }
  } else if (parsed.length === 0) {
    throw new Error("transformer --batch JSON array is empty");
  }

  return parsed;
}

function extractJsonArray(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) {
    throw new Error("transformer --batch produced empty stdout");
  }
  try {
    return JSON.parse(trimmed);
  } catch (first) {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new Error(`transformer --batch did not emit valid JSON: ${first.message}`);
  }
}

export const CRITICAL_ELIGIBILITY_PATTERNS = new Set([
  "eval",
  "create_function",
  "string_assert",
  "preg_replace_e",
]);

export function assertEligibilityAllowsObfuscation(eligibility) {
  const patterns = Array.isArray(eligibility?.forbiddenPatterns) ? eligibility.forbiddenPatterns : [];
  const critical = patterns.filter((item) => CRITICAL_ELIGIBILITY_PATTERNS.has(item.pattern));
  if (critical.length > 0) {
    throw new Error(`Critical security violation in eligibility spike: ${JSON.stringify(critical)}`);
  }
  return patterns;
}

export function assertSymbolMapHasNoCollisions(symMap, options = {}) {
  if (!symMap || typeof symMap !== "object" || Array.isArray(symMap)) {
    throw new Error("symbol map must be an object");
  }
  const checkFlattenCollisions = Boolean(
    options.checkFlattenCollisions ??
    options.flattenNamespaces ??
    options.spaghetti ??
    options.buildPlan?.capabilities?.spaghetti ??
    false
  );
  const symbolPaths = options.symbolPaths || symMap.symbolPaths || symMap.__symbolPaths || {};
  const classesMeta = options.classesMeta || symMap.classes_meta || symMap.__classes_meta || {};
  const declarations = Array.isArray(options.declarations)
    ? options.declarations
    : Array.isArray(symMap.declarations)
      ? symMap.declarations
      : null;
  const retainedNamespaces = new Set(
    Array.isArray(options.retainedNamespaces)
      ? options.retainedNamespaces
      : Array.isArray(symMap.retained_namespaces)
        ? symMap.retained_namespaces
        : (symMap.retained_namespaces && typeof symMap.retained_namespaces === "object")
          ? Object.keys(symMap.retained_namespaces)
          : []
  );

  let totalChecked = 0;

  // 1. If typed declaration records are provided, validate declaration-level collision gate (V3-04)
  if (declarations && declarations.length > 0) {
    const declsByCategoryAndDest = {
      classes: new Map(),
      functions: new Map(),
      constants: new Map(),
    };

    for (const decl of declarations) {
      const fqcn = String(decl.fqcn || decl.symbol || "").trim();
      if (!fqcn) continue;
      const isAlias = Boolean(decl.isAlias ?? decl.is_alias ?? false);
      const isGlobal = Boolean(
        decl.isGlobal ??
        decl.is_global ??
        (!decl.namespace && !fqcn.includes("\\"))
      );
      const ns = decl.namespace !== undefined
        ? String(decl.namespace || "").trim()
        : (fqcn.includes("\\") ? fqcn.slice(0, fqcn.lastIndexOf("\\")) : "");
      const shortName = String(
        decl.name || (fqcn.includes("\\") ? fqcn.slice(fqcn.lastIndexOf("\\") + 1) : fqcn)
      ).trim();
      const kind = String(decl.kind || "class").toLowerCase();

      let category = "classes";
      if (kind === "function") {
        category = "functions";
      } else if (kind === "constant") {
        category = "constants";
      }
      const caseInsensitive = category === "classes" || category === "functions";

      // Compute effective destination if not explicit
      let dest = decl.effectiveDestination;
      if (!dest) {
        const table = (symMap[category] && typeof symMap[category] === "object") ? symMap[category] : {};
        const isFlattened = checkFlattenCollisions && (!ns || !retainedNamespaces.has(ns));
        if (isFlattened) {
          if (table[fqcn]) {
            const mapped = String(table[fqcn]).replace(/^\\/, "");
            dest = mapped.includes("\\") ? mapped.slice(mapped.lastIndexOf("\\") + 1) : mapped;
          } else {
            dest = shortName;
          }
        } else {
          if (table[fqcn]) {
            dest = String(table[fqcn]).replace(/^\\/, "");
          } else {
            dest = fqcn;
          }
        }
      }

      if (!isAlias) {
        const destKey = caseInsensitive ? dest.toLowerCase() : dest;
        const categoryMap = declsByCategoryAndDest[category];

        if (categoryMap.has(destKey)) {
          const existing = categoryMap.get(destKey);
          const existingPath = existing.file
            ? `${existing.fqcn} (${existing.file}${existing.line ? `:${existing.line}` : ""})`
            : (symbolPaths[existing.fqcn] ? `${existing.fqcn} (${symbolPaths[existing.fqcn]})` : existing.fqcn);
          const currentPath = decl.file
            ? `${fqcn} (${decl.file}${decl.line ? `:${decl.line}` : ""})`
            : (symbolPaths[fqcn] ? `${fqcn} (${symbolPaths[fqcn]})` : fqcn);

          const reason = checkFlattenCollisions ? "under namespace flattening" : "under symbol mapping";
          const existingDesc = existing.isGlobal ? "global" : "namespaced";
          const currentDesc = isGlobal ? "global" : "namespaced";

          throw new Error(
            `symbol map collision in ${category}: ${existingDesc} declaration '${existing.fqcn}' and ${currentDesc} declaration '${fqcn}' collide on effective destination '${dest}' ${reason}: [${existingPath}, ${currentPath}]`
          );
        }
        categoryMap.set(destKey, { ...decl, fqcn, isGlobal, file: decl.file, line: decl.line });
      }
      totalChecked++;
    }
  }

  // 2. Validate section tables (classes, functions, constants)
  for (const section of ["classes", "functions", "constants"]) {
    const table = symMap[section] && typeof symMap[section] === "object" ? symMap[section] : {};
    const fqcnsByMangled = new Map();
    const globalsByMangled = new Map();
    const shortNamesToFqcns = new Map();
    const caseInsensitive = section === "classes" || section === "functions";

    // First pass: register all FQCNs (containing backslash)
    for (const [symbol, rawMangled] of Object.entries(table)) {
      if (typeof symbol !== "string" || symbol.startsWith("\\")) continue;
      const mangled = String(rawMangled || "").replace(/^\\/, "");
      if (!mangled) continue;

      if (symbol.includes("\\")) {
        const mangledKey = caseInsensitive ? mangled.toLowerCase() : mangled;
        if (fqcnsByMangled.has(mangledKey)) {
          const existing = fqcnsByMangled.get(mangledKey);
          const isSameSymbol = caseInsensitive
            ? existing.toLowerCase() === symbol.toLowerCase()
            : existing === symbol;
          if (!isSameSymbol) {
            throw new Error(
              `symbol map collision in ${section}: ${existing} and ${symbol} both mangle to ${mangled}`,
            );
          }
        }
        fqcnsByMangled.set(mangledKey, symbol);

        const shortName = symbol.slice(symbol.lastIndexOf("\\") + 1);
        const shortKey = caseInsensitive ? shortName.toLowerCase() : shortName;
        if (!shortNamesToFqcns.has(shortKey)) {
          shortNamesToFqcns.set(shortKey, []);
        }
        shortNamesToFqcns.get(shortKey).push(symbol);
        totalChecked++;
      }
    }

    // C1 Gate: Check short-name collisions across distinct FQCNs under namespace flattening
    if (checkFlattenCollisions) {
      for (const [shortKey, fqcns] of shortNamesToFqcns.entries()) {
        if (fqcns.length > 1) {
          const pathDetails = fqcns
            .map((s) => (symbolPaths[s] ? `${s} (${symbolPaths[s]})` : s))
            .join(", ");
          throw new Error(
            `symbol map collision in ${section}: short-name collision under namespace flattening: '${shortKey}' is shared by multiple FQCNs: [${pathDetails}]`,
          );
        }
      }
    }

    // Second pass: register short names and globals (no backslash)
    for (const [symbol, rawMangled] of Object.entries(table)) {
      if (typeof symbol !== "string" || symbol.startsWith("\\") || symbol.includes("\\")) continue;
      const mangled = String(rawMangled || "").replace(/^\\/, "");
      if (!mangled) continue;

      const mangledKey = caseInsensitive ? mangled.toLowerCase() : mangled;
      const shortKey = caseInsensitive ? symbol.toLowerCase() : symbol;

      const fqcnsForShort = shortNamesToFqcns.get(shortKey) || [];
      if (fqcnsForShort.length > 1) {
        const pathDetails = fqcnsForShort
          .map((s) => (symbolPaths[s] ? `${s} (${symbolPaths[s]})` : s))
          .join(", ");
        throw new Error(
          `symbol map collision in ${section}: ambiguous short name '${symbol}' belongs to multiple FQCNs and cannot be mapped${pathDetails ? ` (colliding: ${pathDetails})` : ""}`,
        );
      }

      if (fqcnsByMangled.has(mangledKey)) {
        const fqcn = fqcnsByMangled.get(mangledKey);
        const fqcnShort = fqcn.slice(fqcn.lastIndexOf("\\") + 1);
        const matchesShort = caseInsensitive
          ? fqcnShort.toLowerCase() === symbol.toLowerCase()
          : fqcnShort === symbol;
        if (!matchesShort) {
          throw new Error(
            `symbol map collision in ${section}: ${fqcn} and ${symbol} both mangle to ${mangled}`,
          );
        }
        // V3-04: Check if symbol is a distinct declaration rather than a short alias
        const isDistinctDeclaration = Boolean(
          (symbolPaths[symbol] && symbolPaths[fqcn] && symbolPaths[symbol] !== symbolPaths[fqcn]) ||
          (classesMeta[symbol] && classesMeta[fqcn])
        );
        if (isDistinctDeclaration && checkFlattenCollisions) {
          const path1 = symbolPaths[fqcn] ? `${fqcn} (${symbolPaths[fqcn]})` : fqcn;
          const path2 = symbolPaths[symbol] ? `${symbol} (${symbolPaths[symbol]})` : symbol;
          throw new Error(
            `symbol map collision in ${section}: global declaration '${symbol}' collides with namespaced declaration '${fqcn}' under namespace flattening: [${path2}, ${path1}]`,
          );
        }
        if (isDistinctDeclaration) {
          totalChecked++;
        }
      } else {
        if (checkFlattenCollisions && shortNamesToFqcns.has(shortKey)) {
          const collidingFqcns = shortNamesToFqcns.get(shortKey) || [];
          const isDistinctDeclaration = Boolean(
            (symbolPaths[symbol] && collidingFqcns.some((f) => symbolPaths[f] && symbolPaths[f] !== symbolPaths[symbol])) ||
            classesMeta[symbol]
          );
          if (isDistinctDeclaration) {
            const path1 = symbolPaths[collidingFqcns[0]] ? `${collidingFqcns[0]} (${symbolPaths[collidingFqcns[0]]})` : collidingFqcns[0];
            const path2 = symbolPaths[symbol] ? `${symbol} (${symbolPaths[symbol]})` : symbol;
            throw new Error(
              `symbol map collision in ${section}: global declaration '${symbol}' collides with namespaced declaration '${collidingFqcns[0]}' under namespace flattening: [${path2}, ${path1}]`,
            );
          }
        }
        if (globalsByMangled.has(mangledKey)) {
          const existing = globalsByMangled.get(mangledKey);
          const isSameSymbol = caseInsensitive
            ? existing.toLowerCase() === symbol.toLowerCase()
            : existing === symbol;
          if (!isSameSymbol) {
            throw new Error(
              `symbol map collision in ${section}: ${existing} and ${symbol} both mangle to ${mangled}`,
            );
          }
        }
        globalsByMangled.set(mangledKey, symbol);
        totalChecked++;
      }
    }
  }
  return totalChecked;
}

export function assertZipHasNoSecretIntermediates(entries) {
  const secrets = [];
  const secretPattern = /(^|\/)(?:symbol[-_]map|symbols)[^/]*\.json$/i;
  for (const entry of entries || []) {
    const name = typeof entry === "string" ? entry : entry?.name;
    if (!name) continue;
    if (secretPattern.test(name)) secrets.push(name);
  }
  if (secrets.length > 0) {
    throw new Error(`secret build intermediate packaged in ZIP: ${secrets.join(", ")}`);
  }
}

async function firstLineVersion(command, args) {
  const { stdout, stderr } = await execFileAsync(command, args);
  const lines = String(stdout || stderr).trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const versionLine = lines.find((l) => /(?:version|v\d|\bzip\s+\d|\b\d+\.\d+)/i.test(l)) || lines[0] || "";
  return versionLine.slice(0, 240);
}

export async function collectToolchainEvidence({ rectorBin = null } = {}) {
  const evidence = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
  const probes = [
    ["php", ["-r", "echo PHP_VERSION;"], "php"],
    ["zip", ["-v"], "zip"],
    ["unzip", ["-v"], "unzip"],
    ["rsync", ["--version"], "rsync"],
    ["composer", ["--version"], "composer"],
  ];
  for (const [command, args, key] of probes) {
    try {
      evidence[key] = await firstLineVersion(command, args);
    } catch (err) {
      throw new Error(`Profile S toolchain preflight failed: ${describeToolchainFailure(command, err)}`);
    }
  }
  if (rectorBin) {
    try {
      evidence.rector = await firstLineVersion("php", [rectorBin, "--version"]);
    } catch (err) {
      throw new Error(`Profile S toolchain preflight failed: rector (${err.message})`);
    }
  }
  return evidence;
}

export async function assertRequiredBuildTools(commands = REQUIRED_BUILD_TOOLS) {
  const missing = [];
  for (const [command, args] of commands) {
    try {
      await execFileAsync(command, args);
    } catch (err) {
      missing.push(describeToolchainFailure(command, err));
    }
  }
  if (missing.length > 0) {
    throw new Error(`Profile S toolchain preflight failed: missing ${missing.join("; ")}`);
  }
}

export async function secureUnlinkSymbolMap(mapFile) {
  if (!mapFile || !fs.existsSync(mapFile)) return;
  try {
    const stat = fs.statSync(mapFile);
    if (stat.isFile() && stat.size > 0) {
      fs.writeFileSync(mapFile, Buffer.alloc(Math.min(stat.size, 64 * 1024 * 1024), 0));
    }
  } catch {
    // Still unlink even if the overwrite fails.
  }
  await rm(mapFile, { force: true });
}

export async function resolveAndValidateTargetPhpInterpreter({
  targetPhp = "7.4",
  phpBin,
  enforceTarget = false,
} = {}) {
  const envTargetBin =
    process.env[`WPDEV_PHP${targetPhp.replace(".", "")}_BIN`] ||
    process.env.WPDEV_PHP_TARGET_BIN ||
    (targetPhp === "7.4" ? process.env.WPDEV_PHP74_BIN : undefined);

  const selectedBin = phpBin || envTargetBin || "php";

  let stdout = "";
  try {
    const res = await execFileAsync(selectedBin, [
      "-d",
      "xdebug.mode=off",
      "-r",
      "echo PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION;",
    ]);
    stdout = String(res.stdout || "").trim();
  } catch (err) {
    throw new Error(
      `Target PHP interpreter '${selectedBin}' failed execution: ${err.message}`,
    );
  }

  const actualVersion = stdout;
  const matchesTarget = actualVersion === targetPhp;

  if (enforceTarget && !matchesTarget) {
    throw new Error(
      `Target PHP interpreter '${selectedBin}' version mismatch: expected PHP ${targetPhp}, got PHP ${actualVersion}`,
    );
  }

  if (envTargetBin && !matchesTarget) {
    throw new Error(
      `Target PHP interpreter '${selectedBin}' configured via environment has version mismatch: expected PHP ${targetPhp}, got PHP ${actualVersion}`,
    );
  }

  return {
    bin: selectedBin,
    version: actualVersion,
    isExactTarget: matchesTarget,
  };
}

export async function validatePhpSyntaxTree(
  dir,
  {
    phpBin,
    targetPhp = "7.4",
    enforceTarget = false,
  } = {}
) {
  const interpreter = await resolveAndValidateTargetPhpInterpreter({
    targetPhp,
    phpBin,
    enforceTarget,
  });
  const phpValidatorScript = `
  $dir = $argv[1];
  $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, RecursiveDirectoryIterator::SKIP_DOTS));
  $errors = [];
  $php8TokenIds = [];
  foreach (['T_ENUM', 'T_READONLY', 'T_MATCH', 'T_NULLSAFE_OBJECT_OPERATOR'] as $const) {
      if (defined($const)) {
          $php8TokenIds[constant($const)] = $const;
      }
  }
  $attrId = defined('T_ATTRIBUTE') ? constant('T_ATTRIBUTE') : -1;
  $fnId = defined('T_FN') ? constant('T_FN') : T_FUNCTION;
  $ellipsisId = defined('T_ELLIPSIS') ? constant('T_ELLIPSIS') : -1;
  $doubleArrowId = defined('T_DOUBLE_ARROW') ? constant('T_DOUBLE_ARROW') : -1;
  // Significant-token helper: previous/next non-whitespace/comment index.
  $prevSig = function($tokens, $idx) {
      for ($j = $idx - 1; $j >= 0; $j--) {
          $t = $tokens[$j];
          if (is_array($t) && in_array($t[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) continue;
          return $j;
      }
      return null;
  };
  $nextSig = function($tokens, $idx, $count) {
      for ($j = $idx + 1; $j < $count; $j++) {
          $t = $tokens[$j];
          if (is_array($t) && in_array($t[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) continue;
          return $j;
      }
      return null;
  };
  foreach ($iterator as $file) {
      if (!$file->isFile() || $file->getExtension() !== 'php') {
          continue;
      }
      $path = $file->getPathname();
      // Dual-load libraries: Real/ implementation is PHP 8.1+ only and conditionally loaded on runtime.
      if (strpos($path, 'php-fault-tolerance' . DIRECTORY_SEPARATOR . 'src' . DIRECTORY_SEPARATOR . 'Real') !== false) {
          continue;
      }
      // Validate all runtime PHP files including vendor and vendor-prefixed
      $code = file_get_contents($path);
      try {
          $tokens = token_get_all($code, TOKEN_PARSE);
      } catch (\\ParseError $e) {
          $errors[] = $path . ': ' . $e->getMessage();
          continue;
      }
      $count = count($tokens);
      for ($i = 0; $i < $count; $i++) {
          $token = $tokens[$i];
          $tokenId = is_array($token) ? $token[0] : null;
          $tokenText = is_array($token) ? $token[1] : $token;

          if ($tokenId !== null && isset($php8TokenIds[$tokenId])) {
              $errors[] = $path . ': PHP 7.4 incompatibility: ' . $php8TokenIds[$tokenId] . ' remains after downgrade';
              break;
          }

          if ($tokenId === $ellipsisId || $tokenText === '...') {
              $pi = $prevSig($tokens, $i);
              $ni = $nextSig($tokens, $i, $count);
              if ($pi !== null && $ni !== null && $tokens[$pi] === '(' && $tokens[$ni] === ')') {
                  $errors[] = $path . ': PHP 7.4 incompatibility: first-class callable syntax (...) detected';
                  break;
              }
          }

          if ($tokenId === $attrId) {
              $attrTokens = [];
              $j = $i + 1;
              while ($j < $count && $tokens[$j] !== ']') {
                  $attrTokens[] = is_array($tokens[$j]) ? $tokens[$j][1] : $tokens[$j];
                  $j++;
              }
              $attrName = trim(implode('', $attrTokens));
              $cleanAttrName = ltrim($attrName, "\\\\");
              if (!in_array($cleanAttrName, ['ReturnTypeWillChange', 'AllowDynamicProperties', 'Override'], true)) {
                  $errors[] = $path . ': PHP 7.4 incompatibility: T_ATTRIBUTE remains after downgrade: ' . $attrName;
                  break;
              }
              $i = $j;
              continue;
          }

          if ($tokenId === T_FUNCTION || $tokenId === $fnId) {
              $isArrow = ($tokenId === $fnId);
              while ($i < $count && $tokens[$i] !== '(') {
                  $i++;
              }
              $depth = 1;
              $paramTokens = [];
              $i++;
              while ($i < $count && $depth > 0) {
                  if ($tokens[$i] === '(') $depth++;
                  elseif ($tokens[$i] === ')') $depth--;
                  if ($depth > 0) $paramTokens[] = $tokens[$i];
                  $i++;
              }
              $lastSigParam = null;
              for ($k = count($paramTokens) - 1; $k >= 0; $k--) {
                  $t = $paramTokens[$k];
                  if (is_array($t) && in_array($t[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) continue;
                  $lastSigParam = is_array($t) ? $t[1] : $t;
                  break;
              }
              if ($lastSigParam === ',') {
                  $errors[] = $path . ': PHP 7.4 incompatibility: trailing comma detected in parameter list';
                  break;
              }
              $inDefault = false;
              $visibilityTokens = [T_PUBLIC, T_PROTECTED, T_PRIVATE];
              if (defined('T_READONLY')) $visibilityTokens[] = constant('T_READONLY');
              foreach ($paramTokens as $pt) {
                  $ptId = is_array($pt) ? $pt[0] : null;
                  $ptText = is_array($pt) ? $pt[1] : $pt;
                  if ($pt === '=') $inDefault = true;
                  elseif ($pt === ',') $inDefault = false;
                  elseif ($inDefault && ($ptId === T_NEW || $ptText === 'new')) {
                      $errors[] = $path . ': PHP 7.4 incompatibility: new in initializer detected in parameter default';
                      break;
                  }
                  elseif (!$inDefault && $pt === '|') {
                      $errors[] = $path . ': PHP 7.4 incompatibility: union type parameter detected in function declaration';
                      break;
                  }
                  // PHP 8.0+ standalone types that Rector must have downgraded.
                  // Note: 'static' tokenizes as T_STATIC, not T_STRING.
                  if (!$inDefault && ($ptId === T_STRING || (defined('T_STATIC') && $ptId === constant('T_STATIC')))) {
                      $lowerPt = strtolower($ptText);
                      if (in_array($lowerPt, ['mixed', 'never', 'static', 'false', 'true', 'null'], true)) {
                          $errors[] = $path . ': PHP 7.4 incompatibility: ' . $ptText . ' type detected in parameter list';
                          break;
                      }
                  }
                  if (in_array($ptId, $visibilityTokens, true)) {
                      $errors[] = $path . ': PHP 7.4 incompatibility: constructor property promotion detected in parameter list';
                      break;
                  }
              }
              for ($pIdx = 0; $pIdx < count($paramTokens); $pIdx++) {
                  $pToken = $paramTokens[$pIdx];
                  $pId = is_array($pToken) ? $pToken[0] : null;
                  $pText = is_array($pToken) ? $pToken[1] : $pToken;
                  if (defined('T_AMPERSAND_NOT_FOLLOWED_BY_VAR_OR_VARARG') && $pId === constant('T_AMPERSAND_NOT_FOLLOWED_BY_VAR_OR_VARARG')) {
                      $errors[] = $path . ': PHP 7.4 incompatibility: intersection type parameter detected';
                      break;
                  }
                  if ($pText === '&') {
                      $nextP = $paramTokens[$pIdx + 1] ?? null;
                      $nextId = is_array($nextP) ? $nextP[0] : null;
                      // '&...$args' (by-ref variadic) is valid PHP 7.4; only flag
                      // '&' that is neither by-ref var nor by-ref variadic.
                      if ($nextId === $ellipsisId) {
                          $afterEllipsis = $paramTokens[$pIdx + 2] ?? null;
                          $afterId = is_array($afterEllipsis) ? $afterEllipsis[0] : null;
                          if ($afterId === T_VARIABLE) continue;
                      }
                      if ($nextId !== T_VARIABLE) {
                          $errors[] = $path . ': PHP 7.4 incompatibility: intersection type parameter detected';
                          break;
                      }
                  }
              }
              $returnTokens = [];
              $hasColon = false;
              while ($i < $count && $tokens[$i] !== '{' && $tokens[$i] !== ';' && $tokens[$i] !== $doubleArrowId && (is_array($tokens[$i]) ? $tokens[$i][0] !== $doubleArrowId : true)) {
                  if ($tokens[$i] === ':') {
                      $hasColon = true;
                  } elseif ($hasColon) {
                      $returnTokens[] = $tokens[$i];
                  }
                  $i++;
              }
              if ($hasColon) {
                  foreach ($returnTokens as $rt) {
                      $rtId = is_array($rt) ? $rt[0] : null;
                      $rtText = is_array($rt) ? $rt[1] : $rt;
                      if ($rtText === '|') {
                          $errors[] = $path . ': PHP 7.4 incompatibility: union return type detected in function declaration';
                          break;
                      }
                      if ($rtId === T_STRING && in_array(strtolower($rtText), ['mixed', 'never', 'static', 'true', 'false', 'null'], true)) {
                          $errors[] = $path . ': PHP 7.4 incompatibility: ' . $rtText . ' return type detected in function declaration';
                          break;
                      }
                      if (defined('T_STATIC') && $rtId === constant('T_STATIC')) {
                          $errors[] = $path . ': PHP 7.4 incompatibility: static return type detected in function declaration';
                          break;
                      }
                      if ($rtText === '&' || (defined('T_AMPERSAND_NOT_FOLLOWED_BY_VAR_OR_VARARG') && $rtId === constant('T_AMPERSAND_NOT_FOLLOWED_BY_VAR_OR_VARARG'))) {
                          $errors[] = $path . ': PHP 7.4 incompatibility: intersection return type detected in function declaration';
                          break;
                      }
                  }
              }
          }

          if ($tokenId === T_CATCH) {
              $open = $nextSig($tokens, $i, $count);
              if ($open !== null && $tokens[$open] === '(') {
                  $hasVar = false;
                  $j = $open + 1;
                  $depth = 1;
                  while ($j < $count && $depth > 0) {
                      $ct = $tokens[$j];
                      if ($ct === '(') $depth++;
                      elseif ($ct === ')') $depth--;
                      elseif ($depth === 1 && is_array($ct) && $ct[0] === T_VARIABLE) $hasVar = true;
                      $j++;
                  }
                  if (!$hasVar) {
                      $errors[] = $path . ': PHP 7.4 incompatibility: non-capturing catch detected';
                      break;
                  }
              }
          }

          if ($tokenId === T_CONST) {
              $n1 = $nextSig($tokens, $i, $count);
              if ($n1 !== null && is_array($tokens[$n1]) && $tokens[$n1][0] === T_STRING) {
                  $n2 = $nextSig($tokens, $n1, $count);
                  if ($n2 !== null && is_array($tokens[$n2]) && $tokens[$n2][0] === T_STRING) {
                      $errors[] = $path . ': PHP 7.4 incompatibility: typed class constant detected';
                      break;
                  }
              }
          }

          // Named arguments 'foo(name: $v)' are PHP 8.0+. A top-level 'Name:'
          // at the start of a call argument (prev significant '(' or ',',
          // next significant not ':' to exclude '::') is a named argument.
          if ($tokenId === T_STRING) {
              $ni = $nextSig($tokens, $i, $count);
              if ($ni !== null && $tokens[$ni] === ':') {
                  $nni = $nextSig($tokens, $ni, $count);
                  $pi = $prevSig($tokens, $i);
                  $prevTok = $pi !== null ? $tokens[$pi] : null;
                  $isScopeOrTernaryQ = ($prevTok === '?' || (is_array($prevTok) && $prevTok[1] === '?'));
                  if ($nni !== null && $tokens[$nni] !== ':' && (is_array($tokens[$nni]) ? $tokens[$nni][1] !== ':' : true)
                      && ($prevTok === '(' || $prevTok === ',') && !$isScopeOrTernaryQ) {
                      $errors[] = $path . ': PHP 7.4 incompatibility: named argument detected: ' . $tokenText;
                      break;
                  }
              }
          }
      }
  }
  if (!empty($errors)) {
      fwrite(STDERR, implode("\\n", $errors) . "\\n");
      exit(1);
  }
  echo "SYNTAX_OK\\n";
  `;
  const { stdout, stderr } = await execFileAsync(interpreter.bin, ["-d", "xdebug.mode=off", "-r", phpValidatorScript, "--", dir]);
  if (!stdout.includes("SYNTAX_OK")) {
    throw new Error(`PHP syntax error in transformed files: ${stdout || stderr}`);
  }
  // V3-16: surface which interpreter actually performed this gate. Without this, callers
  // cannot distinguish "validated on the declared target" from "validated on host PHP",
  // and a 7.4 compatibility claim can be recorded on the back of an 8.x run.
  return {
    interpreter: { bin: interpreter.bin, version: interpreter.version },
    targetPhp,
    enforceTarget: Boolean(enforceTarget),
    targetPhpVerified: interpreter.isExactTarget,
  };
}

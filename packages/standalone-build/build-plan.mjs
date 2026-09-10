/**
 * BuildPlan — Versioned Pipeline Contract & Capability Model
 *
 * Single source of truth for build capability configuration,
 * target PHP, source descriptors, preservation, and asset policies.
 *
 * Implements Task 0 and addresses C1–C4 and R17 from protection-pipeline-fix-plan-v2.md.
 */

import crypto from "node:crypto";
import path from "node:path";

export const BUILD_PLAN_SCHEMA_VERSION = "2.0.0";

/**
 * Unresolved Architectural Choices (C1–C4)
 * Hard entry contracts documented per fix plan v2.
 */
export const UNRESOLVED_CHOICES = Object.freeze({
  C1_SHORT_NAME_COLLISIONS: Object.freeze({
    id: "C1",
    title: "Short-name collisions under namespace flattening",
    status: "LOCKED_FAIL_CLOSED",
    policy:
      "Two distinct FQCNs flattening to the same short name must fail closed and report all colliding FQCNs and source paths. class_alias cannot solve function, constant, serialized-name, or reflection collisions.",
    gatedTask: 6,
  }),
  C2_LEGACY_OBFUSCATE_OPTION: Object.freeze({
    id: "C2",
    title: "Legacy obfuscate option migration",
    status: "DOCUMENTED_PRESETS",
    policy:
      "Legacy flags (--profile=s, --profile=clean, --obfuscate) resolve to documented presets without silently changing semantics. Programmatic callers should use explicit capability flags.",
    gatedTask: 8,
  }),
  C3_CLOSURE_BOUNDARY: Object.freeze({
    id: "C3",
    title: "Framework closure boundary",
    status: "EXPLICIT_PROVIDER_REQUIRED",
    policy:
      "Standalone inline-framework mode requires absorbing all required runtime dependencies. Provider roots must be explicitly resolved; missing or ambiguous providers fail closed before writes.",
    gatedTask: 7,
  }),
  C4_EXTENDED_SPAGHETTI: Object.freeze({
    id: "C4",
    title: "Extended spaghetti scope",
    status: "MINIMUM_MODE_CONFIRMED",
    policy:
      "Minimum spaghetti provides namespace flattening and duck-typed ModuleLoader while retaining names and comments. Extended spaghetti (inheritance/ancestor flattening) is deferred/blocked on C4 confirmation.",
    gatedTask: 11,
  }),
});

/**
 * Core capability flags that can be independently selected.
 */
export const CAPABILITY_FLAGS = Object.freeze([
  "inlineFramework",
  "spaghetti",
  "obfuscate",
]);

/**
 * Documented legacy presets.
 */
export const LEGACY_PRESETS = Object.freeze({
  clean: Object.freeze({
    inlineFramework: true,
    spaghetti: false,
    obfuscate: false,
    minifyAssets: false,
    stripComments: false,
  }),
  s: Object.freeze({
    inlineFramework: true,
    spaghetti: true,
    obfuscate: true,
    minifyAssets: true,
    stripComments: true,
  }),
});

const SUPPORTED_PHP_TARGETS = new Set(["7.4", "8.0", "8.1", "8.2", "8.3"]);

/**
 * Computes a deterministic identity string and SHA-256 fingerprint for a BuildPlan.
 */
export function canonicalJson(value) {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function computePlanFingerprint(planData) {
  const canonical = {
    schemaVersion: BUILD_PLAN_SCHEMA_VERSION,
    consumer: planData.consumer,
    capabilities: {
      inlineFramework: Boolean(planData.capabilities?.inlineFramework),
      spaghetti: Boolean(planData.capabilities?.spaghetti),
      obfuscate: Boolean(planData.capabilities?.obfuscate),
    },
    targetPhp: planData.targetPhp,
    skipZip: Boolean(planData.skipZip),
    assetPolicy: {
      minifyAssets: Boolean(planData.assetPolicy?.minifyAssets),
      mirrorUnminified: Boolean(planData.assetPolicy?.mirrorUnminified),
      preserveReadable: Boolean(planData.assetPolicy?.preserveReadable),
    },
    preservationPolicy: {
      frozenClasses: [...(planData.preservationPolicy?.frozenClasses || [])].sort(),
      frozenFunctions: [...(planData.preservationPolicy?.frozenFunctions || [])].sort(),
      frozenConstants: [...(planData.preservationPolicy?.frozenConstants || [])].sort(),
      frozenProperties: [...(planData.preservationPolicy?.frozenProperties || [])].sort(),
      frozenMethods: [...(planData.preservationPolicy?.frozenMethods || [])].sort(),
      frozenVars: [...(planData.preservationPolicy?.frozenVars || [])].sort(),
      gettextDomains: [...(planData.preservationPolicy?.gettextDomains || [])].sort(),
      reflectionCallbacks: [...(planData.preservationPolicy?.reflectionCallbacks || [])].sort(),
    },
    source: {
      consumer: planData.consumer,
      frameworkProvider: planData.source?.frameworkProvider || null,
    },
  };

  return crypto.createHash("sha256").update(canonicalJson(canonical)).digest("hex");
}

/**
 * Derives a human-readable and deterministic artifact tag from capability flags.
 */
export function deriveCapabilityTag(capabilities) {
  const parts = [];
  if (capabilities.inlineFramework) parts.push("standalone");
  if (capabilities.spaghetti) parts.push("spaghetti");
  if (capabilities.obfuscate) parts.push("obfuscated");
  return parts.length > 0 ? parts.join("-") : "clean";
}

export function resolveArtifactZipName(plan) {
  const tag = plan?.artifactIdentity?.capabilityTag || deriveCapabilityTag(plan?.capabilities || {});
  const consumer = plan?.consumer || "plugin";
  if (tag === "standalone-spaghetti-obfuscated") {
    return `${consumer}-profile-s.zip`;
  }
  if (tag === "clean" || tag === "standalone") {
    return `${consumer}.zip`;
  }
  return `${consumer}-${tag}.zip`;
}

const ALLOWED_BUILD_PLAN_OPTIONS = new Set([
  "consumer",
  "profile",
  "targetPhp",
  "phpTarget",
  "inlineFramework",
  "spaghetti",
  "obfuscate",
  "isObfuscate",
  "sourceRoot",
  "contentRoot",
  "pluginsDir",
  "pluginsDirArg",
  "frameworkProvider",
  "minifyAssets",
  "mirrorUnminified",
  "preserveReadable",
  "skipZip",
  "stripComments",
  "frozenClasses",
  "frozenFunctions",
  "frozenConstants",
  "frozenProperties",
  "frozenMethods",
  "frozenVars",
  "gettextDomains",
  "reflectionCallbacks",
  "signal",
  "phpBin",
  "enforceTargetPhp",
  "emitDistDir",
  "argv",
]);

const BOOLEAN_OPTION_KEYS = new Set([
  "inlineFramework",
  "spaghetti",
  "obfuscate",
  "isObfuscate",
  "minifyAssets",
  "mirrorUnminified",
  "preserveReadable",
  "skipZip",
  "stripComments",
  "enforceTargetPhp",
  "emitDistDir",
]);

/**
 * Creates and validates a versioned BuildPlan.
 *
 * @param {Object} rawOptions User / CLI / programmatic options
 * @returns {Readonly<Object>} Immutable, validated BuildPlan
 */
export function createBuildPlan(rawOptions = {}) {
  if (!rawOptions || typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
    throw new Error("BuildPlan options must be a non-null object");
  }

  for (const key of Object.keys(rawOptions)) {
    if (!ALLOWED_BUILD_PLAN_OPTIONS.has(key)) {
      throw new Error(`Unknown BuildPlan option '${key}'`);
    }
    if (BOOLEAN_OPTION_KEYS.has(key) && rawOptions[key] !== undefined && rawOptions[key] !== null) {
      if (typeof rawOptions[key] !== "boolean") {
        throw new Error(`BuildPlan option '${key}' must be a boolean, got ${typeof rawOptions[key]}`);
      }
    }
  }

  const consumer = String(rawOptions.consumer || "").trim();
  if (!consumer) {
    throw new Error("BuildPlan prerequisite missing: 'consumer' slug is required");
  }

  const rawProfile = rawOptions.profile !== undefined && rawOptions.profile !== null
    ? String(rawOptions.profile).trim().toLowerCase()
    : null;
  if (rawProfile !== null && rawProfile !== "clean" && rawProfile !== "s" && rawProfile !== "custom") {
    throw new Error(`Invalid profile '${rawOptions.profile}'. Allowed: clean, s, custom`);
  }

  // Resolve target PHP
  const targetPhp = String(rawOptions.targetPhp || rawOptions.phpTarget || "7.4").trim();
  if (!SUPPORTED_PHP_TARGETS.has(targetPhp)) {
    throw new Error(
      `BuildPlan invalid target PHP '${targetPhp}'. Supported: ${[...SUPPORTED_PHP_TARGETS].join(", ")}`
    );
  }

  // Resolve capability flags
  let inlineFramework = false;
  let spaghetti = false;
  let obfuscate = false;

  // Independent capability selectors. `obfuscate` / `isObfuscate` alone remain
  // the legacy Profile S preset (C2) and must not silently become obfuscate-only.
  const hasIndependentCapability =
    rawOptions.inlineFramework !== undefined || rawOptions.spaghetti !== undefined;

  const legacyProfile = rawOptions.profile ? String(rawOptions.profile).toLowerCase() : null;
  const legacyIsObfuscate = rawOptions.isObfuscate !== undefined ? Boolean(rawOptions.isObfuscate) : null;

  if (legacyProfile === "s" && legacyIsObfuscate === false) {
    throw new Error(
      "Contradictory options: profile='s' cannot claim isObfuscate=false without transform"
    );
  }
  if (legacyProfile === "clean" && (rawOptions.obfuscate === true || legacyIsObfuscate === true)) {
    throw new Error(
      "Contradictory options: profile='clean' cannot be combined with obfuscate=true or spaghetti=true"
    );
  }

  if (hasIndependentCapability) {
    inlineFramework = Boolean(rawOptions.inlineFramework);
    spaghetti = Boolean(rawOptions.spaghetti);
    obfuscate = Boolean(rawOptions.obfuscate ?? legacyIsObfuscate ?? legacyProfile === "s");

    if (legacyProfile === "clean" && (obfuscate || spaghetti)) {
      throw new Error(
        "Contradictory options: profile='clean' cannot be combined with obfuscate=true or spaghetti=true"
      );
    }
    if (legacyProfile === "s" && !(inlineFramework && spaghetti && obfuscate)) {
      throw new Error(
        "Contradictory options: profile='s' requires inlineFramework, spaghetti, and obfuscate"
      );
    }
  } else if (legacyProfile === "clean") {
    inlineFramework = LEGACY_PRESETS.clean.inlineFramework;
    spaghetti = LEGACY_PRESETS.clean.spaghetti;
    obfuscate = LEGACY_PRESETS.clean.obfuscate;
  } else if (legacyProfile === "s" || legacyIsObfuscate === true || rawOptions.obfuscate) {
    inlineFramework = LEGACY_PRESETS.s.inlineFramework;
    spaghetti = LEGACY_PRESETS.s.spaghetti;
    obfuscate = LEGACY_PRESETS.s.obfuscate;
  } else {
    inlineFramework = false;
    spaghetti = false;
    obfuscate = false;
  }

  const capabilities = Object.freeze({
    inlineFramework,
    spaghetti,
    obfuscate,
  });

  // Source / provider descriptors
  const source = Object.freeze({
    consumer,
    sourceRoot: rawOptions.sourceRoot ? path.resolve(rawOptions.sourceRoot) : null,
    contentRoot: rawOptions.contentRoot ? path.resolve(rawOptions.contentRoot) : null,
    pluginsDir: rawOptions.pluginsDir ? path.resolve(rawOptions.pluginsDir) : null,
    frameworkProvider: rawOptions.frameworkProvider || null,
  });

  // Asset policy
  // Clean, inline-only, and spaghetti-only preserve readable originals by default
  const defaultMinifyAssets = obfuscate ? LEGACY_PRESETS.s.minifyAssets : false;
  const minifyAssets = Boolean(rawOptions.minifyAssets ?? defaultMinifyAssets);
  const mirrorUnminified = Boolean(rawOptions.mirrorUnminified ?? true);
  const preserveReadable = Boolean(rawOptions.preserveReadable ?? !minifyAssets);
  const skipZip = Boolean(rawOptions.skipZip);

  const assetPolicy = Object.freeze({
    minifyAssets,
    mirrorUnminified,
    preserveReadable,
  });

  // Preservation policy
  const preservationPolicy = Object.freeze({
    frozenClasses: Object.freeze([...(rawOptions.frozenClasses || [])]),
    frozenFunctions: Object.freeze([...(rawOptions.frozenFunctions || [])]),
    frozenConstants: Object.freeze([...(rawOptions.frozenConstants || [])]),
    frozenProperties: Object.freeze([...(rawOptions.frozenProperties || [])]),
    frozenMethods: Object.freeze([...(rawOptions.frozenMethods || [])]),
    frozenVars: Object.freeze([...(rawOptions.frozenVars || [])]),
    gettextDomains: Object.freeze([...(rawOptions.gettextDomains || [])]),
    reflectionCallbacks: Object.freeze([...(rawOptions.reflectionCallbacks || [])]),
  });

  // Derived artifact identity
  const capabilityTag = deriveCapabilityTag(capabilities);
  const phpTag = `php${targetPhp.replace(".", "")}`;
  const artifactBaseName = `${consumer}-${phpTag}-${capabilityTag}`;

  const planFingerprint = computePlanFingerprint({
    consumer,
    capabilities,
    targetPhp,
    assetPolicy,
    preservationPolicy,
    skipZip,
    source,
  });

  const artifactIdentity = Object.freeze({
    baseName: artifactBaseName,
    capabilityTag,
    targetPhp,
    fingerprint: planFingerprint,
    zipFileName: resolveArtifactZipName({
      consumer,
      artifactIdentity: { capabilityTag },
      capabilities,
    }),
  });

  const plan = Object.freeze({
    schemaVersion: BUILD_PLAN_SCHEMA_VERSION,
    consumer,
    targetPhp,
    capabilities,
    source,
    assetPolicy,
    preservationPolicy,
    artifactIdentity,
    skipZip,
    unresolvedChoices: UNRESOLVED_CHOICES,
    createdAt: new Date().toISOString(),
  });

  validateBuildPlan(plan);
  return plan;
}

/**
 * Validates a frozen BuildPlan against all required invariants.
 */
export function validateBuildPlan(plan) {
  if (!plan || typeof plan !== "object") {
    throw new Error("BuildPlan must be a non-null object");
  }
  if (plan.schemaVersion !== BUILD_PLAN_SCHEMA_VERSION) {
    throw new Error(
      `BuildPlan schema mismatch: expected '${BUILD_PLAN_SCHEMA_VERSION}', got '${plan.schemaVersion}'`
    );
  }
  if (!plan.consumer || typeof plan.consumer !== "string") {
    throw new Error("BuildPlan requires a valid 'consumer' string");
  }
  if (!SUPPORTED_PHP_TARGETS.has(plan.targetPhp)) {
    throw new Error(`BuildPlan invalid target PHP: '${plan.targetPhp}'`);
  }
  if (!plan.capabilities || typeof plan.capabilities !== "object") {
    throw new Error("BuildPlan requires capabilities object");
  }
  for (const flag of CAPABILITY_FLAGS) {
    if (typeof plan.capabilities[flag] !== "boolean") {
      throw new Error(`BuildPlan capability flag '${flag}' must be a boolean`);
    }
  }
  if (!plan.artifactIdentity?.fingerprint) {
    throw new Error("BuildPlan requires artifactIdentity with fingerprint");
  }
  const expectedFingerprint = computePlanFingerprint(plan);
  if (plan.artifactIdentity.fingerprint !== expectedFingerprint) {
    throw new Error(
      `BuildPlan fingerprint mismatch: expected '${expectedFingerprint}', got '${plan.artifactIdentity.fingerprint}'`
    );
  }
  return true;
}

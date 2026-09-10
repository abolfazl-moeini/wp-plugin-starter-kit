/**
 * Canonical Test Dependency Registry
 * Single source of truth for test metadata, impact mapping, artifact binding requirements, and tier classification.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TESTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "tests");

export const CANONICAL_TEST_REGISTRY = {
  "artifact-fixture-helper.test.mjs": {
    "tools": [
      "tools/artifact-fixture-helper.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "artifact-manifest-tamper-resistance.test.mjs": {
    "tools": [
      "tools/canonical-artifact-manifest.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "artifact-prefix-inventory.test.mjs": {
    "tools": [
      "tools/artifact-prefix-inventory.mjs",
      "tools/target-registry.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "atomic-deploy-and-cache-integrity.test.mjs": {
    "tools": [
      "tools/build-all-standalone-plugins.mjs",
      "tools/build-cache-engine.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "build-dag-runner.test.mjs": {
    "tools": [
      "tools/build-dag-runner.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "class-completeness-gate.test.mjs": {
    "tools": [
      "tools/class-completeness-gate.mjs"
    ],
    "artifacts": [
      "tavangary-core"
    ],
    "requiredBy": [
      "tavangary-core"
    ],
    "criticality": "critical",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": true,
    "tier": "unit"
  },
  "dag-cancellation-subprocess.test.mjs": {
    "tools": [
      "tools/build-dag-runner.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "dev-purge-policy.test.mjs": {
    "tools": [
      "tools/dev-purge-policy.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "fast",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "docker-receipt-binding.test.mjs": {
    "tools": [
      "tools/build-cache-engine.mjs",
      "tools/build-all-standalone-plugins.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "f01-atomic-deploy-rollback-fsync.test.mjs": {
    "tools": [
      "tools/build-all-standalone-plugins.mjs",
      "tools/build-cache-engine.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "f02-transaction-locking.test.mjs": {
    "tools": [
      "tools/build-all-standalone-plugins.mjs",
      "tools/build-cache-engine.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "f03-direct-deploy-journal-recovery.test.mjs": {
    "tools": [
      "tools/build-all-standalone-plugins.mjs",
      "tools/build-cache-engine.mjs",
      "tools/deploy-standalone-plugin.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "f04-zip-snapshot-integrity.test.mjs": {
    "tools": [
      "tools/build-all-standalone-plugins.mjs",
      "tools/canonical-artifact-manifest.mjs",
      "tools/artifact-fixture-helper.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "f05-f06-cache-profile-separation.test.mjs": {
    "tools": [
      "tools/build-cache-engine.mjs",
      "tools/assemble-profile-s-candidate.mjs",
      "tools/build-all-standalone-plugins.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "f07-php74-target-syntax-gate.test.mjs": {
    "tools": [
      "tools/profile-s-fail-closed.mjs",
      "tools/assemble-profile-s-candidate.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "f08-path-and-autoload-validation.test.mjs": {
    "tools": [
      "tools/canonical-artifact-manifest.mjs",
      "tools/build-all-standalone-plugins.mjs",
      "tools/deploy-standalone-plugin.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "f09-f10-f11-transformer-semantics.test.mjs": {
    "tools": [
      "tools/plan3/transformer.php",
      "tools/profile-s-fail-closed.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "f12-consumer-release-alignment.test.mjs": {
    "tools": [
      "tools/assemble-profile-s-candidate.mjs",
      "tools/canonical-artifact-manifest.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "f13-in-flight-drain-and-health.test.mjs": {
    "tools": [
      "tools/build-all-standalone-plugins.mjs",
      "tools/deploy-standalone-plugin.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "f14-bounded-inflate-and-zip-reproducibility.test.mjs": {
    "tools": [
      "tools/canonical-artifact-manifest.mjs",
      "tools/build-all-standalone-plugins.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "framework-closure-inventory.test.mjs": {
    "tools": [
      "tools/framework-closure-inventory.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "framework-template-inventory.test.mjs": {
    "tools": [
      "tools/framework-template-inventory.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "generate-serialized-callback-review-manifest.test.mjs": {
    "tools": [
      "tools/generate-serialized-callback-review-manifest.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "hook-contract-inventory.test.mjs": {
    "tools": [
      "tools/hook-contract-inventory.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "in-place-unzip-race.test.mjs": {
    "tools": [
      "tools/canonical-artifact-manifest.mjs",
      "tools/build-all-standalone-plugins.mjs",
      "tools/deploy-standalone-plugin.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "inliner-collision-and-manifest.test.mjs": {
    "tools": [
      "tools/inline-wpdev-closure.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "module-loader-coexistence-gate.test.mjs": {
    "tools": [
      "tools/module-loader-coexistence-gate.mjs"
    ],
    "artifacts": [
      "drm-connector",
      "tavangary-core",
      "tavangary-theme-panel",
      "wpdev-analytics",
      "wpdev-crm",
      "wpdev-tickets",
      "wpdev-woo-persian"
    ],
    "requiredBy": [
      "drm-connector",
      "tavangary-core",
      "tavangary-theme-panel",
      "wpdev-analytics",
      "wpdev-crm",
      "wpdev-tickets",
      "wpdev-woo-persian"
    ],
    "criticality": "critical",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": true,
    "tier": "contract"
  },
  "multi-plugin-coexistence.test.mjs": {
    "tools": [
      "tools/inline-wpdev-closure.mjs",
      "tools/assemble-profile-s-candidate.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "performance-and-evidence-regressions.test.mjs": {
    "tools": [
      "tools/build-cache-engine.mjs",
      "tools/build-all-standalone-plugins.mjs",
      "tools/test-impact-map.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "fast",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "integration"
  },
  "performance-and-tamper-verification.test.mjs": {
    "tools": [
      "tools/build-cache-engine.mjs",
      "tools/canonical-artifact-manifest.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "pipeline-failure-and-rollback.test.mjs": {
    "tools": [
      "tools/build-all-standalone-plugins.mjs",
      "tools/build-cache-engine.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "fast",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "integration"
  },
  "plan3-transformer.test.mjs": {
    "tools": [
      "tools/plan3/transformer.php"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "prepare-artifact-phpunit-harness.test.mjs": {
    "tools": [
      "tools/prepare-artifact-phpunit-harness.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "profile-s-fail-closed.test.mjs": {
    "tools": [
      "tools/profile-s-fail-closed.mjs",
      "tools/assemble-profile-s-candidate.mjs",
      "tools/build-all-standalone-plugins.mjs",
      "tools/build-plan.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "production-namespace-tests-retention.test.mjs": {
    "tools": [
      "tools/build-cache-engine.mjs"
    ],
    "artifacts": [
      "tavangary-core"
    ],
    "requiredBy": [
      "tavangary-core"
    ],
    "criticality": "critical",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": true,
    "tier": "contract"
  },
  "protection-inventory.test.mjs": {
    "tools": [
      "tools/protection-inventory.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "refresh-pre-registry-candidate-digests.test.mjs": {
    "tools": [
      "tools/refresh-pre-registry-candidate-digests.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "resolve-content-root.test.mjs": {
    "tools": [
      "tools/resolve-content-root.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "fast",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "run-plan3-eligibility-spike.test.mjs": {
    "tools": [
      "tools/run-plan3-eligibility-spike.mjs"
    ],
    "artifacts": [
      "tavangary-core"
    ],
    "requiredBy": [
      "tavangary-core"
    ],
    "criticality": "critical",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": true,
    "tier": "unit"
  },
  "run-protection-gates.test.mjs": {
    "tools": [
      "tools/run-protection-gates.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "safe-ast-obfuscator.test.mjs": {
    "tools": [
      "tools/safe-ast-obfuscator.php"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "serialized-callback-inventory.test.mjs": {
    "tools": [
      "tools/serialized-callback-inventory.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "settings-field-inventory.test.mjs": {
    "tools": [
      "tools/settings-field-inventory.mjs"
    ],
    "artifacts": [
      "tavangary-theme-panel"
    ],
    "requiredBy": [
      "tavangary-theme-panel"
    ],
    "criticality": "critical",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": true,
    "tier": "contract"
  },
  "target-cache-integrity.test.mjs": {
    "tools": [
      "tools/build-cache-engine.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "target-registry.test.mjs": {
    "tools": [
      "tools/target-registry.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "task3-private-members-and-constants.test.mjs": {
    "tools": [
      "tools/plan3/transformer.php",
      "tools/plan3/symbol-analyzer.php"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "fast",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "task4-scope-capture-and-template.test.mjs": {
    "tools": [
      "tools/plan3/transformer.php",
      "tools/plan3/symbol-analyzer.php"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "fast",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "task5-protect-literals-and-comments.test.mjs": {
    "tools": [
      "tools/plan3/transformer.php",
      "tools/plan3/symbol-analyzer.php"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "fast",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "task6-namespaces-and-public-boundaries.test.mjs": {
    "tools": [
      "tools/plan3/transformer.php",
      "tools/plan3/symbol-analyzer.php"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "fast",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "v3-differential-probes.test.mjs": {
    "tools": [
      "tools/plan3/transformer.php",
      "tools/plan3/symbol-analyzer.php"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "fast",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "v3-transform-modes.test.mjs": {
    "tools": [
      "tools/plan3/transformer.php",
      "tools/plan3/symbol-analyzer.php"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "fast",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "tavangary-core-artifact.test.mjs": {
    "tools": [
      "tools/assemble-profile-s-candidate.mjs",
      "tools/artifact-fixture-helper.mjs",
      "tools/canonical-artifact-manifest.mjs"
    ],
    "artifacts": [
      "tavangary-core"
    ],
    "requiredBy": [
      "tavangary-core"
    ],
    "criticality": "critical",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": true,
    "tier": "contract"
  },
  "tavangary-theme-panel-artifact.test.mjs": {
    "tools": [
      "tools/assemble-profile-s-candidate.mjs",
      "tools/artifact-fixture-helper.mjs",
      "tools/canonical-artifact-manifest.mjs"
    ],
    "artifacts": [
      "tavangary-theme-panel"
    ],
    "requiredBy": [
      "tavangary-theme-panel"
    ],
    "criticality": "critical",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": true,
    "tier": "contract"
  },
  "test-impact-map.test.mjs": {
    "tools": [
      "tools/test-impact-map.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "transformer-correctness-matrix.test.mjs": {
    "tools": [
      "tools/plan3/transformer.php"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "fast",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "transformer-engine.test.mjs": {
    "tools": [
      "tools/plan3/transformer.php"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "transformer-fixture-harness.test.mjs": {
    "tools": [
      "tools/plan3/transformer.php"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "fast",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "validate-closure-review-manifest.test.mjs": {
    "tools": [
      "tools/generate-closure-review-manifest.mjs",
      "tools/validate-closure-review-manifest.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "validate-composer-release-policy.test.mjs": {
    "tools": [
      "tools/validate-composer-release-policy.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "fast",
      "contract",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "validate-composer-staging-report.test.mjs": {
    "tools": [
      "tools/validate-composer-staging-report.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "validate-hook-contract-dynamic-domain.test.mjs": {
    "tools": [
      "tools/validate-hook-contract-dynamic-domain.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "validate-hook-contract-review.test.mjs": {
    "tools": [
      "tools/validate-hook-contract-review.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "validate-prefix-migration-contract.test.mjs": {
    "tools": [
      "tools/validate-prefix-migration-contract.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "validate-profile-a-pre-registry-candidate.test.mjs": {
    "tools": [
      "tools/validate-profile-a-pre-registry-candidate.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "validate-profile-a-readiness.test.mjs": {
    "tools": [
      "tools/validate-profile-a-readiness.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "validate-protection-artifact-registry.test.mjs": {
    "tools": [
      "tools/validate-protection-artifact-registry.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "validate-protection-registry-proposals.test.mjs": {
    "tools": [
      "tools/validate-protection-registry-proposals.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "validate-serialized-callback-review.test.mjs": {
    "tools": [
      "tools/validate-serialized-callback-review.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "unit"
  },
  "validate-settings-ownership-review.test.mjs": {
    "tools": [
      "tools/validate-settings-ownership-review.mjs"
    ],
    "artifacts": [
      "tavangary-theme-panel"
    ],
    "requiredBy": [
      "tavangary-theme-panel"
    ],
    "criticality": "critical",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": true,
    "tier": "unit"
  },
  "validate-signed-release-manifest.test.mjs": {
    "tools": [
      "tools/validate-signed-release-manifest.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "validate-template-dependency-review.test.mjs": {
    "tools": [
      "tools/validate-template-dependency-review.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "validate-template-resolver-contract.test.mjs": {
    "tools": [
      "tools/validate-template-resolver-contract.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "validate-test-portability-manifest.test.mjs": {
    "tools": [
      "tools/validate-test-portability-manifest.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "verify-composer-staging.test.mjs": {
    "tools": [
      "tools/verify-composer-staging.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "verify-profile-s-artifact.test.mjs": {
    "tools": [
      "tools/verify-profile-s-artifact.mjs",
      "tools/assemble-profile-s-candidate.mjs",
      "tools/canonical-artifact-manifest.mjs"
    ],
    "artifacts": [
      "drm-connector",
      "tavangary-core",
      "tavangary-theme-panel",
      "wpdev-analytics",
      "wpdev-crm",
      "wpdev-tickets",
      "wpdev-woo-persian"
    ],
    "requiredBy": [
      "drm-connector",
      "tavangary-core",
      "tavangary-theme-panel",
      "wpdev-analytics",
      "wpdev-crm",
      "wpdev-tickets",
      "wpdev-woo-persian"
    ],
    "criticality": "critical",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": true,
    "tier": "contract"
  },
  "wpdev-crm-artifact.test.mjs": {
    "tools": [
      "tools/assemble-profile-s-candidate.mjs",
      "tools/artifact-fixture-helper.mjs",
      "tools/canonical-artifact-manifest.mjs"
    ],
    "artifacts": [
      "wpdev-crm"
    ],
    "requiredBy": [
      "wpdev-crm"
    ],
    "criticality": "critical",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": true,
    "tier": "contract"
  },
  "wpdev-tickets-artifact.test.mjs": {
    "tools": [
      "tools/assemble-profile-s-candidate.mjs",
      "tools/artifact-fixture-helper.mjs",
      "tools/canonical-artifact-manifest.mjs"
    ],
    "artifacts": [
      "wpdev-tickets"
    ],
    "requiredBy": [
      "wpdev-tickets"
    ],
    "criticality": "critical",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": true,
    "tier": "contract"
  },
  "zip-tamper-resistance-extended.test.mjs": {
    "tools": [
      "tools/canonical-artifact-manifest.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "contract"
  },
  "test-scheduler-and-tiers.test.mjs": {
    "tools": [
      "tools/dev/run-tests.mjs",
      "tools/dev/profile-tests.mjs",
      "tools/test-dependency-registry.mjs"
    ],
    "artifacts": [],
    "requiredBy": [],
    "criticality": "normal",
    "allowedModes": [
      "affected",
      "full",
      "release"
    ],
    "releaseSameRun": false,
    "tier": "meta"
  }
};

export const TEST_TIERS = {
  unit: Object.entries(CANONICAL_TEST_REGISTRY).filter(([, v]) => v.tier === "unit").map(([k]) => k).sort(),
  contract: Object.entries(CANONICAL_TEST_REGISTRY).filter(([, v]) => v.tier === "contract").map(([k]) => k).sort(),
  integration: Object.entries(CANONICAL_TEST_REGISTRY).filter(([, v]) => v.tier === "integration").map(([k]) => k).sort(),
  meta: Object.entries(CANONICAL_TEST_REGISTRY).filter(([, v]) => v.tier === "meta").map(([k]) => k).sort(),
};

/**
 * Derived: TEST_SPEC_MAP
 */
export const TEST_SPEC_MAP = Object.fromEntries(
  Object.entries(CANONICAL_TEST_REGISTRY).map(([testFile, entry]) => [
    testFile,
    {
      tier: entry.tier,
      tools: entry.tools || [],
      artifacts: entry.artifacts || [],
      requiredBy: entry.requiredBy || [],
      criticality: entry.criticality || "normal",
      allowedModes: entry.allowedModes || ["affected", "full", "release"],
      releaseSameRun: Boolean(entry.releaseSameRun),
    },
  ])
);

/**
 * Derived: REQUIRED_ARTIFACT_TESTS
 */
export const REQUIRED_ARTIFACT_TESTS = {
  "drm-connector": Object.entries(CANONICAL_TEST_REGISTRY)
    .filter(([, v]) => (v.requiredBy || []).includes("drm-connector"))
    .map(([k]) => k),
  "tavangary-core": Object.entries(CANONICAL_TEST_REGISTRY)
    .filter(([, v]) => (v.requiredBy || []).includes("tavangary-core"))
    .map(([k]) => k),
  "tavangary-theme-panel": Object.entries(CANONICAL_TEST_REGISTRY)
    .filter(([, v]) => (v.requiredBy || []).includes("tavangary-theme-panel"))
    .map(([k]) => k),
  "wpdev-analytics": Object.entries(CANONICAL_TEST_REGISTRY)
    .filter(([, v]) => (v.requiredBy || []).includes("wpdev-analytics"))
    .map(([k]) => k),
  "wpdev-crm": Object.entries(CANONICAL_TEST_REGISTRY)
    .filter(([, v]) => (v.requiredBy || []).includes("wpdev-crm"))
    .map(([k]) => k),
  "wpdev-tickets": Object.entries(CANONICAL_TEST_REGISTRY)
    .filter(([, v]) => (v.requiredBy || []).includes("wpdev-tickets"))
    .map(([k]) => k),
  "wpdev-woo-persian": Object.entries(CANONICAL_TEST_REGISTRY)
    .filter(([, v]) => (v.requiredBy || []).includes("wpdev-woo-persian"))
    .map(([k]) => k),
};

/**
 * Derived: TEST_DEPENDENCY_GRAPH
 */
function buildDependencyGraph() {
  const graph = {
    _tools: Object.keys(CANONICAL_TEST_REGISTRY),
    "themes/tavangary": [
      "tavangary-theme-panel-artifact.test.mjs",
      "settings-field-inventory.test.mjs",
      "validate-settings-ownership-review.test.mjs",
    ],
  };

  for (const [testFile, entry] of Object.entries(CANONICAL_TEST_REGISTRY)) {
    for (const tool of entry.tools || []) {
      const keys = [`tool:${tool}`, tool];
      for (const k of keys) {
        if (!graph[k]) graph[k] = [];
        if (!graph[k].includes(testFile)) {
          graph[k].push(testFile);
        }
      }
    }
    for (const consumer of entry.artifacts || []) {
      const keys = [`plugin:${consumer}`, consumer, `${consumer}-dev`];
      for (const k of keys) {
        if (!graph[k]) graph[k] = [];
        if (!graph[k].includes(testFile)) {
          graph[k].push(testFile);
        }
      }
    }
  }

  return graph;
}

export const TEST_DEPENDENCY_GRAPH = buildDependencyGraph();

const ALLOWED_CONSUMER_NAMES = new Set([
  "drm-connector",
  "tavangary-core",
  "tavangary-theme-panel",
  "wpdev-analytics",
  "wpdev-crm",
  "wpdev-tickets",
  "wpdev-woo-persian",
]);

const ALLOWED_MODES = new Set([
  "affected",
  "fast",
  "contract",
  "artifact",
  "full",
  "release",
]);

const ALLOWED_TIERS = new Set(["unit", "contract", "integration", "meta"]);

/**
 * Validate that the test registry covers all physical test files in testsDir
 * and performs strict semantic validation on declared metadata and tool paths.
 */
export function validateCanonicalTestRegistry(testsDir = DEFAULT_TESTS_DIR, customContentRoot = null) {
  if (!testsDir || !fs.existsSync(testsDir)) {
    return { valid: false, reason: `Tests directory does not exist: ${testsDir}` };
  }

  // Scanner check: No test files allowed directly in toolsDir or other unapproved locations
  const toolsRootDir = path.resolve(testsDir, "..");
  const filesInToolsRoot = fs.readdirSync(toolsRootDir).filter((f) => f.endsWith(".test.mjs"));
  if (filesInToolsRoot.length > 0) {
    return {
      valid: false,
      reason: `Test files found outside canonical test directories: ${filesInToolsRoot.map((f) => path.join("tools", f)).join(", ")} (tests must reside in tools/tests/ or tools/tests-docker/)`,
    };
  }

  const filesOnDisk = fs.readdirSync(testsDir).filter((f) => f.endsWith(".test.mjs")).sort();
  const registered = new Set(Object.keys(CANONICAL_TEST_REGISTRY));

  const missingFromRegistry = filesOnDisk.filter((f) => !registered.has(f));
  const missingFromDisk = Object.keys(CANONICAL_TEST_REGISTRY).filter((f) => !filesOnDisk.includes(f));

  if (missingFromRegistry.length > 0) {
    return { valid: false, reason: `Unmapped test files found on disk: ${missingFromRegistry.join(", ")}` };
  }
  if (missingFromDisk.length > 0) {
    return { valid: false, reason: `Registry references non-existent test files: ${missingFromDisk.join(", ")}` };
  }

  const tierFilesSeen = new Map();
  const root = customContentRoot || path.resolve(path.join(testsDir, "..", ".."));

  for (const [testName, entry] of Object.entries(CANONICAL_TEST_REGISTRY)) {
    if (!entry.tier || !ALLOWED_TIERS.has(entry.tier)) {
      return { valid: false, reason: `Test '${testName}' has invalid or missing tier '${entry.tier}' (allowed: unit, contract, integration, meta)` };
    }
    if (tierFilesSeen.has(testName)) {
      return { valid: false, reason: `Test '${testName}' declared in multiple tiers` };
    }
    tierFilesSeen.set(testName, entry.tier);

    if (!Array.isArray(entry.tools)) {
      return { valid: false, reason: `Test '${testName}' missing tools array` };
    }
    for (const toolRel of entry.tools) {
      const inPackage = path.join(toolsRootDir, toolRel.replace(/^tools\//, ""));
      const toolAbs = fs.existsSync(inPackage) ? inPackage : path.join(root, toolRel);
      if (!fs.existsSync(toolAbs)) {
        return { valid: false, reason: `Test '${testName}' references non-existent tool file: '${toolRel}'` };
      }
    }

    if (!Array.isArray(entry.artifacts)) {
      return { valid: false, reason: `Test '${testName}' missing artifacts array` };
    }
    for (const art of entry.artifacts) {
      if (!ALLOWED_CONSUMER_NAMES.has(art)) {
        return { valid: false, reason: `Test '${testName}' references unknown artifact consumer '${art}'` };
      }
    }

    if (!Array.isArray(entry.requiredBy)) {
      return { valid: false, reason: `Test '${testName}' missing requiredBy array` };
    }
    for (const req of entry.requiredBy) {
      if (!ALLOWED_CONSUMER_NAMES.has(req)) {
        return { valid: false, reason: `Test '${testName}' requiredBy contains unknown consumer '${req}'` };
      }
      if (!entry.artifacts.includes(req)) {
        return { valid: false, reason: `Test '${testName}' requiredBy consumer '${req}' is not declared in artifacts array` };
      }
    }

    if (entry.criticality !== "critical" && entry.criticality !== "normal") {
      return { valid: false, reason: `Test '${testName}' has invalid criticality '${entry.criticality}'` };
    }

    if (!Array.isArray(entry.allowedModes) || entry.allowedModes.length === 0) {
      return { valid: false, reason: `Test '${testName}' has invalid allowedModes array` };
    }
    for (const m of entry.allowedModes) {
      if (!ALLOWED_MODES.has(m)) {
        return { valid: false, reason: `Test '${testName}' has unknown allowedMode '${m}'` };
      }
    }

    if (entry.criticality === "critical" && entry.releaseSameRun !== true) {
      return { valid: false, reason: `Critical test '${testName}' must have releaseSameRun = true` };
    }
  }

  // Verify tier union matches filesOnDisk 100%
  const allTierFiles = [
    ...TEST_TIERS.unit,
    ...TEST_TIERS.contract,
    ...TEST_TIERS.integration,
    ...TEST_TIERS.meta,
  ].sort();

  if (allTierFiles.length !== filesOnDisk.length || !allTierFiles.every((f, i) => f === filesOnDisk[i])) {
    return { valid: false, reason: "Tier union does not match files on disk 1:1" };
  }

  const criticalCount = Object.values(CANONICAL_TEST_REGISTRY).filter((e) => e.criticality === "critical").length;
  const releaseSameRunCount = Object.values(CANONICAL_TEST_REGISTRY).filter((e) => e.releaseSameRun === true).length;

  return {
    valid: true,
    totalTests: filesOnDisk.length,
    criticalTests: criticalCount,
    releaseSameRunTests: releaseSameRunCount,
    tiers: {
      unit: TEST_TIERS.unit.length,
      contract: TEST_TIERS.contract.length,
      integration: TEST_TIERS.integration.length,
      meta: TEST_TIERS.meta.length,
    }
  };
}

# Context & Technical Handoff: Code Protection, AST Obfuscation, and De-modularization (Spaghettification) Engine

> **Target Audience:** Autonomous AI Agents, Senior Systems Engineers, and DevSecOps Reviewers.  
> **Source Repository:** `/Users/moeini/Documents/ideas/extend-kit/wp-starter-kit`  
> **Active Git Branch:** `codex/protection-pilot`  
> **Primary Package Directory:** `packages/standalone-build/`  
> **Related WordPress Content Root:** `/Users/moeini/Dev/tavangary.new/wordpress/wp-content`  
> **Target Consumer Plugins:** `tavangary-core`, `tavangary-theme-panel`, `wpdev-crm`, `wpdev-tickets`  
> **Last Updated:** 2026-09-10

---

## 1. Executive Summary & Core Motivation

### 1.1 The Original Problem Statement

In WordPress/WooCommerce enterprise development with custom boilerplates (like `wp-starter-kit` / `wpdev`), two competing business and engineering priorities emerge:

1. **Internal Development Health (Clean Git Source):**
   - Developers need a modern, testable, modular architecture.
   - Shared modular framework (`wpdev-framework`), abstract base classes (`AbstractModule`, `Base_Admin_Page`), dependency injection, typed contracts, clean PSR-4 namespaces, and comprehensive PHPUnit/Playwright test suites.
2. **Commercial Distribution & Client Handover (Single-Use Legacy Spaghetti Artifact):**
   - When plugins are distributed to clients or deployed to customer-accessible servers (via FTP, hosting panels, or shared environments), **shipping clean, modular source code creates a severe IP and framework theft risk**.
   - If the client or an external developer can easily copy the modular `wpdev` core framework, inspect clean admin-page builders, or extract reusable components, they gain the entire internal toolchain for free.
   - Conversely, standard full-project commercial encryption (e.g., IonCube / SourceGuardian) requires proprietary PHP extensions on the client server, which is frequently disallowed or unavailable in shared hosting, breaks PHP version compatibility, and complicates CI/CD.

### 1.2 The Architectural Objective

Transform clean modular source code during the build stage (`dist/`) into an **unencoded, highly coupled, de-modularized, and obfuscated single-use artifact ("Spaghetti Code")**:

- The output must look and act like monolithic, legacy, tangled code that is so tightly coupled to that specific plugin and database schema that extracting any generic framework component is economically impractical (rebuilding clean from scratch is easier than reverse-engineering the transformed slice).
- **Line in the Sand (خط قرمز پروژه): ZERO FUNCTIONAL REGRESSIONS.**
  The transformed plugin must exhibit 100% execution, runtime, hook, REST, Ajax, translation, and database parity with the clean original source.

---

## 2. The Three Strategic Plans (Evolution & Architecture)

The protection system was developed through three distinct architectural plans documented across the repositories:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        Source Code in Git (Clean & Modular)                           │
│           (packages/wpdev-framework + plugins/*-dev + PSR-4 Namespaces)               │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ [Plan 1: De-modularization & Spaghetti Coupling]                                       │
│ ├─ Class Inlining: Flatten abstract ancestors directly into leaf classes               │
│ ├─ Namespace Eradication: Strip WPDev\..., replace with hashed plugin prefix           │
│ └─ Tight Coupling: Hardcode DB queries, table constants, and plugin-specific checks    │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ [Plan 2: Hybrid Code Protection & Multi-Factor DRM Licensing]                          │
│ ├─ Multi-Factor Fingerprint: Domain (HTTP_HOST) + ABSPATH + DB Prefix + Ed25519       │
│ ├─ HMAC Integrity Check & Poison Pill (silent decay on code modification)              │
│ └─ Commercial Bytecode (SourceGuardian/ionCube) -> Evaluated & marked Out-of-Scope       │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ [Plan 3: Safe AST Obfuscator & Spaghettification Engine (Profile S)]                    │
│ ├─ Step 1: Rector PHP 7.4 Syntax Downgrade (PHP 8.x -> 7.4 compatibility)              │
│ ├─ Step 2: Inlining Framework Closure (inline-wpdev-closure.mjs)                       │
│ ├─ Step 3: AST/Token Transformer (plan3/transformer.php & safe-ast-obfuscator.php)     │
│ │   ├─ Symbol Mangling: Classes (_c_...), Functions (_f_...), Variables ($_v_...)     │
│ │   ├─ 100% DocBlock & Comment Stripping (Preserves WordPress plugin header)           │
│ │   ├─ Whitespace Compaction (Minification & Spaghetti inlining)                       │
│ │   └─ Strict Preservation: WP hooks, filters, globals, WooCommerce, SQL, gettext      │
│ └─ Step 4: Hermetic ZIP Packaging, Manifest & WAL Deployment Engine                    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Plan 1: De-modularization, Class Inlining & Spaghetti Coupling

- **Class Inlining (De-abstraction):** In Git, classes extend `WPDev\Core\AbstractModule` or implement `ModuleInterface`. During the build, ancestor methods are copied directly into the leaf classes; `extends AbstractModule` and `implements ...` are stripped; `parent::...` calls are resolved locally.
- **Framework Eradication & Scoping:** The `WPDev` namespace and folder (`packages/framework`) are 100% eliminated from the output artifact. Each plugin receives an isolated, hashed prefix/namespace.
- **Tight Coupling Injection:** Dynamic config structures (like generic form builders or admin page registries) are transformed to hardcoded, plugin-specific database queries and table checks. If someone extracts the admin page code into another plugin, it immediately crashes due to missing internal database dependencies.

### Plan 2: Hybrid Protection & Multi-Factor DRM Licensing

- **Multi-Factor Fingerprint Engine:**
  1. Normalized domain (`HTTP_HOST` stripped of port and `www.`).
  2. Hash of physical path (`ABSPATH`) to stop direct folder moves.
  3. Database table prefix anchor (`$wpdb->prefix`) combined with an installation key.
  4. Asymmetric signature verification using Ed25519.
- **HMAC Integrity Check & Poison Pill:**
  - Build-time SHA-256 file manifest.
  - Runtime check: If any core file is altered, rather than throwing a loud `License Error` (which tells hackers where to patch), the plugin enters "silent decay" (returning empty queries or subtle no-ops).
- **Status of Commercial Bytecode (SourceGuardian / ionCube):**
  - Officially evaluated and categorized as **`Profile A / Blocked / Out of Scope`** for standard releases. Because local CI lacks commercial binary compilers and customer servers lack commercial PHP loaders, **Profile S (Plan 3)** was engineered as the primary unencoded production path.

### Plan 3: Safe AST Obfuscation & Spaghettification Engine (Profile S)

- **Feasibility & Stop-Loss Gate:** A formal 324-line feasibility document (`plan-safe-obfuscation-spaghetti.md`) established legal, economic, and technical stop-loss thresholds.
- **Safety First:** Pure PHP token manipulation via native `token_get_all()` guarantees zero corruption of string literals, SQL statements, HTML templates, and gettext format strings (`%1$s`).
- **Profile S Output Definition:** A standalone, non-encoded, single-root ZIP artifact that runs on PHP 7.4–8.3+ without external dependencies.

---

## 3. Tooling & Pipeline Architecture

The primary implementation lives in `packages/standalone-build/` in `wp-starter-kit`:

```text
packages/standalone-build/
├── build-all-standalone-plugins.mjs   # Master CLI orchestrator and build pipeline
├── build-dag-runner.mjs               # Directed Acyclic Graph (DAG) parallel build engine (--jobs=N)
├── build-cache-engine.mjs             # Composite SHA-256 fingerprinting (schema v2) & WAL journal
├── inline-wpdev-closure.mjs           # Extracts & scopes required wpdev modules into src/FrameworkClosure
├── assemble-profile-s-candidate.mjs   # Coordinates the complete Profile S assembly workflow
├── rector-downgrade-php74.php         # AST Rector downgrade pass (PHP >=8.0 down to PHP 7.4)
├── plan3/
│   └── transformer.php                # High-speed token/AST symbol mangler & spaghettifier
├── safe-ast-obfuscator.php            # Token-safe AST obfuscator engine
├── heavy-obfuscator.php               # Deep control-flow flattening and symbol mangler
├── verify-profile-s-artifact.mjs      # Black-box runtime & syntax verifier for assembled ZIPs
├── canonical-artifact-manifest.mjs    # Single-root ZIP & embedded SHA-256 manifest inspector
├── deploy-standalone-plugin.mjs       # Atomic deployment engine with sibling staging
├── SOP_PRODUCTION_PLUGIN_DEPLOYMENT.md # Deployment Standard Operating Procedure
├── test-dependency-registry.mjs       # Single source of truth for test metadata & 72 canonical test files
├── test-impact-map.mjs                # Git diff -> Impacted test suite resolver
└── tests/                             # 72 canonical hermetic test suites (509+ subtests)
```

### 3.1 The 6-Stage Build Execution Flow

When running `node packages/standalone-build/build-all-standalone-plugins.mjs --obfuscate --deploy --jobs=4`:

1. **DAG Dependency & Cache Check (`build-cache-engine.mjs`):**
   - Computes composite SHA-256 fingerprints across plugin source files, toolchain scripts, PHP-Parser/Rector versions, and configuration.
   - If cache matches, reuses previous verified candidate (warm no-op in ~360ms).
2. **Framework Closure Inlining (`inline-wpdev-closure.mjs`):**
   - Copies required `wpdev-framework` modules into `src/FrameworkClosure/` within the plugin candidate tree.
   - Mirrors unminified assets alongside `.min.js` / `.min.css` to prevent 404 errors when WordPress runs with `define('SCRIPT_DEBUG', true)`.
   - Normalizes duck-typed module loaders (`ModuleLoader::register(object)`) to allow multiple standalone plugins to coexist without type conflicts.
3. **Rector PHP 7.4 Syntax Downgrade (`rector-downgrade-php74.php`):**
   - Downgrades modern PHP syntax (match expressions, union types, nullsafe operators, constructor property promotion) to strict PHP 7.4 syntax.
4. **AST Obfuscation & Spaghettification (`plan3/transformer.php`):**
   - **Pass 1 (`--dump-map`):** Inventories all symbols, classifying them into internal vs preserved.
   - **Pass 2 (`--batch`):**
     - Renames internal classes to `_c_<hash>`, functions to `_f_<hash>`, constants to `_k_<hash>`, private methods to `_m_<hash>`, private properties to `_p_<hash>`, and local variables to `$_v_<hash>`.
     - Strips 100% of DocBlocks, comments, and developer documentation (except the root WordPress plugin header comment: `/* Plugin Name: ... */`).
     - Condenses whitespace, removing empty lines and structural formatting into compact code blocks.
5. **Autoload Reconstruction & Verification (`verify-profile-s-artifact.mjs`):**
   - Re-dumps the classmap autoload dictionary without dev packages.
   - Runs `php -l` on every single generated PHP file.
   - Audits that **zero DocBlocks** leaked into internal files.
   - Validates class completeness and custom database schema definitions (e.g., BerlinDB).
6. **Hermetic Packaging & Transactional WAL Deployment (`deploy-standalone-plugin.mjs`):**
   - Generates deterministic single-root ZIP archive with `artifact-manifest.json`.
   - Deploys via Write-Ahead Log (WAL) journal:
     - Extracts ZIP into a temporary sibling staging directory (`plugins/.staging-<plugin>-<tx>`).
     - Executes post-extract sanity check.
     - Backs up current active plugin to `.backup-tx-<timestamp>`.
     - Performs atomic directory rename.
     - If anything fails, triggers automatic fail-closed rollback.

---

## 4. Preservation Contracts: What the Obfuscator NEVER Touches

To guarantee **zero runtime regressions**, `plan3/transformer.php` and `safe-ast-obfuscator.php` enforce strict whitelist preservation rules:

### A. WordPress Core APIs & Globals

- **Globals:** `$wpdb`, `$wp_query`, `$post`, `$wp_version`, `$menu`, `$submenu`, `$pagenow`, `$wp_filter`, `$wp_scripts`, `$wp_styles`, `$_GET`, `$_POST`, `$_REQUEST`, `$_SERVER`, `$_COOKIE`, `$_SESSION`, `$GLOBALS`, `$this`.
- **Core Functions & Hooks:** All hook strings registered via `add_action()`, `add_filter()`, `do_action()`, `apply_filters()`, options APIs (`get_option`, `update_option`), post meta APIs, and escaping functions.

### B. WooCommerce & Third-Party Bridges

- Public classes and interfaces extending WooCommerce: `WC_Product_*`, `WC_Order_*`, `WC_Payment_Gateway`, etc.
- Action Scheduler jobs, parameters, and hook names.
- Public REST API route callbacks and permission checks (`rest_api_init`).

### C. String Literals, SQL Queries & i18n

- String literals are **never** altered or encrypted at runtime (runtime decryption introduces CPU overhead, opcache penalties, and eval vulnerabilities).
- SQL statements (`$wpdb->prepare(...)`) remain character-exact.
- Gettext translation calls (`__()`, `_e()`, `_n()`, `_x()`) and placeholder tokens (`%1$s`, `%2$d`, `%s`) are strictly preserved.

### D. Special WordPress & Framework Hierarchy Rules

- Classes extending `WP_List_Table` (such as `Base_List_Table` in admin dashboards) retain their exact inheritance and class names.
- Dynamic callbacks checked via `function_exists()` or `is_callable()` are identified during Pass 1 and exempted from mangling.

---

## 5. Testing Architecture, Quality Gates & Performance Optimization

### 5.1 Test Suites & Tiers (`CANONICAL_TEST_REGISTRY`)

The package includes **72 canonical hermetic test suites** registered in `packages/standalone-build/test-dependency-registry.mjs`:

| Tier               | File Count | Scope & Purpose                                                                                                                       |
| :----------------- | :--------: | :------------------------------------------------------------------------------------------------------------------------------------ |
| **`unit`**         |  18 files  | Fast, isolated tests for utilities, parsers, and manifest inspectors.                                                                 |
| **`contract`**     |  35 files  | Verifies structural contracts, fail-closed gates, and schema invariants.                                                              |
| **`fast`**         |  53 files  | Combined `unit` + `contract` (~8s execution time).                                                                                    |
| **`meta`**         |   1 file   | Tests the test runner and scheduler itself (`test-scheduler-and-tiers.test.mjs`) with isolated synthetic fixtures.                    |
| **`integration`**  |  2 files   | End-to-end build and pipeline verification.                                                                                           |
| **`full`**         |  72 files  | Complete canonical test inventory.                                                                                                    |
| **`docker-smoke`** |   1 file   | Docker container smoke test (`tests-docker/docker-runtime-smoke.test.mjs`), validating standalone artifacts in an isolated container. |

### 5.2 Key Remediation Milestones (History of Fixes)

1. **Elimination of Recursive Subprocess Spawning (392s -> 5.2s):**
   - _Previous Bug:_ Running the test scheduler invoked tests that re-invoked `runTestScheduler()` recursively, causing process explosion and timeouts.
   - _Fix:_ Isolated meta-tests into tiny synthetic fixtures (< 50ms) and added recursion environment guards (`__ANTIGRAVITY_RUN_TESTS_ACTIVE`). Full suite execution dropped to ~5.2 seconds.
2. **Decoupling Benchmarks from Unit Tests:**
   - Moved heavy multi-minute production builds out of unit test suites into a dedicated benchmark tool (`packages/standalone-build/dev/run-benchmark.mjs`). Unit regression tests use primed fixtures and mocks.
3. **Dynamic Scopes & `function_exists` Callback Recognition (Commit `87c8caa`):**
   - Fixed transformer issue where parameters in dynamic scopes and callback names verified via `function_exists()` were incorrectly mangled.
4. **Asset Mirroring for `SCRIPT_DEBUG` (Commit `6e2ab24`):**
   - Fixed 404 errors on production sites running `SCRIPT_DEBUG=true` by ensuring unminified source assets are mirrored alongside `.min` files during inlining.
5. **Atomic WAL Deployment & Crash Rollback:**
   - Implemented `TransactionJournalManager` with `deepFreeze` snapshot immutability, ensuring broken builds never corrupt live plugin folders.

---

## 6. How to Run, Build & Test (Agent Runbook)

### 6.1 Running Tests

From the `packages/standalone-build` directory (or repository root):

```bash
# Set content root pointing to your local WordPress installation
export WPDEV_CONTENT_ROOT="/Users/moeini/Dev/tavangary.new/wordpress/wp-content"

# Run canonical test suite
npm test

# Run fast tier only
node packages/standalone-build/dev/run-tests.mjs --tier=fast --jobs=4

# Run specific test file
node --test packages/standalone-build/tests/verify-profile-s-artifact.test.mjs
```

### 6.2 Assembling & Obfuscating Standalone Plugins

```bash
# 1. Clean Build (framework inlined, no obfuscation)
node packages/standalone-build/build-all-standalone-plugins.mjs --build-only

# 2. Complete Profile S Obfuscation Build + Deploy (Parallelized)
node packages/standalone-build/build-all-standalone-plugins.mjs --obfuscate --deploy --jobs=4

# 3. Deploy an existing built candidate ZIP safely
node packages/standalone-build/deploy-standalone-plugin.mjs \
  dist/tavangary-core-profile-s.zip \
  tavangary-core
```

### 6.3 Per-Plugin Builds (From `*-dev` plugin root)

```bash
cd /Users/moeini/Dev/tavangary.new/wordpress/wp-content/plugins/tavangary-core-dev
npm run release              # Clean release artifact
npm run release:obfuscate    # Profile S obfuscated artifact
```

---

## 7. Rules & Invariants for Incoming Agents

When working on this repository, **you must strictly adhere to the following invariants**:

1. **NEVER modify files directly inside active production plugin directories (`plugins/tavangary-core/`, etc.):**
   Active directories are generated deployment targets. All development edits must occur in the source (`wp-starter-kit`, `wpdev-framework`, or `*-dev` plugin sources), followed by running the build pipeline.
2. **NEVER use `eval()`, runtime-generated PHP, or runtime string decryption:**
   Runtime decryption degrades OPcache performance, introduces security vulnerabilities, and triggers hosting WAF blocks. All transformations must be static AST/token mutations that produce standard, lintable PHP 7.4+ code.
3. **NEVER unzip directly over an existing live plugin directory:**
   Always use sibling directory extraction followed by an atomic directory swap via `deploy-standalone-plugin.mjs` / WAL journal.
4. **Preserve All Public Contracts:**
   If you add or modify transformer rules, always verify that WordPress hooks, filters, WooCommerce overrides, and gettext translation strings remain 100% untouched.
5. **Run the Full Test Suite Before Committing:**
   Run `npm test` and verify that all 72 test suites pass with zero skips and zero failures.

# AGENTS.md — Standalone Build Engine, Profile S AST Obfuscator & Transformation Manual

> **Target Audience:** Autonomous AI Agents, Senior Systems Engineers, and DevSecOps Reviewers.  
> **Canonical Package Path:** `/Users/moeini/Documents/ideas/extend-kit/wp-starter-kit/packages/standalone-build/`  
> **Thin Monorepo Wrapper:** `/Users/moeini/Dev/tavangary.new/wordpress/wp-content/build-standalone.mjs`  
> **Dist Output Locations:**
>
> - `/Users/moeini/Dev/tavangary.new/wordpress/wp-content/dist/`
> - `/Users/moeini/Dev/tavangary.new/dist/`  
>   **Last Updated:** 2026-09-05

---

## 1. Executive Summary & Core Mission

In the Tavangary / WPDev ecosystem, development happens in **clean, uncompiled source repositories** (`*-dev` plugins such as `tavangary-core-dev`, `tavangary-theme-panel-dev`, etc.) that depend on the active development framework (`wpdev`).

For **commercial client delivery, staging, and production release**, plugins must run completely **standalone without the `wpdev` parent plugin active**. The standalone build tooling provides:

1. **Framework Inlining (`inline-wpdev-closure.mjs`):** Inlines only the required parts of the `wpdev` framework into each plugin's `src/FrameworkClosure` without symbol collisions.
2. **PHP 7.4 Rector Downgrade (`rector-downgrade-php74.php`):** Ensures all syntax features downlevel cleanly to PHP 7.4 compatibility.
3. **Profile S PHP Token-Based Transformer (`plan3/transformer.php`):** Performs namespace-aware, token-stream symbol mangling (`_f_...`, `_c_...`, `_k_...`, `_m_...`, `_p_...`, `$_v_...`), local variable scrambling, comment/DocBlock stripping, and code obfuscation while preserving string literals, variable introspection scopes, and WordPress public APIs and hooks.
4. **Hermetic ZIP Packaging & Manifest Generation (`canonical-artifact-manifest.mjs`):** Builds deterministic single-root plugin ZIP archives with SHA-256 integrity digests.
5. **Transactional WAL Deployment (`build-cache-engine.mjs`):** Employs an immutable Write-Ahead Log (WAL) with automatic pre-swap staging, post-swap verification, and fail-closed rollback.
6. **Strict Verification Probes (`verify-profile-s-artifact.mjs`):** Executes black-box runtime and syntax linting (`php -l`), DocBlock leakage audits, and class completeness verification before authorizing deployment.

---

## 2. Monorepo & Tooling Architecture Map

```text
wp-starter-kit/packages/standalone-build/
├── build-all-standalone-plugins.mjs   # Master CLI orchestrator and pipeline runner
├── build-dag-runner.mjs               # Directed Acyclic Graph (DAG) dependency executor
├── build-cache-engine.mjs             # SHA-256 fingerprinting, cache store & WAL journal
├── inline-wpdev-closure.mjs           # wpdev framework closure inliner
├── assemble-profile-s-candidate.mjs   # Profile S pipeline assembly coordinator
├── rector-downgrade-php74.php         # AST Rector downgrade pass (PHP >=8.0 -> 7.4)
├── plan3/
│   └── transformer.php                # High-speed PHP token-based obfuscator / mangler (token_get_all)
├── safe-ast-obfuscator.php            # Safe AST obfuscation utility
├── heavy-obfuscator.php               # Heavy control-flow flattening & string encryption
├── verify-profile-s-artifact.mjs      # Black-box verification runner for assembled ZIPs
├── test-dependency-registry.mjs       # Canonical test matrix, tiers & required evidence
├── test-impact-map.mjs                # Git diff -> Impacted test suite resolver
├── canonical-artifact-manifest.mjs    # Single-root ZIP & embedded manifest inspector
├── deploy-standalone-plugin.mjs       # Thin CLI wrapper around atomicDeployPlugin (sibling staging)
├── SOP_PRODUCTION_PLUGIN_DEPLOYMENT.md # Never unzip onto the live plugin directory
└── tests/                             # Hermetic unit, contract & artifact test suites (81 files)
```

---

## 3. The Obfuscation & "Spaghetti-fication" Engine (Profile S)

Profile S is the standard production protection tier. It transforms readable source code into an obfuscated, tamper-resistant artifact without requiring proprietary PHP C-extensions (like ionCube).

### A. Rector PHP 7.4 Downgrade

Before code is mangled, it is processed via Rector (`rector-downgrade-php74.php`) with the target set to PHP 7.4. This transforms union types, match expressions, named arguments, and nullsafe operators into PHP 7.4-compatible syntax so the final plugin can run across any standard hosting provider.

### B. Plan 3 Transformer (`plan3/transformer.php`)

The core transformer is built on `nikic/php-parser` and operates in two passes:

1. **Pass 1: Pre-scan & Symbol Inventory (`--dump-map`):**
   - Scans the uncompiled plugin tree.
   - Discovers classes, interfaces, traits, enums, functions, and properties.
   - Categorizes symbols into **Internal (private to the plugin)** vs **Preserved (public contracts, WordPress hooks, third-party libraries)**.
   - Generates deterministic, seed-based mangled names (e.g. `_c_a8f1...` for classes, `_f_3d2e...` for functions, `_v_...` for variables).

2. **Pass 2: AST Mutation & Batch Transformation (`--batch`):**
   - Rewrites class definitions and instantiations to their mangled counterparts.
   - Maintains a `class_alias` bridge when backwards compatibility is explicitly declared.
   - Scrambles local variable names and parameter names.
   - Strips **all** DocBlocks, multiline comments, and developer notes (preserving only the mandatory WordPress plugin header in the main entry file).
   - Removes unnecessary formatting and whitespace, condensing the logic into dense, hard-to-read "spaghetti" code while preserving exact execution semantics.

### C. Public Contract & Hook Preservation Rules

The transformer preserves symbols if they match any of the following:

- WordPress Core globals and hooks (`admin_menu`, `init`, `rest_api_init`, `wp_enqueue_scripts`, etc.).
- WooCommerce hooks and method overrides (`WC_Product_*`, `woocommerce_*`).
- Framework public entry points and admin page classes registered in preserve lists (e.g., `Settings_Admin_Page`, `Base_Admin_Page`).
- REST endpoint callbacks and permission checks.

---

## 4. Framework Inlining (`inline-wpdev-closure.mjs`)

Because standalone plugins must run with `wpdev` disabled:

1. The inliner analyzes which modules of `wpdev` are used by the plugin (e.g., `modules/core`, `modules/settings`, `modules/field-builder`).
2. It extracts those classes and templates into `src/FrameworkClosure/` inside the plugin.
3. Class names and references are scoped to prevent collisions if multiple standalone plugins run concurrently on the same WordPress site (first-wins or isolated namespacing).
4. **Asset Mirroring:** Both minified (`.min.js`, `.min.css`) and unminified fallback sibling files are copied to prevent 404 errors when `SCRIPT_DEBUG` is enabled.
5. **Duck-Typed Module Loaders:** Normalizes `ModuleLoader::register()` signatures across plugins so that one plugin's loader does not reject another plugin's module instances.

---

## 5. Preflight Verification & Safety Gates

Before any candidate is zipped or deployed, the pipeline enforces strict safety gates:

1. **Eligibility Spike (`run-plan3-eligibility-spike.mjs`):**
   - Fails immediately if unsafe dynamic patterns are detected: `eval()`, `create_function()`, `preg_replace /e`.
2. **ModuleLoader Coexistence Gate (`module-loader-coexistence-gate.mjs`):**
   - Ensures all `register()` methods use duck-typed `object` typehints instead of strict class-locked interfaces.
3. **Artifact Black-Box Verifier (`verify-profile-s-artifact.mjs`):**
   - Extracts the assembled ZIP to a hermetic temporary directory.
   - Runs `php -l` on every single extracted PHP file.
   - Audits tokens to ensure **zero DocBlocks** leaked into internal files.
   - Verifies that `Plugin Name:` remains intact in the entry file.
   - Confirms that custom database schemas (e.g. BerlinDB in CRM/Tickets) instantiate without errors.
4. **WAL Transaction Journal (`build-cache-engine.mjs`):**
   - Records state in `.deploy-journal.json`.
   - Takes pre-swap backups (`.backup-tx-*`).
   - If any verification step fails, performs an atomic rollback to the previous working build.

---

## 6. CLI Usage & Standard Runbook

### Primary Build Command (From Repository Root or wp-content)

Always invoke via Node with `--obfuscate` when building for release or live testing:

```bash
# Recommended: Build, obfuscate with Profile S, test, and deploy to Docker plugins dir
cd /Users/moeini/Dev/tavangary.new/wordpress/wp-content
node build-standalone.mjs --deploy --force --obfuscate
```

Or directly via the engine:

```bash
cd /Users/moeini/Dev/tavangary.new/wordpress/wp-content
node /Users/moeini/Documents/ideas/extend-kit/wp-starter-kit/packages/standalone-build/build-all-standalone-plugins.mjs --deploy --force --obfuscate
```

### Useful CLI Flags

| Flag                          | Description                                                                                       |
| :---------------------------- | :------------------------------------------------------------------------------------------------ |
| `--deploy`                    | Automatically stages and swaps compiled plugins into `wp-content/plugins/{target}`.               |
| `--force`                     | Bypasses content cache and forces a complete rebuild of all target plugins.                       |
| `--obfuscate` / `--profile=s` | **Crucial:** Enables Rector downgrade and Plan 3 AST symbol mangling/comment stripping.           |
| `--target=<name>`             | Builds only a single plugin (e.g. `--target=tavangary-core` or `--target=tavangary-theme-panel`). |
| `--suite=<name>`              | Selects a specific test suite: `fast`, `contract`, `artifact`, or `full`.                         |
| `--test-mode=<name>`          | Sets the test resolver mode: `affected`, `contract`, `release`, or `docker-smoke`.                |

### Production ZIP swap (never unzip in place)

Do not extract a plugin ZIP onto the live `plugins/{slug}` directory. That race is what produced `autoload_real.php` `Failed opening required .../functions-closure.php`. Canonical docs: `SOP_PRODUCTION_PLUGIN_DEPLOYMENT.md`.

```bash
# Already-built ZIP: sibling extract + two sequential renames (not one atomic syscall)
node build-standalone.mjs --deploy-zip=/path/to/tavangary-core-profile-s.zip tavangary-core
```

ZIP entry order (bootstrap / `autoload.files` targets before `vendor/autoload.php`) is complementary only. Do not wrap Composer `require` in `file_exists`. Two `rename`s still have a brief “plugin missing” window; that is not zero-downtime and is not this Fatal.

### Running the Standalone Build Test Suite

The build tool has its own comprehensive test suite (81 canonical files) verifying token-based transformation, WAL rollback, inliner hygiene, and manifest stability. A green run requires `php`, `composer`, `zip`, `unzip`, and `rsync` on `PATH`:

```bash
cd /Users/moeini/Documents/ideas/extend-kit/wp-starter-kit/packages/standalone-build
npm test
```

---

## 7. Critical Rules for AI Agents & Engineers

> [!IMPORTANT]
> **Rule 1: NEVER edit built plugins directly.**  
> Directories without `-dev` (e.g. `wp-content/plugins/tavangary-core/`) are compilation targets. All edits MUST be made in `wp-content/plugins/*-dev/` or in `wp-starter-kit/`. Any direct edits to compiled plugins will be lost on the next build.

> [!IMPORTANT]
> **Rule 2: ALWAYS pass `--obfuscate` when preparing artifacts or testing deployment.**  
> If you omit `--obfuscate`, the pipeline executes in `[Clean Build]` mode. While fast, the resulting artifacts will NOT have comments stripped or symbols mangled, which will cause the pipeline's artifact verification tests to fail.

> [!WARNING]
> **Rule 3: Beware of `doing_action('wpdev_admin_pages')` in modules.**  
> In standalone plugins, `wpdev_admin_pages` is triggered during lifecycle boot. Do not add guards like `! doing_action('wpdev_admin_pages')` when registering admin pages, or your menus will silently fail to register. Use `wpdev_register_module_admin_pages()` which automatically executes immediately if the hook is already firing or has completed.

> [!TIP]
> **Rule 4: Syncing Production Dist ZIPs.**  
> When a new build completes, verify that the freshly compiled ZIP archives in `wordpress/wp-content/dist/` are mirrored to the root `/Users/moeini/Dev/tavangary.new/dist/` directory for production upload.

# AGENTS.md — Master Architecture & Agent Operational Guide for `wp-starter-kit`

> **Target Audience:** Autonomous AI Coding Agents, Senior Systems Engineers, and Core Contributors.  
> **Repository Root:** `/Users/moeini/Documents/ideas/extend-kit/wp-starter-kit`  
> **Active Development Branch:** `codex/protection-pilot`  
> **Project Type:** Modular WordPress/WooCommerce Plugin Boilerplate, CLI Scaffolder & Standalone Obfuscation Monorepo.  
> **Last Updated:** 2026-09-10

---

## 1. Executive Summary & Monorepo Mission

`wp-starter-kit` is an enterprise-grade, monorepo-based development boilerplate and build system for WordPress and WooCommerce plugins. It bridges modern software engineering practices with WordPress's legacy ecosystem:

1. **Modular Source Development (`src/` & `packages/wpdev-framework`):**
   - Clean, testable, object-oriented PHP architecture based on `ModuleLoader` and `ModuleInterface`.
   - Modern JavaScript/TypeScript client builds with Preact/React aliasing and the Polaris Design System (`packages/polaris-stack/`).
   - Standard PSR-4 namespacing, comprehensive Jest and PHPUnit test harnesses, static analysis (PHPStan level 2+), and WPCS linting.
2. **Scaffolding & Lifecycle Tooling (`packages/create-wp-project`):**
   - CLI engine (`wpdev` / `npm run scaffold`) that generates and manages plugins from a declarative feature catalog (`features.js`).
   - Pure dry-run update planning (`wpdev update`) and automated migrations (`wpdev update --run`).
3. **Production Distribution & Standalone Hardening (`packages/standalone-build`):**
   - Standalone plugin packager that inlines required framework closures (`src/FrameworkClosure/`) so client plugins run without a parent framework dependency.
   - **Profile S AST Obfuscator & Spaghettification Engine:** Strips 100% of internal DocBlocks/comments, mangles internal symbols (`_c_...`, `_f_...`, `_p_...`, `$_v_...`), downlevels syntax to PHP 7.4 via Rector, and compresses code into a dense single-use legacy structure to prevent framework theft.
   - **Zero-Regression Invariant:** Enforces strict whitelist preservation for WordPress hooks, filters, globals, WooCommerce APIs, and gettext translations.
   - **Transactional Write-Ahead Log (WAL):** Atomic staging and fail-closed crash rollback during deployment.

---

## 2. Monorepo Directory Map

```text
wp-starter-kit/
├── wpdev-starter.php                  # Main starter plugin entrypoint
├── wpdev.json                         # PRIMARY SOURCE OF TRUTH: Branding, features & runtime config
├── composer.json / package.json       # Monorepo dependencies, npm workspaces & Composer path repositories
├── phpstan.neon / phpcs.xml           # Static analysis and WordPress Coding Standards rules
├── phpunit.xml.dist / jest.config.mjs # PHPUnit & Jest test configurations
│
├── src/                               # Starter plugin core implementation
│   ├── Core/                          # Plugin bootstrap, ModuleLoader, ModuleInterface
│   ├── Modules/                       # Built-in feature modules (Blocks, McpAbilities, etc.)
│   ├── Support/                       # Infrastructure: REST handlers, Shortcodes, Auth, Assets
│   └── Adapters/                      # Bridges to WPDev admin framework
│
├── packages/                          # Monorepo packages & sub-systems
│   ├── standalone-build/              # Production assembler, Profile S AST obfuscator, WAL journal & 72 test suites
│   ├── create-wp-project/             # CLI scaffolder, feature catalog, migration engine & health doctor
│   ├── cli/                           # wpdev CLI binary wrapper
│   ├── wpdev-framework/               # Core admin framework (Admin pages, list tables, settings, field builders)
│   ├── wpdev-bridge/                  # Bridge layer between plugins and framework
│   ├── polaris-stack/                 # (Git Submodule) Polaris Design System UI components & dark mode
│   ├── mcp-integration/              # WordPress Abilities API & Model Context Protocol (MCP) integration
│   ├── php-fault-tolerance/           # Circuit breaker, HTTP batching & retry handlers (PHP 8.1+)
│   ├── php-test-tools/                # Test utilities, assertions, and patch runner
│   ├── plugin-core-test/              # Base test cases for integration testing
│   ├── rest-utils/                    # Batch REST client & fetch utilities
│   ├── hooks/ / html-utils/ / utils/  # Lightweight TypeScript/PHP cross-cutting helpers
│   ├── rule-engine/                   # Conditional rules & dynamic evaluation engine
│   ├── translation/                   # Gettext translation compiler & extraction scripts
│   └── ui-components/                 # Reusable Preact/React UI elements
│
├── core/packages/                     # JS build workspaces (esbuild orchestration)
│   ├── build/                         # CLIs for dependencies, components, styles & assets
│   ├── dependency-extraction-esbuild-plugin/ # Emits WordPress .asset.php sidecars
│   └── utils/                         # Config readers and build helpers
│
├── dev/                               # Build & release development scripts
│   ├── rector-build.php / rector-upgrade.php # Syntax downgrade and upgrade rules
│   ├── rector-prefix.php              # Strauss vendor namespace prefixer
│   └── translation/                   # Translation generation and compile helpers
│
├── docs/                              # Comprehensive architecture, API, and module guides
│   ├── architecture.md                # System overview and core principles
│   ├── build-system.md                # 4-stage JS/CSS build pipeline
│   ├── module-guide.md                # How to build and register modules
│   ├── vendor-scoping.md              # Strauss scoping and conflict prevention
│   └── obfuscation-and-spaghettification-handoff.md # Pointer to protection engine context
│
├── tests/                             # Root Jest suites (980+ tests) & tests/phpunit/
└── dist/                              # Local scaffold and build outputs (gitignored)
```

---

## 3. Core Architecture & Invariants

### 3.1 Single Source of Truth: `wpdev.json`

All plugin behavior, identity, and build settings originate from `wpdev.json`. Never hardcode identifiers that can be derived from this configuration:

- `slug`, `globalName`, `localizeVar`, `textDomain`, `hookPrefix`, `npmScope`.
- `uiFramework`: `preact` or `react` (aliased at install time via `react -> @preact/compat`).
- `phpMinVersion` (e.g. `7.4`) vs `phpSourceVersion` (e.g. `8.1`). Code is authored in modern PHP and automatically downgraded to `phpMinVersion` via Rector on release.
- `vendorPrefix`: Namespace prefix used by Strauss for third-party dependencies in `dist/`.

### 3.2 PHP Module System

Plugins boot through `src/Core/Plugin.php`:

- `ModuleLoader` discovers and initializes any class implementing `src/Core/ModuleInterface`.
- Modules live in `src/Modules/{ModuleName}/` and must remain self-contained.
- If a module includes frontend assets, entries reside in `src/Modules/{ModuleName}/assets/entries/*.{ts,tsx}` and compile automatically into `assets/bundles/{Module}-{entry}.js`.
- Duck-Typed Module Registration: In standalone/inlined builds, module loaders accept `object` to allow plugins to coexist without strict type-locking collisions.

### 3.3 The 4-Stage Client Build Pipeline

Managed by esbuild via `npm run build` or `npm run dev`:

1. `build:dependencies`: Extracts vendor libraries into `{slug}-deps.js` with `.asset.php` sidecar.
2. `build:components`: Scans module entries and compiles Preact/React/Polaris components.
3. `build:styles`: Bundles CSS with content-hash sidecars.
4. `build:assets`: Synchronizes third-party assets from `node_modules` into `assets/libraries/`.

---

## 4. Standalone Build, AST Obfuscation & Hardening (Profile S)

When plugins are packaged for client handoff or production deployment, `packages/standalone-build` executes the protection pipeline:

```
[Clean Source in Git] ───► [inline-wpdev-closure.mjs] ───► [rector-downgrade-php74.php]
                                                                   │
                                                                   ▼
[Hermetic Candidate ZIP] ◄─── [verify-profile-s-artifact] ◄─── [plan3/transformer.php]
            │
            ▼
[deploy-standalone-plugin.mjs] ──(Transactional WAL + Atomic Swap)──► [Live Plugin]
```

### Critical Preservation Rules (Zero-Regression Invariant)

The transformer (`plan3/transformer.php`) strips comments, mangles internal symbols, and compacts whitespace, but **MUST NEVER TOUCH**:

1. **WordPress Core APIs:** Globals (`$wpdb`, `$_POST`, `$_GET`, etc.), actions/filters (`add_action`, `apply_filters`), option names, and post meta keys.
2. **WooCommerce Integrations:** Public classes extending `WC_Product_*`, `WC_Order_*`, and checkout action hooks.
3. **Strings, SQL & Translations:** All SQL queries (`$wpdb->prepare`), HTML templates, and gettext translation strings (`__('Text', 'domain')`, `%1$s`).
4. **`WP_List_Table` Ancestry:** Classes extending WordPress table classes (e.g. `Base_List_Table`) must keep exact inheritance.

_(For exhaustive architectural details, refer to [`packages/standalone-build/OBFUSCATION_AND_SPAGHETTIFICATION_CONTEXT.md`](packages/standalone-build/OBFUSCATION_AND_SPAGHETTIFICATION_CONTEXT.md))._

---

## 5. Developer & Agent Operational Workflows

### 5.1 Environment Setup & First-Time Bootstrap

```bash
# Install npm dependencies across all workspaces and Composer packages
npm install
composer install --ignore-platform-req=php --no-scripts
composer scope:vendor
```

### 5.2 Day-to-Day Development

```bash
# Watch mode for TypeScript, CSS, and Preact components
npm run dev

# Check configuration and runtime validity
npm run check

# TypeScript typechecking
npm run typecheck

# Code formatting and linting
npm run lint:js
composer validate:phpstan
composer validate:cs
```

### 5.3 Test Execution

```bash
# Run all root Jest suites (980+ tests)
npm test

# Run root PHPUnit tests
composer test

# Run standalone build test suites (72 canonical files)
export WPDEV_CONTENT_ROOT="/path/to/wordpress/wp-content"
cd packages/standalone-build && npm test
```

### 5.4 Standalone Building & Obfuscation

```bash
# Clean standalone build (framework inlined, no obfuscation)
node packages/standalone-build/build-all-standalone-plugins.mjs --build-only

# Complete Profile S obfuscation + atomic deploy with 4 workers
node packages/standalone-build/build-all-standalone-plugins.mjs --obfuscate --deploy --jobs=4

# Deploy existing ZIP safely via sibling staging and WAL rollback
node packages/standalone-build/deploy-standalone-plugin.mjs dist/plugin-profile-s.zip plugin-slug
```

### 5.5 Scaffolding New Plugins

```bash
# Scaffold a new modular plugin using the CLI engine
npm run scaffold -- --slug=my-custom-plugin --name="My Custom Plugin"

# Check project health
npm run doctor

# Inspect available features
npm run add-feature -- --list
```

---

## 6. Strict Rules & Guardrails for AI Agents

1. **Test-Driven Development (TDD):**
   - Always write or update tests before or concurrently with code edits.
   - When modifying `packages/standalone-build/`, verify that `packages/standalone-build/test-dependency-registry.mjs` remains synchronized with the 72 test suites.
2. **Never Edit Deployed/Active Plugin Folders Directly:**
   - Files under `/wordpress/wp-content/plugins/{slug}/` are generated build targets.
   - Always make code modifications in the source trees (`src/`, `packages/`, or `*-dev` folders), then run the build pipeline.
3. **No Unsafe Execution or Runtime Decryption:**
   - Do NOT introduce `eval()`, `create_function()`, `preg_replace /e`, runtime PHP file generation, or runtime string decryption. All code must remain clean, static PHP 7.4+ compatible syntax.
4. **Never Unzip Directly onto Active Plugins:**
   - Overwriting active plugin folders causes fatal errors for concurrent requests. Always extract to sibling staging directories and perform atomic renames via the WAL journal (`deploy-standalone-plugin.mjs`).
5. **Preserve WordPress Security Standards:**
   - Always verify nonces on form submissions and Ajax actions.
   - Always verify capabilities via `current_user_can()`.
   - Sanitize inputs (`sanitize_text_field`, `wp_unslash`) and escape outputs (`esc_html`, `esc_attr`, `wp_kses_post`).
   - Use `$wpdb->prepare()` for all custom SQL queries.
   - Set a strict `permission_callback` on all REST API routes.
6. **Preserve Vendor Scoping:**
   - Never commit un-scoped third-party Composer packages to production distributions. Always run `composer scope:vendor` (Strauss) to ensure clean namespace prefixes.

---

## 7. Key Documentation Links

- **Protection & Obfuscation Master Guide:** [`packages/standalone-build/OBFUSCATION_AND_SPAGHETTIFICATION_CONTEXT.md`](packages/standalone-build/OBFUSCATION_AND_SPAGHETTIFICATION_CONTEXT.md)
- **Deployment SOP:** [`packages/standalone-build/SOP_PRODUCTION_PLUGIN_DEPLOYMENT.md`](packages/standalone-build/SOP_PRODUCTION_PLUGIN_DEPLOYMENT.md)
- **Full Obfuscator Audit & Remediation Log:** [`packages/standalone-build/FULL_BUILD_OBFUSCATOR_AUDIT_AND_REMEDIATION.md`](packages/standalone-build/FULL_BUILD_OBFUSCATOR_AUDIT_AND_REMEDIATION.md)
- **General Architecture:** [`docs/architecture.md`](docs/architecture.md)
- **Build System Reference:** [`docs/build-system.md`](docs/build-system.md)
- **Module Authoring Guide:** [`docs/module-guide.md`](docs/module-guide.md)
- **CLI & Scaffolding Reference:** [`docs/cli-reference.md`](docs/cli-reference.md)

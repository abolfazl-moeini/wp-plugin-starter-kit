# AGENTS — AI coding agent instructions for wpdev-framework

> **Parent Monorepo Master Guide:** Refer to the root [`../../AGENTS.md`](../../AGENTS.md) for full monorepo architecture, testing tiers, and build pipelines.

## Purpose
Provide AI coding agents with the actionable context needed to work productively within `packages/wpdev-framework`.

## Key Facts
- **Part of Monorepo:** This package is managed as part of the `wp-starter-kit` monorepo.
- **Automated Testing & Tooling:** Automated tests run from the repository root via PHPUnit (`composer test`) and Jest (`npm test`). Standalone builds, framework inlining, and Profile S obfuscation are tested in `packages/standalone-build/` (`npm test`).
- **Framework Role:** Provides the base admin framework (admin page builder, settings engine, list tables, field renderers, and notice managers) used across modular plugins.

## Key Files and Directory Structure
- **Entrypoint:** `wpdev.php` — boots the framework and registers core hooks.
- **Modules (`modules/`):** Primary implementation units:
  - `admin-page-builder/`: Declarative admin screen and menu generators.
  - `admin-table-builder/`: WordPress `WP_List_Table` abstractions (e.g. `Base_List_Table`).
  - `admin-widget-builder/`: Dashboard widgets and statistics.
  - `field-builder/`: Form input builders and sanitizers.
  - `notice-manager/`: Admin notice dispatching.
  - `settings/`: Options persistence, advisory locking, and settings panels.
- **Documentation:** See `docs/` and `docs/architecture.md` for architectural patterns.

## Agent Guidelines
1. **Preserve Module Boundaries:** Keep changes localized to the relevant module unless a cross-cutting framework change is strictly necessary.
2. **Backward Compatibility:** Many standalone plugins (e.g. `tavangary-core`, `wpdev-crm`) inline framework modules. Do not break method signatures or duck-typed registration contracts (`ModuleLoader::register(object)`).
3. **Security Standards:** Always enforce nonce verification, capability checks (`current_user_can`), and data escaping in all view templates (`views/`).
4. **Testing:** After modifying framework code, run `composer test` and verify standalone inlining via `cd ../standalone-build && npm test`.

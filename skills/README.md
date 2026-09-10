# Project agent skills

Skills for AI agents working on **wp-starter-kit** and on **plugins generated from this boilerplate**.

| Skill                   | Path                                                           | Use when                                                                                  |
| ----------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **wpdev-php-modules**   | [wpdev-php-modules/SKILL.md](./wpdev-php-modules/SKILL.md)     | Modular PHP features, `src/Modules`, RestSetup/CLI/shortcodes, framework Support packages |
| **wpdev-js-modules**    | [wpdev-js-modules/SKILL.md](./wpdev-js-modules/SKILL.md)       | Module JS entries, Polaris, `@wpdev/*` packages, esbuild bundles, no relative path hell   |
| **wordpress-e2e-tests** | [wordpress-e2e-tests/SKILL.md](./wordpress-e2e-tests/SKILL.md) | Playwright + wp-env browser E2E (`e2eTest=playwright`), wp-admin + front-end smoke specs  |

## Invoke

- Slash (if registered in your agent host): `/wpdev-php-modules`, `/wpdev-js-modules`, `/wordpress-e2e-tests`
- Or open the `SKILL.md` and follow it as the system playbook for that domain

## Scope

These skills describe the **post-scaffold** consumer layout:

- PHP: `{slug}.php` + `packages/framework` + `src/Modules/*`
- JS: `src/Modules/*/assets/entries/*` + `assets/bundles/*` + package-name imports
- E2E: `.wp-env.json` + `playwright.config.js` + `tests/e2e/**` when `e2eTest=playwright`

They complement kit docs (`docs/module-guide.md`, `docs/e2e-tests.md`,
`packages/polaris-stack/context.md`) and are written as **agent instructions**
(rules + checklists), not marketing docs.

Skills are **not** copied into generated projects — agents read them from the kit
(or from a registered personal skill path).

## Related human docs

| Topic             | Doc                                                         |
| ----------------- | ----------------------------------------------------------- |
| Feature catalog   | [docs/features-reference.md](../docs/features-reference.md) |
| Browser E2E guide | [docs/e2e-tests.md](../docs/e2e-tests.md)                   |
| CLI flags         | [docs/cli-reference.md](../docs/cli-reference.md)           |
| PHPUnit / Jest    | [docs/php-test-tools.md](../docs/php-test-tools.md)         |

Shared Playwright skill repo:
[abolfazl-moeini/wordpress-e2e-tests](https://github.com/abolfazl-moeini/wordpress-e2e-tests)

## Cross-cutting: Access Control & Two-Gate Defense

Privileged actions (mutating REST routes, admin AJAX handlers, settings saves, CSV exports) must strictly implement the **Two-Gate Defense-in-Depth Model**:

- **Gate 1 (Native WP Capability):** Evaluated via `CapabilityPolicy::can()`, `current_user_can()`, or `$supported_panels`.
- **Gate 2 (AccessManager Domain Policy):** Evaluated via `CapabilityPolicy::access()` / `have_access()`, or framework `wpdev_can()`.
- Neither gate may bypass the other. When targeting `phpFramework: wpdev`, register fine-grained permissions via `wpdev_register_permission()` on `wpdev_load`.

## Cross-cutting: WP 6.7 i18n

Host plugins must load `load_plugin_textdomain` on `init` (prefer priority `1`) and must **not** call `__( …, '{textDomain}' )` before `init`. `wpdev_load` fires inside `plugins_loaded` — defer host settings registration that uses `__()` until `init`. See `docs/plugin-bootstrap.md` § Text-domain loading and wpdev-core skill `wpdev-settings-dashboard/references/settings-sections.md` § WP 6.7+ i18n timing.

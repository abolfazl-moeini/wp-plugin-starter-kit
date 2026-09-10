# Support packages — agent playbook

Canonical human API (signatures, deeper examples): kit
[`docs/php-core-libs.md`](../../../docs/php-core-libs.md) and
[`docs/api/php-reference.md`](../../../docs/api/php-reference.md).

This file is the **agent checklist**: when to use each package, do/don’t, and
where feature code lives. Paths are relative to a generated plugin root
(`packages/framework/src/Support/…`).

---

## AccessManager (`Support/AccessManager/`)

**Use for:** named feature-level access rules (menus, ajax, REST, CSV, settings) implementing the **Two-Gate Defense-in-Depth Model**.

| Gate                              | Mechanism                                                            | Purpose                           |
| --------------------------------- | -------------------------------------------------------------------- | --------------------------------- |
| **Gate 1 (Native WP Capability)** | `CapabilityPolicy::can()`, `current_user_can()`, `$supported_panels` | Role & capability boundary        |
| **Gate 2 (Domain Access Policy)** | `UserAccess`, `CapabilityPolicy::access()`, `wpdev_can()`            | Declarative domain business rules |

| Class                 | Role                                                            |
| --------------------- | --------------------------------------------------------------- |
| `UserAccess`          | Extend; implement `describe(BluePrint)`                         |
| `QualifierBase`       | `have_access($id)` — OR of rule groups; unknown id → deny       |
| `BluePrint\BluePrint` | Fluent `describe` / `describe_upper` / `any` / `all` / `custom` |

**Semantics:** multiple `describe('same-id')` → OR groups; chained conditions in
one group → AND.

**Framework Alignment:** In `wpdev` core, the canonical access subsystem is `packages/access-manager/` (`WPDev\Access\`), integrated with `WPDevFramework\Core\Access\Permission_Registry`, `Access_Policy_Registry`, and facades `wpdev_can()` / `wpdev_require_access()`. The starter kit's `Support/AccessManager/` provides the standalone consumer DSL. When building for WPDev, declare permissions with `wpdev_register_permission()` on `wpdev_load`.

**Feature code location:** `src/Modules/{Name}/Access/{Name}Access.php`

```php
final class MyFeatureAccess extends UserAccess
{
    public const EDIT_ITEMS = 'edit_items';
    public const CAP_EDIT   = 'edit_posts'; // Gate 1 string for menu / supported_panels

    protected function describe(BluePrint $bp): void
    {
        $bp->describe(self::EDIT_ITEMS)->any(self::CAP_EDIT);
    }
}

// Runtime: Two-Gate Defense (Gate 1 + Gate 2)
CapabilityPolicy::can(MyFeatureAccess::CAP_EDIT)
    && CapabilityPolicy::access(new MyFeatureAccess(), MyFeatureAccess::EDIT_ITEMS);
```

**Do**

- ALWAYS enforce the **Two-Gate Defense-in-Depth Model** on privileged and mutating endpoints (Gate 1 native capability + Gate 2 AccessManager policy).
- ALWAYS add `Access/{Name}Access.php` when the module has admin ajax / REST /
  menu / CSV / settings gates.
- Expose rule ids and underlying WP cap strings as **class constants**.
- Unit-test named rules with `$this->login('role')`.
- When targeting `phpFramework: wpdev`, register permissions with `wpdev_register_permission()` on `wpdev_load`.

**Don’t**

- Rely solely on a single gate (e.g. coarse `manage_options` or unverified policy alone) for critical mutations.
- Scatter feature-level `current_user_can('manage_*'|'edit_products'|…)` once an
  Access class exists — call `have_access` / `CapabilityPolicy::access`.
- Put object ownership into BluePrint without a call-site id — keep
  `current_user_can('edit_post'|'edit_user', $id)` **inline** on metabox/profile
  saves.
- Invent custom caps/roles unless the product plan explicitly requires them.

Gold example: `src/Modules/ExampleFeature/Access/FeatureAccess.php`.

---

## Auth (`Support/Auth/CapabilityPolicy.php`)

**Use for:** thin bridge between REST/admin and AccessManager or a one-off cap, enforcing Two-Gate defense.

| Method                                         | When                                        |
| ---------------------------------------------- | ------------------------------------------- |
| `access($qualifier, $id)` / `rest_access(...)` | Preferred — Gate 2 named AccessManager rule |
| `can($cap)` / `rest_permission($cap)`          | Gate 1 WP capability check                  |

**Don’t** use `read` for mutating endpoints. Always pair with Gate 2 for domain mutations.

---

## Rest (`Support/Rest/`)

**Use for:** all plugin REST routes.

- `RestSetup::register(MyController::class)` from `Module::boot()`.
- Subclass `RestHandler`; implement `rest_end_point`, `methods`,
  `rest_permission`, `rest_handler`.
- Prefer `CapabilityPolicy::rest_access(new XAccess(), XAccess::RULE)` in
  `rest_permission()`.

**Don’t** call `register_rest_route()` in feature code.

---

## Shortcodes (`Support/Shortcodes/`)

**Use for:** kit frontend shortcodes.

- `ShortcodesSetup::register($tag, DemoShortcode::class)`.
- Lazy-enqueue assets from `render_shortcode`, not on every page.

**Don’t** call `add_shortcode()` for kit shortcodes.

---

## WpCli (`Support/WpCli/`)

**Use for:** WP-CLI commands.

- Subclass `Command`; `CliSetup::register(StatusCommand::class)`.

**Don’t** call `WP_CLI::add_command()` directly.

---

## Assets (`Support/Assets.php`)

**Use for:** esbuild bundles under `assets/bundles/`.

- Bootstrap: `Assets::set_plugin_dir($dir, $url)` once in the main plugin file.
- `register_bundle_script` / `enqueue_bundle_script` / `enqueue_bundle_style`.
- Gate enqueue by admin `$hook` or shortcode render.
- Prefix handles with the plugin slug when co-install is possible.

---

## Queue (`Support/Queue/DeferredCall.php`)

**Use for:** queueing a callback before a WP hook has fired.

- `DeferredCall::queue($hook, ['callback' => …, 'params' => …])`.
- Refuses after `did_action($hook)`.

Typical pattern: thin module `Queue/DeferredSetup` helper from `boot()`.

---

## Templates (`Support/Templates/`)

**Use for:** module PHP views under `src/Modules/{Name}/Templates/`.

- `Template::load` / `render` + `set_variable(s)`; function aliases in partials.
- Escape on output (`esc_*`); prefer helpers over raw `include` + `extract()`.

---

## Decision cheat sheet

| Need                  | Package              |
| --------------------- | -------------------- |
| Feature access matrix | AccessManager + Auth |
| REST route            | Rest                 |
| Shortcode             | Shortcodes           |
| WP-CLI                | WpCli                |
| Admin/front bundles   | Assets               |
| Defer until hook      | Queue                |
| PHP views             | Templates            |

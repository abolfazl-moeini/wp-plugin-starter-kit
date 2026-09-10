# How to build a module

> Step-by-step guide for adding a new feature module to a scaffolded plugin.
> Uses `ExampleFeature` as the worked example.

## Overview

A wp-starter-kit plugin is composed of **modules** — small, isolated
feature units implementing `ModuleInterface`. Each module:

1. Declares a stable slug via `get_slug()`
2. Registers hooks, REST routes, and assets in `boot()`
3. Optionally gates boot with `should_boot()` (extend `AbstractModule`)

## Step 1: Create the module class

Create `src/Modules/MyFeature/Module.php`:

```php
<?php
declare(strict_types=1);

namespace WPDev\Modules\MyFeature;

use WPDev\Core\AbstractModule;
use WPDev\Modules\MyFeature\Rest\ItemsController;
use WPDev\Support\Assets;
use WPDev\Support\Rest\RestSetup;

final class Module extends AbstractModule
{
    public function get_slug(): string
    {
        return 'my-feature';
    }

    public function should_boot(): bool
    {
        return function_exists('is_admin') && is_admin();
    }

    public function boot(): void
    {
        RestSetup::register(ItemsController::class);

        add_action('admin_init', [$this, 'register_admin_assets']);
        add_action('admin_enqueue_scripts', [$this, 'enqueue_admin_assets']);
    }

    public function register_admin_assets(): void
    {
        Assets::register_bundle_script(
            'my-feature-admin',
            plugin_dir_path(dirname(__DIR__, 3)) . 'assets/bundles/MyFeature-admin.js'
        );
    }

    public function enqueue_admin_assets(string $hook): void
    {
        if ($hook !== 'toplevel_page_my-feature') {
            return;
        }
        Assets::enqueue_bundle_script('my-feature-admin');
    }
}
```

**Slug stability:** Never rename a slug after release — it is part of the
public contract and used as the `ModuleLoader` lookup key.

## Step 2: Register in the plugin bootstrap

In `{slug}.php` (after `Plugin::boot()`):

```php
\WPDev\Core\Plugin::loader()->register(
    new \WPDev\Modules\MyFeature\Module()
);
```

If using `phpFramework:wpdev`, also attach via the adapter:

```php
\WPDev\Adapters\WpdevModuleAdapter::attach(
    new \WPDev\Modules\MyFeature\Module()
);
```

## Step 3: Add a JS entry

Create `src/Modules/MyFeature/assets/entries/admin.ts`:

```ts
import { h, render } from "preact";
import getHooks from "@wpdev/hooks";

function AdminApp() {
  return h("div", null, "My Feature Admin");
}

const root = document.getElementById("my-feature-root");
if (root) {
  render(h(AdminApp, null), root);
  getHooks()?.doAction("my-plugin.my-feature.init", root);
}
```

The esbuild pipeline discovers entries under `src/Modules/*/assets/entries/*.{ts,js}`
and emits `assets/bundles/MyFeature-admin.js`.

## Step 4: Add a REST handler

Create `src/Modules/MyFeature/Rest/ItemsController.php`:

```php
<?php
declare(strict_types=1);

namespace WPDev\Modules\MyFeature\Rest;

use WPDev\Modules\MyFeature\Access\FeatureAccess;
use WPDev\Support\Auth\CapabilityPolicy;
use WPDev\Support\Rest\RestHandler;
use WP_REST_Request;
use WP_REST_Response;

final class ItemsController extends RestHandler
{
    public function rest_handler(WP_REST_Request $request): WP_REST_Response
    {
        return new WP_REST_Response(['items' => []]);
    }

    public function rest_permission(): bool
    {
        // Enforce Two-Gate Defense: Gate 1 (WP cap) + Gate 2 (AccessManager domain policy).
        return CapabilityPolicy::can('edit_posts')
            && CapabilityPolicy::access(
                new FeatureAccess(),
                FeatureAccess::EDIT_ITEMS
            );
    }

    public function rest_end_point(): string { return 'my-items'; }
    public function methods(): string { return 'GET'; }
}
```

Declare rules once in `Access/FeatureAccess.php` (extends
`WPDev\Support\AccessManager\UserAccess`). See ExampleFeature for a full
map of `any` / `all` / `custom` / OR-group patterns.

Register in `Module::boot()` via `RestSetup::register(ItemsController::class)`.

For deferred work when boot order is uncertain, use
`WPDev\Support\Queue\DeferredCall` (see ExampleFeature
`Queue/DeferredSetup.php` for `params`, `merge_hook_params`, and
`queue_or_run`).

For PHP partials, use `WPDev\Support\Templates\Template` (set/get
variables + `load`/`render`) instead of `extract()` + `include`. See
ExampleFeature `Templates/View.php` and `status-notice.php`.

For WP-CLI, extend `WPDev\Support\WpCli\Command` and register with
`CliSetup::register()` (never call `WP_CLI::add_command` in the module).
See ExampleFeature `Cli/StatusCommand.php`.

## Step 5: Enqueue assets

Use `Assets::enqueue_bundle_script()` with the built bundle path. For
Composer deployments, call `Assets::set_plugin_dir()` in the main plugin
file before any asset method.

Localize REST credentials:

```php
wp_localize_script('my-feature-admin', 'MyProjectLoc', Assets::get_localize_data());
```

See [localize-contract.md](localize-contract.md).

## Step 6: Write tests

**PHPUnit** — `tests/phpunit/Modules/MyFeature/ModuleTest.php`:

```php
public function test_slug_is_stable(): void
{
    $module = new \WPDev\Modules\MyFeature\Module();
    $this->assertSame('my-feature', $module->get_slug());
}
```

**Jest** — test pure JS helpers under `tests/` importing from your module.

Run: `composer test` and `npm test`.

## Step 7: Build and verify

```bash
npm run dev          # watch build
npm run build        # production bundles
composer test
wpdev doctor .       # drift check on the project
```

## Security checklist

Every module must follow WordPress security practices:

- [ ] REST routes implement `permission_callback` enforcing Two-Gate Defense (Gate 1 WP capability + Gate 2 AccessManager `UserAccess` via `CapabilityPolicy::access()` / `wpdev_can()`)
- [ ] Input sanitized (`sanitize_text_field`, `absint`, etc.)
- [ ] Output escaped (`esc_html`, `esc_attr`, `wp_kses_post`)
- [ ] AJAX handlers verify nonces
- [ ] Database queries use `$wpdb->prepare()`
- [ ] Admin pages check `current_user_can()`

## Hooks fired by the loader

After all modules boot, the loader fires:

```
{$hook_prefix}_modules_loaded
```

Subscribe from third-party code:

```php
add_action('my-plugin_modules_loaded', function () {
    // all kit modules are booted
});
```

## Admin-only boot pattern

Extend `AbstractModule` and override `should_boot()`:

```php
public function should_boot(): bool
{
    return function_exists('is_admin') && is_admin();
}
```

The loader skips `boot()` when `should_boot()` returns `false`.

## See also

- [modules.md](modules.md) — `ModuleInterface` contract
- [php-core-libs.md](php-core-libs.md) — REST, Assets, Auth helpers
- [build-system.md](build-system.md) — esbuild entry discovery
- [api/php-reference.md](api/php-reference.md) — full PHP API

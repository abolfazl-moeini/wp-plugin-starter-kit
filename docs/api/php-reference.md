# PHP API reference (`WPDev\`)

> Complete reference for the `wpdev/framework` Composer package surface.
> Detailed usage examples for Support classes live in
> [php-core-libs.md](../php-core-libs.md).

## Table of contents

- [WPDev\Core\Plugin](#wpdevcoreplugin)
- [WPDev\Core\ModuleLoader](#wpdevcoremoduleloader)
- [WPDev\Core\ModuleInterface](#wpdevcoremoduleinterface)
- [WPDev\Core\AbstractModule](#wpdevcoreabstractmodule)
- [WPDev\Support\Rest](#wpdevsupportrest)
- [WPDev\Support\Queue](#wpdevsupportqueue)
- [WPDev\Support\Auth](#wpdevsupportauth)
- [WPDev\Support\Shortcodes](#wpdevsupportshortcodes)
- [WPDev\Support\Assets](#wpdevsupportassets)
- [WPDev\Adapters\WpdevModuleAdapter](#wpdevadapterswpdevmoduleadapter)

---

## `WPDev\Core\Plugin`

Static facade for the plugin bootstrap. Locates `project.config.json`,
holds the `ModuleLoader`, and fires `{$hook_prefix}_plugin_loaded`.

```php
final class Plugin
{
    public static function boot(?string $config_path = null): void;
    public static function instance(): ?self;
    public static function loader(): ModuleLoader;
    public static function config(?string $override_path = null): array;
    public static function is_booted(): bool;
    public static function last_loaded_hook(): ?string;
    public static function loaded_config(): array;
    public static function reset_for_tests(): void;
    public static function set_plugin_dir(?string $path): void;
    public static function on_plugins_loaded(): void;
}
```

| Method                | Parameters                       | Returns        | Purpose                                      |
| --------------------- | -------------------------------- | -------------- | -------------------------------------------- |
| `boot()`              | `$config_path` optional override | `void`         | Idempotent bootstrap; wires `plugins_loaded` |
| `instance()`          | —                                | `?Plugin`      | Test seam for booted singleton               |
| `loader()`            | —                                | `ModuleLoader` | Get/create module loader                     |
| `config()`            | `$override_path` optional        | `array`        | Read `project.config.json`                   |
| `is_booted()`         | —                                | `bool`         | Whether `boot()` ran                         |
| `last_loaded_hook()`  | —                                | `?string`      | Hook name fired at boot                      |
| `loaded_config()`     | —                                | `array`        | Cached config from last boot                 |
| `reset_for_tests()`   | —                                | `void`         | Clear all static state (tests only)          |
| `set_plugin_dir()`    | `$path` plugin root or null      | `void`         | Override config path resolution for Composer |
| `on_plugins_loaded()` | —                                | `void`         | Boot all modules; fires `_modules_loaded`    |

**Typical bootstrap:**

```php
\WPDev\Core\Plugin::set_plugin_dir(plugin_dir_path(__FILE__));
\WPDev\Core\Plugin::boot();
\WPDev\Core\Plugin::loader()->register(new \WPDev\Modules\ExampleFeature\Module());
```

---

## `WPDev\Core\ModuleLoader`

In-memory registry and boot orchestrator for `ModuleInterface` implementations.

```php
final class ModuleLoader
{
    public function __construct(string $hook_prefix);
    public function register(ModuleInterface $module): void;
    public function boot_all(): void;
    public function get(string $slug): ?ModuleInterface;
    public function has(string $slug): bool;
    public function all(): array;
}
```

| Method          | Parameters                 | Returns                          | Purpose                                  |
| --------------- | -------------------------- | -------------------------------- | ---------------------------------------- |
| `__construct()` | `$hook_prefix` from config | —                                | Namespace filter/action hooks            |
| `register()`    | `$module`                  | `void`                           | Add module by slug; throws on duplicate  |
| `boot_all()`    | —                          | `void`                           | Boot each module; fire `_modules_loaded` |
| `get()`         | `$slug`                    | `?ModuleInterface`               | Lookup by slug                           |
| `has()`         | `$slug`                    | `bool`                           | Whether slug is registered               |
| `all()`         | —                          | `array<string, ModuleInterface>` | Full module map                          |

**Hooks fired:**

- Filter: `{$hook_prefix}_module_loader` — decorate loader before boot
- Action: `{$hook_prefix}_modules_loaded` — after all modules boot

---

## `WPDev\Core\ModuleInterface`

Contract every feature module must implement.

```php
interface ModuleInterface
{
    public function boot(): void;
    public function get_slug(): string;
}
```

| Method       | Returns  | Purpose                                    |
| ------------ | -------- | ------------------------------------------ |
| `boot()`     | `void`   | Register hooks, REST routes, assets        |
| `get_slug()` | `string` | Stable lookup key (e.g. `example-feature`) |

---

## `WPDev\Core\AbstractModule`

Optional base with conditional boot gate.

```php
abstract class AbstractModule implements ModuleInterface
{
    public function should_boot(): bool;
}
```

| Method          | Returns | Purpose                                       |
| --------------- | ------- | --------------------------------------------- |
| `should_boot()` | `bool`  | Return `false` to skip boot (e.g. admin-only) |

---

## `WPDev\Support\Rest`

### `RestHandler` (abstract)

```php
abstract class RestHandler
{
    public const INTERNAL_ERROR_MESSAGE = 'Internal server error';

    abstract public function rest_handler(WP_REST_Request $request): WP_REST_Response;
    abstract public function rest_permission(): bool;
    abstract public function rest_end_point(): string;
    abstract public function methods(): string;

    final public function rest_response(WP_REST_Request $request): WP_REST_Response;
}
```

### `RestSetup` (final)

```php
final class RestSetup
{
    public static function register(string|RestHandler $handler): bool;
    public static function setup(): void;
    public static function rest_init(): void;
    public static function flush(): void;
    public static function routes(): array;
}
```

### `AllowBatch` (interface)

```php
interface AllowBatch
{
    public function allow_batch(): array;
}
```

### `BatchResponse` (final)

```php
final class BatchResponse
{
    public static function wrap(mixed $data, string $cacheKey): WP_REST_Response;
    public static function forCacheKey(mixed $data, string $cacheKey): WP_REST_Response;
}
```

---

## `WPDev\Support\Queue`

### `DeferredCall` (final)

```php
final class DeferredCall
{
    public static function queue(string $hook, array $data): bool;
    public static function can_queue(string $hook): bool;
    public static function get_stack(string $hook): array;
    public static function run_queue(...$args): void;
    public static function reset_for_tests(): void;
}
```

---

## `WPDev\Support\Auth`

### `CapabilityPolicy` (final)

```php
final class CapabilityPolicy
{
    public static function can(string $capability): bool;
    public static function rest_permission(string $capability): callable;
    public static function access(UserAccess $qualifier, string $accessId): bool;
    public static function rest_access(UserAccess $qualifier, string $accessId): callable;
}
```

Supports the **Two-Gate Defense-in-Depth Model**:

- **Gate 1 (Native WP Capability):** Use `can()` / `rest_permission()` for standard WordPress role/capability checks.
- **Gate 2 (Domain Policy):** Use `access()` / `rest_access()` with an AccessManager qualifier for feature-level domain rules.
- On mutating or privileged REST endpoints, enforce both Gate 1 and Gate 2.

---

## `WPDev\Support\AccessManager`

Declarative domain access control engine (Gate 2). Aligns with canonical `WPDev\Access\` in the `wpdev` core framework (`packages/access-manager`), integrating with `Permission_Registry`, `Access_Policy_Registry`, and `wpdev_can()`.

### `UserAccess` (abstract)

```php
abstract class UserAccess extends QualifierBase
{
    abstract protected function describe(BluePrint $blue_print): void;
    public function have_access($id): bool;
    public function upper_current_user_can(string $capability): bool;
}
```

### `BluePrint` (final)

```php
final class BluePrint
{
    public function describe(string $id): self;
    public function describe_upper(string $id): self;
    public function any(string ...$caps): self;
    public function all(string ...$caps): self;
    public function custom(callable $callback): self;
    public function structure(): array;
}
```

---

## `WPDev\Support\WpCli`

### `Command` (abstract)

```php
abstract class Command
{
    abstract public function name(): string;
    abstract public function description(): string;
    abstract public function handle(array $args, array $assoc_args): void;
    public function synopsis(): array;
    public function when(): string;
    final public function run(array $args = [], array $assoc_args = []): void;
}
```

### `CliSetup` (final)

```php
final class CliSetup
{
    public static function register(string|Command $command): bool;
    public static function setup(): void;
    public static function cli_init(): void;
    public static function commands(): array;
    public static function flush(): void;
}
```

---

## `WPDev\Support\Templates`

### `Template` (final)

```php
final class Template
{
    public static function set_variable(string $name, $value): void;
    public static function get_variable(string $name);
    public static function set_variables(array &$vars): void;
    public static function get_variables(): array;
    public static function load(string $template, string $directory): bool;
    public static function render(string $template, string $directory): string;
    public static function render_messages($the_error): string;
    public static function reset_for_tests(): void;
}
```

Namespaced function aliases (Composer `files` autoload):
`set_template_variable`, `get_template_variable`, `set_template_variables`,
`get_template_variables`, `load_template`, `render_messages`.

---

## `WPDev\Support\Shortcodes`

### `Shortcode` (abstract)

```php
abstract class Shortcode
{
    abstract public function render_shortcode(
        array $attributes,
        string $content,
        string $tag
    ): string;
}
```

### `ShortcodesSetup` (final)

```php
final class ShortcodesSetup
{
    public static function register(string $tag, string|Shortcode $handler): bool;
    public static function init(): void;
    public static function append_shortcodes(): void;
    public static function render_shortcode($attributes, $content, $tag): string;
    public static function flush(): void;
}
```

---

## `WPDev\Support\Assets`

```php
final class Assets
{
    public static function set_plugin_dir(?string $dir, ?string $url = null): void;
    public static function resolve_paths(): array;
    public static function asset_info(string $rel_path): array;
    public static function register_bundle_script(
        string $handle,
        string $rel_path,
        array $extra_deps = []
    ): bool;
    public static function enqueue_bundle_script(
        string $handle,
        string $rel_path = '',
        array $extra_deps = []
    ): bool;
    public static function enqueue_bundle_style(
        string $handle,
        string $rel_path,
        array $extra_deps = []
    ): bool;
    public static function get_localize_data(): array;
    public static function read_project_config(): array;
    public static function enqueue_legacy_bundle_script(string $abs_path, array $extra_deps = []): bool;
    public static function enqueue_legacy_bundle_style(string $abs_path, array $extra_deps = []): bool;
}
```

**`get_localize_data()` return shape:**

```php
[
    'api'   => ['url' => string, 'nonce' => string],
    'api_x' => ['url' => string, 'nonce' => string],
]
```

---

## `WPDev\Adapters\WpdevModuleAdapter`

Bridge between kit `ModuleInterface` and wpdev-framework lifecycle.

```php
final class WpdevModuleAdapter
{
    public function __construct(ModuleInterface $module);
    public function get_slug(): string;
    public function boot(): void;

    public static function is_framework_active(): bool;
    public static function attach(ModuleInterface $module): void;
}
```

| Method                  | Purpose                                                |
| ----------------------- | ------------------------------------------------------ |
| `is_framework_active()` | `true` when `wpdev_register_table()` exists            |
| `attach()`              | Register module on `wpdev_on_load` or boot immediately |

See [wpdev-adapter.md](../wpdev-adapter.md) for the companion-plugin model
and seam map.

---

## Quick-start: creating a module

1. Create `src/Modules/MyFeature/Module.php` implementing `ModuleInterface`:

```php
<?php
declare(strict_types=1);

namespace MyPlugin\Modules\MyFeature;

use WPDev\Core\ModuleInterface;

final class Module implements ModuleInterface {
    public function get_slug(): string {
        return 'my-feature';
    }

    public function boot(): void {
        add_action( 'admin_menu', array( $this, 'register_menu' ) );
    }

    public function register_menu(): void {
        // ...
    }
}
```

2. Register before or during bootstrap:

```php
\WPDev\Core\Plugin::set_plugin_dir( plugin_dir_path( __FILE__ ) );
\WPDev\Core\Plugin::loader()->register( new \MyPlugin\Modules\MyFeature\Module() );
\WPDev\Core\Plugin::boot();
```

3. Optional: extend `AbstractModule` and gate admin-only boot:

```php
public function should_boot(): bool {
    return is_admin();
}
```

4. Fire custom hooks after your module registers routes — prefer listening on
   `{hookPrefix}_modules_loaded` (see [api/hooks-reference.md](hooks-reference.md)).

---

## Security checklist

Apply on every module that handles HTTP, forms, or output:

| Concern            | PHP pattern                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------- |
| **Capability**     | Prefer `UserAccess` + `CapabilityPolicy::access()`; fallback `can()` / `rest_permission()`   |
| **REST**           | Implement `rest_permission()` on every `RestHandler`; never omit `permission_callback`       |
| **Nonces**         | `wp_verify_nonce()` for form/AJAX actions; localize nonces via `Assets::get_localize_data()` |
| **Sanitize input** | `sanitize_text_field()`, `absint()`, typed REST schema validation                            |
| **Escape output**  | `esc_html()`, `esc_attr()`, `wp_kses_post()` in render paths                                 |
| **Batch**          | Use `AllowBatch` only when responses are cache-safe; validate cache keys                     |

`RestHandler::rest_response()` catches exceptions and returns a generic internal
error message — do not leak stack traces to clients.

---

## `RestHandler` helpers (additional detail)

| Method              | Returns            | Purpose                                     |
| ------------------- | ------------------ | ------------------------------------------- |
| `rest_response()`   | `WP_REST_Response` | Wraps `rest_handler()` with try/catch       |
| `rest_handler()`    | `WP_REST_Response` | **Abstract** — implement business logic     |
| `rest_permission()` | `bool`             | **Abstract** — cap check for route          |
| `rest_end_point()`  | `string`           | **Abstract** — route suffix under namespace |
| `methods()`         | `string`           | **Abstract** — HTTP method(s)               |

Register handlers with `RestSetup::register( new ItemsController() )` during
module `boot()`, then call `RestSetup::setup()` once (often deferred to
`rest_api_init`).

---

## `Assets` method notes

| Method                     | Security / usage notes                                                           |
| -------------------------- | -------------------------------------------------------------------------------- |
| `get_localize_data()`      | Exposes REST root URLs and nonces to JS — only enqueue on screens that need them |
| `enqueue_bundle_script()`  | Reads `.asset.php` for dependencies; never hardcode script handles               |
| `register_bundle_script()` | Register without enqueue for block editor or conditional screens                 |
| `set_plugin_dir()`         | Required when framework loads from `vendor/` so bundle paths resolve             |

---

## `DeferredCall` usage pattern

Queue a callable to run when a WordPress hook fires. `queue()` registers
`run_queue` on that hook automatically — do not call `run_queue()` yourself.

```php
DeferredCall::queue('my_plugin_deferred_sync', [
    'callback' => [$this, 'sync'],
    'params'   => [['id' => 42]],
    'merge_hook_params' => true, // optional: append do_action args
    'priority' => 10,
]);
// Later, when something fires the hook:
do_action('my_plugin_deferred_sync', $extraArg);
```

`can_queue()` / `queue()` return `false` when the hook has already fired
(`did_action`). In that case run the work immediately (see
`ExampleFeature\Queue\DeferredSetup::queue_or_run()`).

---

## Namespace map

| Namespace         | Package path            | Role                                       |
| ----------------- | ----------------------- | ------------------------------------------ |
| `WPDev\Core\`     | `src/Core/`             | Plugin facade, module loader, contracts    |
| `WPDev\Support\`  | `src/Support/`          | REST, assets, shortcodes, queue, auth      |
| `WPDev\Adapters\` | `src/Adapters/`         | Framework integration bridges              |
| `WPDev\Modules\`  | Consumer `src/Modules/` | Feature modules (not in framework package) |

---

## See also

- [php-core-libs.md](../php-core-libs.md) — Support class usage examples
- [api/hooks-reference.md](hooks-reference.md) — framework WordPress hooks
- [modules.md](../modules.md) — module architecture
- [module-guide.md](../module-guide.md) — step-by-step module authoring

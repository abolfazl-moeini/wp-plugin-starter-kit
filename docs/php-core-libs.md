# PHP support libraries

wp-starter-kit reimplements useful `php-core-libs/` behavior under
`packages/framework/src/Support/` with no legacy private dependencies.
Every public class is namespaced under `WPDev\Support\` (or
`WPDev\Support\Rest\`, `WPDev\Support\Queue\`, `WPDev\Support\AccessManager\`,
`WPDev\Support\Templates\`, etc.).

This document lists **signatures, parameters, return types, and usage**
for each public symbol. For a compact index grouped by namespace, see
[api/php-reference.md](api/php-reference.md).

---

## REST (`WPDev\Support\Rest\`)

### `RestHandler` (abstract)

Base class for class-based REST route handlers. Subclasses implement the
handler, permission check, endpoint segment, and HTTP methods. The final
`rest_response()` wrapper converts `Throwable` to safe error responses
(4xx messages pass through; 5xx are replaced with a generic string).

```php
abstract public function rest_handler(WP_REST_Request $request): WP_REST_Response;
abstract public function rest_permission(): bool;
abstract public function rest_end_point(): string;
abstract public function methods(): string;

final public function rest_response(WP_REST_Request $request): WP_REST_Response;
```

**Security:** Every route must implement `rest_permission()`. Never return
raw exception text on 5xx responses.

**Example:**

```php
final class ItemsController extends RestHandler
{
    public function rest_handler(WP_REST_Request $request): WP_REST_Response
    {
        return new WP_REST_Response(['items' => []]);
    }

    public function rest_permission(): bool
    {
        // Prefer AccessManager: CapabilityPolicy::access(new FeatureAccess(), FeatureAccess::EDIT_ITEMS)
        return CapabilityPolicy::can('edit_posts');
    }

    public function rest_end_point(): string { return 'items'; }
    public function methods(): string { return 'GET'; }
}
```

### `RestSetup` (final)

Central registration point. Reads `restNamespace` from
`project.config.json`. Auto-registers on `rest_api_init` when WordPress
is available.

```php
public static function register(string|RestHandler $handler): bool;
public static function setup(): void;
public static function rest_init(): void;
public static function flush(): void;
public static function routes(): array;
```

| Method        | Purpose                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `register()`  | Queue a handler class (or instance). Returns `false` if class missing or not a `RestHandler` subclass. |
| `setup()`     | Attach `rest_init` to `rest_api_init` at priority 20.                                                  |
| `rest_init()` | Instantiate each handler and call `register_rest_route()`.                                             |
| `flush()`     | Clear the route registry (tests).                                                                      |
| `routes()`    | Return registered class names.                                                                         |

**Example:**

```php
RestSetup::register(ItemsController::class);
// Routes appear at: /wp-json/{restNamespace}/items
```

### `AllowBatch` (interface)

Marker for handlers that opt into WordPress REST batch support.

```php
public function allow_batch(): array;  // e.g. ['v1' => true]
```

When implemented, `RestSetup` passes `'allow_batch' => $handler->allow_batch()`
to `register_rest_route()`. Pair with `@wpdev/rest-utils` batch client —
see [fetch-batch.md](fetch-batch.md).

### `BatchResponse` (final)

Wraps payloads for the JS batch client contract (`extra.cacheKey`).

```php
public static function wrap(mixed $data, string $cacheKey): WP_REST_Response;
public static function forCacheKey(mixed $data, string $cacheKey): WP_REST_Response;
```

**Example:**

```php
return BatchResponse::wrap(['items' => $rows], sanitize_text_field($cacheKey));
```

---

## Queue (`WPDev\Support\Queue\DeferredCall`)

Deferred hook callback queue. Refuses to queue after a hook has fired.
Supports priority changes and callable validation.

```php
public static function queue(string $hook, array $data): bool;
public static function can_queue(string $hook): bool;
public static function get_stack(string $hook): array;
public static function run_queue(...$args): void;
public static function reset_for_tests(): void;
```

**`$data` shape:**

| Key                 | Type       | Required | Purpose                            |
| ------------------- | ---------- | -------- | ---------------------------------- |
| `callback`          | `callable` | yes      | Function to invoke when hook fires |
| `params`            | `array`    | no       | Arguments passed to callback       |
| `merge_hook_params` | `bool`     | no       | Merge hook's own args into params  |
| `priority`          | `int`      | no       | `add_action` priority (default 10) |

**Example (boilerplate — `ExampleFeature/Queue/DeferredSetup.php`):**

```php
// Pattern 1: fixed params only (queue-utils DefferCallTest)
DeferredCall::queue('wpdev_example_feature_ready', [
    'callback' => [DeferredSetup::class, 'on_ready'],
    'params'   => [['module' => 'example-feature']],
    'priority' => 10,
]);

// Pattern 2: merge do_action() args after params
DeferredCall::queue('wpdev_example_feature_sync', [
    'callback'          => [DeferredSetup::class, 'on_sync'],
    'params'            => [['source' => 'example-feature']],
    'merge_hook_params' => true,
]);
do_action('wpdev_example_feature_sync', 1, 2, 3);
// → on_sync(['source' => 'example-feature'], 1, 2, 3)

// Pattern 3: already-fired hook → run immediately
if (!DeferredCall::queue('admin_init', ['callback' => [$this, 'setup']])) {
    $this->setup(); // or DeferredSetup::queue_or_run(...)
}
```

See `src/Modules/ExampleFeature/Queue/DeferredSetup.php` for the full demo
wired from `Module::boot()`.

---

## Auth (`WPDev\Support\Auth\CapabilityPolicy`)

Thin wrappers around `current_user_can()` and AccessManager named rules, supporting the **Two-Gate Defense-in-Depth Model**:

```php
public static function can(string $capability): bool;
public static function rest_permission(string $capability): callable;
public static function access(UserAccess $qualifier, string $accessId): bool;
public static function rest_access(UserAccess $qualifier, string $accessId): callable;
```

### Two-Gate Defense-in-Depth Model

Securing sensitive operations (REST routes, AJAX handlers, admin mutations) requires two layers of defense:

1. **Gate 1 (Native WordPress Capability):** Verifies role-based capability boundaries (e.g. `edit_posts`, `manage_options`) using `current_user_can()` or `CapabilityPolicy::can()`.
2. **Gate 2 (AccessManager Domain Policy):** Verifies declarative domain business logic and contextual access rules via `CapabilityPolicy::access()` or `UserAccess::have_access()`.

**Security Best Practice:** Always use the narrowest capability. Avoid `read` for mutating endpoints. On privileged endpoints, combine Gate 1 (role capability) and Gate 2 (domain policy) so that neither coarse role grants nor policy misconfigurations alone can bypass authorization.

**Prefer AccessManager** for multi-rule feature gates (see below). Use `can()` / `rest_permission()` only for one-off single-cap checks.

**Example (single cap):**

```php
register_rest_route($ns, '/items', [
    'permission_callback' => CapabilityPolicy::rest_permission('edit_posts'),
    // ...
]);
```

**Example (named AccessManager rule):**

```php
return CapabilityPolicy::access(new FeatureAccess(), FeatureAccess::EDIT_ITEMS);
```

---

## AccessManager (`WPDev\Support\AccessManager\`)

Declarative named access rules for domain authorization (Gate 2).

| Class                 | Role                                         |
| --------------------- | -------------------------------------------- |
| `UserAccess`          | Extend and implement `describe(BluePrint)`   |
| `QualifierBase`       | `have_access($id)` — OR of rule groups       |
| `BluePrint\BluePrint` | Fluent `describe` / `any` / `all` / `custom` |

### Architecture & WPDev Framework Relationship

- **In the Starter Kit:** `WPDev\Support\AccessManager\` provides the standalone consumer DSL (`UserAccess`, `BluePrint`) for feature modules.
- **In the WPDev Core Framework:** The canonical access engine lives in `packages/access-manager/` (namespace `WPDev\Access\`), integrated with `WPDevFramework\Core\Access\Permission_Registry`, `Access_Policy_Registry`, and public facades `wpdev_can()`, `wpdev_require_access()`, and `wpdev_register_permission()`.
- Modules running under the WPDev framework can register domain permissions into the catalog via `wpdev_register_permission()` on `wpdev_load`, allowing cross-module introspection and centralized auditing.

### Semantics

- Multiple `describe('same-id')` calls create **OR** groups.
- Rules inside one group (`any`/`all`/`custom` chains) are **AND**'d.
- Unknown ids → `false` (deny by default).

**Patterns** (see ExampleFeature `Access/FeatureAccess.php`):

```php
final class FeatureAccess extends UserAccess
{
    public const EDIT_ITEMS = 'edit_items';
    public const PUBLISH_ITEMS = 'publish_items';
    public const MANAGE_FEATURE = 'manage_feature';

    protected function describe(BluePrint $blue_print): void
    {
        // any(): at least one cap
        $blue_print->describe(self::EDIT_ITEMS)->any('edit_posts');

        // all(): every cap required
        $blue_print->describe(self::PUBLISH_ITEMS)
            ->all('edit_posts', 'publish_posts');

        // custom() + second group = OR
        $blue_print->describe(self::MANAGE_FEATURE)
            ->custom(static fn (): bool => current_user_can('manage_options'));
        $blue_print->describe(self::MANAGE_FEATURE)
            ->any('edit_others_posts');
    }
}

// REST permission_callback
return CapabilityPolicy::access(new FeatureAccess(), FeatureAccess::EDIT_ITEMS);
// or: (new FeatureAccess())->have_access(FeatureAccess::EDIT_ITEMS);
```

`describe_upper()` checks the switched-from user when the User Switching
plugin is active (`current_user_switched()`).

---

## WP-CLI (`WPDev\Support\WpCli\`)

Minimal class-based WP-CLI commands — same pattern as Rest / Shortcodes.

### `Command` (abstract)

```php
abstract public function name(): string;          // e.g. 'wpdev example-status'
abstract public function description(): string;
abstract public function handle(array $args, array $assoc_args): void;
public function synopsis(): array;               // optional WP-CLI synopsis
public function when(): string;                  // default after_wp_load
// helpers: log / line / success / warning / error
```

### `CliSetup` (final)

```php
CliSetup::register(StatusCommand::class);
// hooks cli_init → WP_CLI::add_command(...)
```

**Example (boilerplate):**

```php
final class StatusCommand extends Command
{
    public function name(): string { return 'wpdev example-status'; }
    public function description(): string { return 'Show status'; }
    public function handle(array $args, array $assoc_args): void
    {
        $this->success('OK');
    }
}

// Module::boot()
CliSetup::register(StatusCommand::class);
```

```bash
wp wpdev example-status
wp wpdev example-status --format=json
```

See `src/Modules/ExampleFeature/Cli/StatusCommand.php`.

---

## Templates (`WPDev\Support\Templates\`)

Ported from `core-essentials` template helpers. Pass data into PHP partials
without `extract()`; load files from a module directory.

### Class API (`Template`)

```php
Template::set_variable(string $name, mixed $value): void;
Template::get_variable(string $name): mixed;
Template::set_variables(array &$vars): void;
Template::get_variables(): array;
Template::load(string $template, string $directory): bool;
Template::render(string $template, string $directory): string;
Template::render_messages(mixed $the_error): string;
```

### Function aliases (for use inside partials)

```php
use function WPDev\Support\Templates\set_template_variable;
use function WPDev\Support\Templates\get_template_variable;
use function WPDev\Support\Templates\set_template_variables;
use function WPDev\Support\Templates\get_template_variables;
use function WPDev\Support\Templates\load_template;
use function WPDev\Support\Templates\render_messages;
```

Storage is the global `$wpdev_template_vars` bag.

**Example (boilerplate — `ExampleFeature/Templates/`):**

```php
Template::set_variable('notice', [
    'message' => 'Saved',
    'type'    => 'success',
]);
$html = Template::render('status-notice.php', __DIR__);
// or: View::notice('Saved', 'success');

// Errors → HTML list (views/messages.php)
echo Template::render_messages(new WP_Error('x', 'Nope'));
```

See `src/Modules/ExampleFeature/Templates/View.php` and
`status-notice.php`.

---

## Shortcodes (`WPDev\Support\Shortcodes\`)

### `Shortcode` (abstract)

```php
abstract public function render_shortcode(
    array $attributes,
    string $content,
    string $tag
): string;
```

Optional: implement `default_attributes(): array` for `shortcode_atts()`.

### `ShortcodesSetup` (final)

```php
public static function register(string $tag, string|Shortcode $handler): bool;
public static function init(): void;
public static function append_shortcodes(): void;
public static function render_shortcode($attributes, $content, $tag): string;
public static function flush(): void;
```

**Security:** Output is passed through `wp_kses_post()` in the base renderer.
Handlers should still escape user-supplied values.

**Example:**

```php
ShortcodesSetup::register('my_shortcode', MyShortcode::class);
```

---

## Assets (`WPDev\Support\Assets`)

Plugin-based asset loading (replaces theme-based `wpdev_*` helpers).
Composer consumers **must** call `set_plugin_dir()` before any asset method.

```php
public static function set_plugin_dir(?string $dir, ?string $url = null): void;
public static function resolve_paths(): array;
public static function asset_info(string $rel_path): array;
public static function register_bundle_script(string $handle, string $rel_path, array $extra_deps = []): bool;
public static function enqueue_bundle_script(string $handle, string $rel_path = '', array $extra_deps = []): bool;
public static function enqueue_bundle_style(string $handle, string $rel_path, array $extra_deps = []): bool;
public static function get_localize_data(): array;
public static function read_project_config(): array;
```

| Method                      | Purpose                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| `set_plugin_dir()`          | Set consumer plugin root path + URL (required for Composer layout)            |
| `asset_info()`              | Read `.asset.php` sidecar (deps + hash)                                       |
| `register_bundle_script()`  | Register JS with sidecar deps + `wp_set_script_translations()`                |
| `register_vendor_scripts()` | Register shared non-WP vendors (handle `preact` → `assets/bundles/preact.js`) |
| `enqueue_bundle_script()`   | Register (if path given) then enqueue                                         |
| `enqueue_bundle_style()`    | Register + enqueue CSS bundle                                                 |
| `get_localize_data()`       | Build `api` / `api_x` localize payload for `@wpdev/utils`                     |

**Example:**

```php
Assets::set_plugin_dir(plugin_dir_path(__FILE__), plugins_url('', __FILE__));
add_action('init', [Assets::class, 'register_vendor_scripts'], 1);
Assets::enqueue_bundle_script(
    'my-admin',
    plugin_dir_path(__FILE__) . 'assets/bundles/MyModule-admin.js'
);
wp_localize_script('my-admin', 'MyProjectLoc', Assets::get_localize_data());
```

### Shared vendors

Libraries WordPress does not ship (Preact) are registered once under a stable
handle (`preact`). Prefer the unprefixed handle so two kit plugins share one
copy. Call `register_vendor_scripts()` after `set_plugin_dir()`.

### Multi-plugin caveat

`Assets::$plugin_dir` and `Plugin::config()` are **process-wide**. If two kit
plugins are active, whichever called `set_plugin_dir()` / `Plugin::boot()` last
(or first, for config cache) wins for the whole request.

Symptoms when this goes wrong:

| Symptom                                              | Cause                                                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Console `Uncaught SyntaxError: Unexpected token '<'` | `resolve_asset_url()` returned `''`; `add_query_arg` turned it into the site home HTML loaded as JS                                                                |
| View JS missing from the page entirely               | Script depends on `{slug}-deps` but `read_project_config()` returned a **sibling** plugin's `depsBundle`, so the dep was never registered and WP omitted the child |

Mitigations (scaffold Polaris demo does these):

1. Prefix script/style handles with the plugin slug (`{slug}-polaris-demo-view`).
2. Register view JS with `plugins_url( $rel, $plugin_file )` + `.asset.php` deps (do not rely solely on `Assets::resolve_asset_url()` for cross-plugin safety).
3. Read **this** plugin's `wpdev.json` for `depsBundle` / `localizeVar` instead of `Assets::read_project_config()` when co-install is possible.
4. `register_bundle_script()` returns `false` when the URL would be empty (never registers the homepage as a script).
5. `resolve_asset_url()` falls back to `content_url()` when the abs path is under `WP_CONTENT_DIR` but outside the current `set_plugin_dir()` root.

**Security:** `get_localize_data()` uses `sanitize_url()` on REST URLs and
`wp_create_nonce()` for nonces. Never hardcode nonces in JS source.

---

## See also

- [api/php-reference.md](api/php-reference.md) — full `WPDev\` namespace index
- [module-guide.md](module-guide.md) — using Support classes in a new module
- [localize-contract.md](localize-contract.md) — JS↔PHP localize shape
- [fetch-batch.md](fetch-batch.md) — batch client + `BatchResponse`

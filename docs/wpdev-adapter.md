# WPDev Framework Adapter

The `phpFramework: wpdev` feature integrates a generated plugin with the
WPDev Admin Framework as a **soft dependency**. The framework runs as a
separate WordPress plugin on the site; your kit plugin registers modules
alongside it through a thin bridge class.

This kit does **not** create a `companion-plugins/` directory and does
**not** vendor or clone the framework into the project.

## Soft-dependency model

When `phpFramework: wpdev` is enabled during `wpdev create` (or added
later with `wpdev add phpFramework`):

1. **WPDev Admin Framework** must already be (or later be) installed and
   activated as a normal site plugin (e.g. `wp-content/plugins/wpdev`).
2. `FrameworkBridge.php` is scaffolded in your plugin. It exposes
   `is_framework_active()` and is used with `WpdevModuleAdapter::attach()`
   for modules that should boot when the framework is present.
3. The **main plugin file** includes an `admin_notices` check: if
   `wpdev_register_table` is missing, a warning notice is shown.
4. Scaffold also emits `Requires Plugins: wpdev` on the host plugin
   header (WordPress 6.5+).
5. If the framework is not active, framework-dependent modules no-op in
   `boot()`. Generated reference modules avoid extending framework classes
   at load time so autoloading stays fatal-free.

See [framework-as-dependency.md](framework-as-dependency.md) for
`distMode` (`vendored` vs `deps`) and the 1.0.0 migration path.

## Prefix rules and collision validation

The WPDev framework **owns** the `wpdev` hook prefix and the `wpdev_`
PHP function prefix. Your project's branding prefixes must not collide:

| Reserved by framework          | Your project must use                          |
| ------------------------------ | ---------------------------------------------- |
| `hookPrefix = "wpdev"`         | Any other prefix (e.g. `my-plugin`)            |
| `phpFunctionPrefix = "wpdev_"` | Any other prefix ending in `_` (e.g. `myprj_`) |

The installer validates this during `wpdev create` (interactive mode
prompts for a new prefix; non-interactive mode fails fast). The rule
exists because the framework registers dozens of `wpdev_*` hooks and
functions; a colliding prefix would cause double-registration or
silent overrides.

## `WpdevModuleAdapter::attach()` contract

`WPDev\Adapters\WpdevModuleAdapter` wraps any kit `ModuleInterface`
implementation so it can participate in the framework lifecycle when
active, and fall back to the kit's own boot path when the framework is
missing.

```php
use WPDev\Adapters\WpdevModuleAdapter;
use MyPlugin\Modules\WpdevDemo\Module;

WpdevModuleAdapter::attach( new Module() );
```

Detection: `WpdevModuleAdapter::is_framework_active()` returns true when
`function_exists( 'wpdev_register_table' )`.

## Host plugin admin notice

The main bootstrap (`{slug}.php`) registers:

```php
add_action( 'admin_notices', '{slug}_wpdev_dependency_notice' );
function {slug}_wpdev_dependency_notice() {
    if ( function_exists( 'wpdev_register_table' ) ) {
        return;
    }
    // … warning notice for admins who can activate plugins
}
```

The check runs at `admin_notices` time so plugin load order does not
matter.

## Access Control & Two-Gate Defense

When integrated with the WPDev framework (`phpFramework: wpdev`), kit modules align their domain access control with the framework's Two-Gate Defense architecture:

1. **Permission Catalog:** On `wpdev_load`, register feature permissions with `wpdev_register_permission()`:
   ```php
   wpdev_register_permission( 'my_plugin.items.view', array(
       'owner'      => 'my-plugin',
       'capability' => 'my_plugin_view_items',
       'scope'      => 'site',
       'risk'       => 'read',
       'label'      => __( 'View Items', 'my-plugin' ),
   ) );
   ```
2. **Two-Gate Evaluation:** For privileged actions and REST routes, check both Gate 1 (WP role capability) and Gate 2 (AccessManager policy):
   ```php
   return CapabilityPolicy::can( 'my_plugin_view_items' )
       && CapabilityPolicy::access( new ItemAccess(), ItemAccess::VIEW );
   ```
3. **Framework Surfaces:** In WPDev admin pages, list tables declare `protected $access = 'my_plugin.items.view';` and modal forms pass `'access' => 'my_plugin.items.create'`.

## Related files

| Path                               | Role                    |
| ---------------------------------- | ----------------------- |
| `src/Support/FrameworkBridge.php`  | Soft-dep helper         |
| `src/wpdev-demo-register.php`      | Demo module wiring      |
| `src/Modules/WpdevDemo/Module.php` | Reference module        |
| `{slug}.php`                       | Header + admin notice   |
| `docs/wpdev-integration.md`        | Generated project notes |

# @wpdev/standalone-build

Standalone plugin assemble/deploy pipeline for wp-starter-kit consumers.

- Default build is **clean** (no AST mangling, no spaghetti inlining beyond the normal release packager).
- Profile S obfuscation is **opt-in**: `--obfuscate` or `--profile=s`. Closed profile values are `s` and `clean`; unknown or conflicting flags fail.
- `--obfuscate` fails closed if `plan3/transformer.php` cannot be resolved, Rector is missing, or transformer `--batch` JSON is invalid.
- Release CLI requires `WPDEV_CONTENT_ROOT` or a `wp-content`-shaped cwd. There is no silent `process.cwd()` fallback outside `node --test`. Library importers (`deploy-standalone-plugin.mjs`) must pass `contentRoot` / `pluginsDir` explicitly; importing the module does not bind a cwd fallback.
- The orchestrator calls `assembleProfileSCandidate()` in-process (library API). Plugin-local `prepare-release.js` remains a thin packager that reuses the same Profile S fail-closed gates when `--obfuscate` is set; it is not a second assembler.
- Production ZIP swap: never unzip onto the live plugin directory. See `SOP_PRODUCTION_PLUGIN_DEPLOYMENT.md`. Two sequential `rename`s still have a brief “plugin missing” gap; that is not an incomplete-tree Fatal and is not claimed as zero downtime.

## Commands

From a WordPress `wp-content` directory (or with `WPDEV_CONTENT_ROOT` set):

```bash
# Clean standalone assemble (no obfuscation)
node packages/standalone-build/build-all-standalone-plugins.mjs --build-only

# Profile S obfuscation + deploy
node packages/standalone-build/build-all-standalone-plugins.mjs --obfuscate --deploy --jobs=4

# Deploy an already-built ZIP (sibling staging; never unzip onto the live plugin dir)
node packages/standalone-build/deploy-standalone-plugin.mjs dist/tavangary-core-profile-s.zip tavangary-core
```

Per-plugin (from a `*-dev` plugin root):

```bash
npm run release              # clean dist/{slug}
npm run release:obfuscate    # same + Profile S transformer
```

Canonical package tests (from this directory):

```bash
WPDEV_CONTENT_ROOT=/path/to/wordpress/wp-content npm test
```

`npm test` is the single canonical runner (`tests/*.test.mjs` plus `tests-docker/*.test.mjs`). Artifact and protection-gate tests need `WPDEV_CONTENT_ROOT` (or a `wp-content`-shaped cwd) so they do not look at the kit package directory.

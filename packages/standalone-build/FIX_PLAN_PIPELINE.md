# FIX PLAN — Standalone Build Pipeline (inline / spaghetti / obfuscate)

> Audience: a coding agent of **medium** capability. Do the tasks **in order**. Each
> task is self-contained: it says which file to open, what the problem is, exactly
> what to change, and how to prove it works. Do **not** invent behavior beyond what
> a task says. If a step's precondition is not true in the code you see, **stop and
> report** instead of guessing.
>
> Scope of this plan: only the 7 core pipeline files listed below. Line numbers are
> as of the review (2026-09-10) and may have drifted — always confirm by reading the
> named function first.
>
> Golden rule of this whole package (do not violate it while fixing anything):
> **ZERO functional regression.** The transformed plugin must behave identically to
> clean source (hooks, REST, Ajax, SQL, i18n, DB). When in doubt, preserve — do not
> mangle.

## Files in scope

| Short name   | Path                               |
| ------------ | ---------------------------------- |
| orchestrator | `build-all-standalone-plugins.mjs` |
| assembler    | `assemble-profile-s-candidate.mjs` |
| inliner      | `inline-wpdev-closure.mjs`         |
| transformer  | `plan3/transformer.php`            |
| gate         | `profile-s-fail-closed.mjs`        |
| verifier     | `verify-profile-s-artifact.mjs`    |
| deployer     | `deploy-standalone-plugin.mjs`     |

## Mental model of the current pipeline (read once before touching anything)

`assembleProfileSCandidate()` in the assembler runs these stages, top to bottom:

1. rsync source → temp staging.
2. Purge dev docs.
3. **Inline framework closure** (`inlineWpdevClosure`) — copies the WPDev framework
   into `staging/src/FrameworkClosure/`. **Runs always.**
4. **Rector PHP 7.4 downgrade** — **runs always** (even for a "clean" build).
5. **If `isObfuscate`** → run `plan3/transformer.php` (`--dump-map` then `--batch`):
   symbol mangling + comment stripping + namespace flattening. **This is the only
   real toggle today.**
6. Rewrite ModuleLoader `register()` to duck-typed `object`.
7. **Minify all JS/CSS** — **runs always**.
8. Composer classmap dump, PHP lint, manifest, canonical ZIP, verify, publish.

Today there are only two profiles: `clean` and `s` (`--obfuscate` = `s`). See
`parseClosedProfileFlags` in the gate. There is **no** independent control over
framework inlining, and **no** "spaghetti" stage separate from obfuscation.

### Target capability model (decided with the owner)

Three independent capabilities, combinable in any mix. **Rector downgrade stays
always-on** (it is a compatibility step, not a capability).

| Flag                 | Meaning                                                                                                                               | Maps to code                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `--inline-framework` | Copy framework modules into the plugin so the external `wpdev` plugin can be deleted afterward.                                       | `inlineWpdevClosure` (stage 3)                  |
| `--spaghetti`        | De-modularize: flatten namespaces + duck-type ModuleLoader (structural tangling), **without** renaming symbols or stripping comments. | namespace-flatten part of transformer + stage 6 |
| `--obfuscate`        | Rename internal symbols (`_c_/_f_/_k_/_m_/_p_/$_v_`) + strip comments + compact whitespace.                                           | symbol-mangling part of transformer             |

Any combination must work, e.g. `--spaghetti` alone, `--inline-framework --obfuscate`,
or all three. `clean` = none of the three (but still rsync + rector + package).

---

# PART A — Separate the three capabilities

> This is the largest change. Do Part A before Part C, because Part C's fixes are
> easier to test once each stage can be run alone.

## A1 — Split `plan3/transformer.php` into two independent passes

**Severity:** High. **File:** transformer.

**Problem.** `transform()` always does _both_ namespace flattening (structural /
"spaghetti") _and_ symbol mangling + comment stripping ("obfuscate"). There is one
`$this->flatten_namespaces` boolean but no switch for mangling; the two concerns are
interleaved in the same token loop (see the many `if ( $this->flatten_namespaces )`
branches around lines 826–1806, and the mangling that happens unconditionally).

**Fix steps.**

1. Add a second constructor flag `$mangle_symbols` (default `true`) next to the
   existing `$flatten_namespaces` (constructor at line 308). Store as
   `$this->mangle_symbols`.
2. Guard **every symbol-renaming write** with `if ( $this->mangle_symbols )`. The
   renames to guard are: class names (`_c_`), function names (`_f_`), constants
   (`_k_`), private methods (`_m_`), private properties (`_p_`), and local variables
   (`$_v_`). When `mangle_symbols` is false, emit the **original** token text.
   - Concretely: wherever the code currently appends a mangled name (search for
     `_c_`, `_f_`, `_k_`, `_m_`, `_p_`, `$_v_`, and the `try_rewrite_compact_call`
     result), branch so the original text is emitted when mangling is off.
3. Keep comment/DocBlock stripping tied to `mangle_symbols` (comment stripping is an
   obfuscation concern, not structural). When `mangle_symbols` is false, **do not
   strip comments**.
4. Leave namespace flattening controlled only by `$flatten_namespaces`.
5. Add CLI parsing: accept `--no-mangle` and `--no-flatten` for both `--batch` and
   `--dump-map` argv handling (the block starting line 1834). Map:
   - `--no-mangle` → `mangle_symbols = false`
   - `--no-flatten` → `flatten_namespaces = false`
     Parse them positionally-safely: scan `$argv` for these two literal flags and
     remove them before reading the existing positional args (`$staging_dir`,
     `$map_file`, `$seed`, `$main_file`), so their positions do not shift.
6. When `mangle_symbols` is false, `--dump-map` should still run but produce an
   **empty** map (`classes`/`functions`/`constants` = `{}`), OR the assembler should
   skip `--dump-map` entirely for spaghetti-only (decide in A3). Prefer: assembler
   skips dump-map when not obfuscating.

**Acceptance.**

- `php plan3/transformer.php --batch <dir> "" seed main.php --no-mangle` produces
  files where: no `_c_/_f_/_v_` names appear, comments are still present, but
  `namespace ...;` has been flattened (if flatten on).
- `... --no-flatten` (mangle on) produces mangled names but keeps `namespace` blocks.
- Round-trip: a file transformed with both `--no-mangle --no-flatten` is
  byte-identical to input except for trailing alias/whitespace the code already adds
  (ideally identical). Add a small fixture test under `tests/`.

## A2 — Make framework inlining a separate, always-available capability

**Severity:** High. **File:** inliner, assembler.

**Problem.** `inlineWpdevClosure` (assembler line ~197) runs on every assemble and is
also gated by a **hardcoded consumer allowlist** (inliner lines 210–218). A plugin
whose slug is not in that list silently gets `{ inlinedFiles: 0 }`.

**Fix steps.**

1. In the assembler, wrap the `inlineWpdevClosure(...)` call in
   `if (options.inlineFramework) { ... }`. Thread a new `inlineFramework` boolean
   through `assembleProfileSCandidate` options and `parseAssembleCli`.
2. In the inliner, **delete the hardcoded allowlist** (lines 210–218). Replace the
   `isTargetConsumer` gate with a content-based check: inline **iff** the framework
   source directory exists (`fs.existsSync(wpdevPluginDir)`), regardless of slug.
   Keep the early return only for "framework source not found".
3. Keep `wpdevPluginDirOverride` working as an explicit path override.

**Acceptance.** Running assemble with `inlineFramework:true` on a plugin slug **not**
in the old list copies files into `src/FrameworkClosure/` (`inlinedFiles > 0`).
Running with `inlineFramework:false` leaves no `src/FrameworkClosure/` directory.

## A3 — Wire the three flags through orchestrator → assembler → transformer

**Severity:** High. **Files:** gate, orchestrator, assembler.

**Problem.** The whole system is binary `clean` vs `s`. `parseClosedProfileFlags`
(gate line 26) only knows `--obfuscate`/`--profile`.

**Fix steps.**

1. In the gate, add parsing for three independent booleans:
   `inlineFramework` (`--inline-framework`), `spaghetti` (`--spaghetti`),
   `obfuscate` (`--obfuscate`). Keep `--profile s` as a **compatibility alias** that
   sets all three true; keep `--profile clean` = all three false. Keep the existing
   `isObfuscate` return for callers that still read it (set it = `obfuscate`).
2. Do **not** remove `ALLOWED_BUILD_PROFILES`; keep `s`/`clean` valid.
3. In the assembler `assembleProfileSCandidate`:
   - Replace the single `if (isObfuscate)` block (line 244) with:
     - Run `--dump-map` + `--batch` **only if** `spaghetti || obfuscate`.
     - Pass `--no-mangle` when `!obfuscate`.
     - Pass `--no-flatten` when `!spaghetti`.
   - Run stage 6 (duck-typed ModuleLoader rewrite) when `spaghetti` (structural). It
     currently always runs (line 287) — keep it running always is acceptable
     (harmless), but document it; simplest safe choice: leave it always-on.
   - Gate `inlineWpdevClosure` by `inlineFramework` (from A2).
4. In the orchestrator, thread the three booleans from `parseClosedProfileFlags`
   into every `assembleProfileSCandidate(...)` call (lines ~1348 and ~1353) and into
   `buildCandidate`. The artifact name currently switches on `isObfuscate`
   (`${consumer}-profile-s.zip` vs `${consumer}.zip`, assembler line 473); change the
   naming rule to: if any of the three flags is on, name it
   `${consumer}-<suffix>.zip` where suffix encodes the combo (e.g. `profile-s` when
   all on, else a stable short tag like `inline`, `spag`, `obf`, `spag-obf`). Keep
   `clean` → `${consumer}.zip`. **Keep the mapping deterministic** — the cache and
   verifier compare on it.
5. Update the manifest `profile` field (assembler line 423) to record the actual
   combo, not just "Profile S" / "clean".

**Acceptance.**

- `node build-all-standalone-plugins.mjs --targets=<p> --spaghetti --build-only`
  produces a ZIP with flattened namespaces, **original symbol names**, **comments
  intact**, and **no `src/FrameworkClosure/`**.
- `... --inline-framework --build-only` produces a ZIP with `src/FrameworkClosure/`
  and otherwise clean readable code.
- `... --obfuscate --build-only` mangles but does not inline.
- `... --profile s` still behaves exactly like today (all three on).

## A4 — Do not fail the build for Rector when a capability is off

**Severity:** Medium. **Files:** assembler, gate.

**Problem.** `requireRectorForProfileS` (gate line 73) throws if the rector binary is
missing, and the assembler calls it unconditionally (line 209). Rector stays
always-on per the decision, so this is acceptable — **but** the error message says
"Profile S requires Rector" even for a clean/spaghetti/inline build.

**Fix steps.**

1. Rename the message to be profile-agnostic, e.g. "PHP 7.4 downgrade requires Rector
   (missing …)". Keep the throw (rector is mandatory by decision).
2. Do not otherwise change behavior.

**Acceptance.** Error text no longer implies obfuscation; rector still runs for all
builds.

---

# PART B — Remove tavangary-project coupling (make it work on ANY plugin)

> This is a **core** goal: the pipeline must be generic. Every hardcoded
> project-specific value is a latent breakage for other plugins.

## B1 — Replace hand-maintained obfuscation whitelists with derived data

**Severity:** High (this is the likely source of "it was fixed but it breaks
things"). **File:** transformer.

**Problem.** The safety whitelists are polluted with one project's identifiers, so
they neither protect other plugins nor stay correct as code changes:

- `$reserved_vars` (lines 28–89) contains app-specific vars: `$product_id`, `$owns`,
  `$total_lessons`, `$test`, `$result`, `$submission`, `$answers`, `$user_name`,
  `$date_formatted`, `$font_url`, `$is_pdf`, etc.
- `$frozen_public_classes` (lines 152–225) is a list of tavangary/crm/tickets class
  names, and contains `'Plugin'` **twice** (lines 153 and 201).
- `$frozen_public_constants` (lines 227–251) is app-specific.
- `$magic_methods` (lines 253–277) mixes real magic methods with app/framework
  method names (`get_columns`, `get_schema`, `get_table`, `get_items`, `get_count`,
  `get_item`).

**Fix steps.**

1. **Split each list into two parts:**
   - a _structural_ part that is genuinely universal (real PHP superglobals, `$this`,
     real magic methods `__construct`…`__debugInfo`, PHP/WordPress reserved names);
   - a _project_ part that must come from **outside the file**.
2. Remove all app-specific entries from the hardcoded arrays. Keep only the universal
   structural entries.
3. Load the project part from an **optional config file** the assembler passes in,
   e.g. `--preserve-config <path-to-json>` with shape:
   ```json
   { "vars": [], "classes": [], "constants": [], "methods": [] }
   ```
   Merge these into the in-memory sets at construction. If no config is given, use
   only the universal sets.
4. Deduplicate (the `'Plugin'` double-entry proves dedup is needed): build the sets
   with a de-dup step and assert no duplicates in a unit test.
5. **Better default safety (recommended, do if time allows):** derive "public
   surface to freeze" automatically instead of listing names —
   - freeze any class/interface/trait/method/property that is `public` AND
     referenced by a string literal anywhere in the tree (already partly done by the
     preservation heuristics — see B3), and
   - freeze any symbol that appears in the plugin's `composer.json` autoload or in a
     `@api`/registered-hook context.
     This is the real fix; the config file (step 3) is the safety valve for the rest.

**Acceptance.**

- The four arrays contain **no** tavangary/crm/tickets identifiers.
- A unit test asserts there are no duplicate entries.
- Obfuscating a _different_ sample plugin (not tavangary) with no preserve-config
  still passes `php -l` and the verifier.

## B2 — Remove hardcoded machine paths and dev-plugin names from asset minifier

**Severity:** High. **File:** inliner (`minifyAssetsInTree`, lines ~1125–1248).

**Problem.**

- Absolute path `"/Users/moeini/Dev/tavangary.new/wordpress/wp-content"` is baked in
  as a candidate root (line 1133).
- esbuild is discovered only under `plugins/tavangary-core-dev`, `plugins/wpdev-crm-dev`,
  `plugins/wpdev-tickets-dev`, or a top-level `node_modules` (lines 1140–1143 and
  1163–1165). A new plugin with none of those present throws "esbuild not found".

**Fix steps.**

1. Delete the absolute `/Users/moeini/...` entry. Build `candidateRoots` from only:
   `contentRoot` (passed in), `process.env.WPDEV_CONTENT_ROOT`, and the repo root
   derived from `import.meta.url`.
2. Replace the fixed dev-plugin list with a generic search: for each candidate root,
   look for esbuild under `node_modules/esbuild` **and** under
   `plugins/<consumer>-dev/node_modules/esbuild` (use the actual `consumer`, which you
   must thread into `minifyAssetsInTree`), then fall back to scanning
   `plugins/*-dev/node_modules/esbuild` (glob or readdir), then top-level.
3. If esbuild is genuinely absent, keep the clear throw — but include the searched
   roots in the message (it already does; keep that).

**Acceptance.** On a machine without the tavangary paths, minify still finds esbuild
via `contentRoot`/env/`<consumer>-dev`. No absolute personal path remains in the file
(`grep -n "/Users/moeini" inline-wpdev-closure.mjs` returns nothing).

## B3 — Make dynamic-reference preservation config-driven, not name-guessed

**Severity:** Medium. **File:** transformer.

**Problem.** Preservation of strings that name classes/functions relies on heuristics
covering specific caller functions (`is_hook_name_string`, `is_callback_argument_string`,
`is_reflection_or_instantiation_string`, lines 404–564). A dynamic reference not
matching a known caller — e.g. `$c = 'Some_Class'; new $c;` where `'Some_Class'` is a
plain string literal that equals a mangled class — can be rewritten incorrectly.

**Fix steps.**

1. Add to the preserve-config from B1 a `preserveStrings` list: exact string literals
   that must never be treated as a manglable symbol.
2. In the transformer, before rewriting any string that matches a symbol name, check
   the `preserveStrings` set and skip if present.
3. Document (in code comment) that this is the escape hatch when a plugin uses dynamic
   class/function names the heuristics can't see.

**Acceptance.** With a `preserveStrings` entry, the matching string literal is emitted
unchanged even when it equals a mangled symbol name.

---

# PART C — Correctness bugs (do after A so each is testable in isolation)

## C1 — Flattened asset copy aborts the build on filename collision

**Severity:** High. **File:** inliner (lines ~929–937, `safeCopyFile` lines 232–257).

**Problem.** All module asset trees are copied into a single flat
`src/FrameworkClosure/assets/` via `copyDirRecursive` → `safeCopyFile`. `safeCopyFile`
**throws** ("CRITICAL STRUCTURAL COLLISION") when two sources target the same
destination path with **different** content. Two modules that each ship, say,
`assets/js/index.js` with different contents will abort the entire build.

**Fix steps.**

1. Preserve per-module asset paths: copy each module's assets under a
   module-namespaced subfolder (e.g. `assets/<module>/…`) instead of flattening, OR
2. If the flat layout is required by `wpdev_get_asset()` resolution, detect a genuine
   collision and **rename** the second file deterministically + record the remap,
   rather than throwing. Prefer option 1 (namespacing) — it removes the collision
   class entirely.
3. Verify `wpdev_get_module_asset_url()` / `wpdev_path()` in the generated
   `functions-closure.php` still resolves assets under the new layout (adjust the
   `views`/`assets` resolution in the closure if you change the layout).

**Acceptance.** A framework with two modules exposing same-named asset files inlines
without error, and both assets resolve at runtime.

## C2 — View templates get their variables mangled (cross-file include scope)

**Severity:** High. **File:** transformer + assembler.

**Problem.** The transformer detects "dynamic scopes" (extract/compact/`$GLOBALS`/
`$$x`/`${…}`) **per file** (lines 952–986) and preserves variables there. But view
templates receive their variables from the **including** code (a method that does
`extract($data); include $view;`). Analyzed on its own, a view file has no `extract`,
so its scope is not dynamic and its `$title`, `$args`, etc. get mangled to `$_v_…` —
while the includer set them under their original names. Result: undefined variables in
views at runtime.

**Fix steps (pick one, prefer the first):**

1. **Exclude view/template files from variable mangling.** Views are markup, not IP
   worth mangling. In the assembler batch step, pass a "no variable mangling for these
   paths" set, or run the transformer with a mode that skips `$_v_` renaming for files
   under any `views/` or `*/templates/` directory (and the inlined
   `src/FrameworkClosure/views/`). Class/function/const mangling can still apply to
   real code; only local-variable mangling is unsafe for included partials.
2. Alternatively, treat **file scope** (scope id 0) as always-dynamic for variables
   (never mangle top-level `$vars`), since any top-level file may be `include`d into a
   foreign scope. This is safer but reduces obfuscation of top-level scripts.

**Acceptance.** A view file that references `$title` (provided by its includer via
`extract`) keeps `$title` after obfuscation; the rendered admin page shows data, not
"undefined variable" notices.

## C3 — PHP `glob('**')` recursive fallback never matches

**Severity:** Medium. **File:** inliner (`normalizeClosureRequires`, line ~524).

**Problem.** The generated require-fallback uses
`glob($_fc_dir . '/modules/*/src/**/${filename}')` and `glob($_fc_dir . '/**/${filename}')`.
PHP's `glob()` has **no** globstar; `**` behaves like a single `*`, so these patterns
usually match nothing and the last-resort require silently fails.

**Fix steps.**

1. Replace the `**` globs with a bounded set of explicit depths (the require
   candidates already list 1–4 `dirname()` levels above; extend that list), OR
2. Emit a small recursive search helper (a `RecursiveDirectoryIterator` closure) into
   `functions-closure.php` and call it as the last resort instead of `glob('**')`.

**Acceptance.** A file that lives deeper than the 4 hardcoded `dirname()` levels is
still located by the fallback (add a unit/integration check that the emitted code
finds a deep file).

## C4 — Consumer namespace is guessed for unknown plugins

**Severity:** Medium. **File:** inliner (`CONSUMER_NAMESPACES`, lines 536–547 and
989–1001).

**Problem.** For a consumer not in `CONSUMER_NAMESPACES`, the namespace is derived by
kebab→PascalCase. If the plugin's real PHP namespace differs, the `class_alias` /
`psr-4` wiring in `functions-closure.php` and `composer.json` won't match, so
autoloading fails **after** the external framework is deleted — exactly the scenario
the owner wants to support.

**Fix steps.**

1. Determine the real namespace from the plugin's own `composer.json`
   (`autoload.psr-4` first key) when available; fall back to the derived name only if
   composer.json has none.
2. Use that resolved namespace everywhere `consumerNs` is used (both functions).
3. Keep the explicit `CONSUMER_NAMESPACES` map as an override for known plugins.

**Acceptance.** Inlining a new plugin whose namespace is, e.g., `Acme\Foo` produces a
`functions-closure.php`/`composer.json` that references `Acme\Foo\Core\…`, and the
plugin boots with the external `wpdev` plugin **removed**.

## C5 — "Clean" build still minifies JS/CSS

**Severity:** Low/Medium (design). **File:** assembler (line ~298).

**Problem.** `minifyAssetsInTree` runs unconditionally, so even a clean/inline-only
build ships minified (unreadable) assets, contradicting "clean readable production
code". Also, the in-place minify overwrites the original file and then also writes a
`.min` sibling, so the readable original is lost.

**Fix steps.**

1. Only minify when `obfuscate` is on (assets are an IP-protection concern). For
   clean / spaghetti / inline-only builds, **skip** `minifyAssetsInTree`, or run it in
   "sibling-only" mode: write `foo.min.js` **without** overwriting `foo.js`.
2. Note the `assertFrameworkClosureMinifiedAssets` gate (inliner line 1107) requires
   `.min` siblings to exist — if you skip minify, either also relax that gate for
   non-obfuscate builds or always produce sibling `.min` files (without destroying the
   originals). Keep SCRIPT_DEBUG behavior intact (that was the reason siblings exist).

**Acceptance.** A clean/inline-only build keeps readable `foo.js`; SCRIPT_DEBUG=false
sites still find `foo.min.js`; the `assertFrameworkClosureMinifiedAssets` gate passes
for obfuscate builds and does not falsely fail clean builds.

## C6 — Delete or quarantine dead obfuscators to avoid confusion

**Severity:** Low. **Files:** `heavy-obfuscator.php`, `safe-ast-obfuscator.php`.

**Problem.** Neither file is used by the active pipeline (only `plan3/transformer.php`
is invoked). They are referenced only by `test-dependency-registry.mjs` and
themselves, yet `heavy-obfuscator.php` advertises the "spaghetti engine" that the docs
describe — misleading for future work.

**Fix steps.**

1. Confirm they are unused: `grep -rn "heavy-obfuscator\|safe-ast-obfuscator" --include=*.mjs`.
2. Either delete them (and their entries in `test-dependency-registry.mjs` and any
   test that loads them), or move them to a `dev/legacy/` folder with a header comment
   "NOT part of the active pipeline". Do not leave them where they look active.

**Acceptance.** `test-dependency-registry.mjs` and `npm test` stay green after the
removal/move.

---

# Ordering & dependencies

1. **A1** (transformer two-pass) → **A2** (inline toggle) → **A3** (wire flags) →
   **A4** (rector message). After A, the three capabilities run independently.
2. **B1** (whitelists) and **B3** (preserveStrings) touch the transformer — do them
   together, right after A1. **B2** (minifier paths) is independent, do any time.
3. **C1–C5** are correctness fixes; do after A so each can be reproduced with a single
   capability. **C6** last (cleanup).

Suggested minimal order for a medium agent: A1 → A2 → A3 → B2 → C2 → C1 → C4 → B1 →
B3 → C3 → C5 → A4 → C6.

# How to verify the whole thing after each part

```bash
cd packages/standalone-build
export WPDEV_CONTENT_ROOT="<path-to>/wordpress/wp-content"

# 1. Unit/contract suites must stay green after every task:
npm test

# 2. Prove each capability runs alone (build-only, no deploy):
node build-all-standalone-plugins.mjs --targets=<plugin> --build-only                       # clean
node build-all-standalone-plugins.mjs --targets=<plugin> --inline-framework --build-only
node build-all-standalone-plugins.mjs --targets=<plugin> --spaghetti --build-only
node build-all-standalone-plugins.mjs --targets=<plugin> --obfuscate --build-only
node build-all-standalone-plugins.mjs --targets=<plugin> --inline-framework --spaghetti --obfuscate --build-only

# 3. Every generated PHP file must lint:
find <dist>/<plugin> -name '*.php' -print0 | xargs -0 -n1 php -l   # (the pipeline also runs validatePhpSyntaxTree)

# 4. Delete-framework smoke test for --inline-framework:
#    Build with --inline-framework, deploy to a WP install, deactivate/remove the wpdev plugin,
#    load an admin page that uses framework classes → no fatal, no "undefined variable" in views.
```

# Guardrails the fixer must not break

- Never introduce `eval()`, runtime code generation, or runtime string decryption.
- Never mangle: WP hook strings, gettext strings/placeholders, SQL, WooCommerce public
  classes, `WP_List_Table` ancestry, REST callbacks. (These are the preservation
  contracts; the transformer already tries to honor them — keep it that way.)
- Never edit deployed plugin folders directly; only source + staging.
- Keep artifact naming and the manifest `profile` field deterministic — the cache and
  verifier depend on them.
- After any transformer change, re-run `npm test` **and** an end-to-end
  `--obfuscate` build + `php -l` sweep before considering the task done.

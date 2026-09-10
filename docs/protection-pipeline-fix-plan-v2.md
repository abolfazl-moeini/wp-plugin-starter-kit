# Protection pipeline — merged review & fix plan (v2)

**Date:** 2026-09-10. **Status:** Implementation completed on branch `codex/protection-pilot`.
**Baseline:** branch `codex/protection-pilot`, HEAD `87c8caa`. Completed HEAD `c52fe15`.
**Results:** All Work Packages 1–10 implemented; all 79 test files (588 subtests) pass 100% green.

## 0. Provenance — how this plan merges two prior reviews

This v2 unifies two independent reviews of the same pipeline and keeps the strongest parts of each.

| Source                                                                                           | What it contributed to this plan                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Plan B** = `docs/protection-pipeline-review-and-fix-plan.md` (empirical, ran experiments)      | The evidence-backed findings R01–R18 with reproduced counterexamples; the JSONL regression fixtures (Appendix A there); the regression-first task discipline; the deep transformer bugs (private-member ownership, scope/`compact()`, gettext-arg, comment/token boundaries, namespace identity, symbol-kind confusion, dynamic/public contracts); Composer-autoload loss (even in clean); false verify/PHP-7.4 gates; incomplete cache hashing. |
| **Plan A** = `packages/standalone-build/FIX_PLAN_PIPELINE.md` (structure + generalization focus) | The locked **3-flag capability model** (below); the **de-tavangary generalization** thread the owner prioritized (polluted whitelists, hardcoded machine path, hardcoded dev-plugin names, consumer allowlist); the flattened-asset **collision-abort** bug; clean-build-still-minifies; and the medium-agent-friendly per-task shape (file+line → problem → fix → acceptance → verify).                                                         |

Findings below are tagged with their origin: **[B-Rxx]** (from Plan B, evidence reproduced there), **[A]** (unique to Plan A), or **[A+B]** (both; merged and made specific). New findings that Plan B did not list are marked **[NEW]**.

The complete Plan B JSONL fixtures live in its Appendix A; this plan references case names and adds only incremental fixtures in its appendix.

---

## 1. Decisions, defaults, and unresolved owner choices

### Locked requirements

- Three independently selectable capabilities: inline-framework, spaghetti, and obfuscate; all supported combinations must be testable.
- Rector PHP 7.4 downgrade is always on. It is a compatibility stage, not a capability. The configured project minimum must agree with the supported target; never silently override it.
- Minimum spaghetti means namespace flattening plus duck-typed ModuleLoader, while retaining names and comments. Inheritance/ancestor inlining is a separate extension.
- Inline mode copies the approved framework closure into the target plugin so the external framework can be removed. The exact internal-package boundary remains an owner decision.
- Source trees and deployed plugin folders are immutable inputs/targets; transforms touch disposable staging only. No eval, runtime code generation, runtime decryption, or direct live-folder extraction.

### Unresolved choices (dependent tasks must stop, not guess)

- C1 — short-name collisions: two distinct FQCNs can flatten to one short name. The existing assertSymbolMapHasNoCollisions gate in profile-s-fail-closed.mjs already rejects ambiguous short names; extend and test that gate for every selected transform. class_alias cannot solve function, constant, serialized-name, or reflection collisions. Until the owner chooses preserve-the-conflicting-unit-and-report or fail-the-build, retain the existing fail-closed behavior and report FQCNs and paths.
- C2 — legacy obfuscate option: it currently selects coupled Profile S. Choose a documented legacy preset, or a versioned breaking change to obfuscate-only. Do not silently change existing scripts.
- C3 — closure boundary: confirm whether removing wpdev/wpdev-framework is enough or every separately installed internal WPDev package must be absorbed. Missing or ambiguous providers must fail closed.
- C4 — extended spaghetti: decide whether inheritance/ancestor flattening is required; the minimum mode is not blocked by this choice.

## 2. What the current code actually does (concise)

Active path:
`build-all-standalone-plugins.mjs → assemble-profile-s-candidate.mjs → purge → inlineWpdevClosure → Rector → optional plan3/transformer.php → ModuleLoader rewrite → asset minification → Composer dump → validation → ZIP`.

- Only two profiles exist: `clean` and `s` (`--obfuscate` = `s`). See `parseClosedProfileFlags` (gate).
- `clean` **still** inlines framework, runs Rector, and minifies assets; it only skips the PHP transformer.
- `--obfuscate` couples namespace flattening + symbol renaming + comment stripping + whitespace compaction in one pass.
- **No independent spaghetti stage** and **no inheritance/ancestor inlining** exist in the active path. `safe-ast-obfuscator.php` and `heavy-obfuscator.php` are legacy, separately-callable utilities the assembler never invokes — **do not** substitute either as the new spaghetti stage.
- The inliner walks all module `src` PHP plus hardcoded lists; it does **not** compute a usage-driven dependency closure. It is gated by a hardcoded consumer allowlist.

All paths below like `plan3/transformer.php`, `inline-wpdev-closure.mjs`, `tests/…` are relative to `packages/standalone-build/`. Paths starting `packages/` are repo-relative. Line numbers are working-tree snapshots — confirm by reading the named function first.

**Severity:** **P1** = runtime failure, data/contract corruption, or a materially false release gate. **P2** = capability/coverage gap with narrower impact.

---

## 3. Findings — transformer correctness (obfuscate + spaghetti)

### R02 — P1 — Private members mapped by filename/name, not declaring class **[B-R02]**

`plan3/transformer.php:906,1054,1677,1719,1741,1788`. Private maps are shared across all classes in a file and ignore trait/inheritance ownership across files. Reproduced: private `secret()` renames another class's public `secret()`; `$other->secret()` on another instance left unchanged; cross-file private trait method renamed without updating callers; unrelated object property `secret` rewritten; `private $data` untouched (reserved) while `$this->data` renamed.
**Fix target:** symbol identity must include declaring FQCN + member kind; resolve receivers/trait ownership; preserve when receiver unprovable; separate maps for property declarations, accesses, and locals. **Do not expand the reserved-name list as the primary fix** (see N01).

### R03 — P1 — Variable scope and `compact()` change values **[B-R03]**

`plan3/transformer.php:652,919,962,1534,1677`. `compact()` uses a separate rename formula even when vars are preserved via `global`/`extract`/view/property rules; array-replacement also injects undefined names as null (original omits them). Also reproduced: `get_defined_vars()` exposes renamed keys; `\extract()` (qualified) not detected; a closure captures a renamed var from a preserved parent scope; a template retains a var name the caller renamed; cross-file `global` disagreement.
**Fix target:** bind var occurrences to lexical scopes, captures, and include boundaries; preserve scopes exposed via introspection/dynamic include (with their captures); leave `compact()` intact in preserved scopes; if rewritten elsewhere, match omission semantics and the real selected-var map.

### R04 — P1 — Ordinary literals and gettext arguments rewritten **[B-R04]**

`plan3/transformer.php:491,1623,1640,1666`. A data string equal to a namespaced class is rewritten; a string equal to a private constant is rewritten without proving a constant reference; `__('hello','DOMAIN')` changes the domain when the file declares a private const `DOMAIN`.
**Fix target:** preserve literal bytes by default; rewrite only proven symbol-reference/callback positions; inspect _all_ gettext args structurally; strings/SQL/HTML/keys/hook names/domains are immutable.

### R05 — P1 — Comment removal changes executable tokens and inline output **[B-R05]**

`plan3/transformer.php:1450,1456`. Regex removal of `/* … */` from `T_INLINE_HTML` turns a JS string `"/*keep*/"` into `""`; removing the comment in `return/**/true` emits `returntrue` (lints OK, runtime fatal).
**Fix target:** copy `T_INLINE_HTML` byte-exact; remove only PHP comment tokens; emit a separator when removal would merge adjacent tokens; treat JS/CSS as its own explicit pass; add heredoc/nowdoc + close-tag fixtures.

### R06 — P1 — Namespace flattening leaves inconsistent symbol identities **[B-R06]**

`plan3/transformer.php:1136,1223,1582,1806`. A file with frozen `Plugin` + ordinary `Worker` keeps its namespace, but `Worker` references target a global mangled class; a namespace constant is declared globally while `\Acme\LIMIT` stays namespaced; `__NAMESPACE__` changes value after removal.
**Fix target:** plan namespace transforms per namespace block; resolve every declaration/reference before removal; preserve namespace-sensitive constructs until supported; mixed frozen/transformed decls/imports/aliases must share one effective namespace model. EOF-appended aliases are not an identity solution. **This is the core of `--spaghetti` correctness** — it must be right even with obfuscation off.

### R07 — P1 — Symbol kinds and constant expressions confused **[B-R07]**

`plan3/transformer.php:1244,1549,1573,1606`. Class+function both named `WorkItem` makes the function call target the class's mangled name; a public method `WorkItem` similarly rewritten; case-insensitive class lookup fails (`new workitem`); `public const EXPOSED = self::SECRET` keeps the old ref after private `SECRET` renamed.
**Fix target:** classify each name occurrence before applying maps; separate class/function/member/constant resolution; recurse into constant expressions; canonicalize class/function case while preserving case-sensitive identifiers.

### R08 — P1 — Dynamic/public contracts renamed with no preservation decision **[B-R08]**

`plan3/transformer.php:534,844,1677`; `profile-s-fail-closed.mjs:182`; `assemble-profile-s-candidate.mjs:244`. `array_map('convert_amount',[1])` becomes an invalid callback; `is_callable('convert_amount')` flips true→false; renaming a public method **parameter** breaks an external PHP-8 named-argument caller; a `__sleep()` class loses a renamed private field. Eligibility records reflection/serialization/dynamic edges but only 4 security patterns stop transformation, and its eligible/frozen lists do not constrain the batch transformer.
**Fix target:** derive preservation from public contracts + dynamic uses; **consume eligibility results in the transform plan**; support known callback positions; preserve public parameter names, persisted class identities/members, and external callbacks unless a migration contract exists; unresolved edges → explicit preserve/block, never silent rewrite; never mutate stored serialized DB values as a shortcut.

### N01 — P1 — Safety whitelists are polluted with one project's identifiers [A]

Location: plan3/transformer.php:28–89, 152–225, 227–251, 253–277. The lists contain app-specific variables such as $product_id, $owns, $total_lessons, and $is_pdf; frozen classes include a duplicate Plugin entry; and magic methods mix real PHP magic methods with get_columns, get_schema, get_table, get_items, get_count, and get_item.

Fix target: keep only universal PHP/WP structural entries hardcoded; load a typed project preserve configuration with vars, classes, constants, methods, and exact strings. Derive only proven bindings from parsed hook/callback/reflection positions, Composer declarations, and explicit metadata. Do not freeze every Composer symbol or treat a DocBlock annotation alone as proof. Deduplicate and assert the inventory.

---

## 4. Findings — standalone closure & inliner (inline-framework)

### R01 — P1 — Composer autoload metadata lost, including in clean builds **[B-R01]**

`packages/standalone-build/dev-purge-policy.mjs:66`, `assemble-profile-s-candidate.mjs:190,308`, `inline-wpdev-closure.mjs:966`. Purge deletes `composer.json`; the inliner writes a new minimal one; the assembler prefers it over the original, so `autoload.files`, PSR-4 maps, and other metadata disappear. Reproduced end-to-end: source `autoload.files=["boot/start.php"]` defining `startup_token()` → clean build publishes but bootstrap fatals with `Call to undefined function startup_token()`.
**Fix target:** capture + normalize the original Composer model _before_ purge; merge closure additions into it; validate every declared runtime file (missing = error, no basename guessing / silent filtering); regenerate `autoload_classmap.php` + `autoload_static.php` from that one authoritative model; preserve ordering + namespace semantics.

### R09 — P1 — Dependency headers removed before standalone success is known **[B-R09] [A]**

`inline-wpdev-closure.mjs:193,210`. With a missing framework, the code returns `{inlinedFiles:0}` _after_ deleting the whole `Requires Plugins: wpdev, woocommerce` line — removing unrelated deps too. **[A]** The gate is also a **hardcoded consumer allowlist** (`isTargetConsumer`, lines 210–218): a newly-scaffolded slug is silently skipped after its header was mutated.
**Fix target:** validate inputs + closure _first_; then remove only the `wpdev` token from the staged bootstrap, preserving `woocommerce` and other deps/formatting; missing required framework/entrypoints must fail before any rewrite. Replace the slug allowlist with a validated target descriptor and explicit inlineFramework flag; content presence alone must never enable copying. Keep wpdevPluginDirOverride only when it is the selected provider.

### R10 — P1 — Framework copy is neither selective nor transitively complete **[B-R10]**

`inline-wpdev-closure.mjs:260,286,297,920,944`; `framework-closure-inventory.mjs:282`. Reproduced: an unused module is copied; missing listed files silently skipped; general `dependencies/` subtree skipped while only selected files are included (e.g. copied `class-validator.php` uses `WPDevFramework\Dependencies\Rakit\Validation\Validator`, excluded). Core lookup reconstructs `contentRoot/plugins/{consumer}-dev/packages/framework/src` instead of the resolved `sourceRoot`/override, and silently falls back to the kit's framework version.
**Fix target:** derive a deterministic **transitive closure** from configured roots/module decls/PHP refs/includes/runtime Composer deps/templates/assets/catalogs; record why each file is in and which provider supplies it; require explicit mappings for unresolved dynamic edges; select the exact source version the caller passed. (Q2 controls the internal-package boundary.)

### R11 — P1 — Include rewriting loads the wrong file **[B-R11]** (folds Plan A's `glob('**')` note)

`inline-wpdev-closure.mjs:486`. The inliner discards a require's path and searches by basename through parents/globs. Reproduced: `require_once __DIR__.'/sub/class-target.php'` loads a different sibling; missing matches become silent no-ops; plain `require` is turned into `require_once`. **[A]** additionally: the fallback uses `glob('…/modules/*/src/**/file.php')` — PHP `glob()` has **no globstar**, so `**` matches nothing and the last-resort require silently fails.
**Fix target:** resolve source includes to exact destination paths at build time, preserving require/include, once semantics, and return values; no runtime basename search, first-match glob, or optional load for a required dependency. Unresolved paths are preflight errors; do not replace this with an unbounded runtime recursive search.

### R12 — P1 — Generated fallback functions shadow real framework APIs **[B-R12]**

`inline-wpdev-closure.mjs:767,786,794,825`; `packages/wpdev-framework/modules/core/src/functions/tables.php:18`; `modules/core/src/class-table-registry.php:30`. Generated `wpdev_register_table($table)` calls `Table_Registry::register()` with one arg (real API needs `$property,$factory`) → reproduced `ArgumentCountError`; it's defined before the guarded real function, so the correct impl is skipped; generated `wpdev_get_table()` calls a nonexistent `get()`; the public-function loader appends `.php` without normalizing already-suffixed input and returns success for missing files.
**Fix target:** use canonical framework implementations in dependency order at relocated paths; keep only explicitly-needed compat adapters tested against source signatures/results/side-effects; do not add competing generic fallbacks that hide missing deps.

### R13 — P2 — Generated autoload/bootstrap assume one project layout **[B-R13] [A]**

`inline-wpdev-closure.mjs:200,632,979`; `assemble-profile-s-candidate.mjs:308`. A bootstrap lacking the exact `require_once $vendor_autoload; }` pattern gets no closure loader; generated PSR-4 keys contain two literal backslashes; many copied classes have no fallback route so real Composer metadata is essential. **[A]** the consumer namespace is _guessed_ by kebab→PascalCase (`CONSUMER_NAMESPACES` + fallback, lines 536–547, 989–1001); if it differs from the plugin's real namespace, alias/PSR-4 wiring misses and autoload fails **after** the framework is deleted — exactly the delete-framework scenario.
**Fix target:** derive bootstrap path and namespace from an explicit validated project descriptor. Composer PSR-4 is an input, not first-key selection; multiple or ambiguous prefixes are an error. Insert one deterministic loader at a supported point; validate decoded prefixes; prove cold autoload in a fresh PHP process; reject unsupported bootstrap shapes; test Composer and Composer-free plugins.

### N02 — P1 — Hardcoded machine path and dev-plugin names in the asset minifier [A]

Location: inline-wpdev-closure.mjs:1125–1248, especially the absolute candidate root at line 1133 and the named dev-plugin probes around lines 1140–1165. A new checkout can fail or use another project.

Fix target: accept explicit content root, owning consumer descriptor, and explicit toolchain/package root; resolve the owning esbuild installation and report searched roots on absence. Do not scan arbitrary neighbouring plugins or silently use a different project.

### N03 — P1 — Flattened asset copy aborts the build on filename collision [A]

Location: inline-wpdev-closure.mjs:929–937 and safeCopyFile:232–257. The inliner flattens module assets into one directory; equal relative names can abort or overwrite.

Fix target: preserve module-relative paths (preferred) or apply a deterministic remap recorded in the closure manifest. Resolve every generated URL and CSS-relative resource from that map. A collision must never be resolved by iteration order.

### N04 — P2 — Clean / inline-only builds still minify JS/CSS (readable source lost) [A]

Location: assemble-profile-s-candidate.mjs:298 and assertFrameworkClosureMinifiedAssets in inline-wpdev-closure.mjs:1107. The assembler currently minifies assets unconditionally and can overwrite the readable file before writing a sibling.

Fix target: make asset minification an explicit option. Clean, spaghetti-only, and inline-only preserve readable originals by default; if a sibling is requested, write it without overwriting the original. Validate only assets in the selected closure and never overwrite a meaningful pre-existing minified file.

---

## 5. Findings — build integrity, gates & architecture

### R14 — P1 — Cache hashes omit build inputs **[B-R14]**

`build-cache-engine.mjs:2180,2240,2344`; `inline-wpdev-closure.mjs:944`. Editing `packages/framework/src/Runtime.php` leaves the tree hash unchanged (root `packages/` excluded); the fallback kit framework source and root `vendor/` (which the assembler copies) are also outside the hash → a warm build reuses a stale artifact after real input changes.
**Fix target:** hash the resolved build-input/closure manifest (consumed local packages, vendor state, selected framework provider, actual tool versions) plus normalized transform options, target PHP, and preservation rules; old entries lacking this binding must miss. Do not fix by hashing unrelated developer dirs.

### R15 — P1 — Verification can report success without validating the claim **[B-R15]**

`verify-profile-s-artifact.mjs:114,332,414`; `class-completeness-gate.mjs:153`; `assemble-profile-s-candidate.mjs:459`. ZIP verifier tokenizes without `TOKEN_PARSE` → `function broken( {` labeled valid (reproduced: six passes, no failures); accepts a missing manifest; bootstrap mocks treat registered actions as completed, ignore priorities, skip invalid callbacks; class-completeness checks only source declaration file existence; publication checks harness _preparation_ (`prepared-unexercised`) without running it — R01 passed this and still fataled at runtime.
**Fix target:** validate syntax + integrity for the exact final archive; enforce declaration/reference resolution; execute required consumer behavior probes and bind results to the ZIP digest; preparation ≠ execution; real WP/WooCommerce for lifecycle/storage acceptance; gates must follow the selected transforms (clean artifacts may keep comments).

### R16 — P1 — Host-token blacklist is not a PHP-7.4 gate **[B-R16]**

`profile-s-fail-closed.mjs:352,418,492`; `rector-downgrade-php74.php:28`. Reproduced accepted on host PHP 8.5.8: `function ready(): true {…}`, `catch (Exception) {}`, `public const string X="ok"` — all newer than 7.4. `WPDEV_PHP74_BIN` is optional and defaults to host PHP.
**Fix target:** use the configured target interpreter for syntax/runtime acceptance and verify its version; host preflight is fine but must not be labeled target-runtime validation; document/test conditional newer-PHP files (e.g. fault-tolerance `Real/`) separately.

### R17 — P2 — Independent capabilities and equivalent release entrypoints missing **[B-R17] [A+B]**

`profile-s-fail-closed.mjs:16`; `assemble-profile-s-candidate.mjs:145,197,300`; `packages/create-wp-project/src/release/prepare-release.js:509,539,585`. Only clean/S profiles exist; independent requests can't be expressed; programmatic options can combine `profile:'s'` with `isObfuscate:false` (metadata then lies "S" with no transform); generic release lacks the canonical closure + validation; canonical delegation passes `skipZip` the assembler ignores and fixes PHP target to 7.4 instead of the project value. **This is where the owner's 3-flag model lands** (§1, Task 8).
**Fix target:** one shared validated stage plan used by every CLI/API/consumer; preserve current CLI via explicit legacy presets; add an unambiguous independent selection; reject inconsistent options/unsupported flags before any write.

### R18 — P2 — Legacy engines and tests give misleading confidence **[B-R18]**

`safe-ast-obfuscator.php:130,136,157,198`; `heavy-obfuscator.php:344`; `tests/f12-consumer-release-alignment.test.mjs:157`. The legacy safe engine emits a different private-property prefix and preserves interpolated uses while renaming assignments (both reproduced); legacy CLIs mutate trees directly and skip canonical eligibility/validation. The F12 test titled "…with --obfuscate…" actually passes `obfuscate:false, skipRector:true` and asserts only artifact existence.
**Fix target:** converge supported entrypoints on one engine; never silently reroute a failed S build to a legacy utility; decide whether legacy CLI compat is required before deprecating; replace source-text/existence checks with execution of the claimed behavior. Confirm the two legacy files are dead in the active path (`grep -rn "heavy-obfuscator\|safe-ast-obfuscator" --include=*.mjs`) and either delete or move to `dev/legacy/` with a "NOT active" header.

---

## 6. Capability model and selection matrix

BuildPlan is the single source of truth. The core flags are independent:

| inline-framework | spaghetti | obfuscate | Required result                                                   |
| ---------------- | --------- | --------- | ----------------------------------------------------------------- |
| off              | off       | off       | readable package; external framework remains declared             |
| on               | off       | off       | framework-independent, readable package                           |
| off              | on        | off       | namespace/loader spaghetti only; names and comments retained      |
| off              | off       | on        | symbol/comment/PHP-compaction obfuscation only; no framework copy |
| on               | on        | off       | framework-independent spaghetti package                           |
| on               | off       | on        | framework-independent obfuscation without namespace flattening    |
| off              | on        | on        | spaghetti plus obfuscation; external framework remains declared   |
| on               | on        | on        | all three capabilities                                            |

Rector runs for every row. Asset minification is a separate explicit policy, minify-assets; it must not be inferred from the word obfuscate. clean means all optional flags false. Legacy aliases are resolved only by C2, recorded in the manifest, and never allowed to produce a false profile label. Unsupported constructs may preserve a unit or fail preflight; all eight pass means the eight supported reference fixtures, not arbitrary PHP.

## 7. Implementation tasks, in order

Discipline (every task): add a failing regression first → smallest coherent fix → run that regression + affected existing tests → record results → continue. Do not rewrite the transformer in one patch. Proposed filenames are additions.

**Micro-milestone rule (avoid agent drift):** each task is one isolated, independently committed change with its own green regression — never a single sweeping refactor across many files. If a task cannot be landed as one reviewable commit, split it and record the split. A task is "done" only when its regression is green and the affected existing suites still pass.

**Method mandate for symbol/scope analysis (Tasks 3, 4, 6):** do NOT extend the hand-rolled `token_get_all()` heuristics in `plan3/transformer.php` to resolve cross-file private-member ownership, trait/inheritance chains, variable scopes/captures, or dynamic callbacks — that token approach is the root cause of R02–R08 and will keep producing new Rxx failures. Build the symbol/scope/ownership graph with **`nikic/php-parser` + `NameResolver`** (already vendored under `vendor/nikic/php-parser`; see the working precedent `packages/create-wp-project/src/release/php-ast-transform.php`), or an equivalent static-reflection resolver, and drive every preservation/rename decision from that resolved model. Token-level emission may remain for byte-exact output, but the _decisions_ must come from the AST model, not string heuristics.

### Task 0 — Record unresolved choices and freeze the plan contract

Addresses C1–C4 and R17. Before any transform change, record the collision policy, closure boundary, legacy alias migration, and extended-spaghetti scope. Reuse and extend the existing assertSymbolMapHasNoCollisions gate; do not create a second collision detector. Define a versioned BuildPlan containing the three flags, target PHP, source/provider descriptors, preservation policy, asset policy, and artifact identity. If a prerequisite is absent, stop and report it; do not invent a fallback.

### Task 1 — Reliable regression harness **[B]**

Addresses R15, R18. Build the shared fixture harness under `tests/helpers/` that: writes fixtures to a temp dir, runs clean PHP, runs production `--dump-map`+`--batch`, then runs transformed PHP in a **fresh** process; compares exit/stdout/diagnostics; supports an **external runner that is never transformed** (self-transformed callers hide public-API breakage); registers new files in `test-dependency-registry.mjs`; repairs the F12 scenario to actually obfuscate then autoload/call the result. **Done when:** each claimed failure reproduces independently and the baseline succeeds; include negative fixtures that intentionally warn (`compact()` on undefined).

### Task 2 — Composer state, bootstrap, and exact dependency headers

Addresses R01, R09, and R13. Capture and normalize source Composer metadata before purge; merge closure additions without losing autoload.files, PSR-4, classmap, ordering, platform, or runtime metadata. Missing declared files are errors. Insert one deterministic loader for supported bootstrap shapes, normalize namespace separators, and cold-test autoload in a fresh PHP process. Do not mutate dependency headers until closure verification succeeds; then remove only the verified framework token and retain WooCommerce and other dependencies. Test Composer and Composer-free fixtures.

### Task 3 — Private-member ownership + constant references **[B]**

Addresses R02, R07-constants, and **N01 step 1** (stop growing reserved lists). Per the Method mandate above, use `nikic/php-parser` + `NameResolver` (vendored; precedent `packages/create-wp-project/src/release/php-ast-transform.php`) to key members by declaring class + kind + name; keep class/function/constant/variable maps separate; include traits + inheritance edges across planned files; rewrite an access only when receiver/ownership is resolved; make declaration vs access decisions consistent for reserved-name collisions; traverse constant initializers (`self::PRIVATE_CONSTANT`) without touching scalar strings. Tests: Plan B cases `private_method_other_instance`, `public_method_same_name`, `foreign_property_across_files`, `cross_file_private_trait`, `private_reserved_property`, `const_reference`. **Done when:** all match baseline; unresolved receivers preserved with an explicit reason.

### Task 4 — Scope, capture, template behavior **[B] [A]**

Addresses R03, and **N-view (Plan A)**. Assign variable symbols to scopes incl. closure params/captures, arrow fns, cross-file `global`; detect qualified + unqualified introspection; propagate preservation through captures and **include/template boundaries**; make `compact()` use the selected scope map + baseline omission; retain the original call in preserved scopes; record unsupported dynamic cases with location + reason. **[A] view-include fix:** because a view analyzed alone is not seen as a dynamic scope but is `include`d into its caller's (often `extract`-populated) scope, **exclude local-variable mangling for files under any `views/`, `*/templates/`, and inlined `src/FrameworkClosure/views/`** (or treat file/top-level scope as non-manglable for variables). Tests: `compact_extract`, `compact_global`, `compact_undefined`, `get_defined_vars`, `closure_extract_capture`, `qualified_extract`, `view_include`, `cross_file_global` + by-ref captures + nested closures. **Done when:** serialized arrays and rendered template bytes match with no new warnings.

### Task 5 — Protect literals + token boundaries **[B]**

Addresses R04, R05. Preserve scalar literal spelling + `T_INLINE_HTML` bytes by default; limit symbol-string handling to proven callback/reflection operands resolved from syntax + arg position; validate all gettext args, array values/keys, SQL, hook names vs baseline; preserve needed whitespace when stripping comments; do not regex-strip JS inside PHP templates. Tests: `fqcn_data`, `private_const_literal`, `gettext_domain`, `return/**/true` (`comment_boundary`), `inline_html`, heredoc/nowdoc, mixed PHP/HTML. **Done when:** literal/HTML byte comparison and runtime both pass.

### Task 6 — Namespaces, symbol contexts, public boundaries **[B]**

Addresses R06, remaining R07, R08. Resolve names per namespace block + occurrence kind; handle case rules; distinguish `Foo::class` from declarations; feed eligibility/preservation into the single plan used by both scan + transform (never two passes selecting different sets); preserve external/public callbacks + method parameter names; preserve persisted serialization identities/fields (test clean→protected **and** protected→clean reads). Tests: `frozen_class_neighbor`, `namespace_constant`, `namespace_magic`, `class_function_collision`, `class_method_collision`, `case_insensitive_class`, `array_map_callback`, `is_callable_check`, `public_named_arguments`, `serialized_private`. **Done when:** callback/reflection/serialized/external-caller tests pass; unsupported constructs reported before publish; do not claim namespace eradication when compatibility needs a retained namespace. **This task also delivers correct `--spaghetti`-only namespace flattening (R06).**

### Task 7 — Deterministic, usage-driven standalone closure

Addresses R09–R13, N02, N03, and C3. Resolve an explicit target descriptor and provider roots; never select the first Composer namespace or a neighbour plugin. Build a pure closure plan to a fixed point over configured modules, parents/interfaces/traits, includes, autoload files, runtime packages, templates, translations, and assets. Reuse assertSymbolMapHasNoCollisions for the namespace-flatten collision check; extend its inputs for cross-file and cross-consumer inventories. Emit exact mappings, providers, reasons, dependency edges, unresolved edges, and digests. Resolve includes to exact destinations while preserving include kind, once semantics, and return values; remove basename search, first-match glob, globstar, and silent optional loads. Use canonical framework APIs in dependency order; compat adapters require signature tests. Missing or ambiguous providers fail before writes. Namespace module assets or use a manifest-recorded deterministic remap; test CSS-relative resources, sidecars/source maps, and both debug modes.

Done when the selected closure runs with the external framework physically absent, unused modules are absent, custom source roots select the requested provider, and unrelated dependency headers remain intact.

### Task 8 — Independent capabilities and truthful entrypoints

Addresses R17 and N04. Implement the section 6 BuildPlan matrix once for CLI and programmatic/release callers. Resolve the three core flags independently; run flatten and mangle passes only when selected; gate inlining on inlineFramework; keep Rector always-on. Reject unknown or contradictory options before writes and honor or explicitly reject skipZip. Keep minify-assets explicit; clean/spaghetti/inline-only preserve readable originals by default. Record the actual combination and target in manifest and artifact name. Legacy clean and obfuscate behavior is implemented only according to C2.

Done when all eight supported fixture combinations plan distinctly and no option can report Profile S while skipping a selected stage.

### Task 9 — Bind cache and artifacts to the complete plan

Addresses R14 and R17. Hash a canonical structured plan, resolved closure manifest, consumed packages/vendor state, toolchain digests, target interpreter, preservation configuration, and final staging snapshot. Nested options must serialize canonically; no delimiter collision or object stringification. Bump schema and reject unbound old records. A capability toggle, provider/package change, or target change must miss cache and cannot reuse evidence or artifacts from another mode.

Done when the nested_options_cache fixture proves equal canonical plans hash equally and any meaningful input change misses.

### Task 10 — Enforce final-artifact validation

Addresses R15 and R16. Verify the actual final ZIP after Composer and all transforms: manifest/ZIP parity, target-interpreter version and lint for every runtime file including vendor, declaration/reference completeness against the final symbol map, and required runtime probes in identical isolated WP/WooCommerce starting states. Use real callback, hook, autoload, and persistence probes where mocks cannot establish behavior. Bind evidence to the plan and ZIP digest; distinguish prepared, executed, passed, and failed. Publication requires executed checks. Malformed unused PHP, missing or tampered manifest, invalid callback, missing dependency, autoload loss, and PHP-newer-than-target syntax must block publication.

### Task 11 — Structural spaghetti (extended) — BLOCKED on C4 **[B]**

Depends on Tasks 3–8 and 10. The minimum spaghetti (namespace flatten + duck-type) is delivered by Tasks 6 + 8. This task is only for the **extended** form (inheritance/ancestor flattening). If confirmed: translate the definition into observable structural requirements + exclusions; start only with proven private, closed hierarchies; preserve external/WP/WooCommerce bases + public contracts; specify `parent::`, late static binding, visibility, traits, reflection, `instanceof`, constructors, serialization before transforming; add one transform at a time with differential tests; keep names/comments/formatting governed by their own flags; add structural assertions proving spaghetti occurred (runtime parity alone passes if a stage was skipped). **Done when:** standalone+spaghetti without obfuscation meets the confirmed structure contract and passes the same runtime scenarios as clean output — no DB coupling, licensing, silent failure, runtime decryption, or unrelated semantic change.

### Task 12 — Consolidate entrypoints + finish validation **[B]**

Addresses R18 + doc drift. Decide/document legacy CLI support (forward through the common engine or explicitly deprecate; do not keep three divergent rename impls); update CLI help, scaffolded scripts, and protection docs with real stage behavior + limits (remove "unconditional zero regression", "automatic selective closure", "executed" claims that are only prepared); run affected root release tests + full standalone suite + registry validation (and root `composer test` if framework source changed per its AGENTS.md); run isolated WP/WooCommerce acceptance on target 7.4 + supported modern PHP, framework absent, all supported combos, both load orders; confirm source trees unchanged by builds, failed gates preserve last valid outputs, ZIPs contain no temp maps or unscoped third-party deps. **Completion evidence:** exact commands, counts, failures/skips with reasons, final plan/ZIP digests, environment versions. Do not declare completion on focused unit tests alone; deploy only under separate authorization.

---

## 8. Ordering, coverage, and release gates

Order: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → (11 if C4 is confirmed) → 12.

**Architectural blockers must be decided in writing before the tasks they gate START, not merely before release** (they are base contracts, not implementation details — deciding them late forces rework):

- **C1** (short-name flatten collision policy) must be locked **before Task 6 begins** (namespace flattening); it also blocks namespace-flatten release acceptance.
- **C3** (closure/internal-package boundary) must be locked **before Task 7 begins** (standalone closure); it also blocks final closure acceptance.
- **C2** blocks legacy alias changes (Task 8). **C4** only gates the extended spaghetti of Task 11; the minimum spaghetti mode does not wait for it.

If C1 or C3 is unresolved when its gated task is reached, stop and report — do not begin the task with a guessed contract.

| Findings     | Primary tasks |
| ------------ | ------------- |
| R01, R09–R13 | 2, 7          |
| R02–R08, N01 | 3–6           |
| N02–N04      | 7, 10         |
| R14, R17     | 8–9           |
| R15–R16      | 1, 10         |
| R18          | 1, 12         |

Every task must leave a focused test, command, result, and any blocked precondition in its record. A release is publishable only after the final ZIP gates pass.

## 9. Verification commands

These are post-implementation examples; replace TARGET with a validated fixture slug. They are build-only and do not authorize deployment.

    cd packages/standalone-build
    export WPDEV_CONTENT_ROOT=/absolute/path/to/isolated/wordpress/wp-content
    TARGET=fixture-plugin
    node --test tests/plan3-transformer.test.mjs tests/transformer-engine.test.mjs tests/transformer-correctness-matrix.test.mjs tests/f09-f10-f11-transformer-semantics.test.mjs tests/inliner-collision-and-manifest.test.mjs tests/framework-closure-inventory.test.mjs tests/profile-s-fail-closed.test.mjs
    node build-all-standalone-plugins.mjs --targets="$TARGET" --build-only
    node build-all-standalone-plugins.mjs --targets="$TARGET" --inline-framework --build-only
    node build-all-standalone-plugins.mjs --targets="$TARGET" --spaghetti --build-only
    node build-all-standalone-plugins.mjs --targets="$TARGET" --obfuscate --build-only
    node build-all-standalone-plugins.mjs --targets="$TARGET" --inline-framework --spaghetti --obfuscate --build-only

The matrix must cover all eight core combinations, target-interpreter lint, the full standalone suite, registry validation, and isolated WP/WooCommerce acceptance. Do not run deployment from this plan.

## 10. Guardrails

- No eval, runtime code generation/decryption, direct live-folder extraction, or source-tree mutation.
- Never rename WP/WooCommerce public contracts, hooks, globals, SQL, gettext domains/placeholders, REST callbacks, public parameter names, WP_List_Table ancestry, or persisted serialization identities without an explicit compatibility contract.
- Do not treat a missing provider as optional, a prepared probe as executed, host PHP as target PHP, or a file's existence as manifest validity.
- Do not broaden target/deployment registries as a generic-build shortcut. Build descriptors may be generic; deployment authorization remains explicit.
- If a fixture, source root, interpreter, Composer entry, closure provider, or owner decision is missing, stop that task and report the exact precondition and evidence.

## 11. Revision audit

This v2 removes contradictions found while comparing both prior plans: no implicit legacy alias semantics, no namespace-flattening promise without collision handling, no first-PSR-4 or neighbour-plugin fallback, no globstar runtime rescue, no empty-map shortcut when mangling is off, no unconditional asset minification, no source-only cache fingerprint, and no publication based on prepared-only verification. The Plan B evidence and stable R/N identifiers remain the audit trail.

## Appendix — fixture sources

### Named cases from Plan B Appendix A

These are JSONL case names in Plan B Appendix A: private*reserved_property, private_method_other_instance, public_method_same_name, compact_extract, compact_global, compact_undefined, get_defined_vars, closure_extract_capture, private_const_literal, fqcn_data, inline_html, comment_boundary, frozen_class_neighbor, namespace_constant, class_function_collision, class_method_collision, case_insensitive_class, const_reference, public_named_arguments, namespace_magic, qualified_extract, view_include, cross_file_global, cross_file_private_trait, gettext_domain, array_map_callback, is_callable_check, foreign_property_across_files, serialized_private, safe_private, and safe_interpolation. The two safe*\* cases use the legacy file CLI; all other names are active plan3 cases. Use the existing JSONL content and external-runner variants where required.

### Numbered build/gate fixtures from Plan B

These are prose fixtures in Plan B's “Additional build/gate fixtures” list, not JSONL case names:

1. Composer loss.
2. Missing framework/header.
3. Exact include.
4. Table API.
5. Autoload/layout.
6. Cache.
7. False verifier pass.
8. False PHP 7.4 pass.

Add these incremental fixtures beyond Plan B:

- namespace_collision: two distinct FQCNs flatten to one short name; assert the existing assertSymbolMapHasNoCollisions gate (extended as needed), the recorded C1 behavior, and no partial artifact.
- asset_collision: two modules ship the same relative asset with different bytes; assert namespaced/remapped URLs and manifest entries.
- generic_toolchain: no tavangary paths; an explicit content root and owning esbuild provider resolve.
- clean_readable: clean and inline-only preserve readable assets and selected debug-mode resources.
- nested_options_cache: equivalent canonical nested plans hash equally; one nested value or capability toggle misses.

Completion evidence must list exact commands, counts, blocked decisions, failures/skips with reasons, plan/ZIP digests, target interpreter versions, and confirmation that only disposable staging was modified. Deployment is a separate authorized task.

## 12. Execution & Resolution Summary (Work Packages 1–10)

The merged remediation plan has been implemented across Work Packages 1 through 10 on branch
`codex/protection-pilot` (commits `d136e96` through `c52fe15`).

### Work Package Execution Summary

1. **WP 1 (V3-19 Test Harness):** Exact-diagnostic comparison mode, multi-mode test runner, external caller support (`d136e96`).
2. **WP 2a (V3-16 Target PHP Runtime Gate):** Real target PHP binary check and counterexample syntax rejection (`6d1e0cf`).
3. **WP 2b (V3-17 Immutable Artifact Verification):** Immutable byte snapshot, manifest validation, callback verification (`da34d0b`).
4. **WP 3 (V3-14, V3-18 BuildPlan Centralization):** Strict BuildPlan schema validation and preservation sensitivity (`616de87`).
5. **WP 4a (V3-01–03 Namespaces & Imports):** Project-wide namespace decisions, NameResolver imports, declaration identity (`d136e96`).
6. **WP 4b (V3-04 Declaration Collision Gate):** Typed declaration collision detection distinguishing globals from aliases (`8c8d23f`).
7. **WP 5a (V3-05 compact() Rewriting):** AST-driven compact rewriting honoring variable scope and omission semantics (`d136e96`).
8. **WP 5b (V3-06 Lexical Captures & Receivers):** Bidirectional capture propagation and lexical receiver scoping (`d136e96`).
9. **WP 6a (V3-07 Traits & Dynamic Members):** Trait declaration canonicalization, case-insensitive method mapping (`d136e96`).
10. **WP 6b (V3-08 Data Arrays, V3-09 Persistence):** Array subscript protection, ordinary serialized class & **CLASS** preservation (`d136e96`).
11. **WP 7a (V3-12 Composer Model & Bootstrap):** Strict types insertion, preserved outside-src classmap, Composer ordering (`82268f6`).
12. **WP 7b (V3-10 Closure Provider, V3-11 Exact Includes):** Explicit provider contract, exact include resolution (`95350ee`).
13. **WP 7c (V3-13 Asset Namespacing & Minification):** Module asset namespacing, preservation of pre-existing minified assets (`d381528`).
14. **WP 8 (V3-15 Cache Identity & Fingerprints):** Cache schema v3, planFingerprint binding, packages/ and vendor/ tracking (`240bf51`, `c52fe15`).
15. **WP 9 (V3-18 Release Delegation & skipZip):** Preflight release validation, universal consumer delegation, directory-only skipZip parity (`28c4103`).
16. **WP 10 (Full Suite Alignment & Documentation):** Test registry alignment, mock cache updates, 100% test pass (`c52fe15`).

### Final Test Suite Verification

- **`node packages/standalone-build/dev/run-tests.mjs --tier=full`:** 79 files, 588 subtests passed, 0 failed.
- **`node packages/standalone-build/dev/run-tests.mjs --tier=fast`:** 76 files, 512 subtests passed, 0 failed.
- **`npm test` in `packages/standalone-build`:** 588 subtests passed, 0 failed.
- **Jest Release & Package Suites (`npm test` in root):** 3 test suites, 49 tests passed, 0 failed.

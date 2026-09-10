# Protection pipeline: code review and implementation plan

**Date:** 2026-09-10. **Status:** review and plan only; no implementation authorized or performed.
**Audience:** an implementation agent of moderate capability. Execute one numbered task at a time, with its regression tests first.
**Baseline:** branch `codex/protection-pilot`, HEAD `87c8caa`, including existing uncommitted changes. Do not reset, replace, or attribute those changes to this review.

## 1. Decisions still needed from the owner

These questions were asked during the review and remain unanswered. Do not infer their answers from the older protection documents.

- **Q1 — Spaghetti:** Does this mean flattening inheritance/module boundaries while retaining names and readable formatting, or does it also include PHP minification/comment removal? Specify the structural changes that must happen. Task 11 is blocked on this answer; the confirmed bug fixes are not.
- **Q2 — Standalone scope:** Is removing the external `wpdev`/`wpdev-framework` plugin sufficient, or must the build also eliminate every separately installed internal WPDev package? Runtime dependencies of whatever is copied must still be bundled/resolved. Final closure acceptance depends on this answer.

Confirmed requirements: standalone copying, spaghetti, and obfuscation must each be selectable independently. In particular, spaghetti must work with obfuscation disabled. Source trees stay clean; transformations only affect disposable build staging. Public behavior must be preserved.

## 2. What the current code actually does

The active canonical path is:

`build-all-standalone-plugins.mjs → assemble-profile-s-candidate.mjs → purge → inlineWpdevClosure → Rector → optional plan3/transformer.php → ModuleLoader rewrite → asset minification → Composer dump → validation → ZIP`.

- `--profile=clean` still inlines the framework, runs Rector and minifies assets. It skips the PHP transformer.
- `--obfuscate`/`--profile=s` couples namespace flattening, symbol renaming, comment stripping and whitespace compaction.
- No independent structural spaghetti stage or class-ancestor inlining implementation was found in this active path. Namespace removal and whitespace compaction do not flatten inheritance.
- `safe-ast-obfuscator.php` and `heavy-obfuscator.php` are separately callable legacy utilities. The active assembler calls neither. Do not substitute either as the new spaghetti stage.
- The inliner traverses all module `src` PHP files plus hardcoded lists. It does not consume a dependency closure calculated from the target plugin's usage. `framework-closure-inventory.mjs` is a separate analysis tool, not the inliner's input.
- Generic scaffold releases and the seven hardcoded canonical consumers take different release paths.

## 3. Verification performed and limits

- Eight existing focused test files: **43 tests passed, zero failures/skips**.
- Canonical registry validation: **72 physical files / 72 registered files**, valid. Current tiers are 20 unit, 49 contract, 2 integration, 1 meta; older documentation differs.
- First transformer experiment: **24 behavioral differences in 26 inputs; all 26 transformed main files passed host `php -l`**. Two controls passed and are not findings.
- Five additional active-transformer inputs reproduced gettext-domain corruption, callback failures, foreign-property corruption and serialization loss.
- Two legacy safe-obfuscator inputs reproduced private-property and interpolation failures.
- Synthetic inliner experiments reproduced dependency-header deletion with no framework, wrong include selection and an API argument-count fatal.
- A real **clean assembler run on a disposable fixture** published a ZIP and passed its gates, but the built bootstrap failed with `Call to undefined function startup_token()`; the source printed `loaded`.
- The separate ZIP verifier returned `passed` for a ZIP containing unused syntactically invalid PHP and no manifest.
- The PHP 7.4 gate accepted three incompatible syntax examples on host PHP **8.5.8**. This review did not execute a PHP 7.4 runtime or full WordPress/WooCommerce end-to-end suite.

Production plugins, databases and deployment targets were not changed. The full 72-file suite was not run. This is a review of the current build/transform code with executable counterexamples, not a certification that every consumer flow has been exercised. WAL/deployment internals were outside the detailed review scope.

## 4. Findings

In this findings section, short paths such as `plan3/transformer.php`, `inline-wpdev-closure.mjs` and `tests/...` are relative to `packages/standalone-build/`. Paths starting with `packages/` are repository-relative. Line numbers refer to this working-tree snapshot. P1 means runtime failure, data/contract corruption, or a materially false release gate; P2 means a capability/coverage gap with a narrower impact. “Reproduced” distinguishes experiments from source tracing.

### R01 — P1: Composer autoload metadata is lost, including in clean builds

**Locations:** `packages/standalone-build/dev-purge-policy.mjs:66`, `assemble-profile-s-candidate.mjs:190`, `:308`, `inline-wpdev-closure.mjs:966`.

Purge removes `composer.json`. The inliner then creates a new minimal one. The assembler prefers this new file over the original source Composer definition, so root `autoload.files`, namespace mappings and other metadata disappear. Filename heuristics do not recover arbitrary autoload files.

**Reproduced end to end:** source Composer has `autoload.files = ["boot/start.php"]`, defining `startup_token()`. The clean build publishes successfully, but its generated `autoload_files.php` contains only `functions-closure.php`; bootstrap then fatals. This is independent of obfuscation.

**Fix target:** preserve the original normalized Composer model before purge, merge closure additions into it, validate every declared runtime file, and regenerate autoload from that model. No basename guessing or silent filtering of missing files. Preserve file ordering and namespace semantics.

### R02 — P1: private members are mapped by filename/name, not declaring class

**Locations:** `plan3/transformer.php:906`, `:1054`, `:1677`, `:1719`, `:1741`, `:1788`.

Private maps are shared across all classes in one file and do not follow trait/inheritance ownership across files. Reproduced cases:

- A private `secret()` in one class causes another class's public `secret()` declaration to be renamed.
- `$other->secret()` on another instance of the same class is left unchanged although its private declaration was renamed.
- A private trait method declared in another file is renamed without updating its consumer's call.
- An unrelated object's property named `secret` is rewritten because the containing file has a private property of that name.
- `private $data` stays unchanged because `$data` is reserved, while `$this->data` is renamed.

**Fix target:** symbol identity must include declaring FQCN and member kind. Resolve receivers/trait ownership; preserve the member when its receiver cannot be proven. Property declarations, accesses and locals must use distinct maps. Never expand the hardcoded reserved-name list as the primary fix.

### R03 — P1: variable scope and `compact()` transformations change values

**Locations:** `plan3/transformer.php:652`, `:919`, `:962`, `:1534`, `:1677`.

`compact()` uses a separate rename formula even when variables were preserved by `global`, `extract`, view rules or property-name rules. Replacing it with an array also includes undefined names as null, whereas the original omits them. These are reproducible output changes.

Also reproduced: `get_defined_vars()` exposes renamed keys; `\extract()` is not detected; a closure captures a renamed variable from a preserved parent scope; a template retains a variable name whose caller renamed it; a global assignment and a different file's `global` declaration disagree.

**Fix target:** bind variable occurrences to lexical scopes, captures and include boundaries. Initially preserve scopes exposed through introspection/dynamic includes, including their capture dependencies. Leave `compact()` intact in preserved scopes. If rewriting it elsewhere, match its omission behavior and actual selected variable map.

### R04 — P1: ordinary literals and gettext arguments are rewritten

**Locations:** `plan3/transformer.php:491`, `:1623`, `:1640`, `:1666`.

An ordinary data string equal to a namespaced class is rewritten. Any matching private-constant string is rewritten without proving that it is a constant reference. Gettext detection does not protect all argument positions: `__('hello', 'DOMAIN')` changes the domain when the file declares private constant `DOMAIN`.

**Fix target:** preserve literal bytes by default. Rewrite only proven symbol-reference expressions/callback positions. Inspect all gettext arguments structurally; ordinary strings, SQL, HTML payloads, keys, hook names and domains are immutable.

### R05 — P1: comment removal changes executable tokens and inline output

**Locations:** `plan3/transformer.php:1450`, `:1456`.

- Regex removal of `/* ... */` from `T_INLINE_HTML` changes a JS string containing `"/*keep*/"` to `""`.
- Removing the comment in `return/**/true` emits `returntrue`, which passes syntax lint but fails at runtime as an undefined constant.

**Fix target:** copy `T_INLINE_HTML` exactly. Remove only PHP comment tokens; emit a separator whenever removal would merge adjacent tokens. Treat JS/CSS processing as its own explicit pass. Add heredoc/nowdoc and close-tag fixtures before adjusting token emission.

### R06 — P1: namespace flattening leaves inconsistent symbol identities

**Locations:** `plan3/transformer.php:1136`, `:1223`, `:1582`, `:1806`.

Reproduced: a file containing frozen `Plugin` plus ordinary `Worker` retains its namespace, but `Worker` references target a global mangled class. A namespace constant is declared globally while `\Acme\LIMIT` remains namespaced. `__NAMESPACE__` returns a different value after namespace removal.

**Fix target:** plan namespace transformations per namespace block and resolve every declaration/reference before removing it. Preserve namespace-sensitive constructs until semantics are supported. Mixed frozen/transformed declarations, imports and aliases must share the same effective namespace model. Aliases appended blindly at EOF are not a general identity solution.

### R07 — P1: symbol kinds and constant expressions are confused

**Locations:** `plan3/transformer.php:1244`, `:1549`, `:1573`, `:1606`.

Reproduced: a class and function both named `WorkItem` make the function call target the class's mangled name. An object's public method named `WorkItem` is similarly rewritten. Class lookup does not consistently follow case-insensitive class names (`new workitem` fails). `public const EXPOSED = self::SECRET` retains the old reference after private `SECRET` is renamed.

**Fix target:** classify name occurrences before applying maps; use separate class/function/member/constant resolution. Apply constant-expression transforms recursively. Canonicalize class/function lookup case while preserving case-sensitive identifiers where required.

### R08 — P1: dynamic/public contracts are renamed without a preservation decision

**Locations:** `plan3/transformer.php:534`, `:844`, `:1677`; `profile-s-fail-closed.mjs:182`; `assemble-profile-s-candidate.mjs:244`.

Reproduced: `array_map('convert_amount', [1])` becomes an invalid callback; `is_callable('convert_amount')` changes from true to false. Public method parameter renaming breaks an unchanged external caller using named arguments on PHP 8+. A serialized class using `__sleep()` loses a renamed private field.

Eligibility reports reflection/serialization/dynamic edges but only four security patterns stop transformation. Its eligible/frozen file lists do not constrain the batch transformer.

**Fix target:** derive preservation from public contracts and dynamic uses; consume eligibility results in the transform plan. Support known callback positions. Preserve public parameter names, persisted class identities/members and external callbacks unless a migration contract exists. Unresolved edges must produce a precise preserve/block decision, not silent blind rewriting. Do not alter stored serialized database values as a shortcut.

### R09 — P1: dependency headers are removed before standalone success is known

**Locations:** `inline-wpdev-closure.mjs:193`, `:210`.

Reproduced with a missing framework: `{inlinedFiles: 0}` is returned after deleting the entire `Requires Plugins: wpdev, woocommerce` line. Thus an unrelated dependency is removed too. Unknown consumers can also be skipped after their header is changed. Canonical asset checks may subsequently stop a build; they do not make this mutation correct.

**Fix target:** validate inputs and closure first, then remove only the `wpdev` dependency token in the staged bootstrap. Preserve other dependencies and formatting variants. Missing required framework/entrypoints must fail before rewriting. Do not rely on an unrelated later asset check.

### R10 — P1: framework copying is neither selective nor transitively complete

**Locations:** `inline-wpdev-closure.mjs:260`, `:286`, `:297`, `:920`, `:944`; `framework-closure-inventory.mjs:282`.

Reproduced: an unused module is copied. Source tracing shows missing listed files are silently skipped, general `dependencies/` directories are skipped, and only selected dependency files are explicitly included. For example, the copied `modules/core/src/helpers/class-validator.php` uses `WPDevFramework\Dependencies\Rakit\Validation\Validator`, while the general dependency subtree is excluded. A consumer's separately bundled vendor may mask this omission; its absence must be detected.

Core source lookup also reconstructs `contentRoot/plugins/{consumer}-dev/packages/framework/src`, rather than using the resolved `sourceRoot`/plugins override, and silently falls back to the kit's framework version.

**Fix target:** derive a deterministic transitive closure from configured roots, module declarations, PHP references, includes, runtime Composer dependencies, templates, assets and catalogs. Record why each file is included and which provider supplies it. Require explicit mappings for unresolved dynamic edges. Select the actual source version passed by the caller. Q2 controls the final internal-package boundary.

### R11 — P1: include rewriting loads the wrong file

**Location:** `inline-wpdev-closure.mjs:486`.

The inliner discards a require's path and searches by basename through parents/globs. Reproduced: `require_once __DIR__.'/sub/class-target.php'` loads a different sibling `class-target.php`; output is `WRONGprobe` instead of `CORRECTprobe`. Missing matches become silent no-ops. This also changes ordinary `require` into `require_once`.

**Fix target:** resolve source includes at build time to exact destination paths, preserving include/require and once semantics and return values. Preserve relative module layout where possible. No runtime basename search, first-match glob or optional load for a required dependency.

### R12 — P1: generated fallback functions shadow real framework APIs

**Locations:** `inline-wpdev-closure.mjs:767`, `:786`, `:794`, `:825`; `packages/wpdev-framework/modules/core/src/functions/tables.php:18`; `modules/core/src/class-table-registry.php:30`.

The generated `wpdev_register_table($table)` calls `Table_Registry::register()` with one argument, while the real API requires `$property, $factory`. Reproduced `ArgumentCountError`. It is defined before the copied guarded real function, so the correct implementation is skipped. Generated `wpdev_get_table()` calls a nonexistent registry `get()` method. The public-function loader also appends `.php` without normalizing already-suffixed input and returns success for missing files.

**Fix target:** use canonical framework implementations with correct load order and relocated paths. Keep only explicitly needed compatibility adapters, tested against source signatures, results and side effects. Do not add competing generic fallback APIs to hide missing dependencies.

### R13 — P2: generated autoload/bootstrap rules assume one project layout

**Locations:** `inline-wpdev-closure.mjs:200`, `:632`, `:979`; `assemble-profile-s-candidate.mjs:308`.

Reproduced: a bootstrap without the exact `require_once $vendor_autoload; }` pattern receives no closure loader. Inliner-generated Composer PSR-4 keys contain two actual consecutive backslashes, rather than a single namespace separator. Classmap generation masks some malformed-prefix cases. Many copied framework classes have no corresponding generic fallback route; normal Composer metadata is therefore essential.

**Fix target:** derive bootstrap path and namespace from project metadata, insert one deterministic loader at a supported bootstrap point, validate decoded Composer prefixes, and prove a cold autoload in a fresh PHP process. Explicitly reject unsupported bootstrap shapes. Test both Composer and intentionally Composer-free plugins.

### R14 — P1: cache hashes omit build inputs

**Locations:** `build-cache-engine.mjs:2180`, `:2240`, `:2344`; `inline-wpdev-closure.mjs:944`.

Reproduced: editing `packages/framework/src/Runtime.php` leaves `computeTreeContentHash(..., true)` unchanged because root `packages/` is excluded. Those files can be directly consumed by the inliner. The fallback kit framework source is also outside the standalone tool-tree hash. Root `vendor/` is excluded although the assembler copies it. A warm build can reuse an artifact after actual runtime input changes.

**Fix target:** hash the resolved build-input/closure manifest, including consumed local packages, vendor state, selected framework provider and actual tool versions. Hash normalized transform options, target PHP and preservation rules. Old cache entries lacking this binding must miss. Do not fix by hashing unrelated developer directories indiscriminately.

### R15 — P1: verification can report success without validating the claim

**Locations:** `verify-profile-s-artifact.mjs:114`, `:332`, `:414`; `class-completeness-gate.mjs:153`; `assemble-profile-s-candidate.mjs:459`.

- ZIP verifier tokenizes without `TOKEN_PARSE`, so an unused `function broken( {` file is labeled syntactically valid. Reproduced full verifier result: six passes, no failures.
- The same verifier accepts a missing manifest and merely parses a legacy manifest if present. It does not validate the canonical manifest here. Other assembler/ZIP helpers have real integrity checks; keep those.
- Bootstrap mocks treat registered actions as completed actions, ignore priorities and skip invalid callbacks. The settings check only exercises its own mock options functions.
- Class completeness collects declarations/references but only checks source declaration file existence; collected references and `classMap` are not enforced.
- Assembler publication checks harness _preparation_, reporting `prepared-unexercised`, without running that harness. R01 passed this gate and still failed at runtime.

**Fix target:** validate syntax and integrity for the exact final archive, enforce declaration/reference resolution, execute required consumer behavior probes, and bind their results to that ZIP's digest. Preparation is not execution. Keep cheap unit stubs, but use real WordPress/WooCommerce for lifecycle/storage acceptance. Gates must follow the selected transforms so clean artifacts may retain comments.

### R16 — P1: host-token blacklist is not a PHP 7.4 compatibility gate

**Locations:** `profile-s-fail-closed.mjs:352`, `:418`, `:492`; `rector-downgrade-php74.php:28`.

Reproduced accepted inputs: `function ready(): true { return true; }`, `catch (Exception) {}`, and `public const string X = "ok"`. All require syntax newer than PHP 7.4. `WPDEV_PHP74_BIN` is optional and defaults to host PHP. Rector skips ordinary vendor files; output validation therefore matters independently of Rector.

**Fix target:** use the configured target PHP interpreter for syntax/runtime acceptance and verify its version. Structural preflight may run on the host, but must not be labeled target-runtime validation. Document and test conditional newer-PHP files such as fault-tolerance `Real/` separately; do not blindly force them into 7.4.

### R17 — P2: independent capabilities and equivalent release entrypoints are missing

**Locations:** `profile-s-fail-closed.mjs:16`; `assemble-profile-s-candidate.mjs:145`, `:197`, `:300`; `packages/create-wp-project/src/release/prepare-release.js:509`, `:539`, `:585`.

Only clean/S profiles exist. Independent requests cannot be expressed, and unknown feature flags may be silently ignored. Programmatic assembler options can combine `profile: 's'` with `isObfuscate: false`; metadata can then claim S despite no transform. Generic release lacks the canonical closure and final validation path. Canonical delegation passes `skipZip`, which the assembler does not honor, and fixes PHP target to 7.4 instead of the project value.

**Fix target:** a shared validated stage plan used by every CLI/API/consumer. Preserve existing CLI behavior through explicit legacy presets, while adding an unambiguous independent selection mechanism. Reject inconsistent options and unsupported flags before touching output.

### R18 — P2: legacy engines and tests can give misleading confidence

**Locations:** `safe-ast-obfuscator.php:130`, `:136`, `:157`, `:198`; `heavy-obfuscator.php:344`; `tests/f12-consumer-release-alignment.test.mjs:157`.

The safe legacy engine emits a different private-property declaration/access prefix; it also preserves interpolated variable uses while renaming their assignment. Both failures were reproduced. Legacy CLIs mutate passed trees directly and do not share canonical eligibility/validation. They are not a proven fallback.

The F12 test titled “Generic release with --obfuscate dumps Composer classmap” actually passes `obfuscate: false`, `skipRector: true` and asserts only artifact existence. It cannot prove its title's behavior.

**Fix target:** converge supported entrypoints on one engine; do not silently reroute failed S builds to a legacy utility. Establish whether legacy CLI compatibility is required before deprecating it. Replace misleading source-text/existence checks with execution of the behavior claimed by the test.

## 5. Implementation tasks, in order

Every task: add a failing regression first, make the smallest coherent fix, run that regression plus affected existing tests, record the result, then continue. Do not rewrite the entire transformer in one patch. Proposed file names below are additions, not files claimed to exist today.

### Task 1 — Establish reliable regression evidence

**Addresses:** R15, R18. **Inputs:** fixtures in Appendix A.

1. Add a shared test helper under `packages/standalone-build/tests/helpers/` that writes fixtures in a temporary directory, runs clean PHP, runs production `--dump-map` plus `--batch`, then runs transformed PHP in a fresh process.
2. Compare exit code, stdout and relevant diagnostics. Also support an external runner that is never transformed; self-transformed callers can hide public API breakage.
3. Enable assertions explicitly if using PHP `assert`; do not depend on local php.ini. Prefer explicit checks that throw/exit on mismatch.
4. Add the confirmed cases to existing relevant test files, or register any new test file in `test-dependency-registry.mjs` with its actual dependencies/tier. Keep expected source behavior, not mangled hashes, as assertions.
5. Repair the F12 scenario so it actually executes obfuscation and then autoloads/calls the resulting class/function.

**Done when:** each claimed failure is reproducible independently; the baseline succeeds. Record negative fixtures that intentionally warn, such as `compact()` on an undefined variable.

### Task 2 — Fix Composer state loss and bootstrap loading

**Addresses:** R01, R13. **Edit:** assembler, inliner; generic release metadata handoff if necessary.

1. Capture and validate source Composer metadata before staging purge. Pass it explicitly through the assembly context.
2. Merge closure autoload additions into that model; preserve order, classmap paths, PSR-4, files, runtime dependency configuration and platform policy.
3. Validate missing autoload files as errors, not `.filter(exists)` omissions. Rebuild `autoload_classmap.php` and `autoload_static.php` from the same authoritative data.
4. Normalize namespace separators; validate against the configured namespace. Ensure the actual bootstrap loads the resulting autoloader/closure exactly once.
5. Add the `boot/start.php` full clean/S fixture, a nonstandard autoload-file name, custom bootstrap filename, Composer-free fixture and cold alias/autoload checks.

**Done when:** both clean and S builds execute `startup_token()` successfully from a fresh external runner, and original autoload metadata survives. No deploy target is used for this test.

### Task 3 — Correct private-member ownership and constant references

**Addresses:** R02, R07's private constants.

1. Build declaration/member identities using the installed PHP AST facilities. `packages/create-wp-project/src/release/php-ast-transform.php` demonstrates local parser loading; it is not a drop-in replacement transformer. Keep class/function/constant/variable maps separate. Key members by declaring class, kind and name.
2. Include traits and inheritance edges across all planned first-party files. Only rewrite an access when receiver/ownership is resolved.
3. Make declaration and access decisions consistent for reserved-name collisions. Local variables with the same spelling are separate symbols.
4. Traverse constant initializers, including `self::PRIVATE_CONSTANT`, without rewriting unrelated scalar strings.

**Tests:** same-name public/private members across classes; foreign `stdClass`; same-class other-instance private call; cross-file trait private method; private `$data`; static/private member variants; `EXPOSED=self::SECRET`.

**Done when:** all these behaviors match baseline; unresolved receivers are preserved with an explicit reason, not guessed.

### Task 4 — Correct scope, capture and template behavior

**Addresses:** R03.

1. Assign variable symbols to scopes, including closure parameters/captures and arrow functions. Include `global` bindings across files.
2. Detect qualified and unqualified introspection calls. Propagate preservation through captures and known include/template boundaries.
3. Make `compact()` use the selected scope map and baseline omission semantics; retain the original call in preserved scopes.
4. Record unsupported dynamic include/variable cases with source location and preservation/block reason.

**Tests:** Appendix scope cases plus by-reference captures and nested closures. **Done when:** serialized result arrays and rendered template bytes match, without new warnings.

### Task 5 — Protect literals and token boundaries

**Addresses:** R04, R05.

1. Preserve scalar literal spelling and `T_INLINE_HTML` bytes by default.
2. Limit symbol-string handling to proven callback/reflection operands, resolved from syntax and argument position.
3. Validate all gettext arguments, array values/keys, SQL strings and hook names against the baseline.
4. Preserve necessary whitespace when stripping comments; do not regex-strip JS inside PHP templates.

**Tests:** FQCN-as-data, constant-name-as-data, gettext domain/context/plural arguments, `return/**/true`, JS `/*keep*/`, heredoc/nowdoc and mixed PHP/HTML. **Done when:** literal/HTML byte comparison and runtime comparison both pass.

### Task 6 — Resolve namespaces, symbol contexts and public boundaries

**Addresses:** R06, remaining R07, R08.

1. Resolve names per namespace block and occurrence kind; handle case rules correctly and distinguish `Foo::class` from class declarations.
2. Test mixed frozen/ordinary declarations, repeated import aliases in different namespaces, grouped imports, namespace constants, magic constants and conditional declarations.
3. Feed eligibility/preservation decisions into the plan used by both symbol scan and transform. Never let two passes select different symbol sets.
4. Preserve external/public callbacks and method parameter names. Support known callback APIs; block or preserve unresolved callable domains.
5. Preserve persisted serialization identities and fields; test clean-to-protected and protected-to-clean reads, not only a protected roundtrip.

**Done when:** callback, reflection, serialized-state and unchanged external-caller tests pass. Unsupported constructs are reported before a ZIP is published. Do not claim namespace eradication when compatibility requires retaining a namespace.

### Task 7 — Build a deterministic standalone closure

**Addresses:** R09–R13. **Q2:** resolve before finalizing which internal packages must be absorbed.

1. Introduce a pure closure-plan module (for example `framework-closure-plan.mjs`). Input: resolved source roots, target metadata, runtime Composer model and declared feature/module roots. Output: file mappings, symbol providers, dependency edges, resource roots, unresolved edges and digests.
2. Resolve the transitive closure to a fixed point: parents/interfaces/traits, helpers, includes, autoload files, runtime dependency packages, views, assets and translation catalogs. Reuse existing inventory logic only after reviewing its regex/closure limits; do not trust it as a complete graph.
3. Preserve module-relative file layout. Map includes to exact destinations while keeping `require`/`include`, once semantics and return values. Remove runtime basename/glob guessing.
4. Load canonical helper APIs in dependency order; remove shadow implementations demonstrated in R12. Verify public API signatures and behavior against the source framework.
5. Copy only planned files from the explicitly resolved source provider. Reject missing required files and unresolved edges before copying/publishing.
6. After closure verification, remove only `wpdev` from the dependency list. Retain `woocommerce` and any other dependencies.
7. Test with the external framework physically absent from the isolated runtime. No source-tree, Composer path-repository, or neighboring-plugin fallback may rescue the fixture.

**Done when:** the selected module and all transitive dependencies work without the parent framework; an unrelated module is absent; custom source/plugin directories select the right version. Include templates, assets with both `SCRIPT_DEBUG` values, translations, and two consumers in reversed activation orders. Shared globals/classes must have an explicit coexistence/version policy; existence guards alone do not prove semantic compatibility.

### Task 8 — Define independent build capabilities

**Addresses:** R17. **Edit:** shared option resolver, both release wrappers, assembler, pipeline, generated release entrypoints and configuration docs.

Suggested explicit interface: `--transforms=standalone,spaghetti,obfuscate`. The list is the complete requested selection; `--transforms=none` means packaging without optional transforms. Also support separate `strip-comments`, `minify-php`, `minify-assets` entries. These are proposed new options, not current commands.

1. Add a validated `BuildPlan` containing stage selection, PHP target, source roots, closure inputs and preservation policy. Derive identifiers and defaults from `wpdev.json`.
2. Expand legacy `--profile=s`, `--profile=clean` and `--obfuscate` into documented presets to retain existing CLI behavior. An explicit transform list must not inherit hidden stages from those presets; reject mixed selectors rather than guessing precedence.
3. Standalone only copies/relocates runtime dependencies; obfuscation only renames proven private symbols; formatting/comment options are independent. Spaghetti semantics await Q1.
4. Lower PHP syntax only according to the configured target. Standalone and minification do not implicitly select a different PHP target.
5. Normalize CLI and programmatic options with one resolver. Reject unknown stages, contradictory booleans/profiles and unsupported arguments before writes. Honor or explicitly reject `skipZip` consistently.
6. Route generic and registered consumers through the same stage engine. Keep only consumer metadata/probes in registries, not divergent implementations.

Required structural selection matrix (formatting flags tested separately):

| Standalone | Spaghetti | Obfuscate | Required property                                                 |
| ---------- | --------- | --------- | ----------------------------------------------------------------- |
| off        | off       | off       | ordinary package, original optional-transform behavior absent     |
| on         | off       | off       | framework-independent package, readable names/structure           |
| off        | on        | off       | spaghetti according to Q1, original public/private names retained |
| off        | off       | on        | symbol protection only, no implicit framework copying             |
| on         | on        | off       | framework-independent spaghetti, no symbol obfuscation            |
| on         | off       | on        | framework-independent protected symbols, no structural spaghetti  |
| off        | on        | on        | both transforms with the declared external dependencies retained  |
| on         | on        | on        | all three selected capabilities                                   |

For standalone-off cases, external dependencies remain declared and are supplied in the isolated runtime. Spaghetti may transform only owned/available source; missing needed input must be a preflight error. It must not silently enable standalone.

**Done when:** all eight combinations are planned distinctly, every supported combination builds and runs, and unsupported inputs fail before publishing. Comment/minification assertions follow explicit flags, not the word “Profile S”.

### Task 9 — Bind cache and artifacts to the complete plan

**Addresses:** R14, R17 metadata inconsistency.

1. Fingerprint actual resolved source/closure inputs, vendor/runtime packages, toolchain, PHP target, preservation policy and each transform option.
2. Include that plan fingerprint in artifact manifests, cache records and test evidence. Bump schemas and reject unbound old records.
3. Give different capability combinations distinct artifact identities/paths or require explicit output names. Do not silently overwrite a different mode's artifact.
4. Test warm-cache hits for unchanged plans, and misses after one local framework/package/vendor file changes or any capability toggles.

**Done when:** the reproduced package-source change invalidates cache, and no mode can reuse another mode's artifact/evidence.

### Task 10 — Enforce final-artifact validation

**Addresses:** R15, R16.

1. Use existing canonical manifest/ZIP parity helpers in every supported release route. Verify the actual final ZIP after Composer and all transforms.
2. Run target-version PHP lint on all applicable runtime files, including vendor. Verify interpreter version; test conditional newer-PHP branches separately.
3. Enforce class/reference completeness against first-party, bundled dependency and approved external symbols after transformation, with the final symbol map.
4. Execute behavior probes for bootstrap, autoload, hooks/callbacks, REST/Ajax, forms/settings, WooCommerce contracts and framework-free runtime. Use real WP fixtures for lifecycle ordering and persistence acceptance.
5. For clean vs transformed comparison, execute the same scenario against identical isolated starting state and compare observable output, hooks and storage effects. Do not compare two runs against a database already mutated by the first.
6. Bind passing evidence to the final ZIP digest and selected plan. Distinguish `prepared`, `executed`, `passed`, `failed`; release publication requires the relevant executed checks.

**Done when:** malformed unused PHP, missing/tampered manifest, invalid callback, missing dependency, clean-build autoload loss and incompatible PHP syntax all prevent release publication. Preserve existing rollback/transaction safeguards.

### Task 11 — Implement the agreed structural spaghetti transform

**Blocked on Q1; depends on Tasks 3–8 and 10.** This is a new capability, not a repair that can be assumed already implemented.

1. Translate the owner's definition into explicit observable structural requirements and exclusions.
2. If inheritance flattening is requested, start only with proven private, closed hierarchies. Preserve external/WP/WooCommerce bases and public contracts. Specify behavior for `parent::`, late static binding, visibility, traits, reflection, `instanceof`, constructors and serialization before transformation.
3. Add one small supported transformation at a time with differential tests. Unknown hierarchy/call semantics produce a clear preflight rejection or documented preservation of that unit.
4. Keep symbol names, comments and formatting governed by their own selections. Add structural assertions proving spaghetti actually occurred; runtime parity alone can pass if a stage was skipped.

**Done when:** standalone+spaghetti without obfuscation meets Q1's structure contract and passes the same runtime scenarios as clean output. No injected database coupling, licensing behavior, silent failure, runtime decryption or unrelated semantic change is authorized.

### Task 12 — Consolidate entrypoints and finish validation

**Addresses:** R18 and documentation drift.

1. Decide and document legacy CLI support; forward supported calls through the common validated engine or explicitly deprecate them. Do not maintain three divergent rename implementations.
2. Update CLI help, scaffolded scripts and protection documentation with real stage behavior and limitations. Remove claims of unconditional zero regressions, automatic selective closure, or executed tests that are only prepared.
3. Run affected root release tests, the full standalone suite and registry validation. If framework source changes, also run root `composer test` as required by its AGENTS.md.
4. Run isolated WordPress/WooCommerce acceptance on target PHP 7.4 and supported modern PHP, framework absent, all supported combinations, and both consumer load orders.
5. Confirm source trees are unchanged by builds, failed gates preserve the last valid outputs, and ZIPs contain no temporary maps or unscoped third-party dependencies.

**Completion evidence:** exact commands, counts, failures/skips with reasons, final plan/ZIP digests and environment versions. Do not declare completion on focused unit tests alone. Deploy only in a separately authorized task.

## 6. Commands and review evidence

Focused tests actually run, from repository root:

```sh
node --test \
  packages/standalone-build/tests/plan3-transformer.test.mjs \
  packages/standalone-build/tests/transformer-engine.test.mjs \
  packages/standalone-build/tests/transformer-correctness-matrix.test.mjs \
  packages/standalone-build/tests/f09-f10-f11-transformer-semantics.test.mjs \
  packages/standalone-build/tests/safe-ast-obfuscator.test.mjs \
  packages/standalone-build/tests/inliner-collision-and-manifest.test.mjs \
  packages/standalone-build/tests/framework-closure-inventory.test.mjs \
  packages/standalone-build/tests/profile-s-fail-closed.test.mjs
```

Later full standalone validation: `npm test --workspace=@wpdev/standalone-build`, with an explicitly isolated `WPDEV_CONTENT_ROOT` containing the required fixtures. Registry synchronization must be checked with `validateCanonicalTestRegistry(testsDir, contentRoot)`.

Temporary review evidence (may be cleaned by the OS; Appendix A retains reproducible inputs):

- `/private/tmp/wpdev-protection-review-existing-tests.log`
- `/private/tmp/wpdev-review-4cr39bu4/results.json`
- `/private/tmp/wpdev-review-more-smlvi95y/results.json`
- `/private/tmp/wpdev-protection-review-inliner.log` and `/private/tmp/wpdev-inliner-review-gTDOAQ/`
- `/private/tmp/wpdev-protection-review-assembly.log` and `/private/tmp/wpdev-assembly-review-iGcCxN/`
- `/private/tmp/wpdev-php74-review-83FZpX/`

The temporary inliner script's final registry call initially used an incorrect helper name; its preceding experiments completed. Registry validation was subsequently run separately with `validateCanonicalTestRegistry` and passed. An early assembly attempt stopped at fixture-specific gates and Rector's sandbox local-socket restriction; the completed run above used the finished fixture and an approved isolated execution. Neither failed setup attempt is counted as a product regression.

## Appendix A — Exact regression inputs

The following fixtures are source inputs, not proposed production implementations. For each active-transformer fixture: run `main.php` unmodified; create the symbol map **outside** its source tree with seed `audit-seed`; run `--batch <tree> <map> audit-seed main.php`; run `main.php` again in a fresh process. Expected stdout/exit below come from the clean source. Add external-runner versions for public contract cases. The named-argument example tests the transformer directly; Rector can lower internal calls, but cannot rewrite an external PHP 8 caller.

```jsonl
{"case":"private_reserved_property","engine":"plan3/transformer.php","files":{"main.php":"<?php class Vault {private $data='ok'; public function read(){return $this->data;}} echo (new Vault)->read();"},"expectedExit":0,"expectedStdout":"ok"}
{"case":"private_method_other_instance","engine":"plan3/transformer.php","files":{"main.php":"<?php class Vault {private function secret(){return 'ok';} public function read($other){return $other->secret();}} echo (new Vault)->read(new Vault);"},"expectedExit":0,"expectedStdout":"ok"}
{"case":"public_method_same_name","engine":"plan3/transformer.php","files":{"main.php":"<?php class Vault {private function secret(){return 'local';}} class Remote {public function secret(){return 'remote';}} echo (new Remote)->secret();"},"expectedExit":0,"expectedStdout":"remote"}
{"case":"compact_extract","engine":"plan3/transformer.php","files":{"main.php":"<?php function run_it(){extract(['amount'=>7]);return compact('amount');} echo json_encode(run_it());"},"expectedExit":0,"expectedStdout":"{\"amount\":7}"}
{"case":"compact_global","engine":"plan3/transformer.php","files":{"main.php":"<?php $amount=7; function run_it(){global $amount;return compact('amount');} echo json_encode(run_it());"},"expectedExit":0,"expectedStdout":"{\"amount\":7}"}
{"case":"compact_undefined","engine":"plan3/transformer.php","files":{"main.php":"<?php echo json_encode(compact('missing'));"},"expectedExit":0,"expectedStdout":"[]"}
{"case":"get_defined_vars","engine":"plan3/transformer.php","files":{"main.php":"<?php function run_it(){ $amount=7; return get_defined_vars(); } echo json_encode(run_it());"},"expectedExit":0,"expectedStdout":"{\"amount\":7}"}
{"case":"closure_extract_capture","engine":"plan3/transformer.php","files":{"main.php":"<?php function run_it(){extract(['amount'=>7]); $fn=function() use ($amount){return $amount;};return $fn();} echo run_it();"},"expectedExit":0,"expectedStdout":"7"}
{"case":"private_const_literal","engine":"plan3/transformer.php","files":{"main.php":"<?php class Vault { private const SECRET='value';public function read(){return 'SECRET';}} echo (new Vault)->read();"},"expectedExit":0,"expectedStdout":"SECRET"}
{"case":"fqcn_data","engine":"plan3/transformer.php","files":{"main.php":"<?php namespace Acme; class Widget {} echo 'Acme\\\\Widget';"},"expectedExit":0,"expectedStdout":"Acme\\Widget"}
{"case":"inline_html","engine":"plan3/transformer.php","files":{"main.php":"<?php echo \"begin\";?> <script>const pattern=\"/*keep*/\";</script>"},"expectedExit":0,"expectedStdout":"begin <script>const pattern=\"/*keep*/\";</script>"}
{"case":"comment_boundary","engine":"plan3/transformer.php","files":{"main.php":"<?php function run_it(){return/**/true;} echo run_it()?'ok':'bad';"},"expectedExit":0,"expectedStdout":"ok"}
{"case":"frozen_class_neighbor","engine":"plan3/transformer.php","files":{"main.php":"<?php namespace Acme; class Plugin {} class Worker {public function read(){return 'ok';}} echo (new Worker)->read();"},"expectedExit":0,"expectedStdout":"ok"}
{"case":"namespace_constant","engine":"plan3/transformer.php","files":{"main.php":"<?php namespace Acme; const LIMIT=7; echo \\Acme\\LIMIT;"},"expectedExit":0,"expectedStdout":"7"}
{"case":"class_function_collision","engine":"plan3/transformer.php","files":{"main.php":"<?php class WorkItem{} function WorkItem(){return 7;} echo WorkItem();"},"expectedExit":0,"expectedStdout":"7"}
{"case":"class_method_collision","engine":"plan3/transformer.php","files":{"main.php":"<?php class WorkItem{} class Box {public function WorkItem(){return 7;}} echo (new Box)->WorkItem();"},"expectedExit":0,"expectedStdout":"7"}
{"case":"case_insensitive_class","engine":"plan3/transformer.php","files":{"main.php":"<?php class WorkItem {public function read(){return 'ok';}} echo (new workitem)->read();"},"expectedExit":0,"expectedStdout":"ok"}
{"case":"const_reference","engine":"plan3/transformer.php","files":{"main.php":"<?php class Vault {private const SECRET=7;public const EXPOSED=self::SECRET;} echo Vault::EXPOSED;"},"expectedExit":0,"expectedStdout":"7"}
{"case":"public_named_arguments","engine":"plan3/transformer.php","files":{"main.php":"<?php class Box {public function read($amount){return $amount;}} echo (new Box)->read(amount:7);"},"expectedExit":0,"expectedStdout":"7"}
{"case":"namespace_magic","engine":"plan3/transformer.php","files":{"main.php":"<?php namespace Acme; echo __NAMESPACE__;"},"expectedExit":0,"expectedStdout":"Acme"}
{"case":"qualified_extract","engine":"plan3/transformer.php","files":{"main.php":"<?php function run_it(){\\extract(['amount'=>7]);return $amount;} echo run_it();"},"expectedExit":0,"expectedStdout":"7"}
{"case":"view_include","engine":"plan3/transformer.php","files":{"main.php":"<?php function run_it(){ $amount=7; include __DIR__.'/views/value.php';}run_it();","views/value.php":"<?php echo $amount;"},"expectedExit":0,"expectedStdout":"7"}
{"case":"cross_file_global","engine":"plan3/transformer.php","files":{"main.php":"<?php $custom_state=7; require __DIR__.'/other.php'; echo read_state();","other.php":"<?php function read_state(){global $custom_state;return $custom_state;}"},"expectedExit":0,"expectedStdout":"7"}
{"case":"cross_file_private_trait","engine":"plan3/transformer.php","files":{"main.php":"<?php require __DIR__.'/trait.php'; class Box {use SecretTrait;public function read(){return $this->secret();}}echo (new Box)->read();","trait.php":"<?php trait SecretTrait {private function secret(){return 'ok';}}"},"expectedExit":0,"expectedStdout":"ok"}
{"case":"gettext_domain","engine":"plan3/transformer.php","files":{"main.php":"<?php function __($text,$domain){return $domain;} class Vault {private const DOMAIN='unused';public function read(){return __('hello','DOMAIN');}}echo (new Vault)->read();"},"expectedExit":0,"expectedStdout":"DOMAIN"}
{"case":"array_map_callback","engine":"plan3/transformer.php","files":{"main.php":"<?php function convert_amount($x){return $x+1;}echo json_encode(array_map('convert_amount',[1]));"},"expectedExit":0,"expectedStdout":"[2]"}
{"case":"is_callable_check","engine":"plan3/transformer.php","files":{"main.php":"<?php function convert_amount(){return 7;}echo is_callable('convert_amount')?'yes':'no';"},"expectedExit":0,"expectedStdout":"yes"}
{"case":"foreign_property_across_files","engine":"plan3/transformer.php","files":{"main.php":"<?php class Vault {private $secret='local';public function read($other){return $other->secret;}} echo (new Vault)->read((object)['secret'=>'remote']);"},"expectedExit":0,"expectedStdout":"remote"}
{"case":"serialized_private","engine":"plan3/transformer.php","files":{"main.php":"<?php class Vault {private $secret='value';public function __sleep(){return ['secret'];}}echo serialize(new Vault);"},"expectedExit":0,"expectedStdout":"O:5:\"Vault\":1:{s:13:\"\u0000Vault\u0000secret\";s:5:\"value\";}"}
{"case":"safe_private","engine":"safe-ast-obfuscator.php","files":{"main.php":"<?php class Vault {private $secret='ok';public function read(){return $this->secret;}}echo (new Vault)->read();"},"expectedExit":0,"expectedStdout":"ok"}
{"case":"safe_interpolation","engine":"safe-ast-obfuscator.php","files":{"main.php":"<?php $amount=7;echo \"amount=$amount\";"},"expectedExit":0,"expectedStdout":"amount=7"}
```

Legacy `safe_*` fixtures use its file CLI rather than map/batch. The active transformer cases are the release-path regressions; do not count legacy failures as evidence that the current assembler invokes the legacy engine.

### Additional build/gate fixtures

1. **Composer loss:** `composer.json` = `{"name":"audit/probe","autoload":{"files":["boot/start.php"]}}`; `boot/start.php` defines `startup_token()` returning `loaded`; the plugin bootstrap requires `vendor/autoload.php` and calls it. Create source autoload with `composer dump-autoload --no-scripts --no-plugins`. Use an explicit synthetic framework source and its five required asset files. Run the canonical clean assembler into temporary output; an external runner defines `ABSPATH` and requires the built bootstrap. Expected: `loaded`, exit 0. Current: a published ZIP followed by undefined-function fatal.

2. **Missing framework/header:** main PHP header contains `Requires Plugins: wpdev, woocommerce`; supply a nonexistent framework path to `inlineWpdevClosure`. Expected: preflight error with no staged-header mutation. Current: returns zero copied files and removes the whole dependency line.

3. **Exact include:** framework contains `modules/core/src/class-probe.php` requiring `__DIR__ . "/sub/class-target.php"`; that nested target prints `CORRECT`, while the sibling `src/class-target.php` prints `WRONG`. Expected after inlining: `CORRECT`; current: `WRONG`. Also test a missing target, two same-name modules, require return values and repeated plain `require`.

4. **Table API:** copy the canonical two-argument `Table_Registry::register($property, $factory)` and source helper, load generated `functions-closure.php`, call `wpdev_register_table("orders", $factory)`. Expected: registry has the factory; current: one-argument call fatal. Also assert the lookup adapter calls a real supported registry API.

5. **Autoload/layout:** custom consumer/bootstrap with no `$vendor_autoload` pattern; check closure loader and decoded PSR-4 keys, then instantiate a copied class with a fresh Composer autoloader. An unused module fixture must not enter the final closure.

6. **Cache:** hash a source with `main.php` and `packages/framework/src/Runtime.php`; edit only `Runtime.php` and hash again. Expected fingerprint differs. Current fingerprints are equal. Repeat using the resolved fallback provider and copied runtime vendor inputs.

7. **False verifier pass:** ZIP root `tavangary-core/`, main `<?php /* Plugin Name: Audit */`, unused `src/Broken.php` = `<?php function broken( {`, no manifest. Current `verifyProfileSArtifact` returns passed. Split future tests so malformed PHP and missing manifest each independently fail.

8. **False PHP 7.4 pass:** each input in its own directory: `<?php function ready(): true {return true;}`, `<?php try {throw new Exception();} catch (Exception) {}`, `<?php class A {public const string X="ok";}`. Current `validatePhpSyntaxTree` accepts all on PHP 8.5.8. Required target-version gate must reject them for PHP 7.4.

# Protection pipeline — post-implementation review and completion plan (v3)

Date: 2026-09-10. Reviewed HEAD: `1ae87e2` (`codex/protection-pilot`). Working tree was clean when review started.

**Status: review and plan only. No production code, repository tests, source plugins, or deployed plugins were modified. No deployment was performed.** This document supplements [the v2 plan](protection-pipeline-fix-plan-v2.md); it does not authorize implementation or deployment.

## 1. Assessment and evidence

The implementation makes useful progress, but v2 is **not complete**. Passing the current regressions does not establish the claimed independent capabilities, standalone closure, persistence compatibility, or final-artifact release gates.

Verified improvements include the AST analyzer, preservation of the original Composer model before purge, removal of only the `wpdev` header token, real obfuscation and fresh-process autoload execution in F12, `TOKEN_PARSE` in the artifact verifier, additional PHP syntax checks, and readable asset originals surviving minification. These should be retained.

| Review check                                                                     | Observed result                                                                                                                                                             |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Six focused existing test files                                                  | 61 passed, 0 failed, 0 skipped                                                                                                                                              |
| Eight additional existing test files                                             | 35 passed, 0 failed, 0 skipped                                                                                                                                              |
| Canonical registry validation                                                    | Valid; 77 files: 25 unit, 49 contract, 2 integration, 1 meta                                                                                                                |
| New differential PHP probes using the existing production transformer harness    | 13 mismatches among 14 probes; every clean baseline exited 0                                                                                                                |
| Six fixtures × four flatten/mangle settings, using production map/batch commands | 9 runtime/parse failures among 24 combinations; collision gate accepted all 24 maps                                                                                         |
| New build/helper probes                                                          | Empty provider accepted; exact include rejected; missing include redirected; asset collision and overwrite reproduced; cache omission and false verifier success reproduced |

Environment: Node `v22.19.0`, PHP `8.5.8`. These are host-PHP observations. No actual PHP 7.4 runtime, full standalone suite, root PHPUnit suite, or isolated WP/WooCommerce acceptance was run. No final consumer release ZIP was built. The review ZIPs and transformed inputs were disposable fixtures under `/tmp` and the system temporary directory.

Severity: **P1** means runtime/data corruption, a materially false release gate, or a selected capability that cannot produce valid output. **P2** means a narrower contract/coverage gap. “Reproduced” below means executed locally; “code inspection” means the path was traced but not exercised end to end.

All abbreviated paths below are relative to `packages/standalone-build/`; `packages/create-wp-project/...` paths are repository-relative. Line numbers refer to the reviewed HEAD.

## 2. Findings

### V3-01 — P1 — Obfuscate-only emits invalid namespaced function declarations

**Location:** `plan3/transformer.php:1019–1022,1802–1813` (`scan_file_symbols`, function declaration emission). **Reproduced.** Related: v2 R06/R07/R17, Tasks 6/8.

`namespace Acme; function run_it(){return 7;} echo run_it();` fails with `--flatten=0 --mangle=1`: the declaration becomes `function Acme\_f_…()`, which PHP rejects. `simple` and `function_only` both fail in this mode; the three other flag combinations pass.

**Fix/acceptance:** resolve declaration identity separately from reference spelling; emit a short declaration identifier inside a retained namespace. Cover functions, references, imports, callbacks, and return-by-reference declarations in both obfuscation modes. Require syntax plus execution for all capability combinations, not merely distinct BuildPlan objects.

### V3-02 — P1 — Retained namespaces are local decisions; other files still target flattened symbols

**Location:** `plan3/transformer.php:1237–1275,1717–1751,1826–1840`. **Reproduced.** Related: R06, Task 6.

`lib.php` containing `namespace Acme; class Plugin{} class Worker{...}` retains its namespace because `Plugin` is frozen. A second file using `new \Acme\Worker` is rewritten to a global name that does not exist. The same failure occurs when a namespace-level constant forces retention. Both spaghetti-only and combined mode fail. The existing single-file `frozen_class_neighbor` test misses the cross-file reference.

**Fix/acceptance:** compute effective namespaces once, per namespace block, before building any rename map. Persist that decision and use it in every importing file. Test frozen neighbours, constants, multiple namespace blocks, imported aliases, and untransformed external callers. A retained namespace must be reported in the manifest.

### V3-03 — P1 — External function imports disappear under flattening

**Location:** `plan3/transformer.php:1551–1599` and `resolve_function_name`. **Reproduced.** Related: R06/R07, Task 6.

`namespace Acme; use function strlen as length; echo length('abc');` outputs `3` in both non-flattening modes, but both flattening modes fatal with `Call to undefined function length()`. An aliased `extract` call also fails. Imports are still resolved/emitted with token heuristics despite the AST mandate.

**Fix/acceptance:** derive imports and occurrence kinds from `NameResolver`. Preserve external imports or emit their proven fully qualified targets. Cover external and project functions/constants, grouped imports, aliases, and introspection imported under another name. Do not restrict the fix to `strlen` or `extract`.

### V3-04 — P1 — Collision gate confuses a real global declaration with a short alias

**Location:** `profile-s-fail-closed.mjs:279–392`, especially the “Valid short alias” branch; transformer map generation. **Reproduced.** Related: C1/R06, Tasks 0/6/7.

`namespace {class Worker{}} namespace Acme {class Worker{}}` passes `assertSymbolMapHasNoCollisions` with flattening enabled. Spaghetti-only then emits two global `Worker` declarations and fatals. The flat map cannot distinguish a real global declaration from its convenience alias for `Acme\Worker`.

**Fix/acceptance:** extend the existing gate with typed declaration records carrying original FQCN, kind, file/block, effective destination, and explicit alias status. Keep C1's fail-closed interim policy. Include global-vs-namespaced declarations, case variants, frozen declarations, functions/constants, and complete path diagnostics. Do not introduce a parallel collision detector.

### V3-05 — P1 — Retaining `compact()` does not preserve its referenced variables

**Location:** `plan3/symbol-analyzer.php:598–635`; `plan3/transformer.php:720–795,1767–1780`. **Reproduced.** Related: R03, Task 4.

Three independent failures remain:

- A preserved parameter plus a renamed local: `compact('param','local')` loses `local` and warns.
- Array arguments: `compact(['local'])` remains unchanged while `$local` is renamed; the result becomes `[]`.
- Assignment followed by `unset`: the analyzer mistakes “an assignment exists” for “defined at this call”; rewriting returns `{"local":null}` instead of omitting the name.

**Fix/acceptance:** retaining a compact call must preserve all names it may observe, or the containing scope when unresolved. Any rewrite must use the selected scope map and preserve omission/diagnostic semantics across branches, loops, `unset`, arrays, mixed preserved/mangled arguments, and variable arguments. Do not substitute an unconditional array expression.

### V3-06 — P1 — Closure preservation flows only downward; receiver types leak across scopes

**Location:** `plan3/symbol-analyzer.php:290–299,413–431,535–578`. **Reproduced.** Related: R02/R03, Tasks 3/4.

When a closure uses `get_defined_vars()`, its captured `$local` is preserved but the parent's assignment is renamed. `function run_it(){$local=7;$fn=function() use($local){return get_defined_vars();};return $fn();}` returns `{"local":null}` with a warning after transformation.

Separately, a method parameter `Box $other` remains in the analyzer's shared `param_types` while visiting `function($other){return $other->secret();}`. Calling that closure with a `Remote` object rewrites its public call to Box's private mangled method and fatals.

**Fix/acceptance:** solve capture preservation to a fixed point in both directions. Bind receiver types to lexical symbols, with scope push/pop and reassignment invalidation; a same-spelled child parameter is a different binding. Cover by-reference captures, nested closures/arrows, shadowed variables, typed parameter reassignment, and anonymous classes. Unknown types must produce preservation reasons, not speculative renames.

### V3-07 — P1 — Trait adaptations, shared ownership, method case, and dynamic member calls remain unsafe

**Location:** `plan3/symbol-analyzer.php:252–268,413–431,664–771`; member emission in `plan3/transformer.php:1990–2098`. **Reproduced.** Related: R02/R07/R08, Task 3.

- `use SecretTrait { secret as public read; }` keeps the adaptation's old method name while renaming the trait declaration; PHP fatals before execution.
- One trait used by two classes, only one of which has an unresolved receiver, produces incompatible preserve/rename decisions for the shared declaration. The other user's rewritten call fatals.
- `$this->SECRET()` fails after private `secret()` is renamed; member lookup is case-sensitive.
- `$method='secret'; $this->$method()` fatals because non-Identifier member names are not incorporated into preservation.

**Fix/acceptance:** model trait adaptations/precedence and declaring-member identity explicitly; propagate preservation to every consumer before emission. Canonicalize method names, not property/constant names. Record dynamic members and conservatively preserve their possible targets. Resolve inheritance access semantics instead of only recording parent metadata. Add permutation tests so file/class iteration order cannot change the result.

### V3-08 — P1 — Callable-shaped data is still rewritten as a callback

**Location:** `plan3/symbol-analyzer.php:468–485`; `plan3/transformer.php:448–507,1921–1924`. **Reproduced.** Related: R04/R08, Task 5.

`class Box{private function secret(){} public function read(){return [$this,'secret'][1];}} echo (new Box)->read();` outputs `secret` before transformation and `_m_777deff8` afterward. Merely having the shape `[$this, 'name']` does not prove a callback context.

**Fix/acceptance:** attach callback decisions to AST operand positions of known consumers or explicit project metadata. Preserve ordinary arrays, scalar literals, SQL, HTML, keys, and translations byte-for-byte. Add both the data-array counterexample and actual `call_user_func`/WordPress callback uses so preservation does not break valid callback rewriting.

### V3-09 — P1 — Persistence preservation covers selected magic methods, not plain serialized objects

**Location:** `plan3/transformer.php:829–847,2112–2130`; eligibility consumption at `assemble-profile-s-candidate.mjs:304–309`. **Reproduced at serialization output; migration runtime not executed.** Related: R08, Task 6.

`class Box{private $secret='ok';} echo serialize(new Box);` changes both the serialized class name and the visibility-mangled private-property key. The special preservation code only recognizes classes declaring `__sleep`/`__serialize`. The existing roundtrip within one transformed execution is insufficient evidence for saved data. `__CLASS__` also changes from `Acme\Worker` to a mangled global name in a separate probe.

**Fix/acceptance:** derive preservation from serialization/reflection usage and explicit persisted contracts, including ordinary classes and inherited serialization behavior. Preserve class and private-field identity together. Require clean→protected and protected→clean reads in fresh processes with non-default property values; aliases alone do not preserve private-property storage keys. Test `__CLASS__`, `__METHOD__`, reflected names and externally supplied class names under the declared compatibility policy. Do not migrate stored DB values as a workaround.

### V3-10 — P1 — Existing provider directories are treated as verified standalone closures

**Location:** `inline-wpdev-closure.mjs:235–268,310–366,975–984,1022–1029`; assembler call at `:275–284`. **Reproduced plus code inspection.** Related: C3/R09/R10/R13, Task 7.

An empty provider directory returns `inlinedFiles:0` successfully and removes `wpdev` from `Requires Plugins: wpdev, woocommerce`. An entirely unused module is copied. Provider existence is the only preflight requirement; missing listed files are skipped. Core source still comes from `contentRoot/plugins/{consumer}-dev/packages/framework/src`, not the selected consumer source root. The removed kit fallback now leaves Core absent silently when that conventional path is absent.

**Fix/acceptance:** resolve a target/provider descriptor and an explicit closure contract before writes. Plan a deterministic transitive closure including Composer runtime dependencies, ancestors/traits/interfaces, includes, functions, templates, assets, and translations. Require provider provenance and dependency reasons. Empty/incomplete/ambiguous providers must fail without header changes. Test custom source roots and physically absent external framework. Removing unrelated dependency tokens must remain forbidden.

### V3-11 — P1 — Include rewriting still selects by basename, not the source path

**Location:** `inline-wpdev-closure.mjs:532–577`. **Reproduced.** Related: R11, Task 7.

With both `src/class-target.php` and `src/sub/class-target.php`, an unambiguous `require __DIR__.'/sub/class-target.php';` now aborts as ambiguous. Worse, `require __DIR__.'/missing/class-target.php';` succeeds when only the sibling exists: it is silently rewritten to `require __DIR__.'/class-target.php';`.

**Fix/acceptance:** resolve the original include expression relative to its original file, then map that exact source path to its destination. Preserve include/require, once behavior, expression return values, scope, and evaluation order. Missing paths are preflight failures. Test duplicate basenames, assignment from require, plain include, conditional includes, and paths outside the selected closure. Do not replace the old glob fallback with another basename index.

### V3-12 — P1 — Bootstrap injection can invalidate PHP; namespace and Composer models still disagree

**Location:** `inline-wpdev-closure.mjs:207–223,589–599,1011–1019,1034–1048`; `assemble-profile-s-candidate.mjs:432–479`. **Bootstrap reproduced; remaining items from code inspection.** Related: R01/R13, Task 2.

`injectFunctionsClosureLoader('<?php declare(strict_types=1); namespace Demo; class Plugin {}')` inserts executable code before `declare`; `php -l` fatals. A namespaced bootstrap without strict types is likewise not a safe arbitrary insertion point.

The inliner picks the first PSR-4 key and truncates a nested prefix to its first segment, while `scopeFrameworkCoreForConsumer` separately derives a namespace from the slug. Their generated namespace/PSR-4 routes can disagree. During Composer regeneration, declared `autoload.classmap` is replaced by guessed directories, and helper filenames are auto-added to `autoload.files`. A source classmap such as `runtime/Legacy.php` can be omitted when `src/` exists. This still is not one authoritative runtime autoload model.

**Fix/acceptance:** use a validated descriptor with explicit bootstrap and consumer namespace; reject ambiguous PSR-4 configurations. Parse the bootstrap and choose a syntactically valid, deterministic supported insertion point. Merge, validate and preserve declared classmap/files ordering and path semantics; add only proven closure entries. Test nested/multiple PSR-4 mappings, custom bootstrap names, strict/namespaced bootstraps, Composer-free loading, and classes outside guessed directories in fresh PHP processes. Validate resolved paths against the approved runtime roots.

### V3-13 — P1/P2 — Asset path collisions remain; pre-existing minified assets are overwritten

**Location:** `inline-wpdev-closure.mjs:958–971,1170–1195,1248–1280`; `build-plan.mjs:251–255`. **Reproduced.** Related: N02/N03/N04, Tasks 7/8.

Two modules containing different `assets/main.js` still abort because both are first flattened into `FrameworkClosure/assets/main.js`; later module-local copies do not prevent that collision (**P1**, selected closure cannot build). Minification preserves readable originals now, but overwrites a meaningful existing `demo.min.js` unconditionally (**P2**, loses the selected production asset). An explicit obfuscate-only BuildPlan also defaults `minifyAssets` to true, contrary to v2's independent asset policy.

**Fix/acceptance:** namespace module assets/templates/functions or use deterministic mappings; resolve generated URLs, CSS-relative references and sidecars from those mappings. Preserve existing minified files unless an explicit replacement policy is selected. Separate legacy-preset minification from independent obfuscation. Test both `SCRIPT_DEBUG` states and missing explicit toolchains; do not silently substitute a different project's installation.

### V3-14 — P1/P2 — BuildPlan is not an enforced end-to-end contract

**Location:** `build-plan.mjs:164–347`; `assemble-profile-s-candidate.mjs:137–190,314–346`. **API rejection reproduced; unused policies from code inspection.** Related: R17/N01, Tasks 0/8.

Valid independent API requests fail before building because the assembler invents a legacy profile: `{inlineFramework:false,spaghetti:true,obfuscate:false}` gets `profile='clean'`; obfuscate-only gets `profile='s'`. Both are then rejected as contradictory (**P1**). CLI parsing and direct API calls do not share equivalent normalization.

Preservation fields exist in BuildPlan, but neither the map nor batch command receives them. Eligibility's eligible/frozen lists also do not constrain transformation. Unknown options/profile values are accepted by `createBuildPlan`; booleans are coerced; `validateBuildPlan` accepts a forged fingerprint and the assembler does not call it for an injected plan (**P2 contract gaps; preservation bypass affects runtime**).

**Fix/acceptance:** normalize once at each boundary through the same strict schema, distinguishing an explicit legacy preset from absent profile input. Validate consumer/source/provider consistency and recompute identity. Feed typed preservation and eligibility decisions to both production passes. Unknown/conflicting inputs must fail before staging. Exercise every core combination through CLI, direct assembler, orchestrator and release adapter, with the same normalized plan and effective behavior.

### V3-15 — P1 — Cache identity still omits runtime inputs and effective policy

**Location:** `build-cache-engine.mjs:2177–2188,2395–2430`; `build-plan.mjs:102–126`; `build-all-standalone-plugins.mjs:1297–1344`. **Helper omissions reproduced; warm orchestration path inspected.** Related: R14/R17, Task 9.

Editing `packages/framework/src/Runtime.php` leaves `computeTreeContentHash` unchanged. Root `vendor/` is also excluded. Changing `frozenMethods` and `frozenVars` produces exactly the same BuildPlan fingerprint. The orchestrator constructs the BuildPlan after cache planning, hashes `options.buildOptions` rather than that effective plan, and reduces custom modes to `clean` for cache validation. Target/minification/provider changes need not invalidate a previously valid ZIP. Nested option encoding improved, but that does not fix omitted inputs.

**Fix/acceptance:** build the canonical plan and resolved input manifest before cache lookup. Bind all behavior-affecting preservation fields, selected source/provider/package/vendor bytes, target runtime, actual toolchain and asset policy. Compare the expected plan fingerprint with cached evidence and embedded artifact identity; bump schema and invalidate older records. Test a real warm cache with one input changed at a time, including clean vs inline-only sharing a filename. Full-plan identity must not be reduced to two profiles.

### V3-16 — P1 — PHP 7.4 acceptance remains a host-token blacklist

**Location:** `profile-s-fail-closed.mjs:472–723`; `assemble-profile-s-candidate.mjs:291–326,532–535`; `build-plan.mjs:81,175–181`. **Reproduced.** Related: R16, Task 10.

The newly added checks correctly reject non-capturing catch and typed class constants; those old repros are fixed. Nevertheless the supposed 7.4 gate accepts all four of these on host PHP 8.5.8:

```php
function ready(false $value) {}          // standalone false type: PHP 8.2
function ready($value,) {}               // trailing parameter comma: PHP 8.0
$f = strlen(...);                        // first-class callable: PHP 8.1
function ready($value = new stdClass) {} // new in initializer: PHP 8.1
```

Version provenance: [PHP 8.2 type additions](https://www.php.net/manual/en/migration82.new-features.php), [PHP 8.0 additions](https://www.php.net/manual/en/migration80.new-features.php), [PHP 8.1 additions](https://www.php.net/manual/en/migration81.new-features.php). Each snippet was tested separately.

BuildPlan accepts PHP 8.0–8.3 targets while Rector and syntax checks remain hardwired to 7.4. `WPDEV_PHP74_BIN` is optional and its version is never verified. The assembler does not reconcile the source project's minimum with the plan.

**Fix/acceptance:** enforce v2's 7.4 contract, or record an authorized expanded target contract before changing it. Validate the actual target binary/version before staging, then lint and execute on it. Treat host token scans as preflight only. Test missing/wrong-version interpreters, all four counterexamples, actual vendor files and conditional newer-runtime implementations. Do not solve this by indefinitely extending the blacklist.

### V3-17 — P1 — Final verifier and publication still report success without runtime proof

**Location:** `verify-profile-s-artifact.mjs:325–340,414–427`; `assemble-profile-s-candidate.mjs:578–603`; `prepare-artifact-phpunit-harness.mjs:227,299–310`. **Verifier reproduced; publication path inspected.** Related: R15, Task 10.

A ZIP containing only a plugin-header bootstrap with `add_action('init','missing_callback');` and **no release manifest** reports `status:'passed'`, six passes and zero failures. The hook mock ignores invalid callbacks; a missing manifest is explicitly counted as passed, and present JSON is not verified against contents in this verifier.

The assembler's manifest-parity gate is a real improvement to archive integrity, but it then only prepares the external harness and publishes. The harness explicitly returns `prepared-unexercised` and `promotionReady:false`. No execution result or passing status is required there. The standalone verifier's extraction also uses the mutable ZIP path after hashing/inspecting bytes; reuse the immutable-snapshot pattern already implemented in the harness.

**Fix/acceptance:** share final-ZIP verification with the canonical manifest reader, bind every probe to immutable ZIP bytes and the plan/target, and execute required behavior before publication. Validate callbacks when registered; exercise real WP/WooCommerce lifecycle/storage where mocks cannot prove semantics. Support clean/custom modes without demanding comment stripping. Missing/tampered manifest, invalid callback, failed/unexecuted probe and ZIP replacement must block publication and preserve the last valid output. Do not treat adding one more “prepared” status check as runtime validation.

### V3-18 — P1/P2 — Release callers diverge; `skipZip` conflicts with orchestrator artifact handling

**Location:** `packages/create-wp-project/src/release/prepare-release.js:505–558,562–579,605–711`; `build-all-standalone-plugins.mjs:1380–1404`. **Code inspection.** Related: R17/R18, Tasks 8/12.

Canonical release delegation remains restricted to named consumers and forwards neither independent flags nor configured PHP minimum/preservation/provider policy. Other plugins run a separate release path without canonical eligibility, collision, target-runtime and manifest gates (**P1 gate bypass**). Generic release removes its previous dist directory before rejecting `obfuscate + skipRector`, violating the preserve-last-good-output requirement.

The assembler honors `skipZip` by withholding publication, but the orchestrator immediately requires the expected ZIP. With no old ZIP it fails after a successful directory build; with an existing ZIP its following code reads the old archive (**P2 unsupported option/identity risk**, full stale-artifact pipeline not executed).

**Fix/acceptance:** use a common engine with generic build descriptors and separately constrained deployment registries. Forward the complete plan; remove invalid-option checks from post-write stages. Either implement directory-only results throughout orchestration/cache/evidence or reject `skipZip` before any write. Test registered/custom slugs, both old-ZIP states, invalid options with an existing good dist, and parity of all entrypoints. Existing legacy utilities must be routed or explicitly deprecated, never used as fallback after a canonical failure.

### V3-19 — P2 — Regression harness can hide warnings and cannot test capability combinations

**Location:** `tests/helpers/transformer-fixture-harness.mjs:108–156`; Task 3–6 tests. **Reproduced plus code inspection.** Related: R15/R18, Tasks 1/12.

`matched` compares only exit code and trimmed stdout; stderr is ignored. A fixture with `display_errors=0` that emits a candidate-only warning reports `matched:true`. Trimming also cannot prove byte-exact template output. The helper has no flatten/mangle option plumbing and never calls the collision/eligibility gates, so its green results do not establish production-pipeline correctness. Current Task 6 named-argument callers are transformed alongside their callee even though external runners are supported.

**Fix/acceptance:** add exact-output and normalized-diagnostic comparison modes, required baseline expectations, explicit host/target binaries, transform flags, and separate production-gate checks. Preserve intentional warning behavior rather than suppressing it. Add untransformed callers, cross-file fixtures, cross-build serialization, and structural assertions that prove requested transforms happened. Keep focused transformer tests distinct from full-assembler acceptance. The registry is synchronized now; update it and helper dependency mappings when future tests are added.

## 3. Decisions and scope that still need a written record

Do not infer owner approval from a status string in `UNRESOLVED_CHOICES`.

| Contract              | Reviewed state                                                                            | Required implementation prerequisite                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 collisions         | Code says `LOCKED_FAIL_CLOSED`; actual gate has V3-04 gap                                 | Retain v2's fail-closed interim rule; record final policy and repair existing gate before flattening release acceptance                         |
| C2 legacy flags       | Code selects legacy presets; clean still means inlining and S includes minification       | Record whether these exact legacy semantics are approved; separate legacy presets from independent clean/obfuscation requests                   |
| C3 closure boundary   | `EXPLICIT_PROVIDER_REQUIRED` is declared, but providers are still inferred and incomplete | Record which internal WPDev packages are included, required provider descriptors and unresolved-dependency policy before closure implementation |
| C4 extended spaghetti | Deferred                                                                                  | Keep inheritance/ancestor flattening deferred; it is not required to finish minimum spaghetti                                                   |
| PHP target            | v2 locks 7.4; BuildPlan now accepts through 8.3                                           | Reconcile explicitly; do not silently promise additional supported targets                                                                      |
| Preservation          | Public fields exist without consumer wiring                                               | Define typed exact identities and persisted/public contracts; no project-specific whitelist expansion as a substitute                           |

The reviewed repository does not contain a completed per-task acceptance ledger proving all v2 decisions and release gates. This is an evidence gap, not proof that no owner discussion happened elsewhere.

## 4. Ordered remediation work packages

These are proposed changes for a subsequent implementation task. Every package starts with a failing regression and ends with affected existing tests passing. Split packages into reviewable commits where indicated; do not batch the transformer, inliner, cache and deploy changes into one refactor. Use `nikic/php-parser` + `NameResolver` for semantic decisions, with token emission only where needed for exact bytes.

| Order | Work package                                                                                        | Concrete completion condition                                                                                                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | Record the contracts above; establish a task/evidence ledger                                        | Decision IDs, approved defaults, blocked prerequisites, and supported input/output forms are written down; no guessed C3 boundary                                                                |
| 1     | Repair harness comparison and option plumbing (V3-19); register the counterexamples below           | Candidate-only stderr and whitespace changes fail; external runners and each transform mode are exercised; baseline assertions are mandatory                                                     |
| 2a    | Enforce actual target runtime (V3-16)                                                               | Wrong/missing interpreter fails before writes; target lint rejects newer syntax independently of host version                                                                                    |
| 2b    | Enforce immutable final artifact and executed probes (V3-17)                                        | Manifestless ZIP/invalid callback/unexercised harness cannot publish; final evidence records plan, ZIP digest and target version                                                                 |
| 3     | Centralize plan normalization and validation (V3-14, V3-18)                                         | All eight requests normalize equivalently at every entrypoint; unknown/contradictory options fail before writes; injected plans are validated                                                    |
| 4a    | Resolve namespaces/imports/declarations project-wide (V3-01–03)                                     | All namespace mode probes execute correctly; every preserved namespace has consistent cross-file references                                                                                      |
| 4b    | Extend declaration-aware collision gate (V3-04)                                                     | Real global `Worker` plus `Acme\Worker` fails before transform/publication in flatten-only mode, with paths                                                                                      |
| 5a    | Fix compact observation and definite-assignment behavior (V3-05)                                    | Mixed, array, conditional and unset cases match values and diagnostics                                                                                                                           |
| 5b    | Solve lexical capture/receiver bindings (V3-06)                                                     | Bidirectional captures, shadowing and reassignment cases pass with stable preservation reasons                                                                                                   |
| 6a    | Resolve trait ownership/adaptations and dynamic members (V3-07)                                     | Both consumer-order permutations, aliases/precedence and case variants pass; unresolved accesses preserve the whole affected ownership set                                                       |
| 6b    | Constrain symbol-string rewriting and public persistence (V3-08–09)                                 | Ordinary literal bytes stay unchanged; real callbacks work; cross-version reads preserve non-default private state                                                                               |
| 7a    | Correct Composer model and supported bootstrap integration (V3-12)                                  | Custom/nested namespace, classmap outside `src`, original autoload order, strict bootstrap and Composer-free cold-load fixtures pass                                                             |
| 7b    | Implement provider-qualified transitive closure and exact includes (V3-10–11), after C3 is recorded | Empty/missing providers fail; unused modules absent; exact include paths and return semantics survive; source-root override selects its own runtime                                              |
| 7c    | Correct asset mapping and explicit minification policy (V3-13)                                      | Duplicate relative names coexist; pre-existing minified files survive; generated URLs/resources work in both debug modes                                                                         |
| 8     | Bind cache and artifact identities to the complete resolved plan/input manifest (V3-15)             | Warm-cache mutation tests miss for every effective capability, provider, target, preservation and asset change; old schemas rejected                                                             |
| 9     | Finish release-adapter/orchestrator convergence and directory-only behavior (V3-18)                 | Generic and registered consumers use equivalent gates; invalid options preserve old dist; `skipZip` never consumes a stale ZIP                                                                   |
| 10    | Run complete acceptance and reconcile documentation (v2 Task 12)                                    | Full standalone/registry/root-release tests and required framework PHPUnit tests pass; isolated WP/WooCommerce/target-runtime evidence exists for supported matrix and both consumer load orders |

Packages 2a/2b establish trustworthy gates early; remaining semantic repairs must not weaken those gates to make fixtures green. C4's extended structural transform remains separate and blocked on its own decision.

For package 10, record exact commands, versions, counts, failures/skips and reasons, immutable source/provider digests, normalized plans, final ZIP digests, execution evidence, and source-tree immutability. Verify no secret maps/temp files or unscoped runtime dependencies ship. Update README/help and the root/package AGENTS instructions: they still describe 72 suites, token-only analysis and unconditional obfuscation requirements that conflict with the intended independent modes.

## 5. Reproduction fixtures to add in the implementation phase

### Differential fixtures

The following PHP bodies were executed after adding `<?php `. Use the existing helper with `{case,files:{'main.php':code}}`. These are regression specifications, not committed test implementations. The `compact_unset` baseline intentionally warns; preserve its diagnostics rather than demanding no warnings.

| Case                                     | PHP body                                                                                                                                                                                                                                                                             | Baseline                            | Current transformed behavior                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | -------------------------------------------- |
| `compact_mixed`                          | `function run_it($param){$local=7;return compact('param','local');} echo json_encode(run_it(2));`                                                                                                                                                                                    | `{"param":2,"local":7}`             | Loses local, warns                           |
| `compact_array`                          | `function run_it(){$local=7;return compact(['local']);} echo json_encode(run_it());`                                                                                                                                                                                                 | `{"local":7}`                       | `[]`, warns                                  |
| `compact_unset`                          | `function run_it(){$local=7;unset($local);return compact('local');} echo json_encode(run_it());`                                                                                                                                                                                     | `[]` plus compact warning           | `{"local":null}` and different warning       |
| `closure_child_dynamic`                  | `function run_it(){$local=7;$fn=function() use($local){return get_defined_vars();};return $fn();} echo json_encode(run_it());`                                                                                                                                                       | `{"local":7}`                       | Null capture, warns                          |
| `trait_alias`                            | `trait SecretTrait{private function secret(){return 'ok';}} class Box{use SecretTrait{secret as public read;}} echo (new Box)->read();`                                                                                                                                              | `ok`                                | Fatal: aliased method absent                 |
| `private_case`                           | `class Box{private function secret(){return 'ok';}public function read(){return $this->SECRET();}}echo (new Box)->read();`                                                                                                                                                           | `ok`                                | Undefined method                             |
| `dynamic_private`                        | `class Box{private function secret(){return 'ok';}public function read(){$method='secret';return $this->$method();}}echo (new Box)->read();`                                                                                                                                         | `ok`                                | Undefined method                             |
| `private_array_data`                     | `class Box{private function secret(){return 'ok';}public function read(){return [$this,'secret'][1];}}echo (new Box)->read();`                                                                                                                                                       | `secret`                            | Mangled string                               |
| `typed_receiver_shadow`                  | `class Box{private function secret(){return 'local';}public function read(Box $other){$fn=function($other){return $other->secret();};return $fn(new Remote);}}class Remote{public function secret(){return 'remote';}}echo (new Box)->read(new Box);`                                | `remote`                            | Calls Box's private mangled method on Remote |
| `serialized_plain`                       | `class Box{private $secret='ok';}echo serialize(new Box);`                                                                                                                                                                                                                           | Original class/private-key identity | Both identities changed                      |
| `class_magic`                            | `namespace Acme;class Worker{public function read(){return __CLASS__;}}echo (new Worker)->read();`                                                                                                                                                                                   | `Acme\Worker`                       | Mangled global name                          |
| `trait_two_users`                        | `trait SecretTrait{private function secret(){return 'ok';}}class First{use SecretTrait;public function read(){return $this->secret();}}class Second{use SecretTrait;public function read($other){return $other->secret();}}echo (new First)->read().(new Second)->read(new Second);` | `okok`                              | Undefined mangled trait method               |
| `namespaced_extract_alias`               | `namespace Acme;use function extract as unpack_vars;function run_it(){unpack_vars(['local'=>7]);return $local;}echo run_it();`                                                                                                                                                       | `7`                                 | Undefined alias                              |
| `namespaced_group_use` (passing control) | `namespace A{class Worker{public function read(){return 'ok';}}}namespace B{use A\{Worker};echo (new Worker)->read();}`                                                                                                                                                              | `ok`                                | `ok`                                         |

Separate harness false-positive fixture: `ini_set('display_errors','0'); class Box{public function run(){if(__CLASS__ !== 'Box'){trigger_error('candidate-only warning',E_USER_WARNING);}echo 'ok';}} (new Box)->run();`. Both outputs are `ok`, only transformed stderr warns, yet `matched` is true.

### Transform-mode and collision fixtures

For each fixture, create a temporary source directory and use the same flags in both passes. Run `assertSymbolMapHasNoCollisions(map,{spaghetti:Boolean(flatten)})` between them; execute in a fresh PHP process afterward.

```sh
php packages/standalone-build/plan3/transformer.php --dump-map "$SOURCE" "$MAP" audit-seed --flatten=0 --mangle=1 --strip-comments=1
php packages/standalone-build/plan3/transformer.php --batch "$SOURCE" "$MAP" audit-seed main.php --flatten=0 --mangle=1 --strip-comments=1
php -d xdebug.mode=off -d display_errors=0 "$SOURCE/main.php"
```

Repeat with `(flatten,mangle)=(0,0),(0,1),(1,0),(1,1)`; set strip-comments to the mangle value. This is a four-mode transformer probe, **not** the eight-mode end-to-end closure matrix.

- `simple`: `namespace Acme;class Worker{public function read(){return 'ok';}}function run_it(){return (new Worker)->read();}echo run_it();` — only `(0,1)` fails.
- `function_only`: `namespace Acme;function run_it(){return 7;}echo run_it();` — only `(0,1)` fails.
- `frozen_cross_file`: main `namespace Client;require __DIR__.'/lib.php';echo (new \Acme\Worker)->read();`; lib `namespace Acme;class Plugin{}class Worker{public function read(){return 'ok';}}` — both flattening modes fail.
- `const_cross_file`: same main; lib `namespace Acme;const LIMIT=7;class Worker{public function read(){return LIMIT;}}` — both flattening modes fail.
- `function_external_alias`: `namespace Acme;use function strlen as length;echo length('abc');` — both flattening modes fail.
- `global_namespace_collision`: `namespace {class Worker{}}namespace Acme{class Worker{}}` — `(1,0)` fatals, although the collision gate accepts it.

### Build/helper fixtures

Use explicit temporary paths for every provider/content/output/source argument; never use active plugin folders.

1. **Empty provider:** create a provider directory with no files and `demo/demo.php` containing a plugin header requiring `wpdev, woocommerce`. Invoke `inlineWpdevClosure({stagingPlugin,consumer:'demo',contentRoot,frameworkProvider,inlineFramework:true})`. Current result: zero copied files, dependency removed.
2. **Includes:** provider `modules/demo/src/entry.php` requires `__DIR__.'/sub/class-target.php'`; provide both sibling and subdirectory targets. Current result: ambiguity error. Change the require to a missing subdirectory and provide only the sibling: current result silently loads the sibling.
3. **Assets:** two listed framework modules contain different `assets/main.js`: current flattening collision aborts. Independently, pass a directory with `demo.js` and meaningful `demo.min.js` to `minifyAssetsInTree`: current code overwrites the latter.
4. **Cache/policy:** compare `computeTreeContentHash` before/after changing only `packages/framework/src/Runtime.php`. Compare plan fingerprints before/after adding `frozenMethods:['secret'], frozenVars:['local']`. Both comparisons currently remain equal.
5. **Direct API:** call `assembleProfileSCandidate` with explicit temporary paths and either `{inlineFramework:false,spaghetti:true,obfuscate:false}` or `{inlineFramework:false,spaghetti:false,obfuscate:true}`, without a profile. Both currently reject a valid independent request before writes.
6. **Target gate:** place each V3-16 snippet in its own directory and call `validatePhpSyntaxTree` with default options on host PHP 8.5.8. All four currently pass. Non-capturing catch and typed class constants are passing negative controls: they are correctly rejected.
7. **False verifier:** create a single-root `demo` ZIP using `createCanonicalZip`, containing only `demo.php` with `<?php /** Plugin Name: Demo */ add_action('init','missing_callback');`. Call `verifyProfileSArtifact({zipPath,consumer:'demo'})`. Current result: six passes, zero failures, despite absent manifest and invalid callback.

## 6. Commands and retained review evidence

Executed from the repository root:

```sh
node --test packages/standalone-build/tests/transformer-fixture-harness.test.mjs packages/standalone-build/tests/task3-private-members-and-constants.test.mjs packages/standalone-build/tests/task4-scope-capture-and-template.test.mjs packages/standalone-build/tests/task5-protect-literals-and-comments.test.mjs packages/standalone-build/tests/task6-namespaces-and-public-boundaries.test.mjs packages/standalone-build/tests/profile-s-fail-closed.test.mjs

node --test packages/standalone-build/tests/plan3-transformer.test.mjs packages/standalone-build/tests/transformer-engine.test.mjs packages/standalone-build/tests/transformer-correctness-matrix.test.mjs packages/standalone-build/tests/f09-f10-f11-transformer-semantics.test.mjs packages/standalone-build/tests/inliner-collision-and-manifest.test.mjs packages/standalone-build/tests/framework-closure-inventory.test.mjs packages/standalone-build/tests/f07-php74-target-syntax-gate.test.mjs packages/standalone-build/tests/f12-consumer-release-alignment.test.mjs

node --input-type=module -e "import {validateCanonicalTestRegistry} from './packages/standalone-build/test-dependency-registry.mjs'; console.log(validateCanonicalTestRegistry());"
```

Local temporary evidence retained for this review session:

- `/tmp/protection-review-focused.tap` — 61-test run.
- `/tmp/protection-review-existing.tap` — 35-test run.
- `/tmp/protection-review-probes.mjs` and `.json` — 14 differential fixtures, outputs and transformed code.
- `/tmp/protection-review-modes.mjs` and `.json` — 24 mode/gate results and transformed paths.
- `/tmp/protection-review-systems.mjs` and `.json` — provider, bootstrap, cache, plan, minifier and verifier probes. Its original catch/typed-constant probes correctly failed; their stderr was separately inspected to confirm the rejection reasons.
- `/tmp/protection-review-inliner.mjs` and `.json` — exact/missing include, asset collision, unused-module probes.

Temporary evidence may be cleaned by the OS; the fixture specifications above are the durable reproduction contract. The four additional accepted PHP syntax snippets, diagnostic-comparison and direct-API probes were executed as inline Node scripts and are specified above. None of these temporary probes were added to the repository test suite.

**Completion condition for the subsequent implementation:** every P1 above has a regression and a verified resolution; supported capability/entrypoint combinations pass isolated target-runtime acceptance; release evidence is bound to the exact final archive; remaining P2/C4 items are explicitly resolved or recorded as deferred with scope and reason. A green focused suite alone is not completion.

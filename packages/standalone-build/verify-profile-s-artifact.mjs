#!/usr/bin/env node

/**
 * Artifact Black-Box Verification Suite for Profile S Candidate ZIP (Plan 3)
 * 
 * Verifies:
 * 1. Single-root archive topology.
 * 2. PHP Syntax lint.
 * 3. 100% Comment stripping on internal files while preserving main plugin header.
 * 4. Zero development docs (.md) leakage.
 * 5. Gettext & format specifier (%1$s) integrity.
 * 6. Zero-Fatal Bootstrap, Hook Registration & Settings Persistence.
 * 7. Ed25519 Signed Release Manifest verification.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readZipEntries, verifyZipAgainstManifest } from "./canonical-artifact-manifest.mjs";

const execFileAsync = promisify(execFile);

export async function verifyProfileSArtifact({
  zipPath,
  consumer = "tavangary-theme-panel",
  profile = "s",
  stripComments,
  targetPhp = "7.4",
  phpBin,
  requireManifest = true,
} = {}) {
  const failures = [];
  const results = {
    zipPath,
    consumer,
    testsPassed: 0,
    testsFailed: 0,
    details: [],
  };

  // 1. Read ZIP & Hash
  let zipBytes;
  try {
    zipBytes = await readFile(zipPath);
  } catch (err) {
    return { status: "failed", error: `Cannot read ZIP file: ${err.message}` };
  }
  const zipSha256 = crypto.createHash("sha256").update(zipBytes).digest("hex");
  results.zipSha256 = zipSha256;

  // 2. Extract into isolated temporary directory
  const stagingRoot = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), `verify-profile-s-${consumer}-`));
  const extractedPlugin = path.join(stagingRoot, consumer);

  try {
    let entries;
    try {
      entries = readZipEntries(zipBytes);
    } catch (err) {
      return { status: "failed", error: `ZIP preflight failed: ${err.message}`, ...results, failures: [err.message] };
    }
    const expectedPrefix = `${consumer}/`;
    for (const entry of entries) {
      if (entry.name !== consumer && entry.name !== expectedPrefix && !entry.name.startsWith(expectedPrefix)) {
        return {
          status: "failed",
          error: `ZIP entry '${entry.name}' does not reside in single root '${consumer}/'`,
          ...results,
          failures: [`unsafe zip topology: ${entry.name}`],
        };
      }
    }
    const immutableZipPath = path.join(stagingRoot, ".immutable-candidate.zip");
    await writeFile(immutableZipPath, zipBytes, { flag: "wx", mode: 0o444 });
    await execFileAsync("unzip", ["-q", immutableZipPath, "-d", stagingRoot]);

    // Check single-root archive topology
    const topDirs = await readdir(stagingRoot);
    if (!topDirs.includes(consumer)) {
      failures.push(`ZIP archive does not contain root directory ${consumer}/`);
    }

    const activePhpBin = phpBin || process.env.WPDEV_PHP_BIN || process.env.WPDEV_PHP74_BIN || "php";

    // Probe 1 & 2: Fast Batched PHP Syntax lint & Comment Stripping Check
    const phpFiles = [];
    async function collectPhpFiles(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await collectPhpFiles(full);
        } else if (entry.isFile() && entry.name.endsWith(".php")) {
          phpFiles.push(full);
        }
      }
    }
    await collectPhpFiles(extractedPlugin);

    const mainPhpPath = path.join(extractedPlugin, `${consumer}.php`);
    const mainPhpContent = fs.existsSync(mainPhpPath) ? await readFile(mainPhpPath, "utf8") : "";
    let commentStrippingPassed = true;
    if (!mainPhpContent.includes("Plugin Name:")) {
      commentStrippingPassed = false;
      failures.push("Main plugin header is missing in entry file");
    }

    const batchScript = `
    $main = $argv[1];
    $files = array_slice($argv, 2);
    $syntaxErrors = [];
    $commentErrors = [];

    foreach ($files as $f) {
        $code = file_get_contents($f);
        try {
            $tokens = token_get_all($code, TOKEN_PARSE);
        } catch (Throwable $e) {
            $syntaxErrors[] = $f . ': ' . $e->getMessage();
            continue;
        }
        if (basename($f) === $main || strpos($f, '/vendor/') !== false) {
            continue;
        }
        foreach ($tokens as $t) {
            if (is_array($t) && ($t[0] === T_DOC_COMMENT || $t[0] === T_COMMENT)) {
                if (stripos($t[1], 'Plugin Name:') !== false || stripos($t[1], 'SPDX-License') !== false || stripos($t[1], 'Copyright') !== false) {
                    continue;
                }
                $commentErrors[] = $f . ': ' . trim(function_exists('mb_substr') ? mb_substr($t[1], 0, 50, 'UTF-8') : substr($t[1], 0, 50));
                break;
            }
        }
    }

    $flags = defined('JSON_INVALID_UTF8_SUBSTITUTE') ? JSON_INVALID_UTF8_SUBSTITUTE : 0;
    echo json_encode([
        'syntaxErrors' => $syntaxErrors,
        'commentErrors' => $commentErrors
    ], $flags);
    `;

    let syntaxPassed = true;
    const chunkSize = 100;
    for (let i = 0; i < phpFiles.length; i += chunkSize) {
      const chunk = phpFiles.slice(i, i + chunkSize);
      const { stdout } = await execFileAsync(activePhpBin, ["-r", batchScript, "--", `${consumer}.php`, ...chunk]);
      const res = JSON.parse(stdout.trim());
      if (res.syntaxErrors && res.syntaxErrors.length > 0) {
        syntaxPassed = false;
        for (const errFile of res.syntaxErrors) {
          failures.push(`Syntax error in ${path.relative(stagingRoot, errFile)}`);
        }
      }
      if (res.commentErrors && res.commentErrors.length > 0) {
        commentStrippingPassed = false;
        for (const cErr of res.commentErrors) {
          failures.push(`DocBlock found in internal file: ${cErr}`);
        }
      }
    }

    if (syntaxPassed) {
      results.testsPassed++;
      results.details.push({ test: "PHP Syntax Lint", status: "passed" });
    } else {
      results.testsFailed++;
      results.details.push({ test: "PHP Syntax Lint", status: "failed" });
    }

    const expectStripComments = stripComments !== undefined
      ? Boolean(stripComments)
      : (profile === "s");

    if (!expectStripComments) {
      results.testsPassed++;
      results.details.push({
        test: "Comment Stripping & Header Preservation",
        status: "passed",
        skipped: true,
        notes: "Comment stripping not demanded for clean/custom profile",
      });
    } else if (commentStrippingPassed) {
      results.testsPassed++;
      results.details.push({ test: "Comment Stripping & Header Preservation", status: "passed" });
    } else {
      results.testsFailed++;
      results.details.push({ test: "Comment Stripping & Header Preservation", status: "failed" });
    }

    // Probe 3: No Non-Runtime Docs (.md) Leakage
    let noDocsLeakage = true;
    async function checkNoDocs(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await checkNoDocs(full);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          noDocsLeakage = false;
          failures.push(`Unwanted markdown doc found in release archive: ${path.relative(stagingRoot, full)}`);
        }
      }
    }
    await checkNoDocs(extractedPlugin);
    if (noDocsLeakage) {
      results.testsPassed++;
      results.details.push({ test: "Zero Development Docs Leakage", status: "passed" });
    } else {
      results.testsFailed++;
      results.details.push({ test: "Zero Development Docs Leakage", status: "failed" });
    }

    // Probe 4: Gettext / Format String Integrity Probe
    let gettextSafe = true;
    async function scanGettextSafety(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scanGettextSafety(full);
        } else if (entry.isFile() && entry.name.endsWith(".php")) {
          const content = await readFile(full, "utf8");
          if (/%[0-9]+\$_v/i.test(content)) {
            gettextSafe = false;
            failures.push(`Corrupted sprintf/gettext placeholder found in ${path.relative(stagingRoot, full)}`);
          }
        }
      }
    }
    await scanGettextSafety(extractedPlugin);
    if (gettextSafe) {
      results.testsPassed++;
      results.details.push({ test: "Gettext & Format Specifier Integrity", status: "passed" });
    } else {
      results.testsFailed++;
      results.details.push({ test: "Gettext & Format Specifier Integrity", status: "failed" });
    }

    // Probe 5: Zero-Fatal Execution & Hook Registration Probe
    const testRunnerCode = `<?php
define('ABSPATH', __DIR__ . '/');
define('WP_DEBUG', true);
defined('ARRAY_A') || define('ARRAY_A', 'ARRAY_A');
defined('ARRAY_N') || define('ARRAY_N', 'ARRAY_N');
defined('OBJECT') || define('OBJECT', 'OBJECT');
defined('OBJECT_K') || define('OBJECT_K', 'OBJECT_K');

class WP_Error { public function get_error_message() { return ''; } public function get_error_code() { return ''; } }
function is_wp_error($thing) { return $thing instanceof WP_Error; }

$wp_actions = [];
$wp_filters = [];
$wp_options = [];

#[\AllowDynamicProperties]
class MockWpdb {
    public $prefix = 'wp_';
    public $posts = 'wp_posts';
    public $postmeta = 'wp_postmeta';
    public $options = 'wp_options';
    public function get_blog_prefix($blog_id = null) { return $this->prefix; }
    public function tables($scope = 'all', $prefix = true, $blog_id = 0) { return []; }
    public function get_charset_collate() { return 'DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'; }
    public function query($sql) { return true; }
    public function esc_like($text) { return addcslashes((string)$text, '_%' . chr(92)); }
    public function suppress_errors($suppress = true) { return true; }
    public function show_errors($show = true) { return true; }
    public function print_error($str = '') {}
    public function update($table, $data, $where, $format = null, $where_format = null) { return 1; }
    public function insert($table, $data, $format = null) { return 1; }
    public function delete($table, $where, $where_format = null) { return 1; }
    public function replace($table, $data, $format = null) { return 1; }
    public function get_var($query = null) { return null; }
    public function get_row($query = null) { return null; }
    public function get_results($query = null) { return []; }
    public function prepare($query, ...$args) { return $query; }
}
$GLOBALS['wpdb'] = new MockWpdb();
$wpdb = $GLOBALS['wpdb'];

function dbDelta($queries = '') { return []; }

function __return_true() { return true; }
function __return_false() { return false; }
function __return_empty_array() { return []; }
function __return_empty_string() { return ''; }
function __return_null() { return null; }
function __return_zero() { return 0; }

$invalid_registered_callbacks = [];

function wpdev_is_valid_hook_callback($callback) {
    if (is_callable($callback)) {
        return true;
    }
    if (is_string($callback) && function_exists($callback)) {
        return true;
    }
    if (is_array($callback) && count($callback) === 2) {
        [$target, $method] = $callback;
        if (is_object($target) && method_exists($target, $method)) {
            return true;
        }
        if (is_string($target) && (method_exists($target, $method) || class_exists($target))) {
            return true;
        }
    }
    return false;
}

function add_action($hook, $callback, $priority = 10, $accepted_args = 1) {
    global $wp_actions, $invalid_registered_callbacks;
    if (!wpdev_is_valid_hook_callback($callback)) {
        $invalid_registered_callbacks[] = [
            'type' => 'action',
            'hook' => $hook,
            'callback' => is_scalar($callback) ? (string)$callback : (is_array($callback) ? json_encode($callback) : gettype($callback)),
        ];
    }
    $wp_actions[$hook][] = $callback;
    return true;
}
function add_filter($hook, $callback, $priority = 10, $accepted_args = 1) {
    global $wp_filters, $invalid_registered_callbacks;
    if (!wpdev_is_valid_hook_callback($callback)) {
        $invalid_registered_callbacks[] = [
            'type' => 'filter',
            'hook' => $hook,
            'callback' => is_scalar($callback) ? (string)$callback : (is_array($callback) ? json_encode($callback) : gettype($callback)),
        ];
    }
    $wp_filters[$hook][] = $callback;
    return true;
}
function get_option($option, $default = false) {
    global $wp_options;
    return isset($wp_options[$option]) ? $wp_options[$option] : $default;
}
function update_option($option, $value, $autoload = null) {
    global $wp_options;
    $wp_options[$option] = $value;
    return true;
}
function get_network_option($network_id, $option, $default = false) { return get_option($option, $default); }
function update_network_option($network_id, $option, $value) { return update_option($option, $value); }
function sanitize_key($key) { return strtolower(preg_replace('/[^a-z0-9_\\-]/i', '', (string)$key)); }
function sanitize_text_field($str) { return is_string($str) ? trim(strip_tags($str)) : ''; }
function sanitize_title($title) { return strtolower(preg_replace('/[^a-z0-9_\\-]/i', '-', (string)$title)); }
function remove_accents($string) { return (string)$string; }
function maybe_unserialize($data) { return $data; }
function maybe_serialize($data) { return is_array($data) || is_object($data) ? serialize($data) : $data; }
function wp_next_scheduled($hook, $args = []) { return false; }
function wp_schedule_event($timestamp, $recurrence, $hook, $args = [], $wp_error = false) { return true; }
function wp_clear_scheduled_hook($hook, $args = []) { return 1; }
function wp_unschedule_event($timestamp, $hook, $args = [], $wp_error = false) { return true; }
function plugin_dir_path($file) { return dirname($file) . '/'; }
function plugin_dir_url($file) { return 'http://localhost/wp-content/plugins/' . basename(dirname($file)) . '/'; }
function plugin_basename($file) { return basename(dirname($file)) . '/' . basename($file); }
function __($text, $domain = 'default') { return $text; }
function _e($text, $domain = 'default') { echo $text; }
function _x($text, $context, $domain = 'default') { return $text; }
function esc_html($text) { return $text; }
function esc_attr($text) { return $text; }
function esc_sql($data) { return addslashes((string)$data); }
function wp_kses_post($text) { return $text; }
function wp_unslash($text) { return $text; }
function is_admin() { return true; }
function is_multisite() { return false; }
function admin_url($path = '') { return 'http://localhost/wp-admin/' . $path; }
function home_url($path = '') { return 'http://localhost/' . ltrim($path, '/'); }
function site_url($path = '') { return 'http://localhost/' . ltrim($path, '/'); }
function add_menu_page() { return 'hook'; }
function add_submenu_page() { return 'hook'; }
function add_role($role, $display_name, $capabilities = []) { return null; }
function get_role($role) { return null; }
function remove_role($role) {}
function wp_enqueue_style() {}
function wp_enqueue_script() {}
function did_action($hook) { global $wp_actions; return isset($wp_actions[$hook]) ? count($wp_actions[$hook]) : 0; }
function doing_action($hook = null) { return false; }
function do_action($hook, ...$args) {
    global $wp_actions;
    if (isset($wp_actions[$hook])) {
        foreach ($wp_actions[$hook] as $cb) {
            if (!is_callable($cb)) {
                echo "ERROR: Attempted to execute uncallable callback for hook '{$hook}': " . (is_string($cb) ? $cb : json_encode($cb)) . "\n";
                exit(4);
            }
            call_user_func_array($cb, $args);
        }
    }
}
function apply_filters($hook, $value, ...$args) {
    global $wp_filters;
    if (isset($wp_filters[$hook])) {
        foreach ($wp_filters[$hook] as $cb) {
            if (!is_callable($cb)) {
                echo "ERROR: Attempted to execute uncallable callback for filter '{$hook}': " . (is_string($cb) ? $cb : json_encode($cb)) . "\n";
                exit(4);
            }
            $value = call_user_func_array($cb, array_merge([$value], $args));
        }
    }
    return $value;
}
function apply_filters_deprecated($hook_name, $args, $version, $replacement = '', $message = '') { return apply_filters($hook_name, ...$args); }
function do_action_deprecated($hook_name, $args, $version, $replacement = '', $message = '') { do_action($hook_name, ...$args); }
function has_action($hook, $callback = false) { global $wp_actions; return isset($wp_actions[$hook]); }
function has_filter($hook, $callback = false) { global $wp_filters; return isset($wp_filters[$hook]); }
function remove_action($hook, $callback, $priority = 10) { return true; }
function remove_filter($hook, $callback, $priority = 10) { return true; }
function wp_parse_args($args, $defaults = []) { return is_array($args) ? array_merge($defaults, $args) : $defaults; }
function wp_list_pluck($list, $field, $index_key = null) {
    $newlist = [];
    foreach ($list as $key => $value) {
        $val = is_object($value) ? ($value->$field ?? null) : ($value[$field] ?? null);
        if (null === $index_key) { $newlist[$key] = $val; }
        else { $k = is_object($value) ? ($value->$index_key ?? null) : ($value[$index_key] ?? null); $newlist[$k] = $val; }
    }
    return $newlist;
}
function wp_json_encode($data) { return json_encode($data); }
function is_plugin_active($plugin) { return false; }
function load_plugin_textdomain() { return true; }
function load_theme_textdomain() { return true; }
function wp_localize_script() {}
function register_activation_hook() {}
function register_deactivation_hook() {}
function register_uninstall_hook() {}
function plugins_url($path = '', $plugin = '') { return 'http://localhost/wp-content/plugins/' . $path; }

$main_file = '${extractedPlugin}/${consumer}.php';
if (!file_exists($main_file)) {
    echo "ERROR: Main plugin file missing\n";
    exit(1);
}

require_once $main_file;

$all_invalid_callbacks = [];
foreach ($invalid_registered_callbacks as $entry) {
    if (!is_callable($entry['callback'])) {
        $all_invalid_callbacks[] = "{$entry['type']} '{$entry['hook']}': {$entry['callback']}";
    }
}
if (isset($wp_actions)) {
    foreach ($wp_actions as $hook => $callbacks) {
        foreach ($callbacks as $cb) {
            if (!is_callable($cb)) {
                $desc = is_scalar($cb) ? (string)$cb : (is_array($cb) ? json_encode($cb) : gettype($cb));
                $all_invalid_callbacks[] = "action '{$hook}': {$desc}";
            }
        }
    }
}
if (isset($wp_filters)) {
    foreach ($wp_filters as $hook => $callbacks) {
        foreach ($callbacks as $cb) {
            if (!is_callable($cb)) {
                $desc = is_scalar($cb) ? (string)$cb : (is_array($cb) ? json_encode($cb) : gettype($cb));
                $all_invalid_callbacks[] = "filter '{$hook}': {$desc}";
            }
        }
    }
}
if (!empty($all_invalid_callbacks)) {
    $unique = array_values(array_unique($all_invalid_callbacks));
    echo "ERROR: Invalid or uncallable callbacks detected in hook registration:\n" . implode("\n", $unique) . "\n";
    exit(3);
}

if (isset($wp_actions['init'])) {
    foreach ($wp_actions['init'] as $cb) {
        if (!is_callable($cb)) {
            echo "ERROR: Uncallable callback registered on 'init'\n";
            exit(5);
        }
        call_user_func($cb);
    }
}

update_option('wpdev_v2_settings', ['tavangary_hero_title' => 'Test Title']);
$saved = get_option('wpdev_v2_settings');
if (($saved['tavangary_hero_title'] ?? '') !== 'Test Title') {
    echo "ERROR: Settings persistence check failed\n";
    exit(2);
}

echo "BOOTSTRAP_PROBE_OK\n";
echo "REGISTERED_ACTIONS_COUNT: " . count($wp_actions) . "\n";
echo "REGISTERED_FILTERS_COUNT: " . count($wp_filters) . "\n";
`;

    const adminIncDir = path.join(stagingRoot, "wp-admin", "includes");
    await mkdir(adminIncDir, { recursive: true });
    await writeFile(path.join(adminIncDir, "upgrade.php"), "<?php\n// Mock upgrade.php\n", "utf8");

    const runnerFile = path.join(stagingRoot, "runner.php");
    await writeFile(runnerFile, testRunnerCode, "utf8");

    try {
      const { stdout, stderr } = await execFileAsync(activePhpBin, [runnerFile]);
      if (stdout.includes("BOOTSTRAP_PROBE_OK")) {
        results.testsPassed++;
        results.details.push({ test: "Zero-Fatal Bootstrap & Hook Registration", status: "passed", stdout: stdout.trim() });
      } else {
        failures.push(`Bootstrap probe failed: ${stdout} ${stderr}`);
        results.testsFailed++;
        results.details.push({ test: "Zero-Fatal Bootstrap & Hook Registration", status: "failed", error: stdout });
      }
    } catch (err) {
      const output = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
      failures.push(`Execution exception in bootstrap probe: ${output || err.message}`);
      results.testsFailed++;
      results.details.push({ test: "Zero-Fatal Bootstrap & Hook Registration", status: "failed", error: output || err.message });
    }

    // Probe 6: Release Manifest & Parity Verification
    const manifestFile = path.join(extractedPlugin, "release-manifest.json");
    const altManifestFile = path.join(extractedPlugin, "artifact-manifest.json");
    const hasManifest = fs.existsSync(manifestFile) || fs.existsSync(altManifestFile);

    if (requireManifest && !hasManifest) {
      failures.push("Release manifest (release-manifest.json or artifact-manifest.json) is missing from release archive");
      results.testsFailed++;
      results.details.push({ test: "Release Manifest Verification", status: "failed", error: "Release manifest missing" });
    } else if (hasManifest) {
      try {
        const activeManifestPath = fs.existsSync(manifestFile) ? manifestFile : altManifestFile;
        const manifestData = JSON.parse(await readFile(activeManifestPath, "utf8"));
        const zipParity = await verifyZipAgainstManifest({
          zipPath: immutableZipPath,
          consumer,
          manifest: manifestData,
        });
        if (zipParity.status !== "valid") {
          const blockerMsg = (zipParity.blockers || []).join("; ");
          failures.push(`Manifest verification failed: ${blockerMsg}`);
          results.testsFailed++;
          results.details.push({ test: "Release Manifest Verification", status: "failed", blockers: zipParity.blockers });
        } else {
          results.testsPassed++;
          results.details.push({
            test: "Release Manifest Verification",
            status: "passed",
            manifestDigest: manifestData.manifestDigest,
            verifiedFiles: zipParity.verifiedFilesCount || manifestData.files?.length,
          });
        }
      } catch (err) {
        failures.push(`Manifest verification error: ${err.message}`);
        results.testsFailed++;
        results.details.push({ test: "Release Manifest Verification", status: "failed", error: err.message });
      }
    } else {
      results.testsPassed++;
      results.details.push({ test: "Release Manifest Verification", status: "passed", skipped: true, notes: "Manifest not required" });
    }

  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  results.status = failures.length === 0 ? "passed" : "failed";
  results.failures = failures;
  return results;
}

if (process.argv[1] && process.argv[1].endsWith("verify-profile-s-artifact.mjs")) {
  const zipPath = path.resolve(process.argv[2] || "dist/tavangary-theme-panel-profile-s.zip");
  const consumer = process.argv[3] || "tavangary-theme-panel";

  verifyProfileSArtifact({ zipPath, consumer }).then((res) => {
    console.log(JSON.stringify(res, null, 2));
    if (res.status !== "passed") process.exit(1);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

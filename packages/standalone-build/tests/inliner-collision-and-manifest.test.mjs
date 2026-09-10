import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertFrameworkClosureMinifiedAssets,
  inlineWpdevClosure,
  minifyAssetsInTree,
} from "../inline-wpdev-closure.mjs";

test("Inliner: preloads Settings_Admin_Page so host SettingsPage class files can declare", async () => {
  const inlinerSrc = await readFile(
    fileURLToPath(new URL("../inline-wpdev-closure.mjs", import.meta.url)),
    "utf8",
  );
  assert.ok(
    inlinerSrc.includes("Settings_Admin_Page"),
    "functions-closure must eager-load Settings_Admin_Page before autoloading host SettingsPage.php",
  );
  assert.ok(
    inlinerSrc.includes("Wizard_Admin_Page"),
    "Settings_Admin_Page extends Wizard_Admin_Page; both must be preloaded",
  );
});

test("Inliner: copies multi-module files without basename collision or silent overwrite", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "inliner-collision-test-"));
  const stagingPlugin = path.join(tmpDir, "my-plugin");
  const wpdevPluginDir = path.join(tmpDir, "plugins/wpdev");

  // Create two distinct module files with identical basename 'class-component-registry.php'
  await mkdir(path.join(wpdevPluginDir, "modules/admin-page-builder/src"), { recursive: true });
  const adminRegistryContent = "<?php namespace WPDevFramework\\Modules\\AdminPageBuilder; class Component_Registry { public static function type() { return 'admin'; } }";
  await writeFile(path.join(wpdevPluginDir, "modules/admin-page-builder/src/class-component-registry.php"), adminRegistryContent);

  await mkdir(path.join(wpdevPluginDir, "modules/field-builder/src"), { recursive: true });
  const fieldRegistryContent = "<?php namespace WPDevFramework\\Modules\\FieldBuilder; class Component_Registry { public static function type() { return 'field'; } }";
  await writeFile(path.join(wpdevPluginDir, "modules/field-builder/src/class-component-registry.php"), fieldRegistryContent);

  // Create staging plugin
  await mkdir(stagingPlugin, { recursive: true });
  await writeFile(path.join(stagingPlugin, "my-plugin.php"), "<?php // Plugin Name: My Plugin");

  try {
    const result = await inlineWpdevClosure({
      stagingPlugin,
      consumer: "my-plugin",
      contentRoot: tmpDir,
      wpdevPluginDirOverride: wpdevPluginDir
    });

    // Both files must exist in their scoped directories
    const adminDest = path.join(stagingPlugin, "src/FrameworkClosure/modules/admin-page-builder/src/class-component-registry.php");
    const fieldDest = path.join(stagingPlugin, "src/FrameworkClosure/modules/field-builder/src/class-component-registry.php");

    assert.equal(fs.existsSync(adminDest), true, "Admin component registry must exist at scoped path");
    assert.equal(fs.existsSync(fieldDest), true, "Field component registry must exist at scoped path");

    const readAdmin = await readFile(adminDest, "utf8");
    const readField = await readFile(fieldDest, "utf8");

    assert.ok(readAdmin.includes("AdminPageBuilder"), "Admin registry must contain AdminPageBuilder namespace");
    assert.ok(readField.includes("FieldBuilder"), "Field registry must contain FieldBuilder namespace");
    assert.notEqual(readAdmin, readField, "Admin and field registries must NOT be identical/overwritten");

    // Manifest must exist and record SHA-256 for all inlined files
    const manifestPath = path.join(stagingPlugin, "src/FrameworkClosure/inlined-files-manifest.json");
    assert.equal(fs.existsSync(manifestPath), true, "Inlined files manifest must be generated");

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.ok(Array.isArray(manifest.files), "Manifest must contain files array");
    assert.ok(manifest.files.length >= 2, "Manifest must record inlined files");

    const adminEntry = manifest.files.find(f => f.destination.includes("admin-page-builder/src/class-component-registry.php"));
    assert.ok(adminEntry, "Manifest must contain admin-page-builder entry");
    assert.equal(adminEntry.sha256, crypto.createHash("sha256").update(adminRegistryContent).digest("hex"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Minifier: writes SCRIPT_DEBUG=.min siblings next to unminified FrameworkClosure assets", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "minifier-min-sibling-"));
  const assetsDir = path.join(tmpDir, "src/FrameworkClosure/assets/js/functions");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(path.join(assetsDir, "functions-core.js"), "function wpdev_on_load(){return true;}");
  await writeFile(path.join(assetsDir, "functions-utils.js"), "function wpdev_noop(){return 1;}");

  const contentRoot = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
  try {
    const result = await minifyAssetsInTree(tmpDir, contentRoot);
    assert.ok(result.minSiblingsWritten >= 2, "Must emit .min.js siblings for unminified JS");
    assert.equal(
      fs.existsSync(path.join(assetsDir, "functions-core.min.js")),
      true,
      "functions-core.min.js must exist for production SCRIPT_DEBUG=false",
    );
    assert.equal(
      fs.existsSync(path.join(assetsDir, "functions-core.js")),
      true,
      "Unminified functions-core.js must be kept",
    );
    const minSrc = await readFile(path.join(assetsDir, "functions-core.min.js"), "utf8");
    assert.ok(minSrc.includes("wpdev_on_load"), "Minified sibling must still define wpdev_on_load");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("assertFrameworkClosureMinifiedAssets fails closed when production .min files are missing", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "min-asset-gate-"));
  const assetsDir = path.join(tmpDir, "src/FrameworkClosure/assets/js/functions");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(path.join(assetsDir, "functions-core.js"), "function wpdev_on_load(){}");
  try {
    assert.throws(
      () => assertFrameworkClosureMinifiedAssets(tmpDir),
      /functions-core\.min\.js/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Minifier: fails closed and reports errors when JS/CSS has invalid syntax", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "minifier-syntax-test-"));
  const badJsPath = path.join(tmpDir, "broken-syntax.js");
  await writeFile(badJsPath, "const x = ; // syntax error");

  try {
    let errorCaught = false;
    try {
      await minifyAssetsInTree(tmpDir, path.resolve("."));
    } catch (err) {
      errorCaught = true;
    }
    assert.equal(errorCaught, true, "Minifier MUST throw or fail closed on syntax errors");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

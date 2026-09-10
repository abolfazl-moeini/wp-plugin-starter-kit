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

test("V3-13: minifyAssetsInTree preserves pre-existing minified assets unless overwrite is selected", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "minifier-preserve-existing-"));
  const jsDir = path.join(tmpDir, "assets/js");
  await mkdir(jsDir, { recursive: true });

  const customMinContent = "/* custom handcrafted minified asset */ var x=42;";
  await writeFile(path.join(jsDir, "demo.js"), "const demo = 100 + 200; console.log(demo);");
  await writeFile(path.join(jsDir, "demo.min.js"), customMinContent);

  const contentRoot = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
  try {
    // 1. By default, existing .min.js must be preserved
    await minifyAssetsInTree(tmpDir, contentRoot, { overwriteExistingMin: false });
    const preservedContent = await readFile(path.join(jsDir, "demo.min.js"), "utf8");
    assert.equal(preservedContent, customMinContent, "Pre-existing .min.js must not be overwritten by default");

    // 2. With overwriteExistingMin: true, the file should be updated
    await minifyAssetsInTree(tmpDir, contentRoot, { overwriteExistingMin: true });
    const overwrittenContent = await readFile(path.join(jsDir, "demo.min.js"), "utf8");
    assert.notEqual(overwrittenContent, customMinContent, "Existing .min.js should be updated when overwrite is requested");
    assert.ok(overwrittenContent.includes("console.log"), "Should contain minified version of demo.js");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("V3-13: Module assets with identical relative paths do not collide during inlining", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "asset-collision-test-"));
  try {
    const fakeFramework = path.join(tmpDir, "fake-wpdev");
    await mkdir(path.join(fakeFramework, "modules/admin-page-builder/assets/js"), { recursive: true });
    await mkdir(path.join(fakeFramework, "modules/wizard/assets/js"), { recursive: true });
    await mkdir(path.join(fakeFramework, "modules/core/src"), { recursive: true });

    // Dummy core file so framework is valid
    await writeFile(
      path.join(fakeFramework, "modules/core/src/class-plugin.php"),
      `<?php namespace WPDevFramework\\Core; class Plugin {}\n`
    );

    // Two distinct modules with different contents at the SAME relative asset path: js/main.js
    const adminContent = "/* admin */ console.log('admin_builder');";
    const wizardContent = "/* wizard */ console.log('wizard_builder');";
    await writeFile(path.join(fakeFramework, "modules/admin-page-builder/assets/js/main.js"), adminContent);
    await writeFile(path.join(fakeFramework, "modules/wizard/assets/js/main.js"), wizardContent);

    const stagingPlugin = path.join(tmpDir, "test-consumer");
    await mkdir(stagingPlugin, { recursive: true });
    await writeFile(
      path.join(stagingPlugin, "test-consumer.php"),
      `<?php\n/**\n * Plugin Name: Test Consumer\n * Requires Plugins: wpdev\n */\n`
    );

    // Inlining must succeed without throwing CRITICAL STRUCTURAL COLLISION
    const result = await inlineWpdevClosure({
      stagingPlugin,
      consumer: "test-consumer",
      contentRoot: tmpDir,
      wpdevPluginDirOverride: fakeFramework,
    });
    assert.ok(result.inlinedFiles > 0);

    // Both files must exist preserved in their respective module-local asset directories
    const adminCopied = await readFile(
      path.join(stagingPlugin, "src/FrameworkClosure/modules/admin-page-builder/assets/js/main.js"),
      "utf8"
    );
    const wizardCopied = await readFile(
      path.join(stagingPlugin, "src/FrameworkClosure/modules/wizard/assets/js/main.js"),
      "utf8"
    );
    assert.equal(adminCopied, adminContent);
    assert.equal(wizardCopied, wizardContent);

    // The shared root assets/js/main.js should NOT have been created by flattening
    assert.equal(
      fs.existsSync(path.join(stagingPlugin, "src/FrameworkClosure/assets/js/main.js")),
      false,
      "Root assets/js/main.js must not be created from module-specific assets"
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});


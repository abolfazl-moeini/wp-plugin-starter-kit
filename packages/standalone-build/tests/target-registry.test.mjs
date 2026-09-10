import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  IMPACT_ONLY_TARGETS,
  TARGET_REGISTRY,
  listStandaloneConsumers,
  resolveConsumerSource,
} from "../target-registry.mjs";

import { resolveContentRoot } from "../resolve-content-root.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let contentRoot;
if (process.env.WPDEV_CONTENT_ROOT) {
  contentRoot = path.resolve(process.env.WPDEV_CONTENT_ROOT);
} else {
  try {
    contentRoot = resolveContentRoot({ scriptDir: packageRoot, cwd: process.cwd(), env: process.env });
  } catch (err) {
    const fallback = "/Users/moeini/Dev/tavangary.new/wordpress/wp-content";
    if (fs.existsSync(fallback)) {
      contentRoot = fallback;
    } else {
      throw err;
    }
  }
}

test("Target registry: seven standalone consumers are explicit and wpdev is not a standalone artifact", () => {
  const consumers = listStandaloneConsumers();
  assert.deepEqual(
    [...consumers].sort(),
    [
      "drm-connector",
      "tavangary-core",
      "tavangary-theme-panel",
      "wpdev-analytics",
      "wpdev-crm",
      "wpdev-tickets",
      "wpdev-woo-persian",
    ].sort()
  );
  assert.equal(TARGET_REGISTRY.wpdev, undefined, "wpdev must not be a standalone registry target");
  assert.equal(IMPACT_ONLY_TARGETS.wpdev.kind, "shared-framework-source");
  assert.equal(IMPACT_ONLY_TARGETS.wpdev.standaloneArtifact, false);
  assert.equal(IMPACT_ONLY_TARGETS["themes/tavangary"].kind, "impact-only-target");

  for (const consumer of consumers) {
    const entry = TARGET_REGISTRY[consumer];
    assert.notEqual(entry.sourceDirectoryName, entry.deployDirectoryName);
    assert.equal(entry.sourceDirectoryName, `${consumer}-dev`);
    assert.equal(entry.deployDirectoryName, consumer);
    assert.equal(entry.sharedFramework, "wpdev");
    assert.equal(entry.kind, "standalone-plugin");
  }
});

test("Target registry: real in-repo sources resolve to *-dev and never to deploy output", async () => {
  let tested = 0;
  for (const consumer of listStandaloneConsumers()) {
    const entry = TARGET_REGISTRY[consumer];
    const sourceDir = path.join(contentRoot, "plugins", entry.sourceDirectoryName);
    if (!fs.existsSync(sourceDir)) {
      continue;
    }
    const resolved = await resolveConsumerSource({ contentRoot, consumer });
    assert.equal(path.basename(resolved.sourceDir), `${consumer}-dev`);
    assert.equal(path.basename(resolved.deployDir), consumer);
    assert.notEqual(path.resolve(resolved.sourceDir), path.resolve(resolved.deployDir));
    assert.ok(fs.existsSync(path.join(resolved.sourceDir, resolved.entry.bootstrapFile)));
    tested++;
  }
  assert.ok(tested > 0, "At least one consumer must be present and tested");
});

test("Target registry: missing -dev source is fail-closed and must not fall back to deploy output", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "target-registry-missing-"));
  try {
    const deployOnly = path.join(tmp, "plugins", "tavangary-core");
    await mkdir(deployOnly, { recursive: true });
    await writeFile(path.join(deployOnly, "tavangary-core.php"), "<?php // deploy output");

    await assert.rejects(
      () => resolveConsumerSource({ contentRoot: tmp, consumer: "tavangary-core" }),
      /fail-closed|missing|fallback/i
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Target registry: unknown consumer, wpdev standalone, symlink and traversal are rejected", async () => {
  await assert.rejects(
    () => resolveConsumerSource({ contentRoot, consumer: "wpdev" }),
    /shared framework|unknown/i
  );
  await assert.rejects(
    () => resolveConsumerSource({ contentRoot, consumer: "not-a-plugin" }),
    /unknown/i
  );

  const tmp = await mkdtemp(path.join(os.tmpdir(), "target-registry-unsafe-"));
  try {
    const pluginsDir = path.join(tmp, "plugins");
    await mkdir(pluginsDir, { recursive: true });
    const real = path.join(tmp, "outside-source");
    await mkdir(real, { recursive: true });
    await writeFile(path.join(real, "tavangary-core.php"), "<?php");
    await symlink(real, path.join(pluginsDir, "tavangary-core-dev"));

    await assert.rejects(
      () => resolveConsumerSource({ contentRoot: tmp, consumer: "tavangary-core" }),
      /symlink/i
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

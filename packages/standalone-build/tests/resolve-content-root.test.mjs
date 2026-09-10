import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveContentRoot } from "../resolve-content-root.mjs";

test("resolveContentRoot uses WPDEV_CONTENT_ROOT", () => {
  const dir = path.join(os.tmpdir(), `wpdev-content-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  try {
    assert.equal(
      resolveContentRoot({
        scriptDir: os.tmpdir(),
        cwd: os.tmpdir(),
        env: { WPDEV_CONTENT_ROOT: dir },
      }),
      path.resolve(dir),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveContentRoot detects a wp-content-shaped cwd", () => {
  const dir = path.join(os.tmpdir(), `wpdev-wp-content-${process.pid}`);
  mkdirSync(path.join(dir, "plugins"), { recursive: true });
  mkdirSync(path.join(dir, "themes"), { recursive: true });
  writeFileSync(path.join(dir, "plugins", ".keep"), "");
  try {
    assert.equal(
      resolveContentRoot({ scriptDir: os.tmpdir(), cwd: dir, env: {} }),
      path.resolve(dir),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveContentRoot fails closed when it cannot infer wp-content", () => {
  assert.throws(
    () =>
      resolveContentRoot({
        scriptDir: os.tmpdir(),
        cwd: os.tmpdir(),
        env: {},
        argv: [],
      }),
    /WPDEV_CONTENT_ROOT/,
  );
});

test("resolveContentRoot detects parent when cwd is inside plugins subdir", () => {
  const dir = path.join(os.tmpdir(), `wpdev-wp-plugins-${process.pid}`);
  const pluginsDir = path.join(dir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(path.join(dir, "themes"), { recursive: true });
  try {
    assert.equal(
      resolveContentRoot({ scriptDir: os.tmpdir(), cwd: pluginsDir, env: {}, argv: [] }),
      path.resolve(dir),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveContentRoot respects --content-root and --plugins-dir in argv", () => {
  const dir = path.join(os.tmpdir(), `wpdev-argv-root-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  try {
    assert.equal(
      resolveContentRoot({ scriptDir: os.tmpdir(), cwd: os.tmpdir(), env: {}, argv: [`--content-root=${dir}`] }),
      path.resolve(dir),
    );
    assert.equal(
      resolveContentRoot({ scriptDir: os.tmpdir(), cwd: os.tmpdir(), env: {}, argv: [`--plugins-dir=${path.join(dir, "plugins")}`] }),
      path.resolve(dir),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


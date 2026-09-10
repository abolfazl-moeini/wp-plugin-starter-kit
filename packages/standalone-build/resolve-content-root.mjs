import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Resolve the WordPress wp-content root for the standalone build pipeline.
 *
 * The engine used to live at wp-content/tools, so contentRoot was
 * dirname(scriptDir). After the move into the starter kit, callers must
 * run from wp-content or set WPDEV_CONTENT_ROOT.
 */
export function resolveContentRoot({
  scriptDir,
  cwd = process.cwd(),
  env = process.env,
  argv = process.argv,
} = {}) {
  const fromEnv = String(env.WPDEV_CONTENT_ROOT || "").trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  if (Array.isArray(argv)) {
    for (const arg of argv) {
      if (typeof arg === "string" && arg.startsWith("--content-root=")) {
        const val = arg.slice("--content-root=".length).trim();
        if (val) return path.resolve(val);
      }
      if (typeof arg === "string" && arg.startsWith("--plugins-dir=")) {
        const val = arg.slice("--plugins-dir=".length).trim();
        if (val) return path.dirname(path.resolve(val));
      }
    }
  }

  if (looksLikeWpContent(cwd)) {
    return path.resolve(cwd);
  }

  // Operator is inside wp-content/plugins
  const parentOfCwd = path.dirname(cwd);
  if (looksLikeWpContent(parentOfCwd)) {
    return path.resolve(parentOfCwd);
  }

  // Operator is in wordpress root which contains wp-content
  const childWpContent = path.join(cwd, "wp-content");
  if (looksLikeWpContent(childWpContent)) {
    return path.resolve(childWpContent);
  }

  if (scriptDir) {
    const legacySibling = path.resolve(scriptDir, "..");
    if (looksLikeWpContent(legacySibling)) {
      return legacySibling;
    }
  }

  throw new Error(
    "Cannot resolve wp-content root. Run from wordpress/wp-content or set WPDEV_CONTENT_ROOT.",
  );
}

function looksLikeWpContent(dir) {
  return (
    existsSync(path.join(dir, "plugins")) && existsSync(path.join(dir, "themes"))
  );
}

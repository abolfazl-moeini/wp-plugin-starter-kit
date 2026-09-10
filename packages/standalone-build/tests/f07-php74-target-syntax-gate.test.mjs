import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validatePhpSyntaxTree } from "../profile-s-fail-closed.mjs";

test("F07: validatePhpSyntaxTree rejects constructor property promotion", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "f07-promo-"));
  try {
    await writeFile(
      path.join(tmpDir, "Promotion.php"),
      "<?php\nclass Promotion {\n    public function __construct(public string $title, protected int $id) {}\n}\n"
    );
    await assert.rejects(
      validatePhpSyntaxTree(tmpDir),
      /constructor property promotion detected/i
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("F07: validatePhpSyntaxTree rejects intersection types in parameter and return", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "f07-intersection-"));
  try {
    // 1. Parameter intersection type
    await writeFile(
      path.join(tmpDir, "ParamIntersection.php"),
      "<?php\nfunction checkIntersection(Countable&Traversable $collection) { return 1; }\n"
    );
    await assert.rejects(
      validatePhpSyntaxTree(tmpDir),
      /intersection type parameter detected/i
    );

    await rm(path.join(tmpDir, "ParamIntersection.php"));

    // 2. Return intersection type
    await writeFile(
      path.join(tmpDir, "ReturnIntersection.php"),
      "<?php\nfunction getIntersection(): Countable&Traversable { return null; }\n"
    );
    await assert.rejects(
      validatePhpSyntaxTree(tmpDir),
      /intersection return type detected/i
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("F07: validatePhpSyntaxTree validates vendor and vendor-prefixed directories", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "f07-vendor-"));
  try {
    const vendorDir = path.join(tmpDir, "vendor", "test-pkg");
    await mkdir(vendorDir, { recursive: true });
    await writeFile(
      path.join(vendorDir, "InvalidVendor.php"),
      "<?php\nclass BrokenVendor {\n    public function __construct(private string $secret) {}\n}\n"
    );

    // Root is clean, only vendor has incompatible syntax
    await writeFile(path.join(tmpDir, "main.php"), "<?php echo 'ok';");

    await assert.rejects(
      validatePhpSyntaxTree(tmpDir),
      /constructor property promotion detected/i
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("F07: validatePhpSyntaxTree rejects true/false return types, non-capturing catch, and typed constants", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "f07-newer-"));
  try {
    await writeFile(path.join(tmpDir, "TrueType.php"), "<?php\nfunction ready(): true { return true; }\n");
    await assert.rejects(validatePhpSyntaxTree(tmpDir), /true return type/i);
    await rm(path.join(tmpDir, "TrueType.php"));

    await writeFile(path.join(tmpDir, "Catch.php"), "<?php\ntry { throw new Exception('x'); } catch (Exception) {}\n");
    await assert.rejects(validatePhpSyntaxTree(tmpDir), /non-capturing catch/i);
    await rm(path.join(tmpDir, "Catch.php"));

    await writeFile(path.join(tmpDir, "TypedConst.php"), "<?php\nclass Box { public const string X = \"ok\"; }\n");
    await assert.rejects(validatePhpSyntaxTree(tmpDir), /typed class constant/i);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("F07: validatePhpSyntaxTree accepts compliant PHP 7.4 code", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "f07-valid-"));
  try {
    await writeFile(
      path.join(tmpDir, "Compliant.php"),
      `<?php
class Compliant {
    private $title;
    public function __construct(string $title) {
        $this->title = $title;
    }
    public function getTitle(): string {
        return $this->title;
    }
    public function byRef(&$ref): void {
        $ref = 'done';
    }
}
`
    );
    await assert.doesNotReject(validatePhpSyntaxTree(tmpDir));
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

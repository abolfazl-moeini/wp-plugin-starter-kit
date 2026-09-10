import assert from "node:assert/strict";
import fs from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runTestScheduler, resolveTierFiles } from "../dev/run-tests.mjs";
import { runFullSuiteProfiling, profileSingleTestFile } from "../dev/profile-tests.mjs";
import { CANONICAL_TEST_REGISTRY, TEST_TIERS, validateCanonicalTestRegistry } from "../test-dependency-registry.mjs";
import { computeTreeContentHash } from "../build-cache-engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.resolve(__dirname, "..");
const contentRoot = path.resolve(toolsDir, "..");

test("Test Tiers: Meta tests are strictly excluded from unit/contract/integration tiers and present only in meta and full", () => {
  assert.equal(
    TEST_TIERS.unit.includes("test-scheduler-and-tiers.test.mjs"),
    false,
    "Meta test must NEVER be present in TEST_TIERS.unit"
  );
  assert.equal(
    TEST_TIERS.contract.includes("test-scheduler-and-tiers.test.mjs"),
    false,
    "Meta test must NEVER be present in TEST_TIERS.contract"
  );
  assert.equal(
    TEST_TIERS.integration.includes("test-scheduler-and-tiers.test.mjs"),
    false,
    "Meta test must NEVER be present in TEST_TIERS.integration"
  );
  assert.deepEqual(TEST_TIERS.meta, ["test-scheduler-and-tiers.test.mjs"]);

  const allTierFiles = [
    ...TEST_TIERS.unit,
    ...TEST_TIERS.contract,
    ...TEST_TIERS.integration,
    ...TEST_TIERS.meta,
  ].sort();

  const fullTier = resolveTierFiles("full");
  assert.deepEqual(allTierFiles, fullTier, "Full tier must be the exact disjoint union of all 4 tiers");
});

test("Test Tiers: validateCanonicalTestRegistry validates disjoint tier partitioning and rejects invalid tiers", () => {
  const testsDir = path.join(toolsDir, "tests");
  const val = validateCanonicalTestRegistry(testsDir, contentRoot);
  assert.equal(val.valid, true, `Registry must be valid: ${val.reason}`);
  assert.equal(val.tiers.meta, 1);
  assert.equal(val.tiers.unit, 27);
  assert.equal(val.tiers.contract, 49);
  assert.equal(val.tiers.integration, 2);
  assert.equal(val.totalTests, 79);
});

test("canonical npm test inventory matches package.json and files on disk", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(toolsDir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "node --test tests/*.test.mjs");
  const testsDir = path.join(toolsDir, "tests");
  const onDisk = fs.readdirSync(testsDir).filter((name) => name.endsWith(".test.mjs")).sort();
  const val = validateCanonicalTestRegistry(testsDir, contentRoot);
  assert.equal(val.valid, true, val.reason);
  assert.equal(val.totalTests, onDisk.length);
  assert.deepEqual(Object.keys(CANONICAL_TEST_REGISTRY).sort(), onDisk);
});

test("Recursion Guard: runTestScheduler and runFullSuiteProfiling reject nested recursive invocation", async () => {
  const originalRunActive = process.env.__ANTIGRAVITY_RUN_TESTS_ACTIVE;
  const originalProfileActive = process.env.__ANTIGRAVITY_PROFILE_ACTIVE;

  try {
    process.env.__ANTIGRAVITY_RUN_TESTS_ACTIVE = "1";
    await assert.rejects(
      async () => {
        await runTestScheduler({ tier: "unit" });
      },
      /RecursionGuard: Nested runTestScheduler invocation detected/i
    );

    process.env.__ANTIGRAVITY_PROFILE_ACTIVE = "1";
    await assert.rejects(
      async () => {
        await runFullSuiteProfiling({ tier: "unit" });
      },
      /RecursionGuard: Nested profile-tests invocation detected/i
    );
  } finally {
    if (originalRunActive !== undefined) process.env.__ANTIGRAVITY_RUN_TESTS_ACTIVE = originalRunActive;
    else delete process.env.__ANTIGRAVITY_RUN_TESTS_ACTIVE;

    if (originalProfileActive !== undefined) process.env.__ANTIGRAVITY_PROFILE_ACTIVE = originalProfileActive;
    else delete process.env.__ANTIGRAVITY_PROFILE_ACTIVE;
  }
});

test("Test Scheduler (Synthetic Isolation): Executes bounded concurrency without nested suite overhead", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "sched-synth-"));

  try {
    // Create 3 tiny synthetic test files
    await writeFile(
      path.join(tmpDir, "synth-a.test.mjs"),
      `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("synth a", () => assert.ok(true));\n`,
      "utf8"
    );
    await writeFile(
      path.join(tmpDir, "synth-b.test.mjs"),
      `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("synth b", () => assert.ok(true));\n`,
      "utf8"
    );
    await writeFile(
      path.join(tmpDir, "synth-c.test.mjs"),
      `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("synth c", () => assert.ok(true));\n`,
      "utf8"
    );

    const repJobs1 = await runTestScheduler({
      testsDir: tmpDir,
      files: ["synth-a.test.mjs", "synth-b.test.mjs", "synth-c.test.mjs"],
      jobs: 1,
      allowNested: true,
    });

    const repJobs2 = await runTestScheduler({
      testsDir: tmpDir,
      files: ["synth-a.test.mjs", "synth-b.test.mjs", "synth-c.test.mjs"],
      jobs: 2,
      allowNested: true,
    });

    assert.equal(repJobs1.allPassed, true);
    assert.equal(repJobs2.allPassed, true);
    assert.equal(repJobs1.selectedFilesCount, 3);
    assert.equal(repJobs2.selectedFilesCount, 3);
    assert.equal(repJobs1.processesSpawned, 3);
    assert.equal(repJobs2.processesSpawned, 3);
    assert.equal(repJobs1.totalSubtests, 3);
    assert.equal(repJobs2.totalSubtests, 3);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Test Scheduler (Synthetic Isolation): Early cancellation terminates child processes on bail", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "sched-bail-"));

  try {
    await writeFile(
      path.join(tmpDir, "fail-first.test.mjs"),
      `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("intentional fail", () => assert.equal(1, 2));\n`,
      "utf8"
    );
    await writeFile(
      path.join(tmpDir, "slow-second.test.mjs"),
      `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("slow", async () => { await new Promise(r => setTimeout(r, 5000)); assert.ok(true); });\n`,
      "utf8"
    );

    const tStart = performance.now();
    const rep = await runTestScheduler({
      testsDir: tmpDir,
      files: ["fail-first.test.mjs", "slow-second.test.mjs"],
      jobs: 1,
      bail: true,
      allowNested: true,
    });
    const duration = performance.now() - tStart;

    assert.equal(rep.allPassed, false);
    assert.ok(duration < 4000, `Execution must bail early on failure (took ${duration}ms)`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Test Profiler (Synthetic Isolation): Accurately profiles synthetic test files and tracks process count", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "prof-synth-"));

  try {
    await writeFile(
      path.join(tmpDir, "prof-a.test.mjs"),
      `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("prof a", () => assert.ok(true));\n`,
      "utf8"
    );
    await writeFile(
      path.join(tmpDir, "prof-b.test.mjs"),
      `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("prof b", () => assert.ok(true));\n`,
      "utf8"
    );

    const singleRes = await profileSingleTestFile(path.join(tmpDir, "prof-a.test.mjs"), {
      testsDir: tmpDir,
    });
    assert.equal(singleRes.passed, true);
    assert.equal(singleRes.subtestCount, 1);

    const fullProf = await runFullSuiteProfiling({
      testsDir: tmpDir,
      files: ["prof-a.test.mjs", "prof-b.test.mjs"],
      jobs: 1,
      allowNested: true,
    });

    assert.equal(fullProf.totalFiles, 2);
    assert.equal(fullProf.processesSpawned, 2);
    assert.equal(fullProf.totalSubtests, 2);
    assert.equal(fullProf.totalPassed, 2);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Test Scheduler: Running scheduler causes zero mutations to workspace tools directory", async () => {
  const hashBefore = await computeTreeContentHash(toolsDir);

  const testsDir = path.join(toolsDir, "tests");
  assert.ok(fs.existsSync(testsDir));

  const hashAfter = await computeTreeContentHash(toolsDir);
  assert.equal(hashBefore, hashAfter, "Workspace hash must remain 100% identical");
});

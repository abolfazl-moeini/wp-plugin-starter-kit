#!/usr/bin/env node

/**
 * Plan 3: Content-Based Cache & Dependency Graph Build Engine
 * 
 * Features:
 * 1. Content-based SHA-256 hashing (modifying 1 byte triggers rebuild; updating mtime does not).
 * 2. Dependency Graph with Propagation (shared wpdev changes propagate to all dependent plugins).
 * 3. Selective "--changed" mode to build only affected plugins with clear reason reporting.
 * 4. Strict rejection of symlinks, non-regular files, and traversal attempts.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { pLimit } from "./build-dag-runner.mjs";
import { resolveConsumerSource } from "./target-registry.mjs";
import { readEmbeddedManifestFromZip, readZipEntries, verifyArtifactManifest } from "./canonical-artifact-manifest.mjs";
import {
  TEST_SPEC_MAP,
  REQUIRED_ARTIFACT_TESTS,
} from "./test-dependency-registry.mjs";

export { TEST_SPEC_MAP, REQUIRED_ARTIFACT_TESTS };

const execFileAsync = promisify(execFile);
const fileLimit = pLimit(16);

export const CACHE_SCHEMA_VERSION = 3;
export const RECEIPT_SCHEMA_VERSION = 2;
export const TEST_EVIDENCE_SCHEMA_VERSION = 3;
export const DEPLOY_JOURNAL_SCHEMA_VERSION = 2;

export const ALLOWED_CONSUMERS = new Set([
  "drm-connector",
  "tavangary-core",
  "tavangary-theme-panel",
  "wpdev-analytics",
  "wpdev-crm",
  "wpdev-tickets",
  "wpdev-woo-persian",
]);

export function isValidConsumerName(consumer) {
  return typeof consumer === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(consumer);
}

export function canonicalizePath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return targetPath;
  try {
    return fs.realpathSync(targetPath);
  } catch {
    try {
      let current = path.resolve(targetPath);
      const segments = [];
      while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) break;
        segments.unshift(path.basename(current));
        current = parent;
      }
      const realBase = fs.realpathSync(current);
      return path.join(realBase, ...segments);
    } catch {
      return path.resolve(targetPath);
    }
  }
}

export const ALLOWED_JOURNAL_PHASES = new Set([
  "prepared",
  "publishing",
  "committed",
  "cleanup_complete",
  "rolling_back",
  "rolled_back",
  "rollback_failed",
]);

export const ALLOWED_TARGET_PHASES = new Set([
  "prepared",
  "backup_rename_intent",
  "backup_renamed",
  "candidate_swap_intent",
  "candidate_swapped",
  "target_verification_intent",
  "target_verified",
]);

export const MAX_JOURNAL_SIZE_BYTES = 65536;

export function validateDeployJournalSchema(data, options = {}) {
  if (!isPlainObject(data)) {
    return { valid: false, reason: "Deploy journal must be a plain object" };
  }

  if (Object.prototype.hasOwnProperty.call(data, "__proto__") ||
      Object.prototype.hasOwnProperty.call(data, "constructor") ||
      Object.prototype.hasOwnProperty.call(data, "prototype")) {
    return { valid: false, reason: "Deploy journal contains forbidden prototype keys" };
  }

  const ALLOWED_TOP_KEYS = new Set(["schemaVersion", "txId", "revision", "createdAt", "updatedAt", "phase", "targets", "publication", "error"]);
  for (const k of Object.keys(data)) {
    if (!ALLOWED_TOP_KEYS.has(k)) {
      return { valid: false, reason: `Deploy journal contains disallowed top-level key '${k}'` };
    }
  }

  if (data.schemaVersion !== DEPLOY_JOURNAL_SCHEMA_VERSION) {
    return { valid: false, reason: `Deploy journal schema mismatch (expected ${DEPLOY_JOURNAL_SCHEMA_VERSION}, got ${data.schemaVersion})`, isStale: true };
  }

  if (typeof data.txId !== "string" || !/^tx-[0-9]+-[a-z0-9]{4,16}$/.test(data.txId)) {
    return { valid: false, reason: `Invalid txId format '${data.txId}' in deploy journal` };
  }

  if (!Number.isInteger(data.revision) || data.revision < 1) {
    return { valid: false, reason: `Deploy journal revision must be an integer >= 1` };
  }

  if (typeof data.createdAt !== "string" || isNaN(Date.parse(data.createdAt))) {
    return { valid: false, reason: "Deploy journal missing valid ISO createdAt" };
  }
  if (typeof data.updatedAt !== "string" || isNaN(Date.parse(data.updatedAt))) {
    return { valid: false, reason: "Deploy journal missing valid ISO updatedAt" };
  }

  if (!ALLOWED_JOURNAL_PHASES.has(data.phase)) {
    return { valid: false, reason: `Invalid journal phase '${data.phase}'` };
  }

  if (!Array.isArray(data.targets)) {
    return { valid: false, reason: "Deploy journal field 'targets' must be an array" };
  }

  const ALLOWED_TARGET_KEYS = new Set(["consumer", "preExisting", "phase", "backupToken", "stagingToken", "candidateZipSha", "candidateManifestDigest"]);
  const seenConsumers = new Set();
  for (const t of data.targets) {
    if (!isPlainObject(t)) {
      return { valid: false, reason: "Target record in journal must be a plain object" };
    }
    if (Object.prototype.hasOwnProperty.call(t, "__proto__") || Object.prototype.hasOwnProperty.call(t, "constructor")) {
      return { valid: false, reason: "Target record in journal contains forbidden prototype keys" };
    }
    for (const tk of Object.keys(t)) {
      if (!ALLOWED_TARGET_KEYS.has(tk)) {
        return { valid: false, reason: `Target record contains disallowed key '${tk}'` };
      }
    }
    const isAllowed = ALLOWED_CONSUMERS.has(t.consumer) || (options.allowExternalConsumers && isValidConsumerName(t.consumer));
    if (!t.consumer || !isAllowed) {
      return { valid: false, reason: `Disallowed target consumer '${t.consumer}' in journal` };
    }
    if (seenConsumers.has(t.consumer)) {
      return { valid: false, reason: `Duplicate consumer '${t.consumer}' in journal targets` };
    }
    seenConsumers.add(t.consumer);

    if (typeof t.preExisting !== "boolean") {
      return { valid: false, reason: `Target '${t.consumer}' in journal missing boolean preExisting` };
    }
    if (!ALLOWED_TARGET_PHASES.has(t.phase)) {
      return { valid: false, reason: `Invalid target phase '${t.phase}' for '${t.consumer}' in journal` };
    }

    const expectedBackupToken = `.${t.consumer}.backup-${data.txId}`;
    if (t.backupToken !== expectedBackupToken) {
      return { valid: false, reason: `Invalid backupToken '${t.backupToken}' for '${t.consumer}' (expected '${expectedBackupToken}')` };
    }

    const expectedStagingToken = `.${t.consumer}.staging-${data.txId}`;
    if (t.stagingToken !== expectedStagingToken) {
      return { valid: false, reason: `Invalid stagingToken '${t.stagingToken}' for '${t.consumer}' (expected '${expectedStagingToken}')` };
    }

    if (typeof t.candidateZipSha !== "string" || !/^[a-f0-9]{64}$/.test(t.candidateZipSha)) {
      return { valid: false, reason: `Target '${t.consumer}' in journal has invalid candidateZipSha` };
    }
    if (t.candidateManifestDigest !== null && (typeof t.candidateManifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(t.candidateManifestDigest))) {
      return { valid: false, reason: `Target '${t.consumer}' in journal has invalid candidateManifestDigest` };
    }

    // Security: reject injected absolute path fields in journal JSON
    if (Object.prototype.hasOwnProperty.call(t, "targetDir") ||
        Object.prototype.hasOwnProperty.call(t, "backupDir") ||
        Object.prototype.hasOwnProperty.call(t, "stagingDir")) {
      return { valid: false, reason: `Target '${t.consumer}' contains forbidden injected path properties in journal` };
    }
  }

  if (data.publication) {
    if (!isPlainObject(data.publication)) {
      return { valid: false, reason: "Deploy journal publication must be a plain object" };
    }
    if (Object.prototype.hasOwnProperty.call(data.publication, "__proto__")) {
      return { valid: false, reason: "Publication contains forbidden prototype keys" };
    }
    const ALLOWED_PUB_KEYS = new Set(["receipts", "cache", "backupsPurged"]);
    for (const pk of Object.keys(data.publication)) {
      if (!ALLOWED_PUB_KEYS.has(pk)) {
        return { valid: false, reason: `Publication contains disallowed key '${pk}'` };
      }
    }
    if (data.publication.receipts && !isPlainObject(data.publication.receipts)) {
      return { valid: false, reason: "Publication receipts must be a plain object" };
    }
    if (data.publication.receipts) {
      const ALLOWED_PUB_FILE_KEYS = new Set(["consumer", "existedBefore", "preDigest", "backupStatus", "stagedDigest", "publishStatus", "finalDigest"]);
      for (const [c, r] of Object.entries(data.publication.receipts)) {
        if (!ALLOWED_CONSUMERS.has(c) && !isValidConsumerName(c)) {
          return { valid: false, reason: `Disallowed consumer '${c}' in publication receipts` };
        }
        if (r.consumer !== c) {
          return { valid: false, reason: `Consumer mismatch in publication receipt '${c}'` };
        }
        for (const rk of Object.keys(r)) {
          if (!ALLOWED_PUB_FILE_KEYS.has(rk)) {
            return { valid: false, reason: `Publication receipt '${c}' contains disallowed key '${rk}'` };
          }
        }
        if (typeof r.existedBefore !== "boolean") {
          return { valid: false, reason: `Publication receipt '${c}' missing boolean existedBefore` };
        }
        if (r.existedBefore) {
          if (typeof r.preDigest !== "string" || !/^[a-f0-9]{64}$/.test(r.preDigest)) {
            return { valid: false, reason: `Publication receipt '${c}' with existedBefore:true requires valid 64-char preDigest` };
          }
          if (r.backupStatus !== "backed_up") {
            return { valid: false, reason: `Publication receipt '${c}' with existedBefore:true requires backupStatus 'backed_up'` };
          }
        } else {
          if (r.preDigest !== null) {
            return { valid: false, reason: `Publication receipt '${c}' with existedBefore:false must have null preDigest` };
          }
          if (r.backupStatus !== "absent") {
            return { valid: false, reason: `Publication receipt '${c}' with existedBefore:false must have backupStatus 'absent'` };
          }
        }
        if (typeof r.stagedDigest !== "string" || !/^[a-f0-9]{64}$/.test(r.stagedDigest)) {
          return { valid: false, reason: `Publication receipt '${c}' has invalid stagedDigest` };
        }
        if (!new Set(["pending", "staged", "publishing", "published", "restored", "deleted"]).has(r.publishStatus)) {
          return { valid: false, reason: `Publication receipt '${c}' has invalid publishStatus` };
        }
        if (r.publishStatus === "published" && r.finalDigest !== r.stagedDigest) {
          return { valid: false, reason: `Publication receipt '${c}' in published state must have finalDigest equal to stagedDigest` };
        }
        if (r.finalDigest !== null && (typeof r.finalDigest !== "string" || !/^[a-f0-9]{64}$/.test(r.finalDigest))) {
          return { valid: false, reason: `Publication receipt '${c}' has invalid finalDigest` };
        }
      }
    }
    if (data.publication.cache) {
      const c = data.publication.cache;
      if (!isPlainObject(c)) {
        return { valid: false, reason: "Publication cache must be a plain object" };
      }
      const ALLOWED_CACHE_PUB_KEYS = new Set(["existedBefore", "preDigest", "backupStatus", "stagedDigest", "publishStatus", "finalDigest"]);
      for (const ck of Object.keys(c)) {
        if (!ALLOWED_CACHE_PUB_KEYS.has(ck)) {
          return { valid: false, reason: `Publication cache contains disallowed key '${ck}'` };
        }
      }
      if (typeof c.existedBefore !== "boolean") {
        return { valid: false, reason: "Publication cache missing boolean existedBefore" };
      }
      if (c.existedBefore) {
        if (typeof c.preDigest !== "string" || !/^[a-f0-9]{64}$/.test(c.preDigest)) {
          return { valid: false, reason: "Publication cache with existedBefore:true requires valid 64-char preDigest" };
        }
        if (c.backupStatus !== "backed_up") {
          return { valid: false, reason: "Publication cache with existedBefore:true requires backupStatus 'backed_up'" };
        }
      } else {
        if (c.preDigest !== null) {
          return { valid: false, reason: "Publication cache with existedBefore:false must have null preDigest" };
        }
        if (c.backupStatus !== "absent") {
          return { valid: false, reason: "Publication cache with existedBefore:false must have backupStatus 'absent'" };
        }
      }
      if (typeof c.stagedDigest !== "string" || !/^[a-f0-9]{64}$/.test(c.stagedDigest)) {
        return { valid: false, reason: "Publication cache has invalid stagedDigest" };
      }
      if (!new Set(["pending", "staged", "publishing", "published", "restored", "deleted"]).has(c.publishStatus)) {
        return { valid: false, reason: "Publication cache has invalid publishStatus" };
      }
      if (c.publishStatus === "published" && c.finalDigest !== c.stagedDigest) {
        return { valid: false, reason: "Publication cache in published state must have finalDigest equal to stagedDigest" };
      }
      if (c.finalDigest !== null && (typeof c.finalDigest !== "string" || !/^[a-f0-9]{64}$/.test(c.finalDigest))) {
        return { valid: false, reason: "Publication cache has invalid finalDigest" };
      }
    }
    if (typeof data.publication.backupsPurged !== "boolean") {
      return { valid: false, reason: "Publication missing boolean backupsPurged" };
    }
  }

  if (data.error !== null && data.error !== undefined) {
    if (!isPlainObject(data.error)) {
      return { valid: false, reason: "Deploy journal error field must be null or a plain object" };
    }
    const ALLOWED_ERROR_KEYS = new Set(["message", "stack", "failedPhase", "timestamp"]);
    for (const ek of Object.keys(data.error)) {
      if (!ALLOWED_ERROR_KEYS.has(ek)) {
        return { valid: false, reason: `Error record contains disallowed key '${ek}'` };
      }
    }
    if (typeof data.error.message !== "string") {
      return { valid: false, reason: "Error record missing string message" };
    }
  }

  return { valid: true };
}

export async function fsyncDir(dirPath) {
  if (!dirPath || typeof dirPath !== "string") {
    throw new Error("fsyncDir: valid directory path required");
  }
  if (!fs.existsSync(dirPath)) return;
  const lst = await lstat(dirPath);
  if (lst.isSymbolicLink()) {
    throw new Error(`fsyncDir: directory cannot be a symbolic link (${dirPath})`);
  }
  if (!lst.isDirectory()) {
    throw new Error(`fsyncDir: path is not a directory (${dirPath})`);
  }
  const handle = await fs.promises.open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function validateJournalTransition(previous, next, options = {}) {
  if (!isPlainObject(previous) || !isPlainObject(next)) {
    return { valid: false, reason: "Journal states must be plain objects" };
  }
  const valPrev = validateDeployJournalSchema(previous, options);
  if (!valPrev.valid) return { valid: false, reason: `Previous journal state invalid: ${valPrev.reason}` };
  const valNext = validateDeployJournalSchema(next, options);
  if (!valNext.valid) return { valid: false, reason: `Next journal state invalid: ${valNext.reason}` };

  if (next.txId !== previous.txId) {
    return { valid: false, reason: `Journal transition mutated txId ('${previous.txId}' -> '${next.txId}')` };
  }
  if (next.createdAt !== previous.createdAt) {
    return { valid: false, reason: `Journal transition mutated createdAt ('${previous.createdAt}' -> '${next.createdAt}')` };
  }
  if (next.revision !== previous.revision + 1) {
    return { valid: false, reason: `Journal revision must be strictly monotonic (+1) (previous: ${previous.revision}, next: ${next.revision})` };
  }

  if (next.targets.length !== previous.targets.length) {
    return { valid: false, reason: `Journal transition altered target count (${previous.targets.length} -> ${next.targets.length})` };
  }
  for (let i = 0; i < next.targets.length; i++) {
    const prevT = previous.targets[i];
    const nextT = next.targets[i];
    if (nextT.consumer !== prevT.consumer) {
      return { valid: false, reason: `Target mismatch at index ${i}: expected '${prevT.consumer}', got '${nextT.consumer}'` };
    }
    if (nextT.preExisting !== prevT.preExisting) {
      return { valid: false, reason: `Target '${nextT.consumer}' mutated preExisting` };
    }
    if (nextT.backupToken !== prevT.backupToken || nextT.stagingToken !== prevT.stagingToken) {
      return { valid: false, reason: `Target '${nextT.consumer}' mutated tokens` };
    }

    // Candidate digest rules
    if (prevT.phase !== "prepared") {
      if (nextT.candidateZipSha !== prevT.candidateZipSha) {
        return { valid: false, reason: `Target '${nextT.consumer}' candidateZipSha mutated after leaving prepared phase` };
      }
      if (nextT.candidateManifestDigest !== prevT.candidateManifestDigest) {
        return { valid: false, reason: `Target '${nextT.consumer}' candidateManifestDigest mutated after leaving prepared phase` };
      }
    }

    if (nextT.phase !== "prepared" && next.phase !== "rolling_back" && next.phase !== "rolled_back" && next.phase !== "rollback_failed") {
      if (nextT.candidateZipSha === "0".repeat(64) || !/^[a-f0-9]{64}$/.test(nextT.candidateZipSha)) {
        return { valid: false, reason: `Target '${nextT.consumer}' candidateZipSha must be a valid non-zero 64-char hex digest before transitioning to '${nextT.phase}'` };
      }
      if (!nextT.candidateManifestDigest || !/^[a-f0-9]{64}$/.test(nextT.candidateManifestDigest)) {
        return { valid: false, reason: `Target '${nextT.consumer}' candidateManifestDigest must be a valid 64-char hex digest before transitioning to '${nextT.phase}'` };
      }
    }

    const ALLOWED_TARGET_TRANSITIONS = {
      prepared: prevT.preExisting
        ? ["prepared", "backup_rename_intent", "rolling_back"]
        : ["prepared", "candidate_swap_intent", "rolling_back"],
      backup_rename_intent: ["backup_rename_intent", "backup_renamed", "rolling_back"],
      backup_renamed: ["backup_renamed", "candidate_swap_intent", "rolling_back"],
      candidate_swap_intent: ["candidate_swap_intent", "candidate_swapped", "rolling_back"],
      candidate_swapped: ["candidate_swapped", "target_verification_intent", "rolling_back"],
      target_verification_intent: ["target_verification_intent", "target_verified", "rolling_back"],
      target_verified: ["target_verified", "rolling_back"],
    };
    const allowed = ALLOWED_TARGET_TRANSITIONS[prevT.phase] || [];
    if (!allowed.includes(nextT.phase) && next.phase !== "rolling_back" && next.phase !== "rolled_back" && next.phase !== "rollback_failed") {
      return { valid: false, reason: `Invalid target phase transition for '${nextT.consumer}': '${prevT.phase}' -> '${nextT.phase}'` };
    }
  }

  // Publication transitions
  if (next.publication?.backupsPurged === true && next.phase !== "cleanup_complete") {
    return { valid: false, reason: "backupsPurged is only allowed in cleanup_complete phase" };
  }

  const ALLOWED_RECEIPT_TRANSITIONS = {
    pending: ["pending", "staged", "restored", "deleted"],
    staged: ["staged", "publishing", "restored", "deleted"],
    publishing: ["publishing", "published", "restored", "deleted"],
    published: ["published", "restored", "deleted"],
    restored: ["restored"],
    deleted: ["deleted"],
  };

  const isRollbackPhase = next.phase === "rolling_back" || next.phase === "rolled_back" || next.phase === "rollback_failed";

  if (next.publication?.receipts) {
    for (const [consumer, nextR] of Object.entries(next.publication.receipts)) {
      const prevR = previous.publication?.receipts?.[consumer];
      if (prevR) {
        const allowedR = ALLOWED_RECEIPT_TRANSITIONS[prevR.publishStatus] || [];
        if (!allowedR.includes(nextR.publishStatus)) {
          return { valid: false, reason: `Invalid publication receipt phase transition for '${consumer}': '${prevR.publishStatus}' -> '${nextR.publishStatus}'` };
        }
        if ((nextR.publishStatus === "restored" || nextR.publishStatus === "deleted") && !isRollbackPhase) {
          return { valid: false, reason: `Publication receipt '${consumer}' cannot transition to '${nextR.publishStatus}' outside rollback phase` };
        }
        if (prevR.publishStatus === "published") {
          if (nextR.publishStatus !== "published" && (!isRollbackPhase || (nextR.publishStatus !== "restored" && nextR.publishStatus !== "deleted"))) {
            return { valid: false, reason: `Published receipt '${consumer}' cannot transition away from 'published'` };
          }
          if (nextR.publishStatus === "published") {
            if (nextR.stagedDigest !== prevR.stagedDigest || nextR.finalDigest !== prevR.finalDigest) {
              return { valid: false, reason: `Published receipt '${consumer}' digests cannot be mutated` };
            }
            if (nextR.existedBefore !== prevR.existedBefore || nextR.preDigest !== prevR.preDigest || nextR.backupStatus !== prevR.backupStatus) {
              return { valid: false, reason: `Published receipt '${consumer}' metadata cannot be mutated` };
            }
          }
        }
      } else if (nextR.publishStatus === "restored" || nextR.publishStatus === "deleted") {
        if (!isRollbackPhase) {
          return { valid: false, reason: `Publication receipt '${consumer}' cannot initialize as '${nextR.publishStatus}' outside rollback phase` };
        }
      }
      if (nextR.publishStatus === "published" && (!nextR.finalDigest || nextR.finalDigest !== nextR.stagedDigest)) {
        return { valid: false, reason: `finalDigest must equal stagedDigest for published receipt '${consumer}'` };
      }
    }
  }

  if (next.publication?.cache) {
    const nextC = next.publication.cache;
    const prevC = previous.publication?.cache;
    if (prevC) {
      const allowedC = ALLOWED_RECEIPT_TRANSITIONS[prevC.publishStatus] || [];
      if (!allowedC.includes(nextC.publishStatus)) {
        return { valid: false, reason: `Invalid publication cache phase transition: '${prevC.publishStatus}' -> '${nextC.publishStatus}'` };
      }
      if ((nextC.publishStatus === "restored" || nextC.publishStatus === "deleted") && !isRollbackPhase) {
        return { valid: false, reason: `Publication cache cannot transition to '${nextC.publishStatus}' outside rollback phase` };
      }
      if (prevC.publishStatus === "published") {
        if (nextC.publishStatus !== "published" && (!isRollbackPhase || (nextC.publishStatus !== "restored" && nextC.publishStatus !== "deleted"))) {
          return { valid: false, reason: "Published cache cannot transition away from 'published'" };
        }
        if (nextC.publishStatus === "published") {
          if (nextC.stagedDigest !== prevC.stagedDigest || nextC.finalDigest !== prevC.finalDigest) {
            return { valid: false, reason: "Published cache digests cannot be mutated" };
          }
          if (nextC.existedBefore !== prevC.existedBefore || nextC.preDigest !== prevC.preDigest || nextC.backupStatus !== prevC.backupStatus) {
            return { valid: false, reason: "Published cache metadata cannot be mutated" };
          }
        }
      }
    } else if (nextC.publishStatus === "restored" || nextC.publishStatus === "deleted") {
      if (!isRollbackPhase) {
        return { valid: false, reason: `Publication cache cannot initialize as '${nextC.publishStatus}' outside rollback phase` };
      }
    }
    if (nextC.publishStatus === "published" && (!nextC.finalDigest || nextC.finalDigest !== nextC.stagedDigest)) {
      return { valid: false, reason: "finalDigest must equal stagedDigest for published cache" };
    }
  }

  if (next.phase === "committed") {
    if (!next.publication || !next.publication.cache || !next.publication.receipts) {
      return { valid: false, reason: "Publication cache and receipts are required in committed phase" };
    }
    if (next.publication.cache.publishStatus !== "published") {
      return { valid: false, reason: "Publication cache must have status 'published' in committed phase" };
    }

    const targetConsumers = new Set(next.targets.map((t) => t.consumer));
    const receiptConsumers = new Set(Object.keys(next.publication.receipts));

    for (const c of targetConsumers) {
      if (!receiptConsumers.has(c)) {
        return { valid: false, reason: `Missing required publication receipt for target '${c}' in committed phase` };
      }
      const r = next.publication.receipts[c];
      if (r.publishStatus !== "published") {
        return { valid: false, reason: `Publication receipt '${c}' must have status 'published' in committed phase` };
      }
    }

    for (const rc of receiptConsumers) {
      if (!targetConsumers.has(rc)) {
        return { valid: false, reason: `Unexpected extra publication receipt '${rc}' not present in targets` };
      }
    }
  }

  const ALLOWED_JOURNAL_TRANSITIONS = {
    prepared: ["prepared", "publishing", "rolling_back", "rollback_failed"],
    publishing: ["publishing", "committed", "rolling_back", "rollback_failed"],
    committed: ["committed", "cleanup_complete", "rollback_failed"],
    cleanup_complete: ["cleanup_complete"],
    rolling_back: ["rolling_back", "rolled_back", "rollback_failed"],
    rolled_back: ["rolled_back"],
    rollback_failed: ["rollback_failed"],
  };

  const allowedOverall = ALLOWED_JOURNAL_TRANSITIONS[previous.phase] || [];
  if (!allowedOverall.includes(next.phase)) {
    return { valid: false, reason: `Invalid transition from journal phase '${previous.phase}' to '${next.phase}' (illegal transition)` };
  }

  return { valid: true };
}

export function deepFreeze(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Object.isFrozen(obj)) {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = obj[key];
    if (val !== null && typeof val === "object") {
      deepFreeze(val);
    }
  }
  return obj;
}

export class TransactionJournalManager {
  #journalFile;
  #distDir;
  #currentJournal;
  #persistedJournal;
  #writeQueue;
  #isTerminated;
  #isRolledBack;
  #isCommitted;
  #allowExternalConsumers;

  constructor({ journalFile, distDir, initialJournal, allowExternalConsumers = true }) {
    if (!journalFile || typeof journalFile !== "string") {
      throw new Error("TransactionJournalManager requires a valid journalFile path");
    }
    if (!distDir || typeof distDir !== "string") {
      throw new Error("TransactionJournalManager requires a valid distDir path");
    }
    const val = validateDeployJournalSchema(initialJournal, { allowExternalConsumers });
    if (!val.valid) {
      throw new Error(`Initial deploy journal schema invalid: ${val.reason}`);
    }
    this.#allowExternalConsumers = allowExternalConsumers;
    this.#journalFile = journalFile;
    this.#distDir = distDir;
    this.#currentJournal = deepFreeze(structuredClone(initialJournal));
    this.#persistedJournal = null;
    this.#writeQueue = Promise.resolve();
    this.#isTerminated = false;
    this.#isRolledBack = false;
    this.#isCommitted = false;
  }

  get isTerminated() {
    return this.#isTerminated;
  }

  get isRolledBack() {
    return this.#isRolledBack;
  }

  get isCommitted() {
    return this.#isCommitted;
  }

  getSnapshot() {
    return deepFreeze(structuredClone(this.#currentJournal));
  }

  getLastPersistedSnapshot() {
    return this.#persistedJournal ? deepFreeze(structuredClone(this.#persistedJournal)) : null;
  }

  update(mutatorFn) {
    if (this.#isTerminated) {
      return Promise.reject(new Error("TransactionJournalManager is terminated; subsequent journal writes are strictly rejected"));
    }

    return new Promise((resolve, reject) => {
      this.#writeQueue = this.#writeQueue
        .catch(() => {})
        .then(async () => {
          if (this.#isTerminated) {
            reject(new Error("TransactionJournalManager is terminated; subsequent journal writes are strictly rejected"));
            return;
          }
          try {
            const candidateState = structuredClone(this.#currentJournal);
            const prevRevision = this.#persistedJournal ? this.#persistedJournal.revision : (candidateState.revision || 0);
            candidateState.revision = prevRevision + 1;
            candidateState.updatedAt = new Date().toISOString();

            if (typeof mutatorFn === "function") {
              await mutatorFn(candidateState);
            }

            if (this.#isTerminated) {
              throw new Error("TransactionJournalManager was terminated during update execution; mutation aborted");
            }

            if (this.#persistedJournal) {
              const transVal = validateJournalTransition(this.#persistedJournal, candidateState, { allowExternalConsumers: this.#allowExternalConsumers });
              if (!transVal.valid) {
                throw new Error(`Invalid journal transition: ${transVal.reason}`);
              }
            } else {
              const schemaVal = validateDeployJournalSchema(candidateState, { allowExternalConsumers: this.#allowExternalConsumers });
              if (!schemaVal.valid) {
                throw new Error(`Deploy journal schema validation failed: ${schemaVal.reason}`);
              }
            }

            await fs.promises.mkdir(this.#distDir, { recursive: true });
            const writeRes = await writeAtomicCacheFile(this.#journalFile, candidateState);
            if (writeRes.outcome !== "committed-durable") {
              throw new Error(`Failed to durably persist deploy journal (outcome: ${writeRes.outcome})`);
            }

            this.#currentJournal = deepFreeze(structuredClone(candidateState));
            this.#persistedJournal = deepFreeze(structuredClone(candidateState));

            if (candidateState.phase === "committed") {
              this.#isCommitted = true;
            } else if (candidateState.phase === "rolled_back" || candidateState.phase === "rollback_failed") {
              this.#isRolledBack = true;
            }

            resolve(this.getSnapshot());
          } catch (err) {
            reject(err);
          }
        });
    });
  }

  terminate() {
    this.#isTerminated = true;
  }
}

export async function loadDeployJournalRecord(journalFilePath, options = {}) {
  if (!fs.existsSync(journalFilePath)) {
    return { status: "missing", reason: "Deploy journal file does not exist", journal: null };
  }

  let handle;
  try {
    const lst = await lstat(journalFilePath);
    if (lst.isSymbolicLink()) {
      return { status: "invalid", reason: "Deploy journal cannot be a symbolic link", journal: null };
    }
    if (!lst.isFile()) {
      return { status: "invalid", reason: "Deploy journal path is not a regular file", journal: null };
    }
    if (lst.size > MAX_JOURNAL_SIZE_BYTES) {
      return { status: "invalid", reason: `Deploy journal exceeds maximum size limit (${MAX_JOURNAL_SIZE_BYTES} bytes)`, journal: null };
    }

    handle = await fs.promises.open(journalFilePath, "r");
    const raw = await handle.readFile("utf8");
    await handle.close();
    handle = null;

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { status: "corrupted", reason: "Deploy journal contains invalid JSON", journal: null };
    }

    const val = validateDeployJournalSchema(data, options);
    if (!val.valid) {
      return { status: "invalid", reason: val.reason, journal: null };
    }

    return { status: "valid", journal: data };
  } catch (err) {
    if (handle) {
      try { await handle.close(); } catch {}
    }
    return { status: "error", reason: err.message, journal: null };
  }
}

export function deriveJournalPaths({ journal, pluginsDir, distDir }) {
  if (!journal || typeof journal !== "object") {
    throw new Error("deriveJournalPaths: valid journal object required");
  }
  const resolvedPluginsDir = path.resolve(pluginsDir);
  const resolvedDistDir = path.resolve(distDir);

  const targets = (journal.targets || []).map((t) => {
    if (!ALLOWED_CONSUMERS.has(t.consumer) && !isValidConsumerName(t.consumer)) {
      throw new Error(`deriveJournalPaths: unauthorized consumer '${t.consumer}'`);
    }
    const targetDir = path.join(resolvedPluginsDir, t.consumer);
    const backupDir = path.join(resolvedPluginsDir, t.backupToken);
    const stagingDir = path.join(resolvedPluginsDir, t.stagingToken);

    // Strict containment assertion
    if (!path.resolve(targetDir).startsWith(resolvedPluginsDir + path.sep)) {
      throw new Error(`deriveJournalPaths: targetDir traversal detected for '${t.consumer}'`);
    }
    if (!path.resolve(backupDir).startsWith(resolvedPluginsDir + path.sep)) {
      throw new Error(`deriveJournalPaths: backupDir traversal detected for '${t.consumer}'`);
    }
    if (!path.resolve(stagingDir).startsWith(resolvedPluginsDir + path.sep)) {
      throw new Error(`deriveJournalPaths: stagingDir traversal detected for '${t.consumer}'`);
    }

    return {
      consumer: t.consumer,
      preExisting: t.preExisting,
      phase: t.phase,
      candidateZipSha: t.candidateZipSha,
      candidateManifestDigest: t.candidateManifestDigest,
      targetDir,
      backupDir,
      stagingDir,
    };
  });

  const txStagingDir = path.join(resolvedDistDir, `.tx-staging-${journal.txId}`);
  const txBackupDir = path.join(resolvedDistDir, `.tx-backup-${journal.txId}`);

  if (!path.resolve(txStagingDir).startsWith(resolvedDistDir + path.sep)) {
    throw new Error(`deriveJournalPaths: txStagingDir traversal detected`);
  }
  if (!path.resolve(txBackupDir).startsWith(resolvedDistDir + path.sep)) {
    throw new Error(`deriveJournalPaths: txBackupDir traversal detected`);
  }

  return {
    txId: journal.txId,
    targets,
    txStagingDir,
    txBackupDir,
  };
}

async function verifyNoSymlinksInTree(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  const lst = await lstat(targetPath);
  if (lst.isSymbolicLink()) {
    throw new Error(`Symbolic link detected at ${targetPath}`);
  }
  if (lst.isDirectory()) {
    const entries = await readdir(targetPath, { withFileTypes: true });
    for (const ent of entries) {
      const child = path.join(targetPath, ent.name);
      if (ent.isSymbolicLink()) {
        throw new Error(`Symbolic link detected inside directory: ${child}`);
      }
      if (ent.isDirectory()) {
        await verifyNoSymlinksInTree(child);
      }
    }
  }
}

export async function recoverInterruptedDeployment({
  journalFile,
  pluginsDir,
  distDir,
  logger = console,
  allowExternalConsumers = false,
}) {
  if (!fs.existsSync(journalFile)) {
    return { recovered: false, clean: true, reason: "No active deploy journal found" };
  }

  const loaded = await loadDeployJournalRecord(journalFile, { allowExternalConsumers });
  if (loaded.status !== "valid") {
    throw new Error(
      `Unsafe or invalid deployment journal encountered (${loaded.reason}). ` +
      `Halting build fail-closed without auto-deletion. Manual recovery required: inspect ${journalFile}`
    );
  }

  const journal = loaded.journal;

  if (journal.phase === "rollback_failed") {
    throw new Error(
      `Previous deployment rollback failed (${journal.error?.message || "unknown"}). ` +
      `Halting build fail-closed. Inspect ${journalFile} and restore plugins manually.`
    );
  }

  const derived = deriveJournalPaths({ journal, pluginsDir, distDir });

  // 1. If journal is in "committed" phase, verify destination integrity BEFORE forward cleanup
  if (journal.phase === "committed") {
    logger.log?.(`ℹ️ Completing forward cleanup for committed transaction (${journal.txId})...`);

    // Verify all committed destination targets and receipts
    for (const target of derived.targets) {
      if (!fs.existsSync(target.targetDir)) {
        throw new Error(`Committed recovery failed: Target directory missing at ${target.targetDir}`);
      }
      const tStat = await lstat(target.targetDir);
      if (tStat.isSymbolicLink() || !tStat.isDirectory()) {
        throw new Error(`Committed recovery failed: Target directory '${target.consumer}' is not a regular directory`);
      }
      const verifyReport = await verifyArtifactManifest({
        rootDir: target.targetDir,
        consumer: target.consumer,
        profile: "Profile S",
      });
      if (verifyReport.status !== "valid") {
        throw new Error(`Committed recovery failed: Destination artifact for '${target.consumer}' is invalid: ${verifyReport.reason}`);
      }
      if (target.candidateManifestDigest && verifyReport.manifestDigest !== target.candidateManifestDigest) {
        throw new Error(`Committed recovery failed: Destination artifact manifestDigest mismatch for '${target.consumer}'`);
      }
    }

    // Now purge temporary backup/staging directories
    for (const target of derived.targets) {
      if (fs.existsSync(target.backupDir)) {
        await rm(target.backupDir, { recursive: true, force: true });
        if (fs.existsSync(target.backupDir)) {
          throw new Error(`Committed recovery failed: Backup directory still exists at ${target.backupDir}`);
        }
      }
      if (fs.existsSync(target.stagingDir)) {
        await rm(target.stagingDir, { recursive: true, force: true });
        if (fs.existsSync(target.stagingDir)) {
          throw new Error(`Committed recovery failed: Staging directory still exists at ${target.stagingDir}`);
        }
      }
    }
    if (fs.existsSync(derived.txStagingDir)) {
      await rm(derived.txStagingDir, { recursive: true, force: true });
      if (fs.existsSync(derived.txStagingDir)) {
        throw new Error(`Committed recovery failed: txStagingDir still exists at ${derived.txStagingDir}`);
      }
    }
    if (fs.existsSync(derived.txBackupDir)) {
      await rm(derived.txBackupDir, { recursive: true, force: true });
      if (fs.existsSync(derived.txBackupDir)) {
        throw new Error(`Committed recovery failed: txBackupDir still exists at ${derived.txBackupDir}`);
      }
    }

    await fsyncDir(pluginsDir);
    await fsyncDir(distDir);

    journal.phase = "cleanup_complete";
    journal.revision += 1;
    journal.updatedAt = new Date().toISOString();
    if (journal.publication) {
      journal.publication.backupsPurged = true;
    }
    const durRes = await writeAtomicCacheFile(journalFile, journal);
    if (durRes.outcome !== "committed-durable") {
      throw new Error(`Failed to durably mark cleanup_complete in journal: ${durRes.outcome}`);
    }
    await rm(journalFile, { force: true });
    await fsyncDir(distDir);
    return { recovered: true, clean: true, txId: journal.txId };
  }

  if (journal.phase === "cleanup_complete" || journal.phase === "rolled_back") {
    // Verify zero residues
    if (fs.existsSync(derived.txStagingDir)) await rm(derived.txStagingDir, { recursive: true, force: true });
    if (fs.existsSync(derived.txBackupDir)) await rm(derived.txBackupDir, { recursive: true, force: true });
    await rm(journalFile, { force: true });
    await fsyncDir(distDir);
    return { recovered: false, clean: true, reason: "No active deploy journal found" };
  }

  // Active uncommitted phase -> execute deterministic reverse unwinding
  logger.warn?.(`⚠️ Recovering uncommitted deployment (${journal.txId}, phase=${journal.phase})...`);

  // Check symlinks on pluginsDir / distDir / txBackupDir / txStagingDir
  const pStat = await lstat(pluginsDir);
  if (pStat.isSymbolicLink()) {
    throw new Error(`Cannot recover deployment: pluginsDir is a symbolic link (${pluginsDir})`);
  }
  const dStat = await lstat(distDir);
  if (dStat.isSymbolicLink()) {
    throw new Error(`Cannot recover deployment: distDir is a symbolic link (${distDir})`);
  }

  if (fs.existsSync(derived.txStagingDir)) {
    await verifyNoSymlinksInTree(derived.txStagingDir);
  }
  if (fs.existsSync(derived.txBackupDir)) {
    await verifyNoSymlinksInTree(derived.txBackupDir);
  }

  // Advance journal state to rolling_back
  journal.phase = "rolling_back";
  journal.revision += 1;
  journal.updatedAt = new Date().toISOString();
  const durRes = await writeAtomicCacheFile(journalFile, journal);
  if (durRes.outcome !== "committed-durable") {
    throw new Error(`Failed to durably update journal to rolling_back state: ${durRes.outcome}`);
  }

  try {
    // 1. Revert targets in reverse order
    for (const target of [...derived.targets].reverse()) {
      if (fs.existsSync(target.targetDir)) {
        const tStat = await lstat(target.targetDir);
        if (tStat.isSymbolicLink()) {
          throw new Error(`Target directory is a symbolic link: ${target.targetDir}`);
        }
      }
      if (fs.existsSync(target.backupDir)) {
        const bStat = await lstat(target.backupDir);
        if (bStat.isSymbolicLink()) {
          throw new Error(`Backup directory is a symbolic link: ${target.backupDir}`);
        }
      }
      if (fs.existsSync(target.stagingDir)) {
        const sStat = await lstat(target.stagingDir);
        if (sStat.isSymbolicLink()) {
          throw new Error(`Staging directory is a symbolic link: ${target.stagingDir}`);
        }
      }

      if (target.preExisting) {
        if (target.phase !== "prepared") {
          if (!fs.existsSync(target.backupDir)) {
            throw new Error(`Rollback failed: Pre-existing backup directory missing for '${target.consumer}' at ${target.backupDir}`);
          }
          const bStat = await lstat(target.backupDir);
          if (bStat.isSymbolicLink() || !bStat.isDirectory()) {
            throw new Error(`Rollback failed: Backup directory for '${target.consumer}' is not a regular directory`);
          }
          if (fs.existsSync(target.targetDir)) {
            await rm(target.targetDir, { recursive: true, force: true });
          }
          await rename(target.backupDir, target.targetDir);
        }
      } else {
        if (target.phase !== "prepared" && fs.existsSync(target.targetDir)) {
          await rm(target.targetDir, { recursive: true, force: true });
        }
      }

      if (fs.existsSync(target.stagingDir)) {
        await rm(target.stagingDir, { recursive: true, force: true });
        if (fs.existsSync(target.stagingDir)) {
          throw new Error(`Rollback failed: Staging directory still exists at ${target.stagingDir}`);
        }
      }
      if (fs.existsSync(target.backupDir)) {
        await rm(target.backupDir, { recursive: true, force: true });
        if (fs.existsSync(target.backupDir)) {
          throw new Error(`Rollback failed: Backup directory still exists at ${target.backupDir}`);
        }
      }
    }

    // 2. Revert publication receipts & cache accurately
    if (journal.publication) {
      const pubReceipts = journal.publication.receipts || {};
      const targetReceiptsDir = path.join(distDir, ".deploy-receipts");
      const backupReceiptsDir = path.join(derived.txBackupDir, ".deploy-receipts");

      for (const [p, rInfo] of Object.entries(pubReceipts)) {
        const destRcptFile = path.join(targetReceiptsDir, `${p}.receipt.json`);
        if (rInfo.existedBefore) {
          const bkpRcptFile = path.join(backupReceiptsDir, `${p}.receipt.json`);
          if (!fs.existsSync(bkpRcptFile)) {
            throw new Error(`Rollback failed: Backup receipt missing for ${p}`);
          }
          const bkpStat = await lstat(bkpRcptFile);
          if (bkpStat.isSymbolicLink() || !bkpStat.isFile()) {
            throw new Error(`Rollback failed: Backup receipt for ${p} is not a regular file`);
          }
          const bkpBytes = await readFile(bkpRcptFile);
          const bkpDigest = crypto.createHash("sha256").update(bkpBytes).digest("hex");
          if (rInfo.preDigest && bkpDigest !== rInfo.preDigest) {
            throw new Error(`Rollback failed: Backup receipt digest mismatch for ${p}`);
          }
          const wr = await writeAtomicCacheFile(destRcptFile, JSON.parse(bkpBytes.toString("utf8")));
          if (wr.outcome !== "committed-durable") {
            throw new Error(`Failed to durably restore receipt for ${p}`);
          }
          const val = await loadDeployReceiptRecord(destRcptFile, p);
          if (val.status !== "valid") {
            throw new Error(`Restored receipt for ${p} is invalid: ${val.reason}`);
          }
          rInfo.publishStatus = "restored";
          rInfo.finalDigest = bkpDigest;
        } else {
          if (fs.existsSync(destRcptFile)) {
            await rm(destRcptFile, { force: true });
          }
          rInfo.publishStatus = "deleted";
          rInfo.finalDigest = null;
        }
      }

      if (journal.publication.cache) {
        const cInfo = journal.publication.cache;
        const destCacheFile = path.join(distDir, ".build-cache.json");
        const bkpCacheFile = path.join(derived.txBackupDir, ".build-cache.json");

        if (cInfo.existedBefore) {
          if (!fs.existsSync(bkpCacheFile)) {
            throw new Error("Rollback failed: Backup cache file missing");
          }
          const bkpStat = await lstat(bkpCacheFile);
          if (bkpStat.isSymbolicLink() || !bkpStat.isFile()) {
            throw new Error("Rollback failed: Backup cache is not a regular file");
          }
          const bkpBytes = await readFile(bkpCacheFile);
          const bkpDigest = crypto.createHash("sha256").update(bkpBytes).digest("hex");
          if (cInfo.preDigest && bkpDigest !== cInfo.preDigest) {
            throw new Error("Rollback failed: Backup cache digest mismatch");
          }
          const wr = await writeAtomicCacheFile(destCacheFile, JSON.parse(bkpBytes.toString("utf8")));
          if (wr.outcome !== "committed-durable") {
            throw new Error("Failed to durably restore cache");
          }
          const val = await loadBuildCacheRecord(destCacheFile);
          if (val.status !== "valid") {
            throw new Error(`Restored cache is invalid: ${val.reason}`);
          }
          cInfo.publishStatus = "restored";
          cInfo.finalDigest = bkpDigest;
        } else {
          if (fs.existsSync(destCacheFile)) {
            await rm(destCacheFile, { force: true });
          }
          cInfo.publishStatus = "deleted";
          cInfo.finalDigest = null;
        }
      }
    }

    if (fs.existsSync(derived.txStagingDir)) {
      await rm(derived.txStagingDir, { recursive: true, force: true });
      if (fs.existsSync(derived.txStagingDir)) {
        throw new Error(`Rollback failed: txStagingDir still exists at ${derived.txStagingDir}`);
      }
    }
    if (fs.existsSync(derived.txBackupDir)) {
      await rm(derived.txBackupDir, { recursive: true, force: true });
      if (fs.existsSync(derived.txBackupDir)) {
        throw new Error(`Rollback failed: txBackupDir still exists at ${derived.txBackupDir}`);
      }
    }

    await fsyncDir(pluginsDir);
    await fsyncDir(distDir);

    journal.phase = "rolled_back";
    journal.revision += 1;
    journal.updatedAt = new Date().toISOString();
    const rbDur = await writeAtomicCacheFile(journalFile, journal);
    if (rbDur.outcome !== "committed-durable") {
      throw new Error(`Failed to durably write rolled_back state to journal: ${rbDur.outcome}`);
    }
    await rm(journalFile, { force: true });
    await fsyncDir(distDir);

    return { recovered: true, txId: journal.txId };
  } catch (err) {
    journal.phase = "rollback_failed";
    journal.revision += 1;
    journal.updatedAt = new Date().toISOString();
    journal.error = {
      message: err.message,
      stack: err.stack,
      failedPhase: "rolling_back",
      timestamp: new Date().toISOString(),
    };
    const failWriteRes = await writeAtomicCacheFile(journalFile, journal);
    if (failWriteRes.outcome !== "committed-durable") {
      throw new Error(`Failed to durably write rollback_failed state to journal: ${failWriteRes.outcome}`);
    }
    const wrapErr = new Error(`Rollback failed: ${err.message}`);
    wrapErr.outcome = "rollback-failed";
    throw wrapErr;
  }
}

export function computeTestDependencyFingerprint({
  testFile,
  testFileSha256,
  toolFiles = {},
  toolchainFingerprint = "",
}) {
  const spec = TEST_SPEC_MAP[testFile] || { tools: [] };
  const toolRecords = (spec.tools || []).map((t) => `${t}:${toolFiles[t] || "missing"}`).sort();
  const raw = [
    `file:${testFileSha256}`,
    `toolchain:${toolchainFingerprint}`,
    ...toolRecords,
  ].join("\n");
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

export function createTestEvidenceRecord({
  runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  transactionId = null,
  testFile,
  testFileSha256,
  testDependencyFingerprint,
  toolchainFingerprint,
  artifactBindings = [],
  mode = "affected",
  exitStatus = "passed",
  runDurationMs = 0,
  testDurationMs = null,
  executedAt = new Date().toISOString(),
}) {
  if (!testFile || typeof testFile !== "string") {
    throw new Error("createTestEvidenceRecord: testFile is required");
  }
  if (!testFileSha256 || !/^[a-f0-9]{64}$/.test(testFileSha256)) {
    throw new Error(`createTestEvidenceRecord: invalid testFileSha256 '${testFileSha256}'`);
  }
  if (!testDependencyFingerprint || !/^[a-f0-9]{64}$/.test(testDependencyFingerprint)) {
    throw new Error(`createTestEvidenceRecord: invalid testDependencyFingerprint '${testDependencyFingerprint}'`);
  }
  if (!toolchainFingerprint || !/^[a-f0-9]{64}$/.test(toolchainFingerprint)) {
    throw new Error(`createTestEvidenceRecord: invalid toolchainFingerprint '${toolchainFingerprint}'`);
  }
  if (exitStatus !== "passed") {
    throw new Error(`createTestEvidenceRecord: invalid exitStatus '${exitStatus}'`);
  }

  const spec = TEST_SPEC_MAP[testFile];
  const allowedArtifacts = spec ? new Set(spec.artifacts || []) : null;

  const normalizedBindings = (artifactBindings || []).map((b) => {
    if (!b.consumer || !b.artifactId || !b.zipSha256 || !/^[a-f0-9]{64}$/.test(b.zipSha256)) {
      throw new Error(`createTestEvidenceRecord: invalid artifactBinding: ${JSON.stringify(b)}`);
    }
    if (allowedArtifacts && !allowedArtifacts.has(b.consumer)) {
      throw new Error(`createTestEvidenceRecord: unexpected artifact binding '${b.consumer}' for test '${testFile}'`);
    }
    return {
      consumer: b.consumer,
      artifactId: b.artifactId,
      zipSha256: b.zipSha256,
      compositeFingerprint: b.compositeFingerprint || "",
    };
  }).sort((a, b) => (a.consumer < b.consumer ? -1 : a.consumer > b.consumer ? 1 : 0));

  const seenConsumers = new Set();
  for (const b of normalizedBindings) {
    if (seenConsumers.has(b.consumer)) {
      throw new Error(`createTestEvidenceRecord: duplicate artifact binding for '${b.consumer}' in test '${testFile}'`);
    }
    seenConsumers.add(b.consumer);
  }

  return {
    schemaVersion: TEST_EVIDENCE_SCHEMA_VERSION,
    runId,
    transactionId: transactionId || null,
    testFile,
    testFileSha256,
    testDependencyFingerprint,
    toolchainFingerprint,
    artifactBindings: normalizedBindings,
    mode,
    exitStatus,
    runDurationMs: typeof runDurationMs === "number" && runDurationMs >= 0 ? runDurationMs : 0,
    testDurationMs: typeof testDurationMs === "number" && testDurationMs >= 0 ? testDurationMs : null,
    executedAt,
  };
}

export function validateTestEvidenceRecord({
  evidence,
  expectedTestFile,
  expectedTestFileSha256 = null,
  expectedTestDependencyFingerprint = null,
  expectedToolchainFingerprint = null,
  expectedArtifactBindings = null,
  expectedConsumerBinding = null,
  expectedMode = null,
  expectedTransactionId = null,
  expectedRunId = null,
}) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return { valid: false, reason: "Evidence is missing or not an object" };
  }

  if (Object.prototype.hasOwnProperty.call(evidence, "__proto__") ||
      Object.prototype.hasOwnProperty.call(evidence, "constructor") ||
      Object.prototype.hasOwnProperty.call(evidence, "prototype")) {
    return { valid: false, reason: "Evidence contains forbidden prototype keys" };
  }

  if (expectedMode === "release") {
    if (evidence.schemaVersion !== TEST_EVIDENCE_SCHEMA_VERSION) {
      return { valid: false, reason: `Release mode strictly requires evidence schema ${TEST_EVIDENCE_SCHEMA_VERSION}, got ${evidence.schemaVersion}` };
    }
  } else {
    if (evidence.schemaVersion !== 2 && evidence.schemaVersion !== TEST_EVIDENCE_SCHEMA_VERSION) {
      return { valid: false, reason: `Evidence schema mismatch (expected ${TEST_EVIDENCE_SCHEMA_VERSION}, got ${evidence.schemaVersion})` };
    }
  }
  if (!evidence.runId || typeof evidence.runId !== "string" || !/^run-[0-9]+-[a-z0-9]+$/.test(evidence.runId) || evidence.runId.length > 64) {
    return { valid: false, reason: "Evidence missing valid runId" };
  }
  if (expectedRunId && evidence.runId !== expectedRunId) {
    return { valid: false, reason: `Evidence runId mismatch (expected ${expectedRunId}, got ${evidence.runId})` };
  }
  if (expectedTransactionId && evidence.transactionId !== expectedTransactionId) {
    return { valid: false, reason: `Evidence transactionId mismatch (expected ${expectedTransactionId}, got ${evidence.transactionId})` };
  }
  if (expectedMode && evidence.mode !== expectedMode) {
    return { valid: false, reason: `Evidence mode mismatch (expected ${expectedMode}, got ${evidence.mode})` };
  }
  if (typeof evidence.runDurationMs !== "number" || evidence.runDurationMs < 0 || !Number.isFinite(evidence.runDurationMs)) {
    return { valid: false, reason: "Evidence runDurationMs is invalid" };
  }
  if (!evidence.executedAt || typeof evidence.executedAt !== "string" || isNaN(Date.parse(evidence.executedAt))) {
    return { valid: false, reason: "Evidence executedAt is invalid" };
  }
  if (!new Set(["passed", "failed", "skipped"]).has(evidence.exitStatus)) {
    return { valid: false, reason: `Invalid exitStatus '${evidence.exitStatus}' in evidence` };
  }
  if (evidence.exitStatus !== "passed") {
    return { valid: false, reason: `Test exit status was '${evidence.exitStatus}', not passed` };
  }
  if (typeof evidence.testFile !== "string" || !evidence.testFile.endsWith(".test.mjs")) {
    return { valid: false, reason: "Evidence testFile is invalid" };
  }
  if (expectedTestFile && evidence.testFile !== expectedTestFile) {
    return { valid: false, reason: `Test file mismatch (expected ${expectedTestFile}, got ${evidence.testFile})` };
  }
  if (typeof evidence.testFileSha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidence.testFileSha256)) {
    return { valid: false, reason: "Evidence testFileSha256 must be a 64-char hex string" };
  }
  if (expectedTestFileSha256) {
    if (evidence.testFileSha256 !== expectedTestFileSha256) {
      return { valid: false, reason: "Test file content changed (SHA-256 mismatch)" };
    }
  }
  if (typeof evidence.testDependencyFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(evidence.testDependencyFingerprint)) {
    return { valid: false, reason: "Evidence testDependencyFingerprint must be a 64-char hex string" };
  }
  if (expectedTestDependencyFingerprint) {
    if (evidence.testDependencyFingerprint !== expectedTestDependencyFingerprint) {
      return { valid: false, reason: "Test dependency fingerprint changed" };
    }
  }
  if (typeof evidence.toolchainFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(evidence.toolchainFingerprint)) {
    return { valid: false, reason: "Evidence toolchainFingerprint must be a 64-char hex string" };
  }
  if (expectedToolchainFingerprint) {
    if (evidence.toolchainFingerprint !== expectedToolchainFingerprint) {
      return { valid: false, reason: "Toolchain fingerprint changed" };
    }
  }

  if (!Array.isArray(evidence.artifactBindings)) {
    return { valid: false, reason: "Field 'artifactBindings' must be an array" };
  }

  const spec = TEST_SPEC_MAP[evidence.testFile];
  const allowedArtifacts = spec ? new Set(spec.artifacts || []) : null;
  const actualList = evidence.artifactBindings;
  const seenConsumers = new Set();

  for (const b of actualList) {
    if (!isPlainObject(b)) {
      return { valid: false, reason: "Artifact binding must be a plain object" };
    }
    if (Object.prototype.hasOwnProperty.call(b, "__proto__") || Object.prototype.hasOwnProperty.call(b, "constructor")) {
      return { valid: false, reason: "Artifact binding contains forbidden prototype keys" };
    }
    if (!b.consumer || typeof b.consumer !== "string") {
      return { valid: false, reason: "Artifact binding missing consumer" };
    }
    if (!b.artifactId || typeof b.artifactId !== "string") {
      return { valid: false, reason: "Artifact binding missing artifactId" };
    }
    if (!b.zipSha256 || typeof b.zipSha256 !== "string" || !/^[a-f0-9]{64}$/.test(b.zipSha256)) {
      return { valid: false, reason: "Artifact binding zipSha256 must be a 64-char hex string" };
    }
    if (seenConsumers.has(b.consumer)) {
      return { valid: false, reason: `Duplicate artifact binding for consumer '${b.consumer}' in evidence` };
    }
    seenConsumers.add(b.consumer);

    if (allowedArtifacts && !allowedArtifacts.has(b.consumer)) {
      return { valid: false, reason: `Unexpected artifact binding '${b.consumer}' in evidence for '${evidence.testFile}'` };
    }
  }

  const actualMap = new Map(actualList.map((b) => [b.consumer, b]));

  if (expectedConsumerBinding) {
    const match = actualMap.get(expectedConsumerBinding.consumer);
    if (!match) {
      return { valid: false, reason: `Evidence missing artifact binding for consumer '${expectedConsumerBinding.consumer}'` };
    }
    if (expectedConsumerBinding.artifactId && match.artifactId !== expectedConsumerBinding.artifactId) {
      return { valid: false, reason: `ArtifactId mismatch for consumer '${expectedConsumerBinding.consumer}'` };
    }
    if (expectedConsumerBinding.zipSha256 && match.zipSha256 !== expectedConsumerBinding.zipSha256) {
      return { valid: false, reason: `Artifact ZIP SHA-256 mismatch for consumer '${expectedConsumerBinding.consumer}'` };
    }
    if (expectedConsumerBinding.compositeFingerprint && match.compositeFingerprint !== expectedConsumerBinding.compositeFingerprint) {
      return { valid: false, reason: `Composite fingerprint mismatch for consumer '${expectedConsumerBinding.consumer}'` };
    }
  }

  if (expectedArtifactBindings !== null) {
    const expectedList = Array.isArray(expectedArtifactBindings) ? expectedArtifactBindings : [];
    if (expectedList.length !== actualList.length) {
      return { valid: false, reason: `Artifact binding count mismatch (expected ${expectedList.length}, got ${actualList.length})` };
    }
    for (const exp of expectedList) {
      const match = actualMap.get(exp.consumer);
      if (!match) {
        return { valid: false, reason: `Evidence missing artifact binding for consumer '${exp.consumer}'` };
      }
      if (exp.artifactId && match.artifactId !== exp.artifactId) {
        return { valid: false, reason: `ArtifactId mismatch for consumer '${exp.consumer}'` };
      }
      if (exp.zipSha256 && match.zipSha256 !== exp.zipSha256) {
        return { valid: false, reason: `Artifact ZIP SHA-256 mismatch for consumer '${exp.consumer}'` };
      }
      if (exp.compositeFingerprint && match.compositeFingerprint !== exp.compositeFingerprint) {
        return { valid: false, reason: `Composite fingerprint mismatch for consumer '${exp.consumer}'` };
      }
    }
  }

  return { valid: true };
}


export function computeArtifactTestCoverage({
  consumer,
  testEvidenceMap = {},
  testFiles = {},
  toolFiles = {},
  toolchainFingerprint = "",
  artifactRecord = {},
  testMode = "affected",
  currentTransactionId = null,
  currentRunId = null,
}) {
  const required = REQUIRED_ARTIFACT_TESTS[consumer] || [];
  if (required.length === 0) {
    return { covered: false, coveredTests: [], missingTests: [], reason: "No required tests defined for consumer" };
  }

  const missingTests = [];
  const coveredTests = [];

  for (const testName of required) {
    const ev = testEvidenceMap[testName];
    if (!ev) {
      missingTests.push({ testName, reason: "No evidence found" });
      continue;
    }
    const testSha = testFiles[testName] || null;
    const depFingerprint = computeTestDependencyFingerprint({
      testFile: testName,
      testFileSha256: testSha || ev.testFileSha256,
      toolFiles,
      toolchainFingerprint,
    });

    const isBound = (TEST_SPEC_MAP[testName]?.artifacts || []).includes(consumer);
    const expectedConsumerBinding = isBound
      ? {
          consumer,
          artifactId: artifactRecord.artifactId || `${consumer}-profile-s`,
          zipSha256: artifactRecord.zipSha256,
          compositeFingerprint: artifactRecord.compositeFingerprint,
        }
      : null;

    const val = validateTestEvidenceRecord({
      evidence: ev,
      expectedTestFile: testName,
      expectedTestFileSha256: testSha,
      expectedTestDependencyFingerprint: depFingerprint,
      expectedToolchainFingerprint: toolchainFingerprint,
      expectedConsumerBinding,
      expectedMode: testMode === "release" ? "release" : null,
      expectedTransactionId: testMode === "release" ? currentTransactionId : null,
      expectedRunId: testMode === "release" ? currentRunId : null,
    });

    if (!val.valid) {
      missingTests.push({ testName, reason: val.reason });
    } else {
      coveredTests.push(testName);
    }
  }

  if (missingTests.length > 0) {
    return {
      covered: false,
      coveredTests,
      missingTests,
      reason: `Missing valid evidence for ${missingTests.length} tests: ${missingTests.map((t) => `${t.testName} (${t.reason})`).join(", ")}`,
    };
  }

  return { covered: true, coveredTests, missingTests: [], reason: `All ${required.length} required tests verified` };
}

function isPlainObject(obj) {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false;
  const proto = Object.getPrototypeOf(obj);
  return proto === Object.prototype || proto === null;
}

function hasForbiddenPrototypes(obj) {
  if (typeof obj !== "object" || obj === null) return false;
  if (Object.prototype.hasOwnProperty.call(obj, "__proto__") ||
      Object.prototype.hasOwnProperty.call(obj, "constructor") ||
      Object.prototype.hasOwnProperty.call(obj, "prototype")) {
    return true;
  }
  for (const v of Object.values(obj)) {
    if (typeof v === "object" && v !== null) {
      if (hasForbiddenPrototypes(v)) return true;
    }
  }
  return false;
}

export function validateBuildCacheSchema(data, options = {}) {
  if (!isPlainObject(data)) {
    return { valid: false, reason: "Cache payload must be a plain object" };
  }

  if (hasForbiddenPrototypes(data)) {
    return { valid: false, reason: "Cache payload contains forbidden prototype keys" };
  }

  if (data.schemaVersion !== CACHE_SCHEMA_VERSION) {
    return { valid: false, reason: `Cache schema mismatch (expected ${CACHE_SCHEMA_VERSION}, got ${data.schemaVersion})`, isStale: true };
  }

  const requiredTopLevel = ["_tools", "_toolFiles", "_wpdev", "_theme", "_testFiles", "_testEvidence", "toolchain", "artifacts"];
  for (const field of requiredTopLevel) {
    if (!(field in data)) {
      return { valid: false, reason: `Cache payload missing required top-level field '${field}'` };
    }
  }

  if (typeof data.toolchain !== "string" || !/^[a-f0-9]{64}$/.test(data.toolchain)) {
    return { valid: false, reason: "Field 'toolchain' must be a 64-char hex SHA-256 digest" };
  }
  if (typeof data._tools !== "string" || !/^[a-f0-9]{64}$/.test(data._tools)) {
    return { valid: false, reason: "Field '_tools' must be a 64-char hex SHA-256 digest" };
  }
  if (typeof data._wpdev !== "string" || !/^[a-f0-9]{64}$/.test(data._wpdev)) {
    return { valid: false, reason: "Field '_wpdev' must be a 64-char hex SHA-256 digest" };
  }
  if (typeof data._theme !== "string" || !/^[a-f0-9]{64}$/.test(data._theme)) {
    return { valid: false, reason: "Field '_theme' must be a 64-char hex SHA-256 digest" };
  }

  if (!isPlainObject(data._toolFiles) || Object.keys(data._toolFiles).length > 500) {
    return { valid: false, reason: "Field '_toolFiles' must be a plain object with valid bounds" };
  }
  for (const [k, v] of Object.entries(data._toolFiles)) {
    if (typeof k !== "string" || !k.startsWith("tools/") || typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) {
      return { valid: false, reason: `Invalid entry in _toolFiles: '${k}'` };
    }
  }

  if (!isPlainObject(data._testFiles) || Object.keys(data._testFiles).length > 500) {
    return { valid: false, reason: "Field '_testFiles' must be a plain object with valid bounds" };
  }
  for (const [k, v] of Object.entries(data._testFiles)) {
    if (typeof k !== "string" || !k.endsWith(".test.mjs") || typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) {
      return { valid: false, reason: `Invalid entry in _testFiles: '${k}'` };
    }
  }

  if (!isPlainObject(data._testEvidence) || Object.keys(data._testEvidence).length > 500) {
    return { valid: false, reason: "Field '_testEvidence' must be a plain object with valid bounds" };
  }
  for (const [k, ev] of Object.entries(data._testEvidence)) {
    const val = validateTestEvidenceRecord({ evidence: ev, expectedTestFile: k });
    if (!val.valid) {
      return { valid: false, reason: `Invalid evidence for test '${k}': ${val.reason}` };
    }
  }

  if (!isPlainObject(data.artifacts)) {
    return { valid: false, reason: "Field 'artifacts' must be a plain object" };
  }

  const { expectedConsumers = null, expectedDistDir = null } = options;
  const expectedSet = expectedConsumers ? (expectedConsumers instanceof Set ? expectedConsumers : new Set(expectedConsumers)) : null;
  const validGates = new Set(["passed", "none", "pending", "failed", "deployed", "skipped", "verified-skip", "not-requested", "partial"]);
  const ALLOWED_GATE_NAMES = new Set(["artifactIntegrity", "testCoverage", "runtimeSmoke", "deployment"]);
  const validValidationStates = new Set(["built", "artifact-verified", "tests-passed", "deployed", "runtime-verified"]);

  for (const [consumer, record] of Object.entries(data.artifacts)) {
    if (!isPlainObject(record)) {
      return { valid: false, reason: `Artifact record for '${consumer}' must be a plain object` };
    }
    if (expectedSet && !expectedSet.has(consumer)) {
      return { valid: false, reason: `Unexpected artifact consumer '${consumer}' in cache schema` };
    }
    if (!ALLOWED_CONSUMERS.has(consumer)) {
      return { valid: false, reason: `Disallowed artifact consumer '${consumer}' in cache schema` };
    }
    if (record.consumer !== consumer) {
      return { valid: false, reason: `Artifact key '${consumer}' does not match record.consumer '${record.consumer}'` };
    }
    if (record.artifactId !== `${consumer}-profile-s`) {
      return { valid: false, reason: `ArtifactId '${record.artifactId}' is invalid for '${consumer}'` };
    }
    if (typeof record.zipSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.zipSha256)) {
      return { valid: false, reason: `Artifact record for '${consumer}' has invalid zipSha256` };
    }
    if (typeof record.manifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.manifestDigest)) {
      return { valid: false, reason: `Artifact record for '${consumer}' has invalid manifestDigest` };
    }
    if (typeof record.compositeFingerprint !== "string" || !/^(?:[a-f0-9]{64})(?::[a-f0-9]{64}){0,4}(?::profile:[a-z0-9_-]+)?(?::plan:[a-f0-9]{64})?(?::opts:[a-f0-9]{1,32})?$/i.test(record.compositeFingerprint)) {
      return { valid: false, reason: `Artifact record for '${consumer}' has invalid compositeFingerprint` };
    }

    // Check top-level legacy consumer composite match
    if (data[consumer] && data[consumer] !== record.compositeFingerprint) {
      return { valid: false, reason: `Top-level consumer fingerprint '${data[consumer]}' mismatch for '${consumer}'` };
    }

    if (!validValidationStates.has(record.validationState)) {
      return { valid: false, reason: `Artifact record for '${consumer}' has invalid validationState '${record.validationState}'` };
    }
    if (!isPlainObject(record.gates)) {
      return { valid: false, reason: `Artifact record for '${consumer}' missing gates object` };
    }
    for (const [gateName, gate] of Object.entries(record.gates)) {
      if (!ALLOWED_GATE_NAMES.has(gateName)) {
        return { valid: false, reason: `Unknown gate '${gateName}' in artifact '${consumer}'` };
      }
      if (!isPlainObject(gate) || !validGates.has(gate.status)) {
        return { valid: false, reason: `Invalid gate status for '${gateName}' in artifact '${consumer}'` };
      }
    }
    if (record.outputPaths && typeof record.outputPaths === "object") {
      for (const [pKey, pVal] of Object.entries(record.outputPaths)) {
        if (typeof pVal !== "string" || pVal.includes("..")) {
          return { valid: false, reason: `Invalid outputPath '${pKey}'='${pVal}' for '${consumer}'` };
        }
        if (expectedDistDir) {
          const canonDist = canonicalizePath(expectedDistDir);
          const canonOut = canonicalizePath(pVal);
          if (!canonOut.startsWith(canonDist + path.sep)) {
            return { valid: false, reason: `OutputPath '${pVal}' for '${consumer}' is not contained within distDir '${expectedDistDir}'` };
          }
        } else if (!pVal.includes("/dist/") && !pVal.startsWith("dist/")) {
          return { valid: false, reason: `Invalid outputPath '${pKey}'='${pVal}' for '${consumer}'` };
        }
      }
    }
  }

  return { valid: true };
}

export async function loadBuildCacheRecord(cacheFilePath, options = {}) {
  if (!fs.existsSync(cacheFilePath)) {
    return { status: "missing", cache: {} };
  }

  let handle;
  try {
    const lst = await lstat(cacheFilePath);
    if (lst.isSymbolicLink()) {
      return { status: "invalid", reason: "Cache file cannot be a symbolic link", cache: {} };
    }
    if (!lst.isFile()) {
      return { status: "invalid", reason: "Cache path is not a regular file", cache: {} };
    }

    handle = await fs.promises.open(cacheFilePath, "r");
    const raw = await handle.readFile("utf8");
    await handle.close();
    handle = null;

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { status: "corrupted", reason: "Cache file contains invalid JSON", cache: {} };
    }

    const val = validateBuildCacheSchema(data, options);
    if (!val.valid) {
      if (val.isStale) {
        return { status: "stale_schema", reason: val.reason, cache: {} };
      }
      return { status: "invalid", reason: val.reason, cache: {} };
    }

    return { status: "valid", cache: data };
  } catch (err) {
    if (handle) {
      try { await handle.close(); } catch {}
    }
    return { status: "error", reason: err.message, cache: {} };
  }
}

export async function loadDeployReceiptRecord(receiptPath, expectedConsumer = null, options = {}) {
  if (!fs.existsSync(receiptPath)) {
    return { status: "missing", reason: "Receipt file does not exist", receipt: null };
  }

  let handle;
  try {
    const lst = await lstat(receiptPath);
    if (lst.isSymbolicLink()) {
      return { status: "invalid", reason: "Deploy receipt cannot be a symbolic link", receipt: null };
    }
    if (!lst.isFile()) {
      return { status: "invalid", reason: "Deploy receipt path is not a regular file", receipt: null };
    }

    handle = await fs.promises.open(receiptPath, "r");
    const raw = await handle.readFile("utf8");
    await handle.close();
    handle = null;

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { status: "corrupted", reason: "Deploy receipt contains invalid JSON", receipt: null };
    }

    const val = validateDeployReceiptRecord({
      receipt: data,
      consumer: expectedConsumer || data.consumer,
      ...options,
    });
    if (!val.valid) {
      return { status: "invalid", reason: val.reason, receipt: null };
    }

    return { status: "valid", receipt: data };
  } catch (err) {
    if (handle) {
      try { await handle.close(); } catch {}
    }
    return { status: "error", reason: err.message, receipt: null };
  }
}

export async function writeAtomicCacheFile(cacheFilePath, data, options = {}) {
  const { injectFailure = null } = options;
  const dir = path.dirname(cacheFilePath);
  await mkdir(dir, { recursive: true });

  if (fs.existsSync(cacheFilePath)) {
    const existingStat = await lstat(cacheFilePath);
    if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
      throw new Error("Target cache file cannot be overwritten because it is a symbolic link or non-regular file");
    }
  }

  const tmpPath = `${cacheFilePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (injectFailure === "before_write") {
    throw new Error("Injected failure before write");
  }

  let handle;
  let dirHandle;
  let renamed = false;
  try {
    handle = await fs.promises.open(tmpPath, "w", 0o644);
    if (injectFailure === "during_write") {
      await handle.writeFile("CORRUPT_DATA", "utf8");
      throw new Error("Injected failure during write");
    }
    await handle.writeFile(JSON.stringify(data, null, 2) + "\n", "utf8");

    if (injectFailure === "before_sync") {
      throw new Error("Injected failure before sync");
    }
    await handle.sync();
    await handle.close();
    handle = null;

    if (injectFailure === "before_rename") {
      throw new Error("Injected failure before rename");
    }
    await rename(tmpPath, cacheFilePath);
    renamed = true;

    if (injectFailure === "during_dir_sync") {
      throw new Error("Injected failure during dir sync");
    }
    try {
      dirHandle = await fs.promises.open(dir, "r");
      await dirHandle.sync();
    } catch (dErr) {
      return { outcome: "committed-durability-uncertain", error: dErr.message };
    }

    return { outcome: "committed-durable" };
  } catch (err) {
    if (renamed) {
      return { outcome: "committed-durability-uncertain", error: err.message };
    }
    if (handle) {
      try { await handle.close(); } catch {}
    }
    try {
      if (fs.existsSync(tmpPath)) {
        await rm(tmpPath, { force: true });
      }
    } catch {}
    throw err;
  } finally {
    if (handle) {
      try { await handle.close(); } catch {}
    }
    if (dirHandle) {
      try { await dirHandle.close(); } catch {}
    }
  }
}

export function createTargetCacheRecord({
  artifactId,
  consumer,
  sourceFingerprint,
  wpdevFingerprint,
  toolsFingerprint,
  themeFingerprint,
  toolchainFingerprint,
  compositeFingerprint,
  planFingerprint = null,
  zipSha256,
  manifestDigest,
  gates = {},
  validationState = "built",
  testMode = null,
  testEvidence = null,
  outputPaths = {},
}) {
  const artifactIntegrity = gates.artifactIntegrity || {
    status: zipSha256 && manifestDigest ? "passed" : "pending",
    verifiedAt: new Date().toISOString(),
  };

  const testCoverage = gates.testCoverage || {
    status: validationState === "tests-passed" || validationState === "runtime-verified" ? "passed" : "none",
    coveredTests: [],
    missingTests: [],
    coverageReason: "",
  };

  const deployment = gates.deployment || {
    status: validationState === "deployed" || validationState === "runtime-verified" ? "deployed" : "none",
    deployedAt: null,
  };

  const runtimeSmoke = gates.runtimeSmoke || {
    status: validationState === "runtime-verified" ? "passed" : "none",
    verifiedAt: null,
  };

  let resolvedValidationState = validationState;
  if (testCoverage.status === "passed") {
    if (runtimeSmoke.status === "passed") {
      resolvedValidationState = "runtime-verified";
    } else if (deployment.status === "deployed" || deployment.status === "skipped") {
      resolvedValidationState = "deployed";
    } else {
      resolvedValidationState = "tests-passed";
    }
  } else if (deployment.status === "deployed" || deployment.status === "skipped") {
    resolvedValidationState = "deployed";
  } else if (artifactIntegrity.status === "passed") {
    resolvedValidationState = validationState !== "built" ? validationState : "artifact-verified";
  }

  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    artifactId: artifactId || `${consumer}-profile-s`,
    consumer,
    sourceFingerprint: sourceFingerprint || "",
    wpdevFingerprint: wpdevFingerprint || "",
    toolsFingerprint: toolsFingerprint || "",
    themeFingerprint: themeFingerprint || "",
    toolchainFingerprint: toolchainFingerprint || "",
    compositeFingerprint: compositeFingerprint || "",
    planFingerprint: planFingerprint || null,
    zipSha256: zipSha256 || "",
    manifestDigest: manifestDigest || "",
    validationState: resolvedValidationState,
    gates: {
      artifactIntegrity,
      testCoverage,
      deployment,
      runtimeSmoke,
    },
    testMode,
    testEvidence,
    outputPaths,
    updatedAt: new Date().toISOString(),
  };
}

export function createDeployReceiptRecord({
  transactionId = null,
  artifactId = null,
  consumer,
  targetPath,
  zipSha256,
  manifestDigest,
  sourceFingerprint,
  wpdevFingerprint,
  toolsFingerprint,
  themeFingerprint,
  toolchainFingerprint,
  compositeFingerprint,
  validationState = "deployed",
  deployedAt = new Date().toISOString(),
}) {
  if (!consumer || !zipSha256 || !manifestDigest) {
    throw new Error("createDeployReceiptRecord: missing required fields");
  }
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    transactionId: transactionId || null,
    artifactId: artifactId || `${consumer}-profile-s`,
    consumer,
    plugin: consumer,
    targetPath,
    zipSha256,
    manifestDigest,
    sourceFingerprint: sourceFingerprint || "",
    wpdevFingerprint: wpdevFingerprint || "",
    toolsFingerprint: toolsFingerprint || "",
    themeFingerprint: themeFingerprint || "",
    toolchainFingerprint: toolchainFingerprint || "",
    compositeFingerprint: compositeFingerprint || "",
    validationState,
    deployedAt,
  };
}

export function validateDeployReceiptRecord({
  receipt,
  consumer,
  artifactId = null,
  zipSha256 = null,
  manifestDigest = null,
  compositeFingerprint = null,
  targetPath = null,
  transactionId = null,
  expectedPluginsDir = null,
}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { valid: false, reason: "Deploy receipt is missing or is not an object" };
  }
  if (hasForbiddenPrototypes(receipt)) {
    return { valid: false, reason: "Deploy receipt contains forbidden prototype keys" };
  }
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    return { valid: false, reason: `Deploy receipt schema mismatch (expected ${RECEIPT_SCHEMA_VERSION})` };
  }
  if (receipt.consumer !== consumer || (receipt.plugin && receipt.plugin !== consumer)) {
    return { valid: false, reason: `Deploy receipt consumer mismatch for ${consumer}` };
  }
  if (expectedPluginsDir && (!ALLOWED_CONSUMERS.has(receipt.consumer) && !isValidConsumerName(receipt.consumer))) {
    return { valid: false, reason: `Disallowed consumer '${receipt.consumer}' in deploy receipt` };
  }
  if (receipt.artifactId !== (artifactId || `${consumer}-profile-s`)) {
    return { valid: false, reason: `Deploy receipt artifactId mismatch for ${consumer}` };
  }
  if (transactionId && receipt.transactionId !== transactionId) {
    return { valid: false, reason: `Deploy receipt transactionId mismatch (expected ${transactionId}, got ${receipt.transactionId})` };
  }
  if (typeof receipt.targetPath !== "string" || receipt.targetPath.includes("..")) {
    return { valid: false, reason: "Deploy receipt targetPath is invalid or contains traversal" };
  }
  if (targetPath && path.resolve(receipt.targetPath) !== path.resolve(targetPath)) {
    return { valid: false, reason: `Deploy receipt targetPath mismatch (expected ${targetPath}, got ${receipt.targetPath})` };
  }
  if (expectedPluginsDir) {
    const expectedTarget = path.resolve(path.join(expectedPluginsDir, consumer));
    if (path.resolve(receipt.targetPath) !== expectedTarget) {
      return { valid: false, reason: `Deploy receipt targetPath does not match expected plugin directory '${expectedTarget}'` };
    }
  }

  for (const field of ["zipSha256", "manifestDigest"]) {
    if (typeof receipt[field] !== "string" || !/^[a-f0-9]{64}$/.test(receipt[field])) {
      return { valid: false, reason: `Deploy receipt ${field} is not a SHA-256 digest` };
    }
  }
  if (zipSha256 && receipt.zipSha256 !== zipSha256) {
    return { valid: false, reason: `Deploy receipt ZIP digest mismatch for ${consumer}` };
  }
  if (manifestDigest && receipt.manifestDigest !== manifestDigest) {
    return { valid: false, reason: `Deploy receipt manifest digest mismatch for ${consumer}` };
  }
  if (compositeFingerprint && receipt.compositeFingerprint !== compositeFingerprint) {
    return { valid: false, reason: `Deploy receipt input fingerprint mismatch for ${consumer}` };
  }
  if (!new Set(["deployed", "runtime-verified"]).has(receipt.validationState)) {
    return { valid: false, reason: `Deploy receipt has invalid validationState '${receipt.validationState}'` };
  }
  return { valid: true, receipt };
}

export async function validateCachedTargetArtifact({
  cacheRecord,
  zipPath,
  consumer,
  expectedCompositeFingerprint,
  expectedProfile = null,
  expectedPlanFingerprint = null,
}) {
  if (!cacheRecord || typeof cacheRecord !== "object") {
    return { valid: false, reason: "Cache record is missing or invalid object" };
  }

  if (cacheRecord.schemaVersion !== CACHE_SCHEMA_VERSION) {
    return { valid: false, reason: `Cache schema mismatch (expected ${CACHE_SCHEMA_VERSION}, got ${cacheRecord.schemaVersion})` };
  }

  if (cacheRecord.consumer !== consumer) {
    return { valid: false, reason: `Consumer mismatch (expected ${consumer}, got ${cacheRecord.consumer})` };
  }

  if (cacheRecord.compositeFingerprint !== expectedCompositeFingerprint) {
    return { valid: false, reason: "Composite source/toolchain fingerprint changed" };
  }

  if (expectedPlanFingerprint && cacheRecord.planFingerprint && cacheRecord.planFingerprint !== expectedPlanFingerprint) {
    return { valid: false, reason: `Plan fingerprint mismatch: expected ${expectedPlanFingerprint}, cache has ${cacheRecord.planFingerprint}` };
  }

  if (expectedProfile) {
    const normReq = (String(expectedProfile).toLowerCase().trim() === "s" || String(expectedProfile).toLowerCase().trim() === "profile s") ? "profile s" : String(expectedProfile).toLowerCase().trim();
    const recRaw = String(cacheRecord.profile || cacheRecord.resolvedProfile || "").toLowerCase().trim();
    const recProf = (recRaw === "s" || recRaw === "profile s") ? "profile s" : recRaw;
    // NOTE: a missing profile field alone is not a miss when the composite
    // fingerprint (which now always binds the canonical tier) already matched.
    // Truly legacy caches miss via the composite comparison above, since the
    // old format omitted the profile segment entirely.
    if (recProf && recProf !== normReq) {
      return { valid: false, reason: `Profile mismatch: requested ${normReq}, cache record has ${recProf}` };
    }
  }

  if (!cacheRecord.zipSha256 || !fs.existsSync(zipPath)) {
    return { valid: false, reason: `ZIP artifact does not exist at ${zipPath}` };
  }
  if (typeof cacheRecord.manifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(cacheRecord.manifestDigest)) {
    return { valid: false, reason: "Cache record manifestDigest is missing or invalid" };
  }

  const st = await lstat(zipPath);
  if (st.isSymbolicLink() || !st.isFile()) {
    return { valid: false, reason: "ZIP artifact is not a regular file" };
  }

  const zipBytes = await readFile(zipPath);
  const actualSha256 = crypto.createHash("sha256").update(zipBytes).digest("hex");
  if (actualSha256 !== cacheRecord.zipSha256) {
    return { valid: false, reason: `Physical ZIP SHA-256 (${actualSha256.slice(0, 8)}) does not match cache record (${cacheRecord.zipSha256.slice(0, 8)})` };
  }

  // Deep validation of embedded manifest
  const embedded = readEmbeddedManifestFromZip(zipBytes, consumer);
  if (!embedded.valid) {
    return { valid: false, reason: embedded.reason };
  }

  if (expectedProfile) {
    const normReq = (String(expectedProfile).toLowerCase().trim() === "s" || String(expectedProfile).toLowerCase().trim() === "profile s") ? "profile s" : String(expectedProfile).toLowerCase().trim();
    const embRaw = String(embedded.manifest?.profile || embedded.manifest?.resolvedProfile || "").toLowerCase().trim();
    const embProf = (embRaw === "s" || embRaw === "profile s") ? "profile s" : embRaw;
    if (embProf && embProf !== normReq) {
      return { valid: false, reason: `Profile mismatch: requested ${normReq}, embedded manifest has ${embProf}` };
    }
  }

  if (expectedPlanFingerprint) {
    const embPlan = embedded.manifest?.planFingerprint || embedded.manifest?.buildPlan?.artifactIdentity?.fingerprint;
    if (embPlan && embPlan !== expectedPlanFingerprint) {
      return { valid: false, reason: `Embedded manifest plan fingerprint mismatch: requested ${expectedPlanFingerprint}, embedded manifest has ${embPlan}` };
    }
  }

  if (cacheRecord.manifestDigest && cacheRecord.manifestDigest !== embedded.manifestDigest) {
    return { valid: false, reason: `Cache record manifestDigest (${cacheRecord.manifestDigest.slice(0, 8)}) does not match embedded manifest (${embedded.manifestDigest.slice(0, 8)})` };
  }

  if (cacheRecord.artifactId && cacheRecord.artifactId !== embedded.artifactId) {
    return { valid: false, reason: `Cache record artifactId (${cacheRecord.artifactId}) does not match embedded manifest (${embedded.artifactId})` };
  }

  return { valid: true, cacheRecord, manifest: embedded.manifest, manifestDigest: embedded.manifestDigest };
}

export async function canReuseCachedZip({ zipPath, expectedSha256 }) {
  if (!expectedSha256 || typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    return false;
  }
  try {
    const st = await lstat(zipPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      return false;
    }
    const bytes = await readFile(zipPath);
    const actual = crypto.createHash("sha256").update(bytes).digest("hex");
    return actual === expectedSha256;
  } catch {
    return false;
  }
}

export async function computeToolchainFingerprint(signal = null) {
  const parts = [
    `node:${process.version}`,
    `platform:${process.platform}`,
    `arch:${process.arch}`,
  ];
  const execOpts = signal ? { signal } : {};
  const probes = [
    ["php", ["-r", "echo PHP_VERSION;"], "php"],
    ["zip", ["-v"], "zip"],
    ["unzip", ["-v"], "unzip"],
    ["rsync", ["--version"], "rsync"],
    ["composer", ["--version"], "composer"],
  ];
  for (const [cmd, args, key] of probes) {
    try {
      const { stdout } = await execFileAsync(cmd, args, execOpts);
      const line = String(stdout || "").split("\n")[0].trim();
      parts.push(`${key}:${line}`);
    } catch (err) {
      if (signal?.aborted || err.name === "AbortError") {
        throw err;
      }
      parts.push(`${key}:unavailable`);
    }
  }

  const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const rectorBin = path.join(kitRoot, "vendor/bin/rector");
  if (fs.existsSync(rectorBin)) {
    try {
      const { stdout } = await execFileAsync("php", [rectorBin, "--version"], execOpts);
      parts.push(`rector:${String(stdout || "").trim()}`);
    } catch (err) {
      if (signal?.aborted || err.name === "AbortError") {
        throw err;
      }
      parts.push("rector:unreadable");
    }
  } else {
    parts.push("rector:unavailable");
  }

  return crypto.createHash("sha256").update(parts.sort().join("\n"), "utf8").digest("hex");
}

export async function computeTreeContentHash(
  dir,
  baseDir = dir,
  isRoot = true,
  ioLimit = fileLimit,
  signal = null,
  options = {}
) {
  const { fsOps = { readdir, lstat, readFile }, stats = null } = options;

  if (signal?.aborted) throw new Error("Fingerprint traversal aborted");
  if (!fs.existsSync(dir)) return "missing";

  if (stats) {
    stats.opsStarted = (stats.opsStarted || 0) + 1;
    stats.opsActive = (stats.opsActive || 0) + 1;
  }
  let st;
  try {
    st = await fsOps.lstat(dir);
  } finally {
    if (stats) {
      stats.opsActive--;
      stats.opsCompleted = (stats.opsCompleted || 0) + 1;
    }
  }

  if (st.isSymbolicLink()) {
    throw new Error(`Symbolic link directory detected: ${dir}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`Path is not a directory: ${dir}`);
  }

  const fileResults = [];
  const dirQueue = [{ dir, isRoot }];
  const filesToHash = [];

  while (dirQueue.length > 0) {
    if (signal?.aborted) throw new Error("Fingerprint traversal aborted");
    const current = dirQueue.shift();

    if (stats) {
      if (signal?.aborted) stats.opsStartedAfterAbort = (stats.opsStartedAfterAbort || 0) + 1;
      stats.opsStarted = (stats.opsStarted || 0) + 1;
      stats.opsActive = (stats.opsActive || 0) + 1;
    }

    let entries;
    try {
      entries = await fsOps.readdir(current.dir, { withFileTypes: true });
    } finally {
      if (stats) {
        stats.opsActive--;
        stats.opsCompleted = (stats.opsCompleted || 0) + 1;
      }
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (signal?.aborted) throw new Error("Fingerprint traversal aborted");
      const fullPath = path.join(current.dir, entry.name);
      const relPath = path.relative(baseDir, fullPath).split(path.sep).join("/");

      if (entry.name.startsWith(".") && entry.name !== ".htaccess") continue;
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "build" ||
        entry.name === "coverage" ||
        entry.name === "artifacts"
      ) continue;

      if (current.isRoot) {
        if (
          entry.name === "tests" ||
          entry.name === "tests-docker" ||
          entry.name === "unit-tests" ||
          entry.name === "dev" ||
          entry.name === "docs" ||
          entry.name === "docker-phpunit"
        ) continue;
      }

      if (entry.isSymbolicLink()) {
        if (relPath.startsWith("vendor/bin/") || relPath.endsWith("/bin") || relPath.includes("vendor/")) continue;
        throw new Error(`Symbolic links are forbidden in source tree: ${relPath}`);
      }

      if (entry.isDirectory()) {
        dirQueue.push({ dir: fullPath, isRoot: false });
      } else if (entry.isFile()) {
        filesToHash.push({ fullPath, relPath });
      }
    }
  }

  // Hash all collected files using a bounded concurrency worker pool
  const concurrency = Math.max(1, Math.min(Number(ioLimit?.concurrency) || 16, 32));
  let fileIndex = 0;
  async function worker() {
    while (fileIndex < filesToHash.length) {
      if (signal?.aborted) throw new Error("Fingerprint traversal aborted");
      const idx = fileIndex++;
      if (idx >= filesToHash.length) break;
      const item = filesToHash[idx];
      const res = await ioLimit(async () => {
        if (signal?.aborted) throw new Error("Fingerprint traversal aborted");
        if (stats) {
          if (signal?.aborted) stats.opsStartedAfterAbort = (stats.opsStartedAfterAbort || 0) + 1;
          stats.opsStarted = (stats.opsStarted || 0) + 1;
          stats.opsActive = (stats.opsActive || 0) + 1;
        }
        try {
          const content = await fsOps.readFile(item.fullPath);
          const sha256 = crypto.createHash("sha256").update(content).digest("hex");
          return { path: item.relPath, hash: sha256 };
        } finally {
          if (stats) {
            stats.opsActive--;
            stats.opsCompleted = (stats.opsCompleted || 0) + 1;
          }
        }
      });
      if (res) fileResults.push(res);
    }
  }

  const workerCount = Math.min(concurrency, filesToHash.length || 1);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  if (fileResults.length === 0) return "empty";
  fileResults.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const combined = fileResults.map((r) => `${r.path}:${r.hash}`).join("\n");
  return crypto.createHash("sha256").update(combined, "utf8").digest("hex");
}

async function collectToolFiles(scriptDir, contentRoot, signal = null) {
  const files = [];
  async function walk(dir, isRoot = true) {
    if (signal?.aborted) throw new Error("Fingerprint traversal aborted");
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (signal?.aborted) throw new Error("Fingerprint traversal aborted");
      if (entry.name.startsWith(".")) continue;
      if (isRoot && (entry.name === "tests" || entry.name === "tests-docker")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are forbidden in tools tree: ${fullPath}`);
      }
      if (entry.isDirectory()) {
        await walk(fullPath, false);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".mjs") || entry.name.endsWith(".php") || entry.name.endsWith(".json"))
      ) {
        files.push(fullPath);
      }
    }
  }
  await walk(scriptDir);
  const kitRoot = path.resolve(scriptDir, "../..");
  const candidateRoots = [
    contentRoot,
    scriptDir,
    kitRoot,
  ];
  for (const cRoot of new Set(candidateRoots)) {
    for (const extra of ["package.json", "package-lock.json", "composer.json", "composer.lock"]) {
      const extraPath = path.join(cRoot, extra);
      if (fs.existsSync(extraPath) && !files.includes(extraPath)) {
        files.push(extraPath);
      }
    }
  }
  return files;
}

export async function computeTestFileHashes(testsDir, ioLimit = fileLimit, signal = null) {
  const hashes = {};
  if (!fs.existsSync(testsDir)) return hashes;
  const names = (await readdir(testsDir)).filter((name) => name.endsWith(".test.mjs")).sort();
  await Promise.all(
    names.map((name) =>
      ioLimit(async () => {
        if (signal?.aborted) throw new Error("Fingerprint traversal aborted");
        const content = await readFile(path.join(testsDir, name));
        hashes[name] = crypto.createHash("sha256").update(content).digest("hex");
      })
    )
  );
  return hashes;
}

export async function computeToolsFingerprint(scriptDir, ioLimit = fileLimit, signal = null) {
  const contentRoot = path.resolve(path.join(scriptDir, ".."));
  const toolFiles = await collectToolFiles(scriptDir, contentRoot, signal);
  const toolFileMap = {};
  const isToolsName = path.basename(scriptDir) === "tools";
  const kitRoot = path.resolve(scriptDir, "../..");
  const tasks = toolFiles.map((p) =>
    ioLimit(async () => {
      if (signal?.aborted) throw new Error("Fingerprint traversal aborted");
      const st = await lstat(p);
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new Error(`Tool input must be a regular file: ${p}`);
      }
      const content = await readFile(p);
      const sha256 = crypto.createHash("sha256").update(content).digest("hex");
      let rel;
      if (p.startsWith(scriptDir)) {
        if (isToolsName) {
          rel = path.relative(contentRoot, p).split(path.sep).join("/");
        } else {
          rel = "tools/" + path.relative(scriptDir, p).split(path.sep).join("/");
        }
      } else if (p.startsWith(kitRoot)) {
        rel = "tools/kit/" + path.relative(kitRoot, p).split(path.sep).join("/");
      } else if (p.startsWith(contentRoot)) {
        rel = "tools/content/" + path.relative(contentRoot, p).split(path.sep).join("/");
      } else {
        rel = "tools/" + path.basename(p);
      }
      rel = rel.split(path.sep).join("/");
      if (!rel.startsWith("tools/")) {
        rel = "tools/" + rel.replace(/^\.+[\/\\]*/, "");
      }
      toolFileMap[rel] = sha256;
      return `${rel}:${sha256}`;
    })
  );

  const records = (await Promise.all(tasks)).filter(Boolean);
  records.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const toolsHash = crypto.createHash("sha256").update(records.join("\n"), "utf8").digest("hex");
  return { toolsHash, toolFiles: toolFileMap };
}

export async function computeAllFingerprintsParallel({
  scriptDir,
  pluginsDir,
  targetPlugins,
  themeDir = null,
  jobs = 4,
  contentRoot = null,
  signal = null,
}) {
  const resolvedContentRoot = contentRoot || path.resolve(path.join(scriptDir, ".."));
  const resolvedThemeDir = themeDir || path.join(resolvedContentRoot, "themes", "tavangary");
  const ioLimit = pLimit(Math.max(1, Math.min(Number(jobs) || 4, 32)));
  const treeLimit = pLimit(Math.max(1, Math.min(Number(jobs) || 4, 32)));

  const pluginTasks = targetPlugins.map((pluginName) =>
    treeLimit(async () => {
      if (signal?.aborted) throw new Error("Fingerprint traversal aborted");
      const resolved = await resolveConsumerSource({ contentRoot: resolvedContentRoot, consumer: pluginName, pluginsDir });
      return computeTreeContentHash(resolved.sourceDir, resolved.sourceDir, true, ioLimit, signal);
    })
  );

  const [toolsData, wpdev, theme, testFiles, toolchain, ...pluginHashes] = await Promise.all([
    treeLimit(() => computeToolsFingerprint(scriptDir, ioLimit, signal)),
    treeLimit(() => computeTreeContentHash(path.join(pluginsDir, "wpdev"), path.join(pluginsDir, "wpdev"), true, ioLimit, signal)),
    treeLimit(() =>
      fs.existsSync(resolvedThemeDir)
        ? computeTreeContentHash(resolvedThemeDir, resolvedThemeDir, true, ioLimit, signal)
        : "missing"
    ),
    computeTestFileHashes(path.join(scriptDir, "tests"), ioLimit, signal),
    computeToolchainFingerprint(signal),
    ...pluginTasks,
  ]);

  const plugins = {};
  targetPlugins.forEach((p, i) => {
    plugins[p] = pluginHashes[i];
  });

  return {
    tools: toolsData.toolsHash,
    toolFiles: toolsData.toolFiles,
    wpdev,
    theme,
    plugins,
    testFiles,
    toolchain,
  };
}

export function computePluginCompositeFingerprint({
  toolsFingerprint,
  wpdevFingerprint,
  pluginSourceFingerprint,
  toolchainFingerprint = "",
  profile = "clean",
  options = {},
  buildPlan = null,
}) {
  const normTools = (toolsFingerprint && toolsFingerprint !== "missing") ? toolsFingerprint : "0".repeat(64);
  const normWpdev = (wpdevFingerprint && wpdevFingerprint !== "missing") ? wpdevFingerprint : "0".repeat(64);
  const normPlugin = (pluginSourceFingerprint && pluginSourceFingerprint !== "missing") ? pluginSourceFingerprint : "0".repeat(64);
  const normToolchain = (toolchainFingerprint && toolchainFingerprint !== "missing") ? toolchainFingerprint : "";
  const rawProfile = String(profile || "clean").toLowerCase().trim();
  // Canonical profile identity preserves distinct capability profiles
  const normProfile = (rawProfile === "s" || rawProfile === "profile s" || rawProfile === "profile-s" || rawProfile === "profiles" || rawProfile === "obfuscate" || rawProfile === "obfuscated") ? "s" : rawProfile;

  const parts = [normTools, normWpdev, normPlugin];
  if (normToolchain) {
    parts.push(normToolchain);
  }
  parts.push(`profile:${normProfile}`);

  const effectivePlanFingerprint = buildPlan?.artifactIdentity?.fingerprint
    || options?.buildPlan?.artifactIdentity?.fingerprint
    || options?.planFingerprint
    || null;

  if (effectivePlanFingerprint) {
    parts.push(`plan:${effectivePlanFingerprint}`);
  }

  if (options && typeof options === "object" && Object.keys(options).length > 0) {
    const encode = (value) => {
      if (value === undefined) return "null";
      if (value === null || typeof value !== "object") return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
      const innerKeys = Object.keys(value).sort();
      return `{${innerKeys.map((inner) => `${JSON.stringify(inner)}:${encode(value[inner])}`).join(",")}}`;
    };
    const optKeys = Object.keys(options).filter((k) => k !== "buildPlan" && k !== "planFingerprint").sort();
    if (optKeys.length > 0) {
      const optStr = optKeys.map((k) => `${k}=${encode(options[k])}`).join(";");
      parts.push(`opts:${crypto.createHash("sha256").update(optStr).digest("hex").slice(0, 16)}`);
    }
  }
  return parts.join(":");
}

export function planDependencyGraphBuild({
  targetPlugins,
  previousCache = {},
  currentFingerprints,
  mode = "changed", // "all", "changed", "force"
  profile = "clean",
  pluginBuildPlans = null,
  options = {},
}) {
  const plan = {};
  const isForce = mode === "force";
  const toolsChanged = previousCache._tools !== currentFingerprints.tools;
  const wpdevChanged = previousCache._wpdev !== currentFingerprints.wpdev;

  for (const plugin of targetPlugins) {
    const prevPluginFingerprint = previousCache.artifacts?.[plugin]?.compositeFingerprint || previousCache[plugin];
    const currentPluginSource = currentFingerprints.plugins[plugin] || "missing";
    const buildPlan = pluginBuildPlans?.[plugin] || options.buildPlan || null;
    const effectiveProfile = buildPlan ? buildPlan.artifactIdentity.capabilityTag : profile;
    const compositeFingerprint = computePluginCompositeFingerprint({
      toolsFingerprint: currentFingerprints.tools,
      wpdevFingerprint: currentFingerprints.wpdev,
      pluginSourceFingerprint: currentPluginSource,
      toolchainFingerprint: currentFingerprints.toolchain || "",
      profile: effectiveProfile,
      options,
      buildPlan,
    });

    if (isForce) {
      plan[plugin] = {
        shouldRebuild: true,
        reason: "Forced rebuild requested (--force)",
        compositeFingerprint,
      };
      continue;
    }

    if (!prevPluginFingerprint) {
      plan[plugin] = {
        shouldRebuild: true,
        reason: "No previous build cache found",
        compositeFingerprint,
      };
      continue;
    }

    if (toolsChanged) {
      plan[plugin] = {
        shouldRebuild: true,
        reason: "Global build tools or transformer modified",
        compositeFingerprint,
      };
      continue;
    }

    if (wpdevChanged) {
      plan[plugin] = {
        shouldRebuild: true,
        reason: "Shared wpdev runtime closure framework modified",
        compositeFingerprint,
      };
      continue;
    }

    if (prevPluginFingerprint !== compositeFingerprint) {
      plan[plugin] = {
        shouldRebuild: true,
        reason: "Source code changed",
        compositeFingerprint,
      };
      continue;
    }

    plan[plugin] = {
      shouldRebuild: false,
      reason: "Cached (inputs unchanged)",
      compositeFingerprint,
    };
  }

  return plan;
}

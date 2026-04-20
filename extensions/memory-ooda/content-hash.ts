/**
 * CR_OODA_PASS_K_ACCEPTANCE_GATE — raw-edit detector for workspace files.
 *
 * We cannot intercept external edits (user hand-editing KNOWLEDGE.json, a VS Code
 * plugin syncing a different copy, etc.). Instead, every authoritative writer
 * stamps a content hash into `_meta.content_hash` after writing; every reader
 * recomputes and compares. A mismatch means the file changed outside the
 * authoritative code path — the caller is expected to log + snapshot before
 * continuing.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const RAW_EDIT_LOG = ".raw-edit-warnings.jsonl";

// Process-level dedupe: same (filename, claimed-hash) warns at most once per run.
const seenWarnings = new Set<string>();

/** Log a raw-edit warning to `.raw-edit-warnings.jsonl`. Deduped per process. */
export function reportRawEditWarning(
  workspacePath: string,
  filename: string,
  claimed: string | undefined,
  computed: string,
): void {
  const dedupeKey = `${filename}:${claimed ?? "∅"}:${computed}`;
  if (seenWarnings.has(dedupeKey)) return;
  seenWarnings.add(dedupeKey);
  const logPath = path.join(workspacePath, RAW_EDIT_LOG);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        filename,
        claimed_hash: claimed ?? null,
        computed_hash: computed,
      }) + "\n",
      "utf-8",
    );
  } catch {
    // Best-effort — logging must not block reads.
  }
}

export interface HashableMeta {
  content_hash?: string;
}
export interface HashableFile {
  _meta: HashableMeta & Record<string, unknown>;
  [key: string]: unknown;
}

function canonicalSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalSerialize(v)).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) => JSON.stringify(k) + ":" + canonicalSerialize((value as Record<string, unknown>)[k]),
  );
  return "{" + pairs.join(",") + "}";
}

/** Compute the canonical hash of a file, ignoring the `_meta.content_hash` field itself. */
export function computeContentHash(file: HashableFile): string {
  const clone = JSON.parse(JSON.stringify(file)) as HashableFile;
  if (clone._meta && typeof clone._meta === "object") {
    delete clone._meta.content_hash;
  }
  return createHash("sha256").update(canonicalSerialize(clone)).digest("hex");
}

/** Stamp `_meta.content_hash` on the file. Mutates in place. */
export function stampContentHash(file: HashableFile): void {
  if (!file._meta) {
    file._meta = {};
  }
  file._meta.content_hash = computeContentHash(file);
}

export interface VerifyResult {
  status: "ok" | "missing" | "mismatch";
  claimed?: string;
  computed: string;
}

/**
 * Verify the hash on a file. `missing` means the file predates hashing (no
 * warning warranted). `mismatch` means the content drifted — caller decides
 * whether to snapshot, warn, or block.
 */
export function verifyContentHash(file: HashableFile): VerifyResult {
  const computed = computeContentHash(file);
  const claimed = file._meta?.content_hash;
  if (!claimed) return { status: "missing", computed };
  return { status: claimed === computed ? "ok" : "mismatch", claimed, computed };
}

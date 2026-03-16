/**
 * Timestamped file snapshot utility for OODA workspace files.
 *
 * Before any automated write to KNOWLEDGE.json or PRIORITIES.json,
 * call snapshot() to keep a backup. Keeps the last N snapshots per file.
 */

import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_SNAPSHOTS = 5;
const SNAPSHOTS_DIR = ".snapshots";

function ensureSnapshotsDir(workspacePath: string): string {
  const dir = path.join(workspacePath, SNAPSHOTS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Parse snapshot filenames to extract the original filename and timestamp.
 * Format: `<basename>.<timestamp>.bak`
 */
function parseSnapshotName(filename: string): { basename: string; timestamp: number } | null {
  const match = filename.match(/^(.+)\.(\d+)\.bak$/);
  if (!match) return null;
  return { basename: match[1], timestamp: Number(match[2]) };
}

/**
 * List existing snapshots for a given file, sorted newest first.
 */
export function listSnapshots(
  workspacePath: string,
  filename: string,
): Array<{ path: string; timestamp: number }> {
  const dir = path.join(workspacePath, SNAPSHOTS_DIR);
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir);
  const snapshots: Array<{ path: string; timestamp: number }> = [];

  for (const entry of entries) {
    const parsed = parseSnapshotName(entry);
    if (parsed && parsed.basename === filename) {
      snapshots.push({
        path: path.join(dir, entry),
        timestamp: parsed.timestamp,
      });
    }
  }

  return snapshots.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Create a timestamped snapshot of a file before writing.
 * Returns the snapshot path, or null if the source file doesn't exist.
 */
export function createSnapshot(
  workspacePath: string,
  filename: string,
  maxSnapshots: number = DEFAULT_MAX_SNAPSHOTS,
): string | null {
  const sourcePath = path.join(workspacePath, filename);
  if (!fs.existsSync(sourcePath)) return null;

  const dir = ensureSnapshotsDir(workspacePath);
  const timestamp = Date.now();
  const snapshotPath = path.join(dir, `${filename}.${timestamp}.bak`);

  fs.copyFileSync(sourcePath, snapshotPath);

  // Prune old snapshots
  const existing = listSnapshots(workspacePath, filename);
  for (const old of existing.slice(maxSnapshots)) {
    try {
      fs.unlinkSync(old.path);
    } catch (err) {
      console.warn(`snapshot: failed to prune ${old.path}: ${String(err)}`);
    }
  }

  return snapshotPath;
}

/**
 * Restore the most recent snapshot of a file.
 * Returns true if restored, false if no snapshot exists.
 */
export function restoreLatestSnapshot(workspacePath: string, filename: string): boolean {
  const snapshots = listSnapshots(workspacePath, filename);
  const targetPath = path.join(workspacePath, filename);

  for (const snapshot of snapshots) {
    try {
      fs.copyFileSync(snapshot.path, targetPath);
      return true;
    } catch {
      continue; // Try next oldest snapshot
    }
  }

  return false;
}

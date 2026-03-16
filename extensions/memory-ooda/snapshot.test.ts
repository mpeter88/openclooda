import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSnapshot, listSnapshots, restoreLatestSnapshot } from "./snapshot.js";

describe("snapshot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-snapshot-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when source file does not exist", () => {
    const result = createSnapshot(tmpDir, "KNOWLEDGE.json");
    expect(result).toBeNull();
  });

  it("creates a snapshot of an existing file", () => {
    fs.writeFileSync(path.join(tmpDir, "KNOWLEDGE.json"), '{"test": true}');

    const snapshotPath = createSnapshot(tmpDir, "KNOWLEDGE.json");
    expect(snapshotPath).not.toBeNull();
    expect(fs.existsSync(snapshotPath!)).toBe(true);
    expect(fs.readFileSync(snapshotPath!, "utf-8")).toBe('{"test": true}');
  });

  it("lists snapshots sorted newest first", () => {
    fs.writeFileSync(path.join(tmpDir, "KNOWLEDGE.json"), "v1");

    // Create snapshots with different timestamps by manipulating files directly
    const snapshotsDir = path.join(tmpDir, ".snapshots");
    fs.mkdirSync(snapshotsDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotsDir, "KNOWLEDGE.json.1000000.bak"), "old");
    fs.writeFileSync(path.join(snapshotsDir, "KNOWLEDGE.json.2000000.bak"), "new");

    const list = listSnapshots(tmpDir, "KNOWLEDGE.json");
    expect(list).toHaveLength(2);
    expect(list[0].timestamp).toBe(2000000);
    expect(list[1].timestamp).toBe(1000000);
  });

  it("prunes old snapshots beyond max", () => {
    fs.writeFileSync(path.join(tmpDir, "KNOWLEDGE.json"), "content");

    const snapshotsDir = path.join(tmpDir, ".snapshots");
    fs.mkdirSync(snapshotsDir, { recursive: true });

    // Pre-create 4 old snapshots
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(path.join(snapshotsDir, `KNOWLEDGE.json.${i}.bak`), `v${i}`);
    }

    // Create a new one with max=3
    createSnapshot(tmpDir, "KNOWLEDGE.json", 3);

    const list = listSnapshots(tmpDir, "KNOWLEDGE.json");
    // Should have at most 3: the new one + 2 newest old ones
    expect(list.length).toBeLessThanOrEqual(3);
  });

  it("restores the latest snapshot", () => {
    const filePath = path.join(tmpDir, "KNOWLEDGE.json");
    fs.writeFileSync(filePath, "original");
    createSnapshot(tmpDir, "KNOWLEDGE.json");

    // Corrupt the file
    fs.writeFileSync(filePath, "corrupted");

    const restored = restoreLatestSnapshot(tmpDir, "KNOWLEDGE.json");
    expect(restored).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("original");
  });

  it("returns false when no snapshot exists for restore", () => {
    const restored = restoreLatestSnapshot(tmpDir, "KNOWLEDGE.json");
    expect(restored).toBe(false);
  });

  it("does not mix snapshots of different files", () => {
    fs.writeFileSync(path.join(tmpDir, "KNOWLEDGE.json"), "knowledge");
    fs.writeFileSync(path.join(tmpDir, "PRIORITIES.json"), "priorities");

    createSnapshot(tmpDir, "KNOWLEDGE.json");
    createSnapshot(tmpDir, "PRIORITIES.json");

    const knowledgeSnaps = listSnapshots(tmpDir, "KNOWLEDGE.json");
    const prioritySnaps = listSnapshots(tmpDir, "PRIORITIES.json");

    expect(knowledgeSnaps).toHaveLength(1);
    expect(prioritySnaps).toHaveLength(1);
  });
});

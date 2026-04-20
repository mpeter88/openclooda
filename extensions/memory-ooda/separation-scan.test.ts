import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { minhash, serializeSignature } from "./min-hash.js";
import { formatMatchesForDiscriminator, scanForNearDuplicates } from "./separation-scan.js";

async function seedMemoriesSqlite(
  dbPath: string,
  rows: Array<{ id: string; text: string; hashSignature: string | null; createdAt: number }>,
): Promise<void> {
  fs.mkdirSync(dbPath, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dbPath, "memories.sqlite"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      importance REAL,
      category TEXT,
      createdAt INTEGER NOT NULL,
      source TEXT,
      actionId TEXT,
      archivistProcessed INTEGER DEFAULT 0,
      hashSignature TEXT
    )
  `);
  const stmt = db.prepare(
    "INSERT INTO memories (id, text, createdAt, hashSignature) VALUES (?, ?, ?, ?)",
  );
  for (const r of rows) {
    stmt.run(r.id, r.text, r.createdAt, r.hashSignature);
  }
  db.close();
}

async function seedMemoriesSqliteNoHashColumn(dbPath: string): Promise<void> {
  fs.mkdirSync(dbPath, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dbPath, "memories.sqlite"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);
  db.close();
}

describe("scanForNearDuplicates", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-sep-scan-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty array when sqlite file missing", async () => {
    const r = await scanForNearDuplicates(tmp, "any query", {});
    expect(r).toEqual([]);
  });

  it("returns empty array when hashSignature column absent (pre-migration workspace)", async () => {
    await seedMemoriesSqliteNoHashColumn(tmp);
    const r = await scanForNearDuplicates(tmp, "any query", {});
    expect(r).toEqual([]);
  });

  it("returns matches ordered by Jaccard descending", async () => {
    const queryText = "archivist pattern extraction ran successfully on the sqlite backend";
    const nearMatchText = "archivist pattern extraction ran successfully on the lancedb backend";
    const farMatchText = "cooking pastry dessert recipe ingredients";
    const exactMatchText = "archivist pattern extraction ran successfully on the sqlite backend";

    await seedMemoriesSqlite(tmp, [
      {
        id: "near",
        text: nearMatchText,
        hashSignature: serializeSignature(minhash(nearMatchText)),
        createdAt: 1000,
      },
      {
        id: "far",
        text: farMatchText,
        hashSignature: serializeSignature(minhash(farMatchText)),
        createdAt: 2000,
      },
      {
        id: "exact",
        text: exactMatchText,
        hashSignature: serializeSignature(minhash(exactMatchText)),
        createdAt: 3000,
      },
    ]);

    const matches = await scanForNearDuplicates(tmp, queryText, {
      minJaccard: 0.1,
    });
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].memoryId).toBe("exact");
    // Jaccard should be strictly monotone down the list.
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].hashJaccard).toBeGreaterThanOrEqual(matches[i].hashJaccard);
    }
    // Unrelated text should be excluded at minJaccard 0.1.
    expect(matches.find((m) => m.memoryId === "far")).toBeUndefined();
  });

  it("skips rows with null hashSignature (pre-CR rows)", async () => {
    await seedMemoriesSqlite(tmp, [
      {
        id: "pre-cr",
        text: "something",
        hashSignature: null,
        createdAt: 1000,
      },
    ]);
    const r = await scanForNearDuplicates(tmp, "something", {});
    expect(r).toEqual([]);
  });

  it("applies the limit cap", async () => {
    const rows = [];
    const text = "identical query text";
    for (let i = 0; i < 10; i++) {
      rows.push({
        id: `m${i}`,
        text,
        hashSignature: serializeSignature(minhash(text)),
        createdAt: 1000 + i,
      });
    }
    await seedMemoriesSqlite(tmp, rows);
    const r = await scanForNearDuplicates(tmp, text, { limit: 3, minJaccard: 0.1 });
    expect(r).toHaveLength(3);
  });

  it("never throws on corrupted sqlite", async () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, "memories.sqlite"), "not a real sqlite file");
    await expect(scanForNearDuplicates(tmp, "x", {})).resolves.toEqual([]);
  });
});

describe("formatMatchesForDiscriminator", () => {
  it("emits one string per match with date + jaccard", () => {
    const out = formatMatchesForDiscriminator([
      {
        memoryId: "a",
        text: "short memory",
        hashJaccard: 0.9,
        createdAt: 1700000000000,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/jaccard=0\.90/);
    expect(out[0]).toContain("short memory");
  });

  it("truncates long memory text", () => {
    const longText = "x".repeat(400);
    const out = formatMatchesForDiscriminator([
      {
        memoryId: "a",
        text: longText,
        hashJaccard: 0.8,
        createdAt: 1700000000000,
      },
    ]);
    expect(out[0].length).toBeLessThan(260); // prefix + 200 chars + ellipsis
    expect(out[0]).toContain("…");
  });
});

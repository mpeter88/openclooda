import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeContentHash,
  reportRawEditWarning,
  stampContentHash,
  verifyContentHash,
  type HashableFile,
} from "./content-hash.js";

const mk = (overrides: Record<string, unknown> = {}): HashableFile =>
  ({
    _meta: { version: 1, description: "test" },
    payload: 42,
    ...overrides,
  }) as HashableFile;

describe("computeContentHash", () => {
  it("is stable across object key order", () => {
    const a = computeContentHash({ _meta: {}, a: 1, b: 2 });
    const b = computeContentHash({ _meta: {}, b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it("ignores the content_hash field itself", () => {
    const file = mk();
    const first = computeContentHash(file);
    file._meta.content_hash = first;
    const second = computeContentHash(file);
    expect(first).toBe(second);
  });

  it("changes when payload changes", () => {
    expect(computeContentHash(mk({ payload: 1 }))).not.toBe(computeContentHash(mk({ payload: 2 })));
  });
});

describe("stampContentHash + verifyContentHash", () => {
  it("round-trips as ok", () => {
    const file = mk();
    stampContentHash(file);
    expect(verifyContentHash(file).status).toBe("ok");
  });

  it("returns missing when unstamped", () => {
    const file = mk();
    expect(verifyContentHash(file).status).toBe("missing");
  });

  it("returns mismatch after raw edit", () => {
    const file = mk();
    stampContentHash(file);
    (file as Record<string, unknown>).payload = "tampered";
    const verdict = verifyContentHash(file);
    expect(verdict.status).toBe("mismatch");
    expect(verdict.claimed).not.toBe(verdict.computed);
  });
});

describe("reportRawEditWarning", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ooda-raw-edit-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes a row to .raw-edit-warnings.jsonl", () => {
    reportRawEditWarning(tmp, "KNOWLEDGE.json", "oldhash", "newhash");
    const lines = fs
      .readFileSync(path.join(tmp, ".raw-edit-warnings.jsonl"), "utf-8")
      .trim()
      .split("\n");
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]);
    expect(row.filename).toBe("KNOWLEDGE.json");
    expect(row.claimed_hash).toBe("oldhash");
    expect(row.computed_hash).toBe("newhash");
  });

  it("dedupes identical (filename, claimed, computed) within a process", () => {
    reportRawEditWarning(tmp, "BELIEFS.json", "x", "y");
    reportRawEditWarning(tmp, "BELIEFS.json", "x", "y");
    const content = fs.readFileSync(path.join(tmp, ".raw-edit-warnings.jsonl"), "utf-8");
    expect(content.trim().split("\n").length).toBe(1);
  });

  it("does not dedupe different (claimed, computed) pairs", () => {
    reportRawEditWarning(tmp, "PRIORITIES.json", "h1", "c1");
    reportRawEditWarning(tmp, "PRIORITIES.json", "h2", "c2");
    const content = fs.readFileSync(path.join(tmp, ".raw-edit-warnings.jsonl"), "utf-8");
    expect(content.trim().split("\n").length).toBe(2);
  });
});

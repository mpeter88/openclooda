/**
 * MinHash contract test — memory-ooda vs memory-lancedb.
 *
 * memory-ooda/min-hash.ts and memory-lancedb/min-hash.ts are deliberately
 * duplicated (extensions can't import across each other). This test enforces
 * byte-for-byte equivalence on a fixed corpus so a drift-inducing edit on one
 * side fails CI instead of silently producing mismatched bands across plugins
 * at runtime.
 *
 * If this test fails, either:
 *   (a) intentional algorithm change — mirror it in both files AND bump the
 *       serialized hash format version so pre-migration rows are invalidated;
 *   (b) unintentional drift — revert.
 */

import { describe, expect, it } from "vitest";
import * as lancedb from "../memory-lancedb/min-hash.js";
import * as ooda from "./min-hash.js";

const CORPUS: string[] = [
  "",
  "a",
  "the quick brown fox jumps over the lazy dog",
  "archivist pattern extraction ran successfully today on the sqlite backend",
  "archivist pattern extraction ran successfully today on the lancedb backend",
  "council dissent chair overrode strategist mode=system2 winner=minimal_viable_action",
  "memory-ooda: registered (workspace: /Users/michaelpeter/.openclaw/workspace)",
  "deploy pipeline failed on staging with exit code 1",
  "deploy pipeline failed on production with exit code 1",
  "user preferences never_do includes auto-deploy-without-confirmation",
  "railway bridge signal engineering protocols mandate dual-channel handshake",
  "cooking pastry dessert recipe ingredients for saturday afternoon",
  "OpenClaw Gateway 2026.4.15 starting channels and sidecars",
  "heartbeat started interval 300s grace 60s",
  "sqlite-vec 0.1.7-alpha.2 rejects explicit rowid on INSERT",
  "LanceDB unavailable on this platform using sqlite-vec fallback",
  "test_passed build_passed all 274 tests",
  "campbell_suspected in ops domain grounded reversed while approval positive",
  "Tokens: archivist triage valuation sitrep strategy knowledge.json",
  "Peter is typing... async replies outperform sync responses in chat",
  "the the the the the the the", // stopword-heavy
];

describe("MinHash cross-plugin contract", () => {
  it("both modules expose the same public shape", () => {
    expect(typeof ooda.minhash).toBe("function");
    expect(typeof lancedb.minhash).toBe("function");
    expect(typeof ooda.minhashJaccard).toBe("function");
    expect(typeof lancedb.minhashJaccard).toBe("function");
    expect(typeof ooda.serializeSignature).toBe("function");
    expect(typeof lancedb.serializeSignature).toBe("function");
    expect(typeof ooda.deserializeSignature).toBe("function");
    expect(typeof lancedb.deserializeSignature).toBe("function");
  });

  it("minhash signatures are byte-identical across plugins on the corpus", () => {
    for (const text of CORPUS) {
      const a = ooda.minhash(text);
      const b = lancedb.minhash(text);
      expect(a, `minhash differs for text=${JSON.stringify(text.slice(0, 60))}`).toEqual(b);
    }
  });

  it("serialized signatures are identical strings across plugins", () => {
    for (const text of CORPUS) {
      const a = ooda.serializeSignature(ooda.minhash(text));
      const b = lancedb.serializeSignature(lancedb.minhash(text));
      expect(a).toBe(b);
      expect(a).toHaveLength(32); // 128-bit signature
    }
  });

  it("deserializeSignature is symmetric across plugins", () => {
    for (const text of CORPUS) {
      const sig = ooda.minhash(text);
      const hex = ooda.serializeSignature(sig);
      // Deserialize using the OPPOSITE plugin to catch asymmetric drift.
      const roundtripA = lancedb.deserializeSignature(hex);
      const roundtripB = ooda.deserializeSignature(hex);
      expect(roundtripA).toEqual(sig);
      expect(roundtripB).toEqual(sig);
    }
  });

  it("Jaccard computations agree across plugins for all pairs in the corpus", () => {
    for (let i = 0; i < CORPUS.length; i++) {
      for (let j = i; j < CORPUS.length; j++) {
        const sigAi = ooda.minhash(CORPUS[i]);
        const sigAj = ooda.minhash(CORPUS[j]);
        const sigBi = lancedb.minhash(CORPUS[i]);
        const sigBj = lancedb.minhash(CORPUS[j]);
        const ja = ooda.minhashJaccard(sigAi, sigAj);
        const jb = lancedb.minhashJaccard(sigBi, sigBj);
        expect(ja).toBe(jb);
      }
    }
  });

  it("deserializing garbage returns [] in both", () => {
    expect(ooda.deserializeSignature("short")).toEqual([]);
    expect(lancedb.deserializeSignature("short")).toEqual([]);
    expect(ooda.deserializeSignature("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toEqual(
      lancedb.deserializeSignature("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"),
    );
  });
});

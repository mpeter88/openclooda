import { describe, expect, it } from "vitest";
import { minhash, minhashJaccard, serializeSignature, deserializeSignature } from "./min-hash.js";
import {
  DEFAULT_SEPARATION_THRESHOLDS,
  bandDistribution,
  classifyAll,
  classifyCandidate,
  computeNovelty,
  formatSeparationContext,
  hashJaccardOfTexts,
  needsDiscriminator,
  type ClassifiedCandidate,
} from "./pattern-separation.js";

describe("minhash", () => {
  it("is deterministic for identical input", () => {
    const a = minhash("the quick brown fox jumps over the lazy dog");
    const b = minhash("the quick brown fox jumps over the lazy dog");
    expect(a).toEqual(b);
  });

  it("produces a 4-element uint32 signature", () => {
    const sig = minhash("hello world test text here");
    expect(sig).toHaveLength(4);
    for (const n of sig) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("identical text → Jaccard 1.0", () => {
    const text = "archivist pattern extraction ran successfully today";
    expect(minhashJaccard(minhash(text), minhash(text))).toBe(1);
  });

  it("disjoint text → Jaccard near 0", () => {
    // 4-hash signatures have high variance; "near 0" allowance is generous.
    const j = minhashJaccard(
      minhash("railway bridge signal engineering protocols"),
      minhash("cooking pastry dessert recipe ingredients"),
    );
    expect(j).toBeLessThanOrEqual(0.5);
  });

  it("near-duplicate text → high Jaccard", () => {
    const j = hashJaccardOfTexts(
      "archivist pattern extraction ran successfully today with node.js and sqlite",
      "archivist pattern extraction ran successfully today with node.js and lancedb",
    );
    expect(j).toBeGreaterThanOrEqual(0.25);
  });

  it("serializeSignature / deserializeSignature round-trip", () => {
    const sig = minhash("round trip test text content here for coverage");
    const hex = serializeSignature(sig);
    expect(hex).toHaveLength(32);
    expect(deserializeSignature(hex)).toEqual(sig);
  });

  it("deserializeSignature returns [] on malformed input", () => {
    expect(deserializeSignature("garbage")).toEqual([]);
  });
});

describe("classifyCandidate", () => {
  it("dense >= 0.95 + hash >= 0.8 → exact_duplicate", () => {
    expect(classifyCandidate({ memoryId: "m1", denseSim: 0.97, hashJaccard: 0.85 })).toBe(
      "exact_duplicate",
    );
  });

  it("dense >= 0.95 + hash < 0.8 → semantic_twin", () => {
    expect(classifyCandidate({ memoryId: "m2", denseSim: 0.97, hashJaccard: 0.3 })).toBe(
      "semantic_twin",
    );
  });

  it("dense in mid-range + high hash → lexical_echo", () => {
    expect(classifyCandidate({ memoryId: "m3", denseSim: 0.75, hashJaccard: 0.9 })).toBe(
      "lexical_echo",
    );
  });

  it("dense in mid-range + low hash → fuzzy_candidate", () => {
    expect(classifyCandidate({ memoryId: "m4", denseSim: 0.75, hashJaccard: 0.2 })).toBe(
      "fuzzy_candidate",
    );
  });

  it("dense < 0.6 → weak_signal (low hash) or lexical_echo (high hash)", () => {
    expect(classifyCandidate({ memoryId: "m5", denseSim: 0.3, hashJaccard: 0.1 })).toBe(
      "weak_signal",
    );
    expect(classifyCandidate({ memoryId: "m6", denseSim: 0.3, hashJaccard: 0.9 })).toBe(
      "lexical_echo",
    );
  });

  it("respects custom thresholds", () => {
    expect(
      classifyCandidate(
        { memoryId: "m7", denseSim: 0.9, hashJaccard: 0.5 },
        { exact_dense_floor: 0.85, exact_hash_floor: 0.4, weak_dense_ceil: 0.5 },
      ),
    ).toBe("exact_duplicate");
  });
});

describe("computeNovelty", () => {
  it("empty candidates → novelty 1.0", () => {
    expect(computeNovelty([])).toBe(1);
  });

  it("one exact-duplicate candidate → novelty near 0", () => {
    expect(computeNovelty([{ memoryId: "m1", denseSim: 0.98, hashJaccard: 0.9 }])).toBeCloseTo(
      0.02,
      5,
    );
  });

  it("uses the max similarity across candidates", () => {
    expect(
      computeNovelty([
        { memoryId: "a", denseSim: 0.3, hashJaccard: 0 },
        { memoryId: "b", denseSim: 0.91, hashJaccard: 0 },
        { memoryId: "c", denseSim: 0.5, hashJaccard: 0 },
      ]),
    ).toBeCloseTo(0.09, 5);
  });

  it("clamps to [0, 1]", () => {
    expect(computeNovelty([{ memoryId: "a", denseSim: 1.5, hashJaccard: 0 }])).toBe(0);
  });
});

describe("needsDiscriminator", () => {
  it("true when at least one exact_duplicate", () => {
    const classified: ClassifiedCandidate[] = [
      { memoryId: "a", denseSim: 0.7, hashJaccard: 0.2, band: "fuzzy_candidate" },
      { memoryId: "b", denseSim: 0.98, hashJaccard: 0.9, band: "exact_duplicate" },
    ];
    expect(needsDiscriminator(classified)).toBe(true);
  });

  it("false when no exact_duplicate band", () => {
    const classified: ClassifiedCandidate[] = [
      { memoryId: "a", denseSim: 0.7, hashJaccard: 0.2, band: "fuzzy_candidate" },
      { memoryId: "b", denseSim: 0.3, hashJaccard: 0.1, band: "weak_signal" },
    ];
    expect(needsDiscriminator(classified)).toBe(false);
  });
});

describe("bandDistribution", () => {
  it("counts bands correctly", () => {
    const classified = classifyAll([
      { memoryId: "a", denseSim: 0.97, hashJaccard: 0.9 }, // exact_duplicate
      { memoryId: "b", denseSim: 0.96, hashJaccard: 0.2 }, // semantic_twin
      { memoryId: "c", denseSim: 0.7, hashJaccard: 0.9 }, // lexical_echo
      { memoryId: "d", denseSim: 0.7, hashJaccard: 0.1 }, // fuzzy_candidate
      { memoryId: "e", denseSim: 0.2, hashJaccard: 0.1 }, // weak_signal
    ]);
    const dist = bandDistribution(classified);
    expect(dist.exact_duplicate).toBe(1);
    expect(dist.semantic_twin).toBe(1);
    expect(dist.lexical_echo).toBe(1);
    expect(dist.fuzzy_candidate).toBe(1);
    expect(dist.weak_signal).toBe(1);
  });
});

describe("formatSeparationContext", () => {
  it("returns empty string when no candidates", () => {
    expect(formatSeparationContext([])).toBe("");
  });

  it("emits the exact_duplicate warning text", () => {
    const c: ClassifiedCandidate = {
      memoryId: "mem-123",
      denseSim: 0.98,
      hashJaccard: 0.9,
      band: "exact_duplicate",
    };
    const out = formatSeparationContext([c]);
    expect(out).toContain("<pattern-separation>");
    expect(out).toContain("exact_duplicate");
    expect(out).toContain("WARNING");
    expect(out).toContain("mem-123");
  });

  it("groups output by band", () => {
    const cs: ClassifiedCandidate[] = [
      { memoryId: "a", denseSim: 0.97, hashJaccard: 0.9, band: "exact_duplicate" },
      { memoryId: "b", denseSim: 0.97, hashJaccard: 0.2, band: "semantic_twin" },
      { memoryId: "c", denseSim: 0.3, hashJaccard: 0.1, band: "weak_signal" },
    ];
    const out = formatSeparationContext(cs);
    // Weak signals are excluded from the formatted context (intentional — they're noise).
    expect(out).not.toContain("weak_signal");
    expect(out).toContain("exact_duplicate");
    expect(out).toContain("semantic_twin");
  });
});

describe("DEFAULT_SEPARATION_THRESHOLDS", () => {
  it("matches CR values", () => {
    expect(DEFAULT_SEPARATION_THRESHOLDS.exact_dense_floor).toBe(0.95);
    expect(DEFAULT_SEPARATION_THRESHOLDS.exact_hash_floor).toBe(0.8);
    expect(DEFAULT_SEPARATION_THRESHOLDS.weak_dense_ceil).toBe(0.6);
  });
});

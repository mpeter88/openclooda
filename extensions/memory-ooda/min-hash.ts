/**
 * MinHash sketches for pattern separation.
 *
 * CR_OODA_PATTERN_SEPARATION_GATE. The dentate-gyrus analog needs a cheap
 * surface-form similarity alongside the dense semantic embedding, so we can
 * tell "near-identical text" from "semantically adjacent but different text."
 * MinHash estimates Jaccard similarity of n-gram token sets in constant time.
 *
 * Signature is 128-bit = 4 × uint32. Accuracy: Jaccard estimate stdev ≈ 1/√N
 * where N = number of hash functions (4). For a sharper estimate we'd want
 * 64–128 hashes; 4 is a pragmatic floor because our consumer only cares about
 * three bands (≥0.80 / 0.5–0.8 / <0.5), not fine-grained Jaccard.
 *
 * This file is mirrored in extensions/memory-lancedb/min-hash.ts. Duplication
 * is intentional — see that file's header for the architectural rationale.
 * min-hash-contract.test.ts asserts byte-identical output across the pair.
 */

const NGRAM_SIZE = 3;
const NUM_HASHES = 4;
const SEEDS = [0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f];

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "with",
  "and",
  "or",
  "that",
  "this",
  "it",
  "was",
  "be",
  "by",
  "as",
  "from",
]);

function normalize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = lower.match(/[a-z][a-z0-9]{1,}/g) ?? [];
  return tokens.filter((t) => !STOPWORDS.has(t));
}

function ngrams(tokens: string[], n: number): string[] {
  if (tokens.length < n) return tokens.length > 0 ? [tokens.join(" ")] : [];
  const out: string[] = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    out.push(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

/** FNV-1a 32-bit hash, seeded so multiple hash functions produce independent values. */
function hash32(str: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Compute a MinHash signature over the text's n-gram token set.
 * Returns a fixed-length array of 32-bit unsigned integers (NUM_HASHES entries).
 * Same input always produces same output — deterministic, stable across runs.
 */
export function minhash(text: string): number[] {
  const tokens = normalize(text);
  const grams = ngrams(tokens, NGRAM_SIZE);
  const sig = new Array(NUM_HASHES).fill(0xffffffff);
  if (grams.length === 0) return sig;
  for (const gram of grams) {
    for (let i = 0; i < NUM_HASHES; i++) {
      const h = hash32(gram, SEEDS[i]);
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

/**
 * Estimate Jaccard similarity between two MinHash signatures. The proportion
 * of matching positions in the signatures is an unbiased estimator of the
 * Jaccard index of the underlying token-n-gram sets.
 */
export function minhashJaccard(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) matches++;
  }
  return matches / a.length;
}

/** Serialize a signature to a hex string (e.g. for column storage). */
export function serializeSignature(sig: number[]): string {
  return sig.map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
}

/** Parse a hex string produced by serializeSignature. Returns [] on malformed input. */
export function deserializeSignature(hex: string): number[] {
  if (hex.length !== NUM_HASHES * 8) return [];
  const out: number[] = [];
  for (let i = 0; i < NUM_HASHES; i++) {
    const chunk = hex.slice(i * 8, (i + 1) * 8);
    const n = Number.parseInt(chunk, 16);
    if (!Number.isFinite(n)) return [];
    out.push(n >>> 0);
  }
  return out;
}

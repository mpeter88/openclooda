/**
 * MinHash signature implementation — mirror of
 * extensions/memory-ooda/min-hash.ts.
 *
 * Why duplicated (not shared):
 *   Extensions cannot reliably depend on a workspace:* package at runtime —
 *   per CLAUDE.md, plugin install runs `npm install --omit=dev` in the plugin
 *   directory, and workspace:* in dependencies breaks npm install. Options
 *   considered + rejected:
 *     - Shared workspace package in `packages/ooda-shared/`: breaks the npm
 *       install invariant above; would require vendoring the source into each
 *       plugin at build time, which trades duplication at edit time for
 *       duplication at build time (worse).
 *     - Subpath export on openclaw/plugin-sdk: plugin-sdk is a public API
 *       surface; MinHash is a specific internal helper, not a platform
 *       contract. Wrong layer.
 *     - Copy once into a shared import path + require both plugins to use it:
 *       same problem as workspace:*.
 *
 * Mitigation: min-hash-contract.test.ts (in memory-ooda) asserts byte-identical
 * output from this file and memory-ooda/min-hash.ts on a 20-fixture corpus.
 * Any drift — even a one-character change — fails CI.
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

function hash32(str: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

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

export function minhashJaccard(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) matches++;
  }
  return matches / a.length;
}

export function serializeSignature(sig: number[]): string {
  return sig.map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
}

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

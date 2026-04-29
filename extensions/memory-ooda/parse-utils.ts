/**
 * Shared parsing utilities for OODA agent modules.
 *
 * Extracted from triage, strategy, archivist, and meta-reviewer
 * to avoid duplicating the same logic in 4 files.
 */

/**
 * Extract a human-readable message from an unknown error value.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return JSON.stringify(err);
}

/**
 * Strip Markdown code fences from model output.
 * Handles ```json ... ``` and bare ``` ... ``` wrapping.
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  // Fast path: no fences at all
  if (!trimmed.includes("```")) return trimmed;
  // Extract the outermost JSON object — find first { and last }
  // Handles any wrapping (```json, ```, explanation before/after, nested fences)
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    return trimmed.slice(first, last + 1);
  }
  // No JSON object found — strip the fence markers and return whatever's inside
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

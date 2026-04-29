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
  // Primary: anchored full-string fence (model output is only the fenced block)
  const anchored = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (anchored) {
    return (anchored[1] ?? "").trim();
  }
  // Fallback: extract the first fenced block even if there's surrounding text
  // (model prefixed with explanation or appended a note after the closing fence)
  const inner = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (inner) {
    return (inner[1] ?? "").trim();
  }
  return trimmed;
}

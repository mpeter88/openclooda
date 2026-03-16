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
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (match) {
    return (match[1] ?? "").trim();
  }
  return trimmed;
}

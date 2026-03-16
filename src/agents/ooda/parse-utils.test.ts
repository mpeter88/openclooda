import { describe, expect, it } from "vitest";
import { stripCodeFences } from "./parse-utils.js";

describe("stripCodeFences", () => {
  it("returns plain text unchanged", () => {
    expect(stripCodeFences('{"key": "value"}')).toBe('{"key": "value"}');
  });

  it("strips ```json fences", () => {
    expect(stripCodeFences('```json\n{"key": "value"}\n```')).toBe('{"key": "value"}');
  });

  it("strips bare ``` fences", () => {
    expect(stripCodeFences("```\n[1, 2, 3]\n```")).toBe("[1, 2, 3]");
  });

  it("trims whitespace", () => {
    expect(stripCodeFences("  \n  hello  \n  ")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(stripCodeFences("")).toBe("");
  });

  it("handles code fences with extra whitespace", () => {
    expect(stripCodeFences("```json  \n  content  \n  ```")).toBe("content");
  });
});

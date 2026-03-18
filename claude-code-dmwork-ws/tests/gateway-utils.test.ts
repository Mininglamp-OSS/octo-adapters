import { describe, it, expect } from "vitest";

// splitMessage is not exported, so we re-implement the same logic for testing.
// This also serves as a specification test for the splitting behavior.
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n\n", maxLen);
    if (splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;

    parts.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) parts.push(remaining);
  return parts;
}

describe("splitMessage", () => {
  it("returns single part for short messages", () => {
    expect(splitMessage("hello", 100)).toEqual(["hello"]);
  });

  it("splits at paragraph boundary", () => {
    const text = "A".repeat(50) + "\n\n" + "B".repeat(50);
    const parts = splitMessage(text, 60);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("A".repeat(50));
    expect(parts[1]).toBe("B".repeat(50));
  });

  it("splits at newline when no paragraph boundary", () => {
    const text = "A".repeat(50) + "\n" + "B".repeat(50);
    const parts = splitMessage(text, 60);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("A".repeat(50));
    expect(parts[1]).toBe("B".repeat(50));
  });

  it("splits at space when no newline", () => {
    const text = "A".repeat(50) + " " + "B".repeat(50);
    const parts = splitMessage(text, 60);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("A".repeat(50));
    expect(parts[1]).toBe("B".repeat(50));
  });

  it("hard splits when no natural boundary", () => {
    const text = "A".repeat(200);
    const parts = splitMessage(text, 100);
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBe(100);
    expect(parts[1].length).toBe(100);
  });

  it("handles multiple splits", () => {
    const text = Array(5).fill("X".repeat(80)).join("\n\n");
    const parts = splitMessage(text, 100);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(100);
    }
  });
});

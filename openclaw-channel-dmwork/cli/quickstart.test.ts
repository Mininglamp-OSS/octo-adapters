import { describe, it, expect } from "vitest";
import { normalizeUsername } from "./quickstart.js";

describe("normalizeUsername", () => {
  it("plain ascii id", () => {
    expect(normalizeUsername("main")).toBe("main_bot");
  });

  it("already has _bot suffix — no double suffix", () => {
    expect(normalizeUsername("main_bot")).toBe("main_bot");
  });

  it("mixed case normalized to lowercase", () => {
    expect(normalizeUsername("MyAgent")).toBe("myagent_bot");
  });

  it("hyphens and spaces stripped", () => {
    expect(normalizeUsername("My-Agent")).toBe("myagent_bot");
  });

  it("all CJK characters → fallback to agent", () => {
    expect(normalizeUsername("机器人")).toBe("agent_bot");
  });

  it("all symbols → fallback to agent", () => {
    expect(normalizeUsername("!!!")).toBe("agent_bot");
  });

  it("all underscores — kept, not empty", () => {
    expect(normalizeUsername("___")).toBe("____bot");
  });

  it("long id truncated to leave room for suffix", () => {
    const long = "a".repeat(30);
    const result = normalizeUsername(long);
    expect(result).toBe("a".repeat(17) + "_bot");
    expect(result.length).toBeLessThanOrEqual(21); // 17 + len("_bot")
  });

  it("long id with _bot suffix — truncated correctly", () => {
    const long = "a".repeat(20) + "_bot";
    const result = normalizeUsername(long);
    expect(result.length).toBeLessThanOrEqual(21);
    expect(result.endsWith("_bot")).toBe(true);
  });

  it("leading/trailing whitespace trimmed", () => {
    expect(normalizeUsername("  agent  ")).toBe("agent_bot");
  });
});

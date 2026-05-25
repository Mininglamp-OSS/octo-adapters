import { describe, it, expect } from "vitest";
import { validateAccountId } from "./utils.js";

describe("validateAccountId", () => {
  it("should accept valid IDs", () => {
    expect(validateAccountId("my_bot")).toBe(true);
    expect(validateAccountId("Bot123")).toBe(true);
    expect(validateAccountId("a")).toBe(true);
    expect(validateAccountId("test_bot_2")).toBe(true);
  });

  it("should reject invalid IDs", () => {
    expect(validateAccountId("")).toBe(false);
    expect(validateAccountId("my-bot")).toBe(false);
    expect(validateAccountId("my bot")).toBe(false);
    expect(validateAccountId("bot.name")).toBe(false);
    expect(validateAccountId("bot/name")).toBe(false);
    expect(validateAccountId("bot@name")).toBe(false);
  });
});

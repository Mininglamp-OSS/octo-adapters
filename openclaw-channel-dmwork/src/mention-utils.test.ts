import { describe, it, expect } from "vitest";
import { parseMentions, extractMentionMatches, MENTION_PATTERN } from "./mention-utils.js";

/**
 * Tests for shared @mention parsing utilities.
 * Verifies consistent behavior across different mention formats.
 *
 * Fixes: https://github.com/Mininglamp-OSS/octo-adapters/issues/31
 */
describe("parseMentions", () => {
  it("should parse English alphanumeric mentions", () => {
    const result = parseMentions("Hello @user123 and @test_user!");
    expect(result).toEqual(["user123", "test_user"]);
  });

  it("should parse Chinese character mentions", () => {
    const result = parseMentions("你好 @陈皮皮 请回复");
    expect(result).toEqual(["陈皮皮"]);
  });

  it("should parse mixed Chinese and English mentions", () => {
    const result = parseMentions("@陈皮皮 @bob_123 @托马斯");
    expect(result).toEqual(["陈皮皮", "bob_123", "托马斯"]);
  });

  it("should parse mentions with dots", () => {
    const result = parseMentions("Hi @thomas.ford how are you?");
    expect(result).toEqual(["thomas.ford"]);
  });

  it("should parse mentions with hyphens", () => {
    const result = parseMentions("CC @user-name please");
    expect(result).toEqual(["user-name"]);
  });

  it("should parse complex mixed mentions", () => {
    const result = parseMentions("@陈皮皮_test @user.name-123 @普通用户");
    expect(result).toEqual(["陈皮皮_test", "user.name-123", "普通用户"]);
  });

  it("should return empty array for no mentions", () => {
    const result = parseMentions("Hello world! No mentions here.");
    expect(result).toEqual([]);
  });

  it("should handle @all-like patterns", () => {
    const result = parseMentions("@all please check @everyone");
    expect(result).toEqual(["all", "everyone"]);
  });

  it("should handle mentions at start and end", () => {
    const result = parseMentions("@start middle @end");
    expect(result).toEqual(["start", "end"]);
  });

  it("should handle consecutive mentions", () => {
    const result = parseMentions("@user1@user2@user3");
    expect(result).toEqual(["user1", "user2", "user3"]);
  });
});

describe("extractMentionMatches", () => {
  it("should return matches with @ prefix", () => {
    const result = extractMentionMatches("Hello @陈皮皮 and @bob!");
    expect(result).toEqual(["@陈皮皮", "@bob"]);
  });

  it("should return empty array for no mentions", () => {
    const result = extractMentionMatches("No mentions");
    expect(result).toEqual([]);
  });
});

describe("MENTION_PATTERN", () => {
  it("should be a valid regex", () => {
    expect(MENTION_PATTERN).toBeInstanceOf(RegExp);
  });

  it("should have global flag", () => {
    expect(MENTION_PATTERN.flags).toContain("g");
  });

  it("should match Chinese characters (CJK range)", () => {
    // Test the pattern directly
    const testStr = "@中文名字";
    const regex = new RegExp(MENTION_PATTERN.source, "g");
    const match = testStr.match(regex);
    expect(match).toEqual(["@中文名字"]);
  });

  it("should match underscores", () => {
    const testStr = "@user_name_123";
    const regex = new RegExp(MENTION_PATTERN.source, "g");
    const match = testStr.match(regex);
    expect(match).toEqual(["@user_name_123"]);
  });
});

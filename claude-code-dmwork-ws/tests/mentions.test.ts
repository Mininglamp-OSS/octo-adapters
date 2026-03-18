import { describe, it, expect } from "vitest";
import { parseMentions, extractMentionMatches } from "../src/dmwork/mentions.js";

describe("parseMentions", () => {
  it("extracts single mention", () => {
    expect(parseMentions("hello @alice")).toEqual(["alice"]);
  });

  it("extracts multiple mentions", () => {
    expect(parseMentions("@alice @bob please review")).toEqual(["alice", "bob"]);
  });

  it("handles Chinese names", () => {
    expect(parseMentions("@小明 你好")).toEqual(["小明"]);
  });

  it("handles names with dots and hyphens", () => {
    expect(parseMentions("@user.name @another-user")).toEqual(["user.name", "another-user"]);
  });

  it("returns empty array when no mentions", () => {
    expect(parseMentions("no mentions here")).toEqual([]);
  });

  it("handles empty string", () => {
    expect(parseMentions("")).toEqual([]);
  });
});

describe("extractMentionMatches", () => {
  it("returns raw matches with @ prefix", () => {
    expect(extractMentionMatches("@alice @bob")).toEqual(["@alice", "@bob"]);
  });

  it("returns empty array when no matches", () => {
    expect(extractMentionMatches("plain text")).toEqual([]);
  });
});

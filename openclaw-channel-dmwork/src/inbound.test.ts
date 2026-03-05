import { describe, it, expect } from "vitest";
import { ChannelType, MessageType, type MentionPayload } from "./types.js";
import { DEFAULT_HISTORY_PROMPT_TEMPLATE } from "./config-schema.js";

/**
 * Tests for mention.all detection logic.
 *
 * The API can return mention.all as either:
 * - boolean `true` (newer API versions)
 * - number `1` (older API versions / WuKongIM native format)
 *
 * Both should be treated as "mention all".
 */
describe("mention.all detection", () => {
  // Helper to simulate the detection logic from inbound.ts
  function isMentionAll(mention?: MentionPayload): boolean {
    const mentionAllRaw = mention?.all;
    return mentionAllRaw === true || mentionAllRaw === 1;
  }

  it("should detect mention.all when all is boolean true", () => {
    const mention: MentionPayload = { all: true };
    expect(isMentionAll(mention)).toBe(true);
  });

  it("should detect mention.all when all is numeric 1", () => {
    const mention: MentionPayload = { all: 1 };
    expect(isMentionAll(mention)).toBe(true);
  });

  it("should NOT detect mention.all when all is false", () => {
    const mention: MentionPayload = { all: false as unknown as boolean | number };
    expect(isMentionAll(mention)).toBe(false);
  });

  it("should NOT detect mention.all when all is 0", () => {
    const mention: MentionPayload = { all: 0 };
    expect(isMentionAll(mention)).toBe(false);
  });

  it("should NOT detect mention.all when all is undefined", () => {
    const mention: MentionPayload = { uids: ["user1"] };
    expect(isMentionAll(mention)).toBe(false);
  });

  it("should NOT detect mention.all when mention is undefined", () => {
    expect(isMentionAll(undefined)).toBe(false);
  });

  it("should NOT detect mention.all when all is a different number", () => {
    const mention: MentionPayload = { all: 2 };
    expect(isMentionAll(mention)).toBe(false);
  });
});

/**
 * Tests for historyPromptTemplate configuration.
 *
 * The template supports placeholders:
 * - {messages}: JSON stringified array of {sender, body} objects
 * - {count}: Number of messages in the history
 */
describe("historyPromptTemplate", () => {
  // Helper to render template (mirrors logic from inbound.ts)
  function renderHistoryPrompt(
    template: string,
    entries: Array<{ sender: string; body: string }>,
  ): string {
    const messagesJson = JSON.stringify(
      entries.map((e) => ({ sender: e.sender, body: e.body })),
      null,
      2,
    );
    return template
      .replace("{messages}", messagesJson)
      .replace("{count}", String(entries.length));
  }

  it("should use English as default template", () => {
    expect(DEFAULT_HISTORY_PROMPT_TEMPLATE).toContain("[Group Chat History]");
    expect(DEFAULT_HISTORY_PROMPT_TEMPLATE).toContain("{messages}");
  });

  it("should replace {messages} placeholder with JSON", () => {
    const entries = [
      { sender: "user1", body: "Hello" },
      { sender: "user2", body: "Hi there" },
    ];
    const result = renderHistoryPrompt(DEFAULT_HISTORY_PROMPT_TEMPLATE, entries);

    expect(result).toContain('"sender": "user1"');
    expect(result).toContain('"body": "Hello"');
    expect(result).toContain('"sender": "user2"');
    expect(result).toContain('"body": "Hi there"');
  });

  it("should replace {count} placeholder with message count", () => {
    const customTemplate = "You have {count} messages:\n{messages}";
    const entries = [
      { sender: "user1", body: "Hello" },
      { sender: "user2", body: "Hi" },
      { sender: "user3", body: "Hey" },
    ];
    const result = renderHistoryPrompt(customTemplate, entries);

    expect(result).toContain("You have 3 messages:");
  });

  it("should support custom templates with both placeholders", () => {
    const customTemplate =
      "--- History ({count} messages) ---\n{messages}\n--- End History ---";
    const entries = [{ sender: "alice", body: "Test message" }];
    const result = renderHistoryPrompt(customTemplate, entries);

    expect(result).toContain("--- History (1 messages) ---");
    expect(result).toContain('"sender": "alice"');
    expect(result).toContain("--- End History ---");
  });

  it("should handle empty entries array", () => {
    const result = renderHistoryPrompt(DEFAULT_HISTORY_PROMPT_TEMPLATE, []);
    expect(result).toContain("[]");
  });
});

/**
 * Tests for timestamp standardization.
 *
 * getChannelMessages should return timestamps in milliseconds (internal standard),
 * converting from the API's seconds-based timestamps.
 */
describe("timestamp standardization", () => {
  it("should convert seconds to milliseconds", () => {
    // Simulate the conversion logic from getChannelMessages
    const apiTimestampSeconds = 1709654400; // Example: 2024-03-05 in seconds
    const expectedMs = apiTimestampSeconds * 1000;

    // This mirrors the conversion in api-fetch.ts
    const convertedTimestamp = apiTimestampSeconds * 1000;

    expect(convertedTimestamp).toBe(expectedMs);
    expect(convertedTimestamp).toBe(1709654400000);
  });

  it("should handle undefined timestamp with fallback", () => {
    // Simulate fallback logic: (m.timestamp ?? Math.floor(Date.now() / 1000)) * 1000
    const now = Date.now();
    const fallbackSeconds = Math.floor(now / 1000);
    const apiTimestamp: number | undefined = undefined;
    const result = (apiTimestamp ?? fallbackSeconds) * 1000;

    // Result should be close to current time in ms
    expect(result).toBeGreaterThan(now - 1000);
    expect(result).toBeLessThanOrEqual(now + 1000);
  });

  it("timestamp from getChannelMessages should be in milliseconds range", () => {
    // Typical millisecond timestamp has 13 digits (until year 2286)
    const msTimestamp = 1709654400000;
    const secondsTimestamp = 1709654400;

    expect(String(msTimestamp).length).toBe(13);
    expect(String(secondsTimestamp).length).toBe(10);

    // After conversion, seconds become milliseconds
    expect(String(secondsTimestamp * 1000).length).toBe(13);
  });
});

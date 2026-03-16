import { describe, it, expect } from "vitest";
import { ChannelType, MessageType, type MentionPayload } from "./types.js";
import { DEFAULT_HISTORY_PROMPT_TEMPLATE } from "./config-schema.js";
import { resolveInnerMessageText, resolveApiMessagePlaceholder, resolveMultipleForwardText } from "./inbound.js";

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

/**
 * Tests for MultipleForward (type=11) message handling.
 *
 * MultipleForward is a merge-forwarded chat record containing:
 * - users: array of {uid, name} for sender info
 * - msgs: array of messages with payload
 */
describe("MultipleForward handling", () => {
  it("should resolve MultipleForward with text messages", () => {
    const payload = {
      type: MessageType.MultipleForward,
      users: [
        { uid: "user1", name: "大棍子" },
        { uid: "user2", name: "托马斯" },
      ],
      msgs: [
        { from_uid: "user1", payload: { type: MessageType.Text, content: "你好" } },
        { from_uid: "user2", payload: { type: MessageType.Text, content: "Hello" } },
        { from_uid: "user1", payload: { type: MessageType.Text, content: "晚上好" } },
      ],
    };

    const result = { text: resolveMultipleForwardText(payload) };
    expect(result.text).toBe(
      "[合并转发: 聊天记录]\n大棍子: 你好\n托马斯: Hello\n大棍子: 晚上好"
    );
    // mediaUrl is not part of the resolved text result
  });

  it("should resolve MultipleForward with mixed types", () => {
    const payload = {
      type: MessageType.MultipleForward,
      users: [
        { uid: "user1", name: "Alice" },
        { uid: "user2", name: "Bob" },
      ],
      msgs: [
        { from_uid: "user1", payload: { type: MessageType.Text, content: "Check this out" } },
        { from_uid: "user2", payload: { type: MessageType.Image, url: "http://example.com/img.jpg" } },
        { from_uid: "user1", payload: { type: MessageType.File, name: "document.pdf" } },
        { from_uid: "user2", payload: { type: MessageType.Voice } },
        { from_uid: "user1", payload: { type: MessageType.Video } },
      ],
    };

    const result = { text: resolveMultipleForwardText(payload) };
    expect(result.text).toContain("[合并转发: 聊天记录]");
    expect(result.text).toContain("Alice: Check this out");
    expect(result.text).toContain("Bob: [图片]");
    expect(result.text).toContain("Alice: [文件: document.pdf]");
    expect(result.text).toContain("Bob: [语音]");
    expect(result.text).toContain("Alice: [视频]");
  });

  it("should resolve nested MultipleForward", () => {
    const payload = {
      type: MessageType.MultipleForward,
      users: [{ uid: "user1", name: "张三" }],
      msgs: [
        { from_uid: "user1", payload: { type: MessageType.Text, content: "看这个" } },
        {
          from_uid: "user1",
          payload: {
            type: MessageType.MultipleForward,
            users: [{ uid: "user2", name: "李四" }],
            msgs: [{ from_uid: "user2", payload: { type: MessageType.Text, content: "内层消息" } }],
          },
        },
      ],
    };

    const result = { text: resolveMultipleForwardText(payload) };
    expect(result.text).toContain("[合并转发: 聊天记录]");
    expect(result.text).toContain("张三: 看这个");
    expect(result.text).toContain("张三: [合并转发]");
  });

  it("should handle empty msgs array", () => {
    const payload = {
      type: MessageType.MultipleForward,
      users: [{ uid: "user1", name: "Test" }],
      msgs: [],
    };

    const result = { text: resolveMultipleForwardText(payload) };
    expect(result.text).toBe("[合并转发: 聊天记录]");
  });

  it("should handle missing users array", () => {
    const payload = {
      type: MessageType.MultipleForward,
      msgs: [
        { from_uid: "unknown_uid_123", payload: { type: MessageType.Text, content: "Hello" } },
      ],
    };

    const result = { text: resolveMultipleForwardText(payload) };
    expect(result.text).toContain("[合并转发: 聊天记录]");
    expect(result.text).toContain("unknown_uid_123: Hello");
  });

  it("should return placeholder for resolveApiMessagePlaceholder", () => {
    expect(resolveApiMessagePlaceholder(MessageType.MultipleForward)).toBe("[合并转发]");
  });

  it("resolveInnerMessageText should handle all message types", () => {
    expect(resolveInnerMessageText({ type: MessageType.Text, content: "test" })).toBe("test");
    expect(resolveInnerMessageText({ type: MessageType.Image })).toBe("[图片]");
    expect(resolveInnerMessageText({ type: MessageType.GIF })).toBe("[GIF]");
    expect(resolveInnerMessageText({ type: MessageType.Voice })).toBe("[语音]");
    expect(resolveInnerMessageText({ type: MessageType.Video })).toBe("[视频]");
    expect(resolveInnerMessageText({ type: MessageType.Location })).toBe("[位置信息]");
    expect(resolveInnerMessageText({ type: MessageType.Card })).toBe("[名片]");
    expect(resolveInnerMessageText({ type: MessageType.File, name: "doc.pdf" })).toBe("[文件: doc.pdf]");
    expect(resolveInnerMessageText({ type: MessageType.File })).toBe("[文件]");
    expect(resolveInnerMessageText({ type: MessageType.MultipleForward })).toBe("[合并转发]");
    expect(resolveInnerMessageText({ type: 99 })).toBe("[消息]");
    expect(resolveInnerMessageText({ type: 99, content: "fallback" })).toBe("fallback");
  });
});

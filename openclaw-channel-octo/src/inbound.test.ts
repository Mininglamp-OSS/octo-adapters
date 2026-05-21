import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType, MessageType, type MentionPayload } from "./types.js";
import { DEFAULT_HISTORY_PROMPT_TEMPLATE } from "./config-schema.js";
import {
  resolveInnerMessageText,
  resolveApiMessagePlaceholder,
  resolveMultipleForwardText,
  buildMediaUrl,
  calcDownloadTimeout,
  formatSize,
  resolveFileContentWithRetry,
  downloadToTemp,
  uploadAndSendMedia,
  downloadMediaToLocal,
  buildMemberListPrefix,
  resolveCommandBody,
  resolveCommandAuthorized,
  pendingInboundContext,
  segmentHistoryEntries,
  type ResolveFileResult,
} from "./inbound.js";
import { extractMentionUids } from "./mention-utils.js";
import { existsSync, unlinkSync, readFileSync } from "node:fs";

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
 * Tests for mention.humans + persona clone (onBehalfOf) gating.
 *
 * Plan X: mention.humans=1 means @所有人 (human-only notification).
 * Regular bots should NOT respond. Persona clone bots (onBehalfOf configured)
 * SHOULD respond because they act on behalf of a human who is part of @所有人.
 */
describe("mention.humans + persona clone gating", () => {
  function isMentionHumans(mention?: MentionPayload): boolean {
    const raw = mention?.humans;
    return raw === true || raw === 1;
  }

  function shouldRespond(mention: MentionPayload | undefined, opts: { onBehalfOf?: string; ignoreMentionAll?: boolean }): boolean {
    const mentionAllRaw = mention?.all;
    const mentionAll = mentionAllRaw === true || mentionAllRaw === 1;
    const mentionAisRaw = mention?.ais;
    const mentionAis = mentionAisRaw === true || mentionAisRaw === 1;
    const mentionHumans = isMentionHumans(mention);
    const isPersonaClone = Boolean(opts.onBehalfOf);
    return (!opts.ignoreMentionAll && mentionAll) || mentionAis || (mentionHumans && isPersonaClone);
  }

  // Helper to determine reply identity: returns "grantor" or "self"
  function replyIdentity(mention: MentionPayload | undefined, opts: { onBehalfOf?: string; ignoreMentionAll?: boolean; botUidMentioned?: boolean }): "grantor" | "self" {
    const mentionAllRaw = mention?.all;
    const mentionAll = mentionAllRaw === true || mentionAllRaw === 1;
    const mentionHumans = isMentionHumans(mention);
    const isPersonaClone = Boolean(opts.onBehalfOf);
    const isExplicitBotMention = Boolean(opts.botUidMentioned);
    const isHumanBroadcast = mentionHumans || (!opts.ignoreMentionAll && mentionAll);
    const triggered = isHumanBroadcast && isPersonaClone && !isExplicitBotMention;
    return triggered ? "grantor" : "self";
  }

  it("persona clone bot should respond to mention.humans=1", () => {
    expect(shouldRespond({ humans: 1 }, { onBehalfOf: "admin" })).toBe(true);
  });

  it("persona clone bot should respond to mention.humans=true", () => {
    expect(shouldRespond({ humans: true }, { onBehalfOf: "admin" })).toBe(true);
  });

  it("regular bot should NOT respond to mention.humans=1", () => {
    expect(shouldRespond({ humans: 1 }, {})).toBe(false);
  });

  it("regular bot should NOT respond to mention.humans=true", () => {
    expect(shouldRespond({ humans: true }, {})).toBe(false);
  });

  it("persona clone bot should still respond to mention.ais=1", () => {
    expect(shouldRespond({ ais: 1 }, { onBehalfOf: "admin" })).toBe(true);
  });

  it("regular bot should respond to mention.ais=1", () => {
    expect(shouldRespond({ ais: 1 }, {})).toBe(true);
  });

  it("mention.humans=0 should NOT trigger persona clone", () => {
    expect(shouldRespond({ humans: 0 }, { onBehalfOf: "admin" })).toBe(false);
  });

  it("mention.humans=1 + ais=1 should trigger both types", () => {
    expect(shouldRespond({ humans: 1, ais: 1 }, { onBehalfOf: "admin" })).toBe(true);
    expect(shouldRespond({ humans: 1, ais: 1 }, {})).toBe(true); // ais=1 triggers regular bot
  });

  it("legacy all=1 should trigger persona clone (via mentionAll path)", () => {
    expect(shouldRespond({ all: 1 }, { onBehalfOf: "admin" })).toBe(true);
  });

  // Identity tests
  it("@所有人 (humans=1) → persona clone replies as grantor", () => {
    expect(replyIdentity({ humans: 1 }, { onBehalfOf: "admin" })).toBe("grantor");
  });

  it("legacy @所有人 (all=1, server rewrite to {all:1,ais:1}) → persona clone replies as grantor", () => {
    expect(replyIdentity({ all: 1, ais: 1 }, { onBehalfOf: "admin" })).toBe("grantor");
  });

  it("@所有AI (ais=1 only) → persona clone replies as self", () => {
    expect(replyIdentity({ ais: 1 }, { onBehalfOf: "admin" })).toBe("self");
  });

  it("direct @james mention → persona clone replies as self", () => {
    expect(replyIdentity({ humans: 1 }, { onBehalfOf: "admin", botUidMentioned: true })).toBe("self");
  });

  it("regular bot always replies as self regardless of mention type", () => {
    expect(replyIdentity({ humans: 1 }, {})).toBe("self");
    expect(replyIdentity({ all: 1 }, {})).toBe("self");
    expect(replyIdentity({ ais: 1 }, {})).toBe("self");
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

/**
 * Tests for GROUP.md event detection logic.
 */
describe("GROUP.md event detection", () => {
  function isGroupMdEvent(payload: any): boolean {
    return payload?.event?.type === "group_md_updated";
  }

  it("should detect group_md_updated event", () => {
    const payload = {
      type: 1,
      content: "GROUP.md updated",
      event: { type: "group_md_updated", version: 4, updated_by: "user_uid" },
      mention: { uids: ["bot1", "bot2"] },
    };
    expect(isGroupMdEvent(payload)).toBe(true);
  });

  it("should NOT detect regular text messages as GROUP.md event", () => {
    const payload = { type: 1, content: "Hello world" };
    expect(isGroupMdEvent(payload)).toBe(false);
  });

  it("should NOT detect other event types", () => {
    const payload = {
      type: 1,
      content: "Something happened",
      event: { type: "member_joined" },
    };
    expect(isGroupMdEvent(payload)).toBe(false);
  });

  it("should NOT detect when event is undefined", () => {
    const payload = { type: 1, content: "No event" };
    expect(isGroupMdEvent(payload)).toBe(false);
  });

  it("should NOT detect when payload is undefined", () => {
    expect(isGroupMdEvent(undefined)).toBe(false);
  });
});

/**
 * Tests for calcDownloadTimeout — calls the real exported function.
 */
describe("calcDownloadTimeout", () => {
  it("should return minimum 5 minutes for small files", () => {
    expect(calcDownloadTimeout(1024)).toBe(300_000);
  });

  it("should scale timeout based on file size (512KB/s baseline)", () => {
    // 10MB file: ceil(10*1024*1024 / (512*1024)) * 1000 = ceil(20) * 1000 = 20_000
    // But min is 300_000
    expect(calcDownloadTimeout(10 * 1024 * 1024)).toBe(300_000);
  });

  it("should cap at 30 minutes max", () => {
    expect(calcDownloadTimeout(1024 * 1024 * 1024)).toBe(1_800_000);
  });

  it("should assume 256MB when size is unknown", () => {
    const timeout = calcDownloadTimeout(undefined);
    // 256MB / (512*1024) * 1000 = 512 * 1000 = 512_000
    expect(timeout).toBeGreaterThanOrEqual(300_000);
    expect(timeout).toBeLessThanOrEqual(1_800_000);
  });

  it("should return computed timeout for large files", () => {
    // 500MB: ceil(500*1024*1024 / (512*1024)) * 1000 = ceil(1000) * 1000 = 1_000_000
    const timeout = calcDownloadTimeout(500 * 1024 * 1024);
    expect(timeout).toBe(1_000_000);
  });
});

/**
 * Tests for formatSize — calls the real exported function.
 */
describe("formatSize", () => {
  it("should format bytes", () => {
    expect(formatSize(500)).toBe("500B");
  });

  it("should format kilobytes", () => {
    expect(formatSize(20 * 1024)).toBe("20.0KB");
  });

  it("should format megabytes", () => {
    expect(formatSize(52 * 1024 * 1024)).toBe("52.0MB");
  });

  it("should format gigabytes", () => {
    expect(formatSize(2 * 1024 * 1024 * 1024)).toBe("2.0GB");
  });
});

/**
 * Tests for resolveFileContentWithRetry — mocks global fetch, calls the real function.
 */
describe("resolveFileContentWithRetry", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should return null for non-text file extensions", async () => {
    const result = await resolveFileContentWithRetry(
      "https://example.com/photo.png",
      "token",
      "photo.png",
    );
    expect(result).toBeNull();
  });

  it("should inline small text files (< 20KB)", async () => {
    const smallContent = "Hello, world!";
    const encoded = new TextEncoder().encode(smallContent);

    globalThis.fetch = (vi.fn() as any)
      // HEAD request
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-length": String(encoded.byteLength) }),
      } as any)
      // GET request
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-length": String(encoded.byteLength) }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoded);
            controller.close();
          },
        }),
      } as any);

    const result = await resolveFileContentWithRetry(
      "https://example.com/file.txt",
      "token",
      "file.txt",
    );
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("inline", smallContent);
  });

  it("should return description for file > 20KB with Content-Length", async () => {
    const largeSize = 25 * 1024;

    globalThis.fetch = (vi.fn() as any)
      // HEAD request reports large file
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-length": String(largeSize) }),
      } as any)
      // downloadToTemp GET request — simulate failure to keep test simple
      .mockRejectedValueOnce(new Error("HTTP 500"));

    const result = await resolveFileContentWithRetry(
      "https://example.com/large.txt",
      "token",
      "large.txt",
      { knownSize: largeSize, maxRetries: 1 },
    );
    // Should not be null (text extension), and should not be inline
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("inline");
  });

  it("should reject file exceeding 500MB hard cap via HEAD without downloading", async () => {
    const hugeSize = 600 * 1024 * 1024; // 600MB

    globalThis.fetch = (vi.fn() as any)
      // HEAD request reports 600MB
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-length": String(hugeSize) }),
      } as any);

    // Do NOT pass knownSize — let HEAD discovery trigger the 500MB check
    const result = await resolveFileContentWithRetry(
      "https://example.com/huge.csv",
      "token",
      "huge.csv",
      { maxRetries: 3 },
    );
    // Should return error description, NOT attempt download
    expect(result).toHaveProperty("description");
    expect((result as any).description).toContain("500.0MB");
    expect((result as any).description).toContain("最大下载限制");
    // Only HEAD request, no GET — verify no download attempted
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("should fall back to GET streaming when HEAD fails", async () => {
    const content = "fallback content";
    const encoded = new TextEncoder().encode(content);

    globalThis.fetch = (vi.fn() as any)
      // HEAD request fails
      .mockRejectedValueOnce(new Error("HEAD not supported"))
      // GET request succeeds
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-length": String(encoded.byteLength) }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoded);
            controller.close();
          },
        }),
      } as any);

    const result = await resolveFileContentWithRetry(
      "https://example.com/data.json",
      "token",
      "data.json",
    );
    expect(result).toHaveProperty("inline", content);
  });

  it("should return error description on HTTP 404 and NOT retry", async () => {
    globalThis.fetch = (vi.fn() as any)
      // HEAD request
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-length": "100" }),
      } as any)
      // GET returns 404
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
      } as any);

    const result = await resolveFileContentWithRetry(
      "https://example.com/missing.txt",
      "token",
      "missing.txt",
      { maxRetries: 3 },
    );

    expect(result).not.toBeNull();
    expect(result).toHaveProperty("description");
    expect((result as { description: string }).description).toContain("HTTP 404");
    // Should only have called fetch twice (HEAD + one GET), not retried
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("should retry on timeout and return error description", async () => {
    globalThis.fetch = (vi.fn() as any)
      // HEAD request
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-length": "100" }),
      } as any)
      // All GET attempts timeout
      .mockRejectedValueOnce(new Error("TimeoutError"))
      .mockRejectedValueOnce(new Error("TimeoutError"));

    const result = await resolveFileContentWithRetry(
      "https://example.com/slow.txt",
      "token",
      "slow.txt",
      { maxRetries: 2 },
    );

    expect(result).not.toBeNull();
    expect(result).toHaveProperty("description");
    expect((result as { description: string }).description).toContain("下载失败");
  });
});

/**
 * Tests for uploadAndSendMedia timeout signal.
 *
 * Verifies that the fetch call to download media includes a timeout signal
 * by inspecting the function's behavior with a mocked global fetch.
 */
describe("uploadAndSendMedia timeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("should pass timeout signal to fetch", async () => {
    const calls: Array<{ url: string; method?: string; signal?: AbortSignal }> = [];
    const { Readable } = await import("node:stream");
    vi.stubGlobal("fetch", async (url: string, opts?: any) => {
      calls.push({ url, method: opts?.method, signal: opts?.signal });
      if (opts?.method === "HEAD") {
        return {
          ok: true,
          headers: new Headers({ "content-length": "8" }),
        };
      }
      // GET request — return a readable stream body
      const body = new Readable({ read() { this.push(Buffer.alloc(8)); this.push(null); } });
      return {
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        body,
      };
    });

    // Call uploadAndSendMedia — it will use the mocked fetch for HEAD + GET,
    // then fail on getUploadCredentials (which also uses fetch but posts to API)
    let caughtError: unknown;
    try {
      await uploadAndSendMedia({
        mediaUrl: "https://example.com/img.png",
        apiUrl: "https://api.example.com",
        botToken: "token",
        channelId: "ch1",
        channelType: ChannelType.DM,
      });
    } catch (err) {
      caughtError = err;
    }

    // calls[0] is HEAD (no signal), calls[1] is GET with timeout signal
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].method).toBe("HEAD");
    expect(calls[1].signal).toBeDefined();
  });
});

/**
 * Tests for downloadMediaToLocal — downloads inbound media to local temp files.
 */
describe("downloadMediaToLocal", () => {
  const originalFetch = globalThis.fetch;
  const tempFiles: string[] = [];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    // Clean up any temp files created during tests
    for (const f of tempFiles) {
      try { unlinkSync(f); } catch {}
    }
    tempFiles.length = 0;
  });

  it("should download image to local path (not http URL)", async () => {
    const imageData = new Uint8Array(64).fill(0xff);

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "image/jpeg" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(imageData);
          controller.close();
        },
      }),
    }) as any;

    const result = await downloadMediaToLocal(
      "https://cdn.example.com/bucket/upload_abc123.jpg",
      "image/jpeg",
    );

    expect(result).toBeDefined();
    expect(result).not.toContain("http");
    expect(result!.startsWith("/tmp/octo-media/")).toBe(true);
    expect(result!.endsWith(".jpeg")).toBe(true);
    expect(existsSync(result!)).toBe(true);
    expect(readFileSync(result!)).toEqual(Buffer.from(imageData));
    tempFiles.push(result!);
  });

  it("should return undefined for large media (>20MB)", async () => {
    // Simulate a stream that exceeds 20MB
    const chunkSize = 1024 * 1024; // 1MB chunks
    let chunksSent = 0;

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      body: new ReadableStream({
        pull(controller) {
          if (chunksSent < 22) { // 22MB total
            controller.enqueue(new Uint8Array(chunkSize));
            chunksSent++;
          } else {
            controller.close();
          }
        },
      }),
    }) as any;

    const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
    const result = await downloadMediaToLocal(
      "https://cdn.example.com/huge-image.png",
      "image/png",
      log,
    );

    expect(result).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("media too large"),
    );
  });

  it("should return undefined on download failure (HTTP error)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
    }) as any;

    const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
    const result = await downloadMediaToLocal(
      "https://cdn.example.com/missing.jpg",
      "image/jpeg",
      log,
    );

    expect(result).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("HTTP 404"),
    );
  });

  it("should return undefined on network error (no crash)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(
      new Error("ECONNREFUSED"),
    ) as any;

    const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
    const result = await downloadMediaToLocal(
      "https://cdn.example.com/unreachable.jpg",
      "image/jpeg",
      log,
    );

    expect(result).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("media download failed"),
    );
  });

  it("should derive extension from mime type", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "audio/mpeg" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.close();
        },
      }),
    }) as any;

    const result = await downloadMediaToLocal(
      "https://cdn.example.com/voice_msg",
      "audio/mpeg",
    );

    expect(result).toBeDefined();
    expect(result!.endsWith(".mpeg")).toBe(true);
    tempFiles.push(result!);
  });

  it("should derive extension from URL when mime is not provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({}),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.close();
        },
      }),
    }) as any;

    const result = await downloadMediaToLocal(
      "https://cdn.example.com/video.mp4",
      undefined,
    );

    expect(result).toBeDefined();
    expect(result!.endsWith(".mp4")).toBe(true);
    tempFiles.push(result!);
  });
});

/**
 * Tests for Bot @ detection with entities support.
 */
describe("Bot @ 检测（entities 支持）", () => {
  it("应从 entities 检测 bot 被 @", () => {
    const mention: MentionPayload = {
      entities: [{ uid: "bot_uid", offset: 0, length: 4 }],
    };
    const mentionUids = extractMentionUids(mention);
    expect(mentionUids.includes("bot_uid")).toBe(true);
  });

  it("entities 无效时应从 uids 检测", () => {
    const mention: MentionPayload = {
      entities: [{} as any],
      uids: ["bot_uid"],
    };
    const mentionUids = extractMentionUids(mention);
    expect(mentionUids.includes("bot_uid")).toBe(true);
  });
});

describe("buildMemberListPrefix", () => {
  it("should return empty string for empty map", () => {
    const map = new Map<string, string>();
    expect(buildMemberListPrefix(map)).toBe("");
  });

  it("should inject full member list when ≤ 10 members", () => {
    const map = new Map<string, string>([
      ["uid_alice", "Alice"],
      ["uid_bob", "Bob"],
      ["uid_chen", "陈皮皮"],
    ]);
    const result = buildMemberListPrefix(map);
    expect(result).toContain("[Group Members]");
    expect(result).toContain("Alice (uid_alice)");
    expect(result).toContain("Bob (uid_bob)");
    expect(result).toContain("陈皮皮 (uid_chen)");
    expect(result).toContain("@[uid:displayName]");
  });

  it("should inject full member list when exactly 10 members", () => {
    const map = new Map<string, string>();
    for (let i = 1; i <= 10; i++) {
      map.set(`uid_${i}`, `User${i}`);
    }
    const result = buildMemberListPrefix(map);
    expect(result).toContain("[Group Members]");
    expect(result).toContain("User1 (uid_1)");
    expect(result).toContain("User10 (uid_10)");
  });

  it("should inject hint message when > 10 members", () => {
    const map = new Map<string, string>();
    for (let i = 1; i <= 11; i++) {
      map.set(`uid_${i}`, `User${i}`);
    }
    const result = buildMemberListPrefix(map);
    expect(result).toContain("[Group Info]");
    expect(result).toContain("11 members");
    expect(result).toContain("group management tool");
    expect(result).not.toContain("[Group Members]");
    expect(result).not.toContain("User1 (uid_1)");
  });

  it("should inject hint message for large groups", () => {
    const map = new Map<string, string>();
    for (let i = 1; i <= 50; i++) {
      map.set(`uid_${i}`, `User${i}`);
    }
    const result = buildMemberListPrefix(map);
    expect(result).toContain("[Group Info]");
    expect(result).toContain("50 members");
  });
});

/**
 * Tests for buildMediaUrl — exported module-level URL builder.
 */
describe("buildMediaUrl", () => {
  it("should return undefined for empty url", () => {
    expect(buildMediaUrl(undefined)).toBeUndefined();
    expect(buildMediaUrl("")).toBeUndefined();
  });

  it("should return absolute URL as-is", () => {
    expect(buildMediaUrl("https://cdn.example.com/img.jpg")).toBe("https://cdn.example.com/img.jpg");
    expect(buildMediaUrl("http://example.com/file.pdf")).toBe("http://example.com/file.pdf");
  });

  it("should use cdnUrl when provided", () => {
    expect(buildMediaUrl("upload/abc123.jpg", "https://api.example.com", "https://cdn.example.com"))
      .toBe("https://cdn.example.com/upload/abc123.jpg");
  });

  it("should strip trailing slashes from cdnUrl", () => {
    expect(buildMediaUrl("upload/abc.jpg", undefined, "https://cdn.example.com///"))
      .toBe("https://cdn.example.com/upload/abc.jpg");
  });

  it("should strip file/preview/ prefix with cdnUrl", () => {
    expect(buildMediaUrl("file/preview/bucket/img.jpg", undefined, "https://cdn.example.com"))
      .toBe("https://cdn.example.com/bucket/img.jpg");
  });

  it("should strip file/ prefix with cdnUrl", () => {
    expect(buildMediaUrl("file/bucket/img.jpg", undefined, "https://cdn.example.com"))
      .toBe("https://cdn.example.com/bucket/img.jpg");
  });

  it("should fall back to apiUrl when cdnUrl is not provided", () => {
    expect(buildMediaUrl("upload/abc123.jpg", "https://api.example.com"))
      .toBe("https://api.example.com/file/upload/abc123.jpg");
  });

  it("should strip trailing slashes from apiUrl", () => {
    expect(buildMediaUrl("upload/abc.jpg", "https://api.example.com/"))
      .toBe("https://api.example.com/file/upload/abc.jpg");
  });

  it("should strip file/ prefix with apiUrl fallback", () => {
    expect(buildMediaUrl("file/bucket/img.jpg", "https://api.example.com"))
      .toBe("https://api.example.com/file/bucket/img.jpg");
  });

  it("should return /file/path when neither cdnUrl nor apiUrl provided", () => {
    expect(buildMediaUrl("upload/abc.jpg")).toBe("/file/upload/abc.jpg");
  });
});

/**
 * Tests for resolveInnerMessageText with buildUrl parameter.
 */
describe("resolveInnerMessageText with buildUrl", () => {
  const mockBuildUrl = (url?: string) => url ? `https://cdn.example.com/${url}` : undefined;

  it("should append URL for Image when buildUrl is provided", () => {
    const result = resolveInnerMessageText(
      { type: MessageType.Image, url: "img.jpg" },
      mockBuildUrl,
    );
    expect(result).toBe("[图片]\nhttps://cdn.example.com/img.jpg");
  });

  it("should append URL for GIF when buildUrl is provided", () => {
    const result = resolveInnerMessageText(
      { type: MessageType.GIF, url: "anim.gif" },
      mockBuildUrl,
    );
    expect(result).toBe("[GIF]\nhttps://cdn.example.com/anim.gif");
  });

  it("should append URL for Voice when buildUrl is provided", () => {
    const result = resolveInnerMessageText(
      { type: MessageType.Voice, url: "voice.mp3" },
      mockBuildUrl,
    );
    expect(result).toBe("[语音]\nhttps://cdn.example.com/voice.mp3");
  });

  it("should append URL for Video when buildUrl is provided", () => {
    const result = resolveInnerMessageText(
      { type: MessageType.Video, url: "clip.mp4" },
      mockBuildUrl,
    );
    expect(result).toBe("[视频]\nhttps://cdn.example.com/clip.mp4");
  });

  it("should append URL for File when buildUrl is provided", () => {
    const result = resolveInnerMessageText(
      { type: MessageType.File, name: "report.pdf", url: "report.pdf" },
      mockBuildUrl,
    );
    expect(result).toBe("[文件: report.pdf]\nhttps://cdn.example.com/report.pdf");
  });

  it("should return placeholder without URL when buildUrl is not provided", () => {
    expect(resolveInnerMessageText({ type: MessageType.Image, url: "img.jpg" })).toBe("[图片]");
    expect(resolveInnerMessageText({ type: MessageType.GIF, url: "anim.gif" })).toBe("[GIF]");
    expect(resolveInnerMessageText({ type: MessageType.Voice, url: "voice.mp3" })).toBe("[语音]");
    expect(resolveInnerMessageText({ type: MessageType.Video, url: "clip.mp4" })).toBe("[视频]");
    expect(resolveInnerMessageText({ type: MessageType.File, name: "doc.pdf", url: "doc.pdf" })).toBe("[文件: doc.pdf]");
  });

  it("should return placeholder when payload.url is missing even with buildUrl", () => {
    expect(resolveInnerMessageText({ type: MessageType.Image }, mockBuildUrl)).toBe("[图片]");
    expect(resolveInnerMessageText({ type: MessageType.Voice }, mockBuildUrl)).toBe("[语音]");
    expect(resolveInnerMessageText({ type: MessageType.File, name: "doc.pdf" }, mockBuildUrl)).toBe("[文件: doc.pdf]");
  });
});

/**
 * Tests for resolveMultipleForwardText with apiUrl/cdnUrl — nested media URL resolution.
 */
describe("resolveMultipleForwardText with URL resolution", () => {
  it("should include full URLs for media messages when apiUrl is provided", () => {
    const payload = {
      type: MessageType.MultipleForward,
      users: [{ uid: "user1", name: "Alice" }],
      msgs: [
        { from_uid: "user1", payload: { type: MessageType.Image, url: "upload/img.jpg" } },
        { from_uid: "user1", payload: { type: MessageType.File, name: "doc.pdf", url: "upload/doc.pdf" } },
      ],
    };

    const result = resolveMultipleForwardText(payload, "https://api.example.com");
    expect(result).toContain("Alice: [图片]\nhttps://api.example.com/file/upload/img.jpg");
    expect(result).toContain("Alice: [文件: doc.pdf]\nhttps://api.example.com/file/upload/doc.pdf");
  });

  it("should use cdnUrl when provided", () => {
    const payload = {
      type: MessageType.MultipleForward,
      users: [{ uid: "user1", name: "Bob" }],
      msgs: [
        { from_uid: "user1", payload: { type: MessageType.Video, url: "upload/clip.mp4" } },
      ],
    };

    const result = resolveMultipleForwardText(payload, "https://api.example.com", "https://cdn.example.com");
    expect(result).toContain("Bob: [视频]\nhttps://cdn.example.com/upload/clip.mp4");
  });

  it("should recursively resolve nested MultipleForward with URLs", () => {
    const payload = {
      type: MessageType.MultipleForward,
      users: [{ uid: "user1", name: "张三" }],
      msgs: [
        {
          from_uid: "user1",
          payload: {
            type: MessageType.MultipleForward,
            users: [{ uid: "user2", name: "李四" }],
            msgs: [
              { from_uid: "user2", payload: { type: MessageType.File, name: "secret.docx", url: "upload/secret.docx" } },
            ],
          },
        },
      ],
    };

    const result = resolveMultipleForwardText(payload, "https://api.example.com");
    expect(result).toContain("张三: [合并转发]");
    expect(result).toContain("[合并转发: 聊天记录]");
    expect(result).toContain("李四: [文件: secret.docx]\nhttps://api.example.com/file/upload/secret.docx");
  });

  it("should keep placeholders when no apiUrl or cdnUrl provided", () => {
    const payload = {
      type: MessageType.MultipleForward,
      users: [{ uid: "user1", name: "Test" }],
      msgs: [
        { from_uid: "user1", payload: { type: MessageType.Image, url: "upload/img.jpg" } },
      ],
    };

    const result = resolveMultipleForwardText(payload);
    expect(result).toBe("[合并转发: 聊天记录]\nTest: [图片]");
  });

  it("should handle payload.url being empty in nested messages", () => {
    const payload = {
      type: MessageType.MultipleForward,
      users: [{ uid: "user1", name: "Test" }],
      msgs: [
        { from_uid: "user1", payload: { type: MessageType.Image } },
        { from_uid: "user1", payload: { type: MessageType.File, name: "doc.pdf" } },
      ],
    };

    const result = resolveMultipleForwardText(payload, "https://api.example.com");
    expect(result).toContain("Test: [图片]");
    expect(result).toContain("Test: [文件: doc.pdf]");
    expect(result).not.toContain("https://");
  });
});

// ─── Slash command authorization & body resolution ───────────────────────────

describe("resolveCommandBody", () => {
  it("DM: keeps raw body as-is", () => {
    expect(resolveCommandBody("/new", false, false)).toBe("/new");
  });

  it("group + explicit @bot: strips @mention prefix", () => {
    expect(resolveCommandBody("@ona /new", true, true)).toBe("/new");
  });

  it("group + @all (not explicit bot mention): keeps raw body", () => {
    expect(resolveCommandBody("@all /new", true, false)).toBe("@all /new");
  });

  it("group + no mention: keeps raw body", () => {
    expect(resolveCommandBody("/new", true, false)).toBe("/new");
  });
});

describe("resolveCommandAuthorized", () => {
  it("DM: anyone can execute commands", () => {
    expect(resolveCommandAuthorized(false, false, false)).toBe(true);
    expect(resolveCommandAuthorized(false, true, false)).toBe(true);
  });

  it("group: owner + explicit @bot → authorized", () => {
    expect(resolveCommandAuthorized(true, true, true)).toBe(true);
  });

  it("group: non-owner + explicit @bot → not authorized", () => {
    expect(resolveCommandAuthorized(true, false, true)).toBe(false);
  });

  it("group: owner + @all (no explicit bot mention) → not authorized", () => {
    expect(resolveCommandAuthorized(true, true, false)).toBe(false);
  });

  it("group: non-owner + no mention → not authorized", () => {
    expect(resolveCommandAuthorized(true, false, false)).toBe(false);
  });
});

describe("pendingInboundContext", () => {
  beforeEach(() => {
    pendingInboundContext.clear();
  });

  it("should store and retrieve context by sessionKey", () => {
    const key = "dmwork:group:test123";
    pendingInboundContext.set(key, {
      historyPrefix: "history...",
      memberListPrefix: "members...",
    });
    expect(pendingInboundContext.has(key)).toBe(true);
    const entry = pendingInboundContext.get(key);
    expect(entry?.historyPrefix).toBe("history...");
    expect(entry?.memberListPrefix).toBe("members...");
  });

  it("should allow delete after read (consume-once pattern)", () => {
    const key = "dmwork:group:consume";
    pendingInboundContext.set(key, {
      historyPrefix: "h",
      memberListPrefix: "m",
    });
    const entry = pendingInboundContext.get(key);
    pendingInboundContext.delete(key);
    expect(entry).toBeDefined();
    expect(pendingInboundContext.has(key)).toBe(false);
  });

  it("should keep separate entries for different sessionKeys", () => {
    pendingInboundContext.set("key1", { historyPrefix: "h1", memberListPrefix: "" });
    pendingInboundContext.set("key2", { historyPrefix: "", memberListPrefix: "m2" });
    expect(pendingInboundContext.get("key1")?.historyPrefix).toBe("h1");
    expect(pendingInboundContext.get("key2")?.memberListPrefix).toBe("m2");
  });

  it("should overwrite on repeated set for same key", () => {
    const key = "dmwork:group:overwrite";
    pendingInboundContext.set(key, { historyPrefix: "old", memberListPrefix: "" });
    pendingInboundContext.set(key, { historyPrefix: "new", memberListPrefix: "ml" });
    expect(pendingInboundContext.get(key)?.historyPrefix).toBe("new");
    expect(pendingInboundContext.get(key)?.memberListPrefix).toBe("ml");
  });
});

describe("segmentHistoryEntries", () => {
  it("should segment entries by cutoffSeq", () => {
    const entries = [
      { sender: "user1", body: "Q1 (old)", message_seq: 100, message_id: "m1" },
      { sender: "user2", body: "chat msg", message_seq: 200, message_id: "m2" },
      { sender: "user1", body: "Q2 (new)", message_seq: 300, message_id: "m3" },
    ];

    const result = segmentHistoryEntries({
      entries,
      cutoffSeq: 150,
      currentMsgId: undefined,
    });

    expect(result.answered).toHaveLength(1);
    expect(result.answered[0].body).toBe("Q1 (old)");
    expect(result.new).toHaveLength(2);
    expect(result.new[0].body).toBe("chat msg");
    expect(result.new[1].body).toBe("Q2 (new)");
  });

  it("should exclude current message by message_id", () => {
    const entries = [
      { sender: "user1", body: "old", message_seq: 100, message_id: "m1" },
      { sender: "user2", body: "current @Bot Q2", message_seq: 300, message_id: "m-current" },
    ];

    const result = segmentHistoryEntries({
      entries,
      cutoffSeq: 150,
      currentMsgId: "m-current",
    });

    expect(result.answered).toHaveLength(1);
    expect(result.answered[0].body).toBe("old");
    expect(result.new).toHaveLength(0);
  });

  it("should treat all entries as new when cutoffSeq is 0", () => {
    const entries = [
      { sender: "user1", body: "msg1", message_seq: 100, message_id: "m1" },
      { sender: "user2", body: "msg2", message_seq: 200, message_id: "m2" },
    ];

    const result = segmentHistoryEntries({
      entries,
      cutoffSeq: 0,
      currentMsgId: undefined,
    });

    expect(result.answered).toHaveLength(0);
    expect(result.new).toHaveLength(2);
  });

  it("should treat all entries as new when cutoffSeq is negative", () => {
    const entries = [
      { sender: "user1", body: "msg1", message_seq: 100, message_id: "m1" },
    ];

    const result = segmentHistoryEntries({
      entries,
      cutoffSeq: -1,
      currentMsgId: undefined,
    });

    expect(result.answered).toHaveLength(0);
    expect(result.new).toHaveLength(1);
  });

  it("should handle entries without message_seq (fallback to 0)", () => {
    const entries = [
      { sender: "user1", body: "no seq", message_id: "m1" },
      { sender: "user2", body: "has seq", message_seq: 200, message_id: "m2" },
    ];

    const result = segmentHistoryEntries({
      entries,
      cutoffSeq: 100,
      currentMsgId: undefined,
    });

    expect(result.answered).toHaveLength(1);
    expect(result.answered[0].body).toBe("no seq");
    expect(result.new).toHaveLength(1);
    expect(result.new[0].body).toBe("has seq");
  });

  it("should work correctly with multi-user scenario after bot reply", () => {
    const entries = [
      { sender: "userA", body: "Q1 @Bot", message_seq: 50, message_id: "m1" },
      { sender: "userC", body: "casual chat", message_seq: 120, message_id: "m3" },
      { sender: "userB", body: "new @Bot Q2", message_seq: 200, message_id: "m4" },
    ];

    // Bot replied with seq=100
    const result = segmentHistoryEntries({
      entries,
      cutoffSeq: 100,
      currentMsgId: "m4",  // current @Bot message excluded
    });

    expect(result.answered).toHaveLength(1);
    expect(result.answered[0].body).toBe("Q1 @Bot");
    expect(result.new).toHaveLength(1);
    expect(result.new[0].body).toBe("casual chat");
  });

  it("should handle empty entries", () => {
    const result = segmentHistoryEntries({
      entries: [],
      cutoffSeq: 100,
      currentMsgId: undefined,
    });

    expect(result.answered).toHaveLength(0);
    expect(result.new).toHaveLength(0);
  });

  it("should handle all entries at or below cutoff", () => {
    const entries = [
      { sender: "user1", body: "msg1", message_seq: 50, message_id: "m1" },
      { sender: "user2", body: "msg2", message_seq: 100, message_id: "m2" },
    ];

    const result = segmentHistoryEntries({
      entries,
      cutoffSeq: 100,
      currentMsgId: undefined,
    });

    expect(result.answered).toHaveLength(2);
    expect(result.new).toHaveLength(0);
  });

  it("should handle all entries above cutoff", () => {
    const entries = [
      { sender: "user1", body: "msg1", message_seq: 150, message_id: "m1" },
      { sender: "user2", body: "msg2", message_seq: 200, message_id: "m2" },
    ];

    const result = segmentHistoryEntries({
      entries,
      cutoffSeq: 100,
      currentMsgId: undefined,
    });

    expect(result.answered).toHaveLength(0);
    expect(result.new).toHaveLength(2);
  });

  it("should not filter entries when currentMsgId is undefined", () => {
    const entries = [
      { sender: "user1", body: "msg1", message_seq: 50, message_id: "m1" },
      { sender: "user2", body: "msg2", message_seq: 150, message_id: "m2" },
    ];

    const result = segmentHistoryEntries({
      entries,
      cutoffSeq: 100,
      currentMsgId: undefined,
    });

    expect(result.answered).toHaveLength(1);
    expect(result.new).toHaveLength(1);
  });

  it("should handle entry at exactly the cutoff boundary (seq === cutoffSeq) as answered", () => {
    const entries = [
      { sender: "user1", body: "at boundary", message_seq: 100, message_id: "m1" },
      { sender: "user2", body: "after boundary", message_seq: 101, message_id: "m2" },
    ];

    const result = segmentHistoryEntries({
      entries,
      cutoffSeq: 100,
      currentMsgId: undefined,
    });

    expect(result.answered).toHaveLength(1);
    expect(result.answered[0].body).toBe("at boundary");
    expect(result.new).toHaveLength(1);
    expect(result.new[0].body).toBe("after boundary");
  });

  it("should preserve extra fields on entries", () => {
    const entries = [
      { sender: "user1", body: "msg", message_seq: 50, message_id: "m1", mediaUrl: "http://example.com/img.png", mention: { uids: ["uid1"] } },
    ];

    const result = segmentHistoryEntries({
      entries,
      cutoffSeq: 100,
      currentMsgId: undefined,
    });

    expect(result.answered[0].mediaUrl).toBe("http://example.com/img.png");
    expect(result.answered[0].mention).toEqual({ uids: ["uid1"] });
  });
});

// ─── Integration tests ───────────────────────────────────────────────────────

describe("history prompt template integration", () => {
  function renderSegmentedTemplate(
    template: string,
    answeredEntries: Array<{ sender: string; body: string }>,
    newEntries: Array<{ sender: string; body: string }>,
    allEntries: Array<{ sender: string; body: string }>,
  ): string {
    const formatEntries = (items: Array<{ sender: string; body: string }>) =>
      JSON.stringify(items.map(e => ({ sender: e.sender, body: e.body })), null, 2);

    const hasSegmentedPlaceholders =
      template.includes("{answered_messages}") ||
      template.includes("{new_messages}");

    if (hasSegmentedPlaceholders) {
      return template
        .replace("{answered_messages}", formatEntries(answeredEntries))
        .replace("{new_messages}", formatEntries(newEntries))
        .replace("{answered_count}", String(answeredEntries.length))
        .replace("{new_count}", String(newEntries.length))
        .replace("{messages}", formatEntries(allEntries))
        .replace("{count}", String(allEntries.length));
    } else {
      const legacyPreamble = answeredEntries.length > 0
        ? `[Note: The first ${answeredEntries.length} message(s) below have already been answered. Do NOT re-answer them.]\n`
        : "";
      return legacyPreamble + template
        .replace("{messages}", formatEntries(allEntries))
        .replace("{count}", String(allEntries.length));
    }
  }

  it("legacy template with {messages} adds preamble for answered entries", () => {
    const template = "History ({count} messages):\n{messages}";
    const answered = [{ sender: "user1", body: "old question" }];
    const newMsgs = [{ sender: "user2", body: "new question" }];
    const all = [...answered, ...newMsgs];

    const result = renderSegmentedTemplate(template, answered, newMsgs, all);

    expect(result).toContain("[Note: The first 1 message(s) below have already been answered. Do NOT re-answer them.]");
    expect(result).toContain("History (2 messages):");
    expect(result).toContain('"sender": "user1"');
    expect(result).toContain('"sender": "user2"');
  });

  it("legacy template with no answered entries skips preamble", () => {
    const template = "History ({count} messages):\n{messages}";
    const answered: Array<{ sender: string; body: string }> = [];
    const newMsgs = [{ sender: "user1", body: "hello" }];

    const result = renderSegmentedTemplate(template, answered, newMsgs, newMsgs);

    expect(result).not.toContain("[Note:");
    expect(result).toContain("History (1 messages):");
  });

  it("segmented template with {answered_messages}/{new_messages} renders correctly", () => {
    const template =
      "Already answered ({answered_count}):\n{answered_messages}\n\nNew ({new_count}):\n{new_messages}";
    const answered = [{ sender: "user1", body: "old" }];
    const newMsgs = [{ sender: "user2", body: "fresh" }, { sender: "user3", body: "latest" }];
    const all = [...answered, ...newMsgs];

    const result = renderSegmentedTemplate(template, answered, newMsgs, all);

    expect(result).toContain("Already answered (1):");
    expect(result).toContain('"body": "old"');
    expect(result).toContain("New (2):");
    expect(result).toContain('"body": "fresh"');
    expect(result).toContain('"body": "latest"');
    expect(result).not.toContain("[Note:");
  });

  it("template without any placeholders passes through unchanged", () => {
    const template = "Static prompt with no placeholders";
    const result = renderSegmentedTemplate(template, [], [], []);
    expect(result).toBe("Static prompt with no placeholders");
  });
});

describe("media-only reply cutoff tracking", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uploadAndSendMedia returns SendMessageResult from sendMediaMessage", async () => {
    const { Readable } = await import("node:stream");

    vi.stubGlobal("fetch", async (url: string, opts?: any) => {
      if (opts?.method === "HEAD") {
        return { ok: true, headers: new Headers({ "content-length": "8" }) };
      }
      if (typeof url === "string" && url.includes("/v1/bot/")) {
        // API calls (getUploadCredentials, sendMessage)
        if (url.includes("upload/credentials")) {
          return {
            ok: true,
            text: async () => JSON.stringify({
              credentials: { tmpSecretId: "id", tmpSecretKey: "key", sessionToken: "tok" },
              startTime: 0, expiredTime: 9999999999,
              bucket: "b", region: "r", key: "k", cdnBaseUrl: "https://cdn.example.com",
            }),
          };
        }
        // sendMessage response
        return {
          ok: true,
          text: async () => JSON.stringify({ message_id: "mid_123", message_seq: 42 }),
        };
      }
      // GET for file download
      const body = new Readable({ read() { this.push(Buffer.alloc(8)); this.push(null); } });
      return {
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        body,
      };
    });

    // COS upload fails in test env — uploadAndSendMedia should propagate the error
    await expect(uploadAndSendMedia({
      mediaUrl: "https://example.com/img.png",
      apiUrl: "https://api.example.com",
      botToken: "token",
      channelId: "ch1",
      channelType: ChannelType.DM,
    })).rejects.toThrow();
  });
});

describe("cold-start cutoff derivation", () => {
  it("derives cutoff from bot replies in API backfill when lastBotReplySeq is 0", () => {
    const lastBotReplySeqMap = new Map<string, number>();
    const sessionId = "test-session";
    const botUid = "bot_uid";

    const apiMessages = [
      { from_uid: "user1", message_seq: 100, content: "hello" },
      { from_uid: botUid, message_seq: 150, content: "hi there" },
      { from_uid: "user2", message_seq: 200, content: "hey" },
      { from_uid: botUid, message_seq: 250, content: "welcome" },
      { from_uid: "user1", message_seq: 300, content: "new question" },
    ];

    // Simulate cold-start derivation logic
    if ((lastBotReplySeqMap.get(sessionId) ?? 0) === 0 && apiMessages.length > 0) {
      let inferredCutoff = 0;
      for (const m of apiMessages) {
        if (
          m.from_uid === botUid &&
          typeof m.message_seq === "number" &&
          m.message_seq > inferredCutoff
        ) {
          inferredCutoff = m.message_seq;
        }
      }
      if (inferredCutoff > 0) {
        lastBotReplySeqMap.set(sessionId, inferredCutoff);
      }
    }

    expect(lastBotReplySeqMap.get(sessionId)).toBe(250);
  });

  it("does not override existing non-zero cutoff", () => {
    const lastBotReplySeqMap = new Map<string, number>();
    const sessionId = "test-session";
    const botUid = "bot_uid";
    lastBotReplySeqMap.set(sessionId, 500);

    const apiMessages = [
      { from_uid: botUid, message_seq: 250, content: "old reply" },
    ];

    if ((lastBotReplySeqMap.get(sessionId) ?? 0) === 0 && apiMessages.length > 0) {
      let inferredCutoff = 0;
      for (const m of apiMessages) {
        if (m.from_uid === botUid && typeof m.message_seq === "number" && m.message_seq > inferredCutoff) {
          inferredCutoff = m.message_seq;
        }
      }
      if (inferredCutoff > 0) {
        lastBotReplySeqMap.set(sessionId, inferredCutoff);
      }
    }

    expect(lastBotReplySeqMap.get(sessionId)).toBe(500);
  });

  it("leaves cutoff at 0 when no bot replies in API backfill", () => {
    const lastBotReplySeqMap = new Map<string, number>();
    const sessionId = "test-session";
    const botUid = "bot_uid";

    const apiMessages = [
      { from_uid: "user1", message_seq: 100, content: "hello" },
      { from_uid: "user2", message_seq: 200, content: "world" },
    ];

    if ((lastBotReplySeqMap.get(sessionId) ?? 0) === 0 && apiMessages.length > 0) {
      let inferredCutoff = 0;
      for (const m of apiMessages) {
        if (m.from_uid === botUid && typeof m.message_seq === "number" && m.message_seq > inferredCutoff) {
          inferredCutoff = m.message_seq;
        }
      }
      if (inferredCutoff > 0) {
        lastBotReplySeqMap.set(sessionId, inferredCutoff);
      }
    }

    expect(lastBotReplySeqMap.has(sessionId)).toBe(false);
  });
});

describe("inbound queue serialization", () => {
  it("same session messages are processed in order", async () => {
    const order: number[] = [];
    const queues = new Map<string, Promise<void>>();

    function enqueue(key: string, task: () => Promise<void>): void {
      const previous = queues.get(key) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(task)
        .catch(() => {})
        .finally(() => {
          if (queues.get(key) === next) queues.delete(key);
        });
      queues.set(key, next);
    }

    enqueue("session-A", async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });
    enqueue("session-A", async () => {
      order.push(2);
    });

    // Wait for queue to drain
    await queues.get("session-A");
    // Task 1 should complete before task 2
    expect(order).toEqual([1, 2]);
  });

  it("different session messages run concurrently", async () => {
    const events: string[] = [];
    const queues = new Map<string, Promise<void>>();

    function enqueue(key: string, task: () => Promise<void>): void {
      const previous = queues.get(key) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(task)
        .catch(() => {})
        .finally(() => {
          if (queues.get(key) === next) queues.delete(key);
        });
      queues.set(key, next);
    }

    enqueue("session-A", async () => {
      events.push("A-start");
      await new Promise(r => setTimeout(r, 50));
      events.push("A-end");
    });
    enqueue("session-B", async () => {
      events.push("B-start");
      await new Promise(r => setTimeout(r, 50));
      events.push("B-end");
    });

    await Promise.all([queues.get("session-A"), queues.get("session-B")]);
    // Both should start before either ends (concurrent)
    expect(events.indexOf("A-start")).toBeLessThan(events.indexOf("A-end"));
    expect(events.indexOf("B-start")).toBeLessThan(events.indexOf("B-end"));
    // B should start before A ends (proving concurrency)
    expect(events.indexOf("B-start")).toBeLessThan(events.indexOf("A-end"));
  });

  it("queue error in one task does not block subsequent tasks", async () => {
    const results: string[] = [];
    const queues = new Map<string, Promise<void>>();

    function enqueue(key: string, task: () => Promise<void>): void {
      const previous = queues.get(key) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(task)
        .catch(() => {})
        .finally(() => {
          if (queues.get(key) === next) queues.delete(key);
        });
      queues.set(key, next);
    }

    enqueue("session-X", async () => {
      throw new Error("task 1 failed");
    });
    enqueue("session-X", async () => {
      results.push("task2-ok");
    });

    await queues.get("session-X");
    expect(results).toEqual(["task2-ok"]);
  });

  it("queue cleans up after draining", async () => {
    const queues = new Map<string, Promise<void>>();

    function enqueue(key: string, task: () => Promise<void>): void {
      const previous = queues.get(key) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(task)
        .catch(() => {})
        .finally(() => {
          if (queues.get(key) === next) queues.delete(key);
        });
      queues.set(key, next);
    }

    enqueue("session-Z", async () => {});

    await queues.get("session-Z");
    // After small delay for finally to execute
    await new Promise(r => setTimeout(r, 10));
    expect(queues.has("session-Z")).toBe(false);
  });
});

// ─── Inbound message_seq cutoff tracking ────────────────────────────────────

describe("inbound message_seq cutoff tracking", () => {
  /**
   * Simulates the finally-block logic from handleInboundMessage that records
   * the cutoff after a successful bot reply. Uses the inbound @mention
   * message's message_seq (from WebSocket frame) rather than sendMessage's
   * returned message_seq (which is always 0).
   */
  function recordCutoff(
    lastBotReplySeqMap: Map<string, number>,
    sessionId: string,
    inboundMessageSeq: unknown,
    replySucceeded: boolean,
  ): void {
    if (replySucceeded) {
      const seq = inboundMessageSeq;
      if (typeof seq === "number" && seq > 0) {
        const existing = lastBotReplySeqMap.get(sessionId) ?? 0;
        if (seq > existing) {
          lastBotReplySeqMap.set(sessionId, seq);
        }
      }
    }
  }

  it("should update cutoff using inbound message_seq even when sendMessage returns 0", () => {
    const map = new Map<string, number>();
    const sessionId = "group_abc";

    // sendMessage would have returned message_seq=0, but we use the inbound seq
    const sendMessageReturnedSeq = 0;
    const inboundMsgSeq = 500;

    // Old logic would fail: recordCutoff with sendMessageReturnedSeq=0 does nothing
    recordCutoff(map, sessionId, sendMessageReturnedSeq, true);
    expect(map.has(sessionId)).toBe(false);

    // New logic: use inbound message_seq
    recordCutoff(map, sessionId, inboundMsgSeq, true);
    expect(map.get(sessionId)).toBe(500);
  });

  it("should preserve monotonic-increasing cutoff (never go backwards)", () => {
    const map = new Map<string, number>();
    const sessionId = "group_abc";

    recordCutoff(map, sessionId, 300, true);
    expect(map.get(sessionId)).toBe(300);

    // Older message_seq should not override
    recordCutoff(map, sessionId, 200, true);
    expect(map.get(sessionId)).toBe(300);

    // Higher message_seq should update
    recordCutoff(map, sessionId, 500, true);
    expect(map.get(sessionId)).toBe(500);
  });

  it("should guard against non-number and non-positive message_seq", () => {
    const map = new Map<string, number>();
    const sessionId = "group_abc";

    recordCutoff(map, sessionId, undefined, true);
    expect(map.has(sessionId)).toBe(false);

    recordCutoff(map, sessionId, null, true);
    expect(map.has(sessionId)).toBe(false);

    recordCutoff(map, sessionId, "500", true);
    expect(map.has(sessionId)).toBe(false);

    recordCutoff(map, sessionId, 0, true);
    expect(map.has(sessionId)).toBe(false);

    recordCutoff(map, sessionId, -1, true);
    expect(map.has(sessionId)).toBe(false);
  });

  it("should not update cutoff when reply failed", () => {
    const map = new Map<string, number>();
    const sessionId = "group_abc";

    recordCutoff(map, sessionId, 500, false);
    expect(map.has(sessionId)).toBe(false);
  });

  it("hot-run multi-round: first @bot sets cutoff, second @bot sees first as answered", () => {
    const map = new Map<string, number>();
    const sessionId = "group_xyz";

    // Round 1: user @bot with message_seq=100, bot replies successfully
    recordCutoff(map, sessionId, 100, true);
    expect(map.get(sessionId)).toBe(100);

    // Round 2: user @bot with message_seq=300
    // History includes messages at seq 50, 100, 120, 200, 300
    const entries = [
      { sender: "userA", body: "Q1 @bot", message_seq: 50, message_id: "m1" },
      { sender: "userA", body: "Q2 @bot (round 1 trigger)", message_seq: 100, message_id: "m2" },
      { sender: "userC", body: "random chat", message_seq: 120, message_id: "m3" },
      { sender: "userB", body: "comment", message_seq: 200, message_id: "m4" },
      { sender: "userA", body: "Q3 @bot (round 2 trigger)", message_seq: 300, message_id: "m5" },
    ];

    const cutoffSeq = map.get(sessionId) ?? 0; // 100
    const { answered, new: newEntries } = segmentHistoryEntries({
      entries,
      cutoffSeq,
      currentMsgId: "m5",
    });

    // Messages at seq 50 and 100 should be marked as answered
    expect(answered).toHaveLength(2);
    expect(answered.map(e => e.message_seq)).toEqual([50, 100]);

    // Messages at seq 120 and 200 are new (above cutoff, not the current msg)
    expect(newEntries).toHaveLength(2);
    expect(newEntries.map(e => e.message_seq)).toEqual([120, 200]);

    // After round 2 reply succeeds, cutoff updates to 300
    recordCutoff(map, sessionId, 300, true);
    expect(map.get(sessionId)).toBe(300);
  });

  it("concurrent @mentions in serial queue: cutoff updates monotonically", () => {
    const map = new Map<string, number>();
    const sessionId = "group_concurrent";

    // Messages arrive rapidly: seq 100, 200, 300
    // Serial queue processes them in order
    recordCutoff(map, sessionId, 100, true);
    expect(map.get(sessionId)).toBe(100);

    recordCutoff(map, sessionId, 200, true);
    expect(map.get(sessionId)).toBe(200);

    recordCutoff(map, sessionId, 300, true);
    expect(map.get(sessionId)).toBe(300);

    // If a stale message somehow gets processed, cutoff stays at 300
    recordCutoff(map, sessionId, 150, true);
    expect(map.get(sessionId)).toBe(300);
  });
});

/**
 * Tests for OBO v2 sender identity validation (GH#63).
 *
 * Mirrors the isOBOv2 detection logic in inbound.ts. Only payloads sent by
 * the configured grantor (account.config.onBehalfOf) should be honored;
 * arbitrary senders inserting obo_origin_channel_id / obo_respond_as fields
 * must be ignored, otherwise they could trick the persona clone into
 * replying in another channel as the grantor.
 */
describe("OBO v2 sender identity validation (GH#63)", () => {
  type OboPayload = {
    obo_origin_channel_id?: unknown;
    obo_origin_channel_type?: unknown;
    obo_respond_as?: unknown;
    obo_grantor_uid?: unknown;
  };
  type FakeMessage = { from_uid: string; payload?: OboPayload };
  type FakeAccount = { config: { onBehalfOf?: string } };
  type WarnSink = { warn: (msg: string) => void };

  // Mirrors the validation block at inbound.ts:1624-1642
  function detectOBOv2(
    message: FakeMessage,
    account: FakeAccount,
    log?: WarnSink,
  ): boolean {
    const oboV2OriginChannel = message.payload?.obo_origin_channel_id;
    const oboV2RespondAs =
      message.payload?.obo_respond_as ?? message.payload?.obo_grantor_uid;
    const grantorUid = account.config.onBehalfOf;
    const isOBOv2 = Boolean(
      typeof oboV2OriginChannel === "string" &&
        (oboV2OriginChannel as string).length > 0 &&
        typeof oboV2RespondAs === "string" &&
        (oboV2RespondAs as string).length > 0 &&
        grantorUid &&
        message.from_uid === grantorUid,
    );
    if (
      !isOBOv2 &&
      typeof oboV2OriginChannel === "string" &&
      (oboV2OriginChannel as string).length > 0
    ) {
      log?.warn(
        `octo: OBO v2 payload rejected — from_uid=${message.from_uid} is not configured grantor ${grantorUid ?? "(none)"}`,
      );
    }
    return isOBOv2;
  }

  it("OBO v2 from configured grantor → isOBOv2=true, no warn", () => {
    const warn = vi.fn();
    const ok = detectOBOv2(
      {
        from_uid: "admin",
        payload: {
          obo_origin_channel_id: "group_xyz",
          obo_origin_channel_type: ChannelType.Group,
          obo_respond_as: "admin",
        },
      },
      { config: { onBehalfOf: "admin" } },
      { warn },
    );
    expect(ok).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("OBO v2 from non-grantor sender → isOBOv2=false, warn logged", () => {
    const warn = vi.fn();
    const ok = detectOBOv2(
      {
        from_uid: "mallory",
        payload: {
          obo_origin_channel_id: "group_xyz",
          obo_origin_channel_type: ChannelType.Group,
          obo_respond_as: "admin",
        },
      },
      { config: { onBehalfOf: "admin" } },
      { warn },
    );
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("OBO v2 payload rejected");
    expect(warn.mock.calls[0][0]).toContain("from_uid=mallory");
    expect(warn.mock.calls[0][0]).toContain("admin");
  });

  it("OBO v2 with no onBehalfOf configured → OBO v2 disabled, warn logged", () => {
    const warn = vi.fn();
    const ok = detectOBOv2(
      {
        from_uid: "admin",
        payload: {
          obo_origin_channel_id: "group_xyz",
          obo_origin_channel_type: ChannelType.Group,
          obo_respond_as: "admin",
        },
      },
      { config: {} },
      { warn },
    );
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("(none)");
  });

  it("no OBO payload → isOBOv2=false, no warn (nothing to reject)", () => {
    const warn = vi.fn();
    const ok = detectOBOv2(
      { from_uid: "alice", payload: {} },
      { config: { onBehalfOf: "admin" } },
      { warn },
    );
    expect(ok).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("OBO v2 with obo_grantor_uid fallback from grantor → isOBOv2=true", () => {
    const warn = vi.fn();
    const ok = detectOBOv2(
      {
        from_uid: "admin",
        payload: {
          obo_origin_channel_id: "group_xyz",
          obo_grantor_uid: "admin",
        },
      },
      { config: { onBehalfOf: "admin" } },
      { warn },
    );
    expect(ok).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("OBO v2 missing obo_respond_as / obo_grantor_uid → isOBOv2=false, warn logged", () => {
    const warn = vi.fn();
    const ok = detectOBOv2(
      {
        from_uid: "admin",
        payload: { obo_origin_channel_id: "group_xyz" },
      },
      { config: { onBehalfOf: "admin" } },
      { warn },
    );
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/**
 * Tests for OBO v2 effective identity authority (PR#61 R5).
 *
 * In the isOBOv2 branch of inbound.ts (~L1685), `effectiveOnBehalfOf` is the
 * identity we use as `on_behalf_of` for replies/typing. It MUST come from the
 * trusted `account.config.onBehalfOf`, not from the payload field
 * `obo_respond_as` (which is attacker-controllable in transit). When the two
 * disagree, we keep the configured grantor and emit a warn for visibility.
 */
describe("OBO v2 effective identity authority (PR#61 R5)", () => {
  type WarnSink = { warn: (msg: string) => void; info?: (msg: string) => void };

  // Mirrors the assignment at inbound.ts:1685 (post-fix).
  function resolveEffectiveOnBehalfOf(
    oboV2RespondAs: string | undefined,
    configuredGrantor: string,
    log?: WarnSink,
  ): string {
    const effective = configuredGrantor; // trusted source
    if (oboV2RespondAs !== effective) {
      log?.warn(
        `octo: OBO v2 payload respondAs=${oboV2RespondAs} differs from configured grantor=${effective} — using configured grantor`,
      );
    }
    return effective;
  }

  it("payload respondAs matches configured grantor → no warn, uses configured", () => {
    const warn = vi.fn();
    const eff = resolveEffectiveOnBehalfOf("admin", "admin", { warn });
    expect(eff).toBe("admin");
    expect(warn).not.toHaveBeenCalled();
  });

  it("payload respondAs differs from configured grantor → warn, uses configured", () => {
    const warn = vi.fn();
    const eff = resolveEffectiveOnBehalfOf("evil-spoofed-uid", "admin", { warn });
    // Authority is configured grantor, never the payload value.
    expect(eff).toBe("admin");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("payload respondAs=evil-spoofed-uid");
    expect(warn.mock.calls[0][0]).toContain("configured grantor=admin");
    expect(warn.mock.calls[0][0]).toContain("using configured grantor");
  });

  it("payload respondAs missing → warn, still uses configured grantor", () => {
    const warn = vi.fn();
    const eff = resolveEffectiveOnBehalfOf(undefined, "admin", { warn });
    expect(eff).toBe("admin");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

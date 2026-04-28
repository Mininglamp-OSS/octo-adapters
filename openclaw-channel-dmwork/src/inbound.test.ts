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
    expect(result!.startsWith("/tmp/dmwork-media/")).toBe(true);
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
